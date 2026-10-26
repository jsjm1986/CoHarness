/** Actual pg connections against fixture-owned PostgreSQL handshake and disconnect peers. */
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import type { Pool, PoolClient } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeTlsFixture } from '../../packages/host/webserver/tests/tls-fixture.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import {
  connectFromPool, createPostgresPool, errorCodeForDiagnostics, isTransientDatabaseError,
  withDatabaseStartupRetry, type GatewayPoolConfig,
} from '../src/postgres/database.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).map(close => close()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'PostgreSQL transport fixture cleanup failed')
})

function packet(tag: string, body: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeInt32BE(body.byteLength + 4)
  return Buffer.concat([Buffer.from(tag), length, body])
}

const AUTHENTICATED = Buffer.concat([
  packet('R', Buffer.from([0, 0, 0, 0])),
  packet('Z', Buffer.from('I')),
])
const QUERY_COMPLETE = Buffer.concat([packet('C', Buffer.from('SELECT 0\0')), packet('Z', Buffer.from('I'))])

async function peer(receive: (socket: Socket, connection: number, tag: string) => void, tls?: SecureContext) {
  const sockets = new Set<Socket>()
  const errors: Error[] = []
  let connections = 0
  const attach = (socket: Socket, connection: number): void => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') errors.push(error)
    })
    let bytes = Buffer.alloc(0)
    let startup = true
    const consume = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 65536) { socket.destroy(new Error('Fixture packet exceeded its input bound')); return }
      while (bytes.length >= (startup ? 4 : 5)) {
        const length = bytes.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
        if (length < (startup ? 4 : 5) || length > 65536) {
          socket.destroy(new Error('Fixture received an invalid PostgreSQL packet length'))
          return
        }
        if (bytes.length < length) return
        const tag = startup ? 'startup' : String.fromCharCode(bytes[0]!)
        if (startup && tls !== undefined && length === 8 && bytes.readInt32BE(4) === 80877103) {
          socket.off('data', consume)
          socket.write('S')
          attach(new TLSSocket(socket, { isServer: true, secureContext: tls }), connection)
          return
        }
        bytes = bytes.subarray(length)
        startup = false
        if (tag === 'X') socket.end()
        else receive(socket, connection, tag)
      }
    }
    socket.on('data', consume)
  }
  const server = createServer(socket => { attach(socket, ++connections) })
  cleanups.push(async () => {
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
      for (const socket of sockets) socket.destroy()
      await closed
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Unexpected PostgreSQL fixture socket failure')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture has no TCP listener')
  return { port: address.port, connections: () => connections }
}

function poolFor(port: number, overrides: GatewayPoolConfig = {}): Pool {
  const pool = createPostgresPool(`postgresql://fixture@127.0.0.1:${String(port)}/fixture`, {
    max: 1, maxCheckoutQueue: 4, idleTimeoutMillis: 0, ssl: false, ...overrides,
  })
  const acquired = new Set<PoolClient>()
  pool.on('acquire', (client: PoolClient) => { acquired.add(client) })
  pool.on('release', (_error: unknown, client: PoolClient) => { acquired.delete(client) })
  cleanups.unshift(async () => {
    for (const client of acquired) client.release(true)
    if (!pool.ending) await pool.end()
  })
  return pool
}

async function securePeer(receive: (socket: Socket, connection: number, tag: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'hgw-postgres-tls-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const certificate = await materializeTlsFixture(directory)
  const key = await readFile(certificate.keyFile)
  return { ...await peer(receive, createSecureContext({ cert: certificate.ca, key })), ca: certificate.ca }
}

describe('Gateway PostgreSQL transport classification', () => {
  it('retries an orderly peer disconnect before authentication without parsing its message', async () => {
    const remote = await peer((socket, connection) => {
      if (connection === 1) socket.end()
      else socket.write(AUTHENTICATED)
    })
    const pool = poolFor(remote.port)
    const retries: string[] = []
    const result = await withDatabaseStartupRetry(async () => {
      const client = await connectFromPool(pool)
      client.release()
      return 'ready'
    }, { initialDelayMs: 1, maxDelayMs: 1, onRetry: error => retries.push(errorCodeForDiagnostics(error)) })
    expect(result).toBe('ready')
    expect(remote.connections()).toBe(2)
    expect(retries).toEqual(['08006'])
  })

  it('retries a peer disconnect during a startup query using a fresh connection', async () => {
    const remote = await peer((socket, connection, tag) => {
      if (tag === 'startup') socket.write(AUTHENTICATED)
      else if (connection === 1) socket.end()
      else socket.write(QUERY_COMPLETE)
    })
    const pool = poolFor(remote.port)
    const retries: string[] = []
    const result = await withDatabaseStartupRetry(async () => {
      const client = await connectFromPool(pool)
      try { return (await client.query('SELECT 1')).command }
      finally { client.release(true) }
    }, { initialDelayMs: 1, maxDelayMs: 1, onRetry: error => retries.push(errorCodeForDiagnostics(error)) })
    expect(result).toBe('SELECT')
    expect(remote.connections()).toBe(2)
    expect(retries).toEqual(['08006'])
  })

  it('projects a real read disconnection through the existing conversation dependency error', async () => {
    const remote = await peer((socket, _connection, tag) => {
      if (tag === 'startup') socket.write(AUTHENTICATED)
      else socket.end()
    })
    const repository = new ConversationRepository(poolFor(remote.port))
    await expect(repository.readHeader('synthetic-session')).rejects.toMatchObject({
      code: 'dependency', cause: { code: '08006' },
    })
    expect(remote.connections()).toBe(1)
  })

  it('reports a failed ordinary data query once without automatically repeating it', async () => {
    let queries = 0
    const remote = await peer((socket, _connection, tag) => {
      if (tag === 'startup') socket.write(AUTHENTICATED)
      else { queries++; socket.end() }
    })
    const pool = poolFor(remote.port)
    await expect(pool.query('INSERT INTO synthetic VALUES (1)')).rejects.toMatchObject({ code: '08006' })
    expect(queries).toBe(1)
    expect(remote.connections()).toBe(1)
  })

  it('preserves PostgreSQL credential refusal even when the peer closes afterward', async () => {
    const remote = await peer(socket => {
      socket.end(packet('E', Buffer.from('SFATAL\0C28P01\0Mfixture authentication refused\0\0')))
    })
    const pool = poolFor(remote.port)
    let retries = 0
    await expect(withDatabaseStartupRetry(() => connectFromPool(pool), {
      initialDelayMs: 1, maxDelayMs: 1, onRetry: () => { retries++ },
    })).rejects.toMatchObject({ code: '28P01' })
    expect(retries).toBe(0)
    expect(remote.connections()).toBe(1)
  })

  it('keeps uncoded TLS refusal fail-fast even when the peer closes afterward', async () => {
    const remote = await peer(socket => { socket.end(Buffer.from('N')) })
    const pool = poolFor(remote.port, { ssl: true })
    let failure: unknown
    let retries = 0
    await expect(withDatabaseStartupRetry(() => connectFromPool(pool), {
      initialDelayMs: 1, maxDelayMs: 1,
      onRetry: () => { retries++; throw new Error('TLS refusal must not retry') },
    }).catch((error: unknown) => { failure = error; throw error })).rejects.toBeInstanceOf(Error)
    expect(errorCodeForDiagnostics(failure)).toBe('unknown')
    expect(isTransientDatabaseError(failure)).toBe(false)
    expect(retries).toBe(0)
    expect(remote.connections()).toBe(1)
  })

  it('does not report a connection reset for intentional pool shutdown', async () => {
    const remote = await peer(socket => { socket.write(AUTHENTICATED) })
    const pool = poolFor(remote.port)
    const errors: unknown[] = []
    pool.on('error', (error: unknown) => { errors.push(error) })
    const client = await connectFromPool(pool)
    client.release()
    await pool.end()
    expect(errors).toEqual([])
    expect(remote.connections()).toBe(1)
  })

  it('connects and shuts down normally through verified PostgreSQL TLS negotiation', async () => {
    const remote = await securePeer((socket, _connection, tag) => {
      socket.write(tag === 'startup' ? AUTHENTICATED : QUERY_COMPLETE)
    })
    const pool = poolFor(remote.port, { ssl: { ca: remote.ca, servername: 'localhost' } })
    const errors: unknown[] = []
    pool.on('error', (error: unknown) => { errors.push(error) })
    const client = await connectFromPool(pool)
    expect((await client.query('SELECT 1')).command).toBe('SELECT')
    client.release()
    await pool.end()
    expect(errors).toEqual([])
    expect(remote.connections()).toBe(1)
  })

  it('retries peer EOF after verified TLS negotiation without weakening certificate checks', async () => {
    const remote = await securePeer((socket, connection) => {
      if (connection === 1) socket.end()
      else socket.write(AUTHENTICATED)
    })
    const pool = poolFor(remote.port, { ssl: { ca: remote.ca, servername: 'localhost' } })
    const retries: string[] = []
    await withDatabaseStartupRetry(async () => {
      const client = await connectFromPool(pool)
      client.release()
    }, { initialDelayMs: 1, maxDelayMs: 1, onRetry: error => retries.push(errorCodeForDiagnostics(error)) })
    expect(remote.connections()).toBe(2)
    expect(retries).toEqual(['08006'])
  })

  it('preserves TLS hostname refusal without retrying it as a peer disconnect', async () => {
    const remote = await securePeer(socket => { socket.write(AUTHENTICATED) })
    const pool = poolFor(remote.port, { ssl: { ca: remote.ca, servername: 'wrong.invalid' } })
    let retries = 0
    await expect(withDatabaseStartupRetry(() => connectFromPool(pool), {
      initialDelayMs: 1, maxDelayMs: 1,
      onRetry: () => { retries++; throw new Error('TLS hostname refusal must not retry') },
    })).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    expect(retries).toBe(0)
    expect(remote.connections()).toBe(1)
  })

  it('honors supervisor cancellation after a peer disconnect without another connection', async () => {
    const remote = await peer(socket => { socket.end() })
    const pool = poolFor(remote.port)
    const controller = new AbortController()
    const retries: string[] = []
    await expect(withDatabaseStartupRetry(() => connectFromPool(pool), {
      initialDelayMs: 1, maxDelayMs: 1, signal: controller.signal,
      onRetry: error => { retries.push(errorCodeForDiagnostics(error)); controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(retries).toEqual(['08006'])
    expect(remote.connections()).toBe(1)
  })
})
