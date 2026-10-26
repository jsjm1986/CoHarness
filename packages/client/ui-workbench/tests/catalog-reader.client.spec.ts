import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkbenchCatalogReader } from '../src/client/catalog-reader.ts'

function response(name = 'Synthetic account'): Response {
  return new Response(JSON.stringify({ personalComplete: true, personal: { id: 1, name },
    activeRuntime: { kind: 'personal' }, projects: [], items: [] }))
}

const cleanups: (() => Promise<void>)[] = []

function harness(restoring = false) {
  const demand = createSnapshotStore(restoring)
  const reader = new WorkbenchCatalogReader(() => demand.getSnapshot())
  const unsubscribe = demand.subscribe(() => { reader.releaseUnobserved() })
  const requests: { signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>> }[] = []
  const owners = new Set([reader])
  const settleBeforeDisposal: (() => void)[] = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    const signal = init?.signal
    if (signal === undefined || signal === null) throw new Error('Catalog request must be cancellable')
    const pending = Promise.withResolvers<Response>()
    requests.push({ signal, response: pending })
    return pending.promise
  })
  vi.stubGlobal('fetch', fetcher)
  cleanups.push(async () => {
    unsubscribe()
    for (const settle of settleBeforeDisposal) settle()
    for (const request of requests) request.response.resolve(response())
    await Promise.all([...owners].map(owner => owner.dispose()))
  })
  return { reader, demand, fetcher, requests, owners, settleBeforeDisposal }
}

afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup() }
  finally { vi.unstubAllGlobals() }
})

describe('plugin-owned workbench catalog reads', () => {
  it('cancels a caller aborted during transport dispatch', async () => {
    const h = harness()
    const abort = new AbortController()
    h.fetcher.mockImplementationOnce(async () => {
      abort.abort()
      return response()
    })
    await expect(h.reader.read(abort.signal, false)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('joins a request when its transport starts plugin disposal synchronously', async () => {
    const h = harness(true)
    const pending = Promise.withResolvers<Response>()
    h.settleBeforeDisposal.push(() => { pending.resolve(response()) })
    const lifecycle: { disposal?: Promise<void> } = {}
    h.fetcher.mockImplementationOnce(() => {
      lifecycle.disposal = h.reader.dispose()
      return pending.promise
    })
    const read = h.reader.read(new AbortController().signal, false)
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    const disposal = lifecycle.disposal
    if (disposal === undefined) throw new Error('Transport did not dispatch')
    let disposed = false
    const done = disposal.then(() => { disposed = true })
    expect(disposed).toBe(false)
    pending.resolve(response())
    await done
    expect(disposed).toBe(true)
  })

  it('shares a pending read without making another caller own its cancellation', async () => {
    const h = harness()
    const a = new AbortController()
    const b = new AbortController()
    const first = h.reader.read(a.signal, false)
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = h.reader.read(b.signal, false)
    a.abort()
    await canceled
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.signal.aborted).toBe(false)
    h.requests[0]!.response.resolve(response())
    await expect(second).resolves.toMatchObject({ personal: { name: 'Synthetic account' } })
  })

  it('keeps a requested restoration alive between toolbar mounts', async () => {
    const h = harness(true)
    const a = new AbortController()
    const first = h.reader.read(a.signal, false)
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    a.abort()
    await canceled
    expect(h.requests[0]!.signal.aborted).toBe(false)
    const second = h.reader.read(new AbortController().signal, false)
    expect(h.requests).toHaveLength(1)
    h.requests[0]!.response.resolve(response())
    await expect(second).resolves.toMatchObject({ personalComplete: true })
  })

  it('cancels an unobserved chooser read and reads fresh choices on reopening', async () => {
    const h = harness()
    const a = new AbortController()
    const first = h.reader.read(a.signal, false)
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    a.abort()
    await canceled
    expect(h.requests[0]!.signal.aborted).toBe(true)
    const second = h.reader.read(new AbortController().signal, false)
    expect(h.requests).toHaveLength(2)
    h.requests[0]!.response.resolve(response('Canceled choice'))
    h.requests[1]!.response.resolve(response('Fresh choice'))
    await expect(second).resolves.toMatchObject({ personal: { name: 'Fresh choice' } })
  })

  it('releases an unobserved restoration as soon as its viewport withdraws demand', async () => {
    const h = harness(true)
    const a = new AbortController()
    const first = h.reader.read(a.signal, false)
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    a.abort()
    await canceled
    expect(h.requests[0]!.signal.aborted).toBe(false)
    h.demand.set(false)
    expect(h.requests[0]!.signal.aborted).toBe(true)
  })

  it('isolates a canceled transport failure from a fresh caller', async () => {
    const h = harness()
    const abort = new AbortController()
    const first = h.reader.read(abort.signal, false)
    const canceled = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await canceled
    const second = h.reader.read(new AbortController().signal, false)
    h.requests[0]!.response.reject(new Error('Canceled transport settled'))
    h.requests[1]!.response.resolve(response('Fresh response'))
    await expect(second).resolves.toMatchObject({ personal: { name: 'Fresh response' } })
  })

  it('does not cancel an active caller when restoration demand clears', async () => {
    const h = harness(true)
    const read = h.reader.read(new AbortController().signal, false)
    h.demand.set(false)
    expect(h.requests[0]!.signal.aborted).toBe(false)
    h.requests[0]!.response.resolve(response())
    await expect(read).resolves.toMatchObject({ personalComplete: true })
  })

  it('starts a fresh retry and lets subsequent readers share that request', async () => {
    const h = harness(true)
    const a = new AbortController()
    const old = h.reader.read(a.signal, false)
    const canceled = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    a.abort()
    await canceled
    const retry = h.reader.read(new AbortController().signal, true)
    const joined = h.reader.read(new AbortController().signal, false)
    expect(h.requests).toHaveLength(2)
    expect(h.requests[0]!.signal.aborted).toBe(true)
    expect(h.requests[1]!.signal.aborted).toBe(false)
    h.requests[0]!.response.resolve(response('Old response'))
    h.requests[1]!.response.resolve(response('Retry response'))
    const result = await retry
    expect(result.personal.name).toBe('Retry response')
    expect(await joined).toBe(result)
  })

  it('never reuses a completed response or a failed read', async () => {
    const h = harness()
    const first = h.reader.read(new AbortController().signal, false)
    h.requests[0]!.response.resolve(response('First response'))
    await expect(first).resolves.toMatchObject({ personal: { name: 'First response' } })
    const failed = h.reader.read(new AbortController().signal, false)
    const failure = expect(failed).rejects.toThrow('workbench catalog unavailable (503)')
    h.requests[1]!.response.resolve(new Response('unavailable', { status: 503 }))
    await failure
    const fresh = h.reader.read(new AbortController().signal, false)
    expect(h.requests).toHaveLength(3)
    h.requests[2]!.response.resolve(response('Fresh response'))
    await expect(fresh).resolves.toMatchObject({ personal: { name: 'Fresh response' } })
  })

  it('reports an untyped transport rejection as an Error with its cause', async () => {
    const h = harness()
    const read = h.reader.read(new AbortController().signal, false)
    const failure = expect(read).rejects.toMatchObject({ message: 'Workbench catalog read failed', cause: 'transport failure' })
    h.requests[0]!.response.reject('transport failure')
    await failure
  })

  it('does not share reads between plugin owners', async () => {
    const h = harness(true)
    const other = new WorkbenchCatalogReader(() => true)
    h.owners.add(other)
    const first = h.reader.read(new AbortController().signal, false)
    const second = other.read(new AbortController().signal, false)
    expect(h.requests).toHaveLength(2)
    h.requests[0]!.response.resolve(response('First owner'))
    h.requests[1]!.response.resolve(response('Second owner'))
    await expect(first).resolves.toMatchObject({ personal: { name: 'First owner' } })
    await expect(second).resolves.toMatchObject({ personal: { name: 'Second owner' } })
  })

  it('joins canceled body reads during disposal and rejects new callers', async () => {
    const h = harness(true)
    const bodyRead = Promise.withResolvers<undefined>()
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let closed = false
    const finish = (): void => {
      if (closed || body === undefined) return
      closed = true
      body.enqueue(new TextEncoder().encode(JSON.stringify({ personalComplete: true, personal: { id: 1, name: 'Synthetic account' },
        activeRuntime: { kind: 'personal' }, projects: [], items: [] })))
      body.close()
    }
    h.settleBeforeDisposal.push(finish)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { body = controller }, pull() { bodyRead.resolve(undefined) },
    })
    const caller = h.reader.read(new AbortController().signal, false)
    const canceled = expect(caller).rejects.toMatchObject({ name: 'AbortError' })
    h.requests[0]!.response.resolve(new Response(stream))
    await bodyRead.promise
    let disposed = false
    const disposal = h.reader.dispose().then(() => { disposed = true })
    await canceled
    expect(h.requests[0]!.signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    await expect(h.reader.read(new AbortController().signal, false)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.requests).toHaveLength(1)
    finish()
    await disposal
    expect(disposed).toBe(true)
  })
})
