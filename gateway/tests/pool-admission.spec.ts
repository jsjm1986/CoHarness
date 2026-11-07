/** Real pg.Pool scheduling driven by fixture-owned clients without a database socket. */
import { Client, type Pool, type QueryResult } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectFromPool, createPostgresPool, poolAdmissionSnapshot, transaction } from '../src/postgres/database.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(limit = 1, connectionTimeoutMillis = 0) {
  const clients: ControlledClient[] = []
  const acquired = new Set<import('pg').PoolClient>()
  const queryStarted = deferred<{ finish(error?: Error): void }>()
  let constructorFailure: Error | undefined
  let queryFailure: Error | undefined
  class ControlledClient extends Client {
    private connected!: (error?: Error) => void
    constructor() {
      super()
      if (constructorFailure !== undefined) {
        const failure = constructorFailure
        constructorFailure = undefined
        throw failure
      }
      clients.push(this)
    }
    override connect(): Promise<void>
    override connect(callback: (error: Error) => void): void
    override connect(callback?: (error: Error) => void): Promise<void> | void {
      if (callback === undefined) return new Promise<void>((resolve, reject) => {
        this.connected = error => error === undefined ? resolve() : reject(error)
      })
      this.connected = error => { callback(error!) }
    }
    accept(error?: Error): void { this.connected(error) }
    override query = new Proxy(Client.prototype.query, {
      apply: (_target, _receiver, args: unknown[]) => {
        if (queryFailure !== undefined) {
          const failure = queryFailure
          queryFailure = undefined
          throw failure
        }
        const callback = args[2] as (error: Error | null, result?: QueryResult) => void
        let finished = false
        const finish = (error?: Error): void => {
          if (finished) return
          finished = true
          callback(error ?? null, error === undefined ? { rows: [{ value: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } : undefined)
        }
        queryStarted.resolve({ finish })
        queueMicrotask(() => { finish() })
      },
    })
    override end(): Promise<void>
    override end(callback: (error?: Error) => void): void
    override end(callback?: (error?: Error) => void): Promise<void> | void {
      this.emit('end')
      callback?.()
      return callback === undefined ? Promise.resolve() : undefined
    }
  }
  const pool = createPostgresPool('postgresql://fixture.invalid/not-opened', {
    Client: ControlledClient, max: 1, maxCheckoutQueue: limit,
    connectionTimeoutMillis, idleTimeoutMillis: 0,
  })
  pool.on('acquire', (client: import('pg').PoolClient) => { acquired.add(client) })
  pool.on('release', (_error: unknown, client: import('pg').PoolClient) => { acquired.delete(client) })
  cleanups.push(async () => {
    while (acquired.size > 0) [...acquired][0]!.release()
    if (!pool.ending) await pool.end()
  })
  return {
    pool, clients, queryStarted,
    failNextConstructor: (error: Error) => { constructorFailure = error },
    failNextQuery: (error: Error) => { queryFailure = error },
  }
}

async function hold(pool: Pool, clients: { accept(error?: Error): void }[]) {
  const acquired = pool.connect()
  clients[0]!.accept()
  return acquired
}

describe('production pool checkout admission', () => {
  it('bounds the native query checkout and recovers after a held client releases', async () => {
    const { pool, clients, queryStarted } = fixture()
    const client = await hold(pool, clients)
    const waiting = pool.query('SELECT 1')
    expect(pool.waitingCount).toBe(1)
    expect(poolAdmissionSnapshot(pool)).toEqual({ pending: 1, maxPending: 1, rejected: 0 })
    const overflow = pool.query('SELECT 2')
    const rejected = expect(overflow).rejects.toMatchObject({ code: 'DB_CHECKOUT_QUEUE_FULL' })
    client.release()
    const query = await queryStarted.promise
    query.finish()
    await rejected
    await expect(waiting).resolves.toMatchObject({ rows: [{ value: 1 }] })
    const later = await pool.connect()
    later.release()
    expect(pool.waitingCount).toBe(0)
    expect(poolAdmissionSnapshot(pool)).toEqual({ pending: 0, maxPending: 1, rejected: 1 })
  })

  it('shares the limit across promise, callback and helper checkouts and delivers callback refusal asynchronously', async () => {
    const { pool, clients } = fixture()
    const client = await hold(pool, clients)
    const waiting = connectFromPool(pool)
    const refused = deferred<Error | undefined>()
    let callbackReturned = false
    pool.connect(error => {
      expect(callbackReturned).toBe(true)
      refused.resolve(error)
    })
    callbackReturned = true
    const rejection = expect(refused.promise).resolves.toMatchObject({ code: 'DB_CHECKOUT_QUEUE_FULL' })
    const promiseRefusal = expect(pool.connect()).rejects.toMatchObject({ code: 'DB_CHECKOUT_QUEUE_FULL' })
    client.release()
    await rejection
    await promiseRefusal
    const next = await waiting
    next.release()
    const later = await new Promise<import('pg').PoolClient>((resolve, reject) => {
      pool.connect((error, value) => error ? reject(error) : resolve(value!))
    })
    later.release()
  })

  it('releases a late checkout only once after its transaction was canceled and restores capacity', async () => {
    const { pool, clients } = fixture()
    const client = await hold(pool, clients)
    const controller = new AbortController()
    const operation = vi.fn(async () => {})
    const canceled = transaction(pool, operation, controller.signal)
    expect(poolAdmissionSnapshot(pool)?.pending).toBe(1)
    controller.abort(new Error('checkout canceled'))
    await expect(canceled).rejects.toThrow('checkout canceled')

    client.release()
    const release = client.release.bind(client)
    const failures: unknown[] = []
    const lateRelease = vi.spyOn(client, 'release').mockImplementation((error) => {
      try { release(error) } catch (failure: unknown) { failures.push(failure) }
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(lateRelease).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([])
    expect(operation).not.toHaveBeenCalled()
    expect(pool.waitingCount).toBe(0)
    expect(poolAdmissionSnapshot(pool)).toEqual({ pending: 0, maxPending: 1, rejected: 0 })
    lateRelease.mockRestore()

    const next = await connectFromPool(pool)
    next.release()
  })

  it('releases admission on a connection failure before the next checkout', async () => {
    const { pool, clients } = fixture()
    const failure = new Error('controlled connection refusal')
    const first = pool.connect()
    const rejected = expect(first).rejects.toBe(failure)
    clients[0]!.accept(failure)
    await rejected
    const next = pool.connect()
    clients[1]!.accept()
    const client = await next
    client.release()
    expect(poolAdmissionSnapshot(pool)?.pending).toBe(0)
  })

  it('routes the callback query overload through the same admission', async () => {
    const { pool, clients } = fixture()
    const client = await hold(pool, clients)
    const waiting = new Promise<void>((resolve, reject) => {
      pool.query('SELECT 1', error => error ? reject(error) : resolve())
    })
    const refusal = new Promise<Error>((resolve) => {
      pool.query('SELECT 2', error => { resolve(error!) })
    })
    const rejected = expect(refusal).resolves.toMatchObject({ code: 'DB_CHECKOUT_QUEUE_FULL' })
    client.release()
    await Promise.all([waiting, rejected])
    expect(poolAdmissionSnapshot(pool)).toEqual({ pending: 0, maxPending: 1, rejected: 1 })
  })

  it('releases callback admission after a failed native connection', async () => {
    const { pool, clients } = fixture()
    const failure = new Error('callback connection failed')
    const failed = new Promise<Error | undefined>((resolve) => {
      pool.connect(error => { resolve(error) })
    })
    clients[0]!.accept(failure)
    await expect(failed).resolves.toBe(failure)
    expect(poolAdmissionSnapshot(pool)?.pending).toBe(0)
    const next = pool.connect()
    clients[1]!.accept()
    const client = await next
    client.release()
  })

  it('rolls back callback admission on a synchronous native throw', async () => {
    const { pool, clients, failNextConstructor } = fixture()
    const failure = new Error('callback constructor failed')
    failNextConstructor(failure)
    expect(() => pool.connect(() => {})).toThrow(failure)
    expect(poolAdmissionSnapshot(pool)?.pending).toBe(0)
    const next = pool.connect()
    clients[0]!.accept()
    const client = await next
    client.release()
  })

  it('does not retain admission after pg catches a synchronous query error', async () => {
    const { pool, clients, failNextQuery } = fixture()
    const client = await hold(pool, clients)
    client.release()
    const failure = new Error('synchronous query failure')
    failNextQuery(failure)
    await expect(pool.query('SELECT failure')).rejects.toBe(failure)
    expect(poolAdmissionSnapshot(pool)?.pending).toBe(0)
    const next = pool.connect()
    clients[1]!.accept()
    const recovered = await next
    recovered.release()
  })

  it('returns capacity after pg checkout timeout and keeps end refusal distinct from queue full', async () => {
    vi.useFakeTimers()
    const { pool, clients } = fixture(1, 100)
    const client = await hold(pool, clients)
    const waiting = pool.connect()
    const rejected = expect(waiting).rejects.toThrow('timeout exceeded when trying to connect')
    const ending = pool.end()
    await expect(pool.connect()).rejects.toThrow('after calling end')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(poolAdmissionSnapshot(pool)).toEqual({ pending: 0, maxPending: 1, rejected: 0 })
    client.release()
    await ending
    expect(pool.ended).toBe(true)
  })

  it('turns synchronous promise-checkout failure into rejection without leaking admission', async () => {
    const { pool, clients, failNextConstructor } = fixture()
    const failure = new Error('controlled constructor failure')
    failNextConstructor(failure)
    let result: Promise<import('pg').PoolClient> | undefined
    expect(() => { result = pool.connect() }).not.toThrow()
    await expect(result).rejects.toBe(failure)
    const next = pool.connect()
    clients[0]!.accept()
    const client = await next
    client.release()
  })

  it('keeps checked-out client error events guarded across direct and helper reuse', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { pool, clients } = fixture()
    const first = await hold(pool, clients)
    expect(() => first.emit('error', Object.assign(new Error('private detail'), { code: '08006' }))).not.toThrow()
    first.release()
    const next = await connectFromPool(pool)
    next.emit('error', Object.assign(new Error('private detail'), { code: '08006' }))
    next.release()
    expect(log.mock.calls).toEqual([
      ['[gateway] PostgreSQL checked-out client error (08006)'],
      ['[gateway] PostgreSQL checked-out client error (08006)'],
    ])
  })

  it('preserves pg errors after pool end without consuming admission', async () => {
    const { pool } = fixture()
    await pool.end()
    await expect(pool.connect()).rejects.toThrow('after calling end')
    const error = await new Promise<Error | undefined>(resolve => { pool.connect(value => { resolve(value) }) })
    expect(error?.message).toContain('after calling end')
    await expect(pool.query('SELECT 1')).rejects.toThrow('after calling end')
    expect(pool.waitingCount).toBe(0)
  })
})
