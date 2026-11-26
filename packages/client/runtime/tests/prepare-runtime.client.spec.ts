/** Explicit Runtime entry prepares its captured allocation while directory discovery stays passive. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle, HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'
import { PreparedSessionApi, prepareGatewayRuntime } from '../src/client/prepare-runtime.ts'
import { GatewayEntryRequests } from '../src/client/entry-requests.ts'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import { FakeApiClient } from './fake-api.client.ts'

const first = '11111111-1111-4111-8111-111111111111' as NonNullable<SessionRuntimeTarget['runtimeId']>
const second = '22222222-2222-4222-8222-222222222222' as NonNullable<SessionRuntimeTarget['runtimeId']>
const target: SessionRuntimeTarget = { kind: 'personal', runtimeId: second }
function description(id = first): HostDescription {
  return { version: 'test', cwd: '/work', home: '/home/test', attachedSessions: 0, canOpenPath: false,
    executionAuthorityRequired: true, runtimeTarget: { kind: 'personal', runtimeId: id } }
}
function connection(host: HostDescription | undefined): ConnectionHandle {
  return { metadataTiming: { requestTimeoutMs: 1000, retryAfterMs: 1000 }, api: new FakeApiClient(), isLoopback: false,
    interactions: 'none', hostDescription: createSnapshotStore(host), state: createSnapshotStore(undefined),
    rpc: { call: () => Promise.reject(new Error('Unexpected generic RPC')) }, reconnect: () => {}, start: () => ({ stop: () => {} }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('explicit managed Runtime preparation', () => {
  const receiptId = '55555555-5555-4555-8555-555555555555'
  const createInput = { sessionId: 'cold-conversation', draftId: 'draft-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as Parameters<PreparedSessionApi['sessions']['create']>[0]
  function pendingResponse(waitMs = 10_000, runtimeId = second, id = receiptId): Response {
    return Response.json({ error: { code: 'INSTANCE_STARTING', message: 'Starting' }, preparation: { id, waitMs } },
      { status: 503, headers: { 'x-dsh-runtime-id': runtimeId, 'retry-after': '2' } })
  }
  function created(init: RequestInit): Response {
    const request = JSON.parse(init.body as string) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { sessionId: createInput.sessionId } } },
      { headers: { 'x-dsh-runtime-id': second } })
  }

  it('waits beyond the single-request deadline only for the same accepted start and preserves its operation identity', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const requests: RequestInit[] = [], urls: URL[] = []
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      requests.push(init)
      urls.push(_url)
      return requests.length < 3 ? pendingResponse() : created(init)
    })
    vi.stubGlobal('fetch', fetcher)
    const nodeId = '33333333-3333-4333-8333-333333333333' as NonNullable<SessionRuntimeTarget['nodeId']>
    const api = new PreparedSessionApi(connection(description()), { ...target, nodeId }, 7)
    const result = api.sessions.create(createInput)
    await vi.advanceTimersByTimeAsync(4000)
    expect((await result).result.ok).toBe(true)
    expect(requests).toHaveLength(3)
    expect(requests.map(init => new Headers(init.headers).get('x-dsh-prepare-continuation'))).toEqual([null, receiptId, receiptId])
    expect(new Set(requests.map(init => init.body)).size).toBe(1)
    expect(requests.map(init => new Headers(init.headers).get('x-dsh-operation-id'))).toEqual(Array(3).fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
    for (const [i, url] of urls.entries()) {
      expect(url.searchParams.get('dshRuntime')).toBe(second)
      expect(url.searchParams.get('dshNode')).toBe(nodeId)
      expect(url.searchParams.get('dshTarget')).toBe('personal')
      expect(new Headers(requests[i]!.headers).get('x-dsh-expected-principal-id')).toBe('7')
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a warm preparation to one request and never sends a continuation for prompts', async () => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => created(init))
    vi.stubGlobal('fetch', fetcher)
    const api = new PreparedSessionApi(connection(description()), target, 7)
    expect((await api.sessions.create(createInput)).result.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(new Headers(fetcher.mock.calls[0]![1].headers).has('x-dsh-prepare-continuation')).toBe(false)
    fetcher.mockImplementation(async () => pendingResponse())
    await expect(api.sessions.prompt({ sessionId: createInput.sessionId!, requestId: RpcId(receiptId), mode: 'queue', content: [] })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('uses bounded receipt backoff and wakes only for a new description of the original computer', async () => {
    vi.useFakeTimers()
    const nodeId = '33333333-3333-4333-8333-333333333333' as NonNullable<SessionRuntimeTarget['nodeId']>
    const otherNode = '44444444-4444-4444-8444-444444444444' as typeof nodeId
    const host = createSnapshotStore<HostDescription | undefined>(undefined)
    const backoff = vi.fn((failure: number) => 500 * failure)
    const base = connection(description())
    const exact = { ...base, metadataTiming: { ...base.metadataTiming, recoveryDelayMs: backoff }, hostDescription: host }
    const api = new PreparedSessionApi({ ...base, forTarget: () => exact }, { ...target, nodeId }, 7)
    const attempt = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce(undefined)
    const result = api.recoverPrompt(new AbortController().signal, attempt)
    await vi.advanceTimersByTimeAsync(499)
    expect(attempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(backoff.mock.calls).toEqual([[1], [2]])
    const ready = description(second)
    host.set({ ...ready, runtimeTarget: { ...target, nodeId: otherNode } })
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt).toHaveBeenCalledTimes(2)
    attempt.mockResolvedValueOnce('accepted')
    host.set({ ...ready, runtimeTarget: { ...target, nodeId } })
    await expect(result).resolves.toBe('accepted')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['permission', 'transport', 'runtime', 'receipt', 'oversized'] as const)('does not replay after %s failure', async (kind) => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const fetcher = vi.fn(async () => {
      if (kind === 'transport') throw new Error('Connection lost before a response')
      if (kind === 'permission') return Response.json({ error: 'access-revoked' }, { status: 503 })
      if (kind === 'runtime') return pendingResponse(10_000, first)
      if (kind === 'oversized') return Response.json({ padding: 'x'.repeat(4096) }, { status: 503 })
      return pendingResponse(10_000, second, 'not-an-id')
    })
    vi.stubGlobal('fetch', fetcher)
    const api = new PreparedSessionApi(connection(description()), target, 7)
    await expect(api.sessions.create(createInput)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending wait without another request and clears all owned timers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const fetcher = vi.fn(async () => pendingResponse()); vi.stubGlobal('fetch', fetcher)
    const cancel = new AbortController(), reason = new Error('Tab switched')
    const api = new PreparedSessionApi(connection(description()), target, 7)
    const result = api.sessions.create(createInput, cancel.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    cancel.abort(reason)
    expect(await result).toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([401, 403, 409, 503])('stops at HTTP %s after a known pending response without retrying refusal', async (status) => {
    vi.useFakeTimers()
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? pendingResponse() : Response.json({ error: 'unavailable' }, { status }))
    vi.stubGlobal('fetch', fetcher)
    const api = new PreparedSessionApi(connection(description()), target, 7)
    const result = api.sessions.create(createInput).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toMatchObject({ status })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not extend the first accepted wait budget or substitute another receipt', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const fetcher = vi.fn(async () => pendingResponse(fetcher.mock.calls.length === 1 ? 3000 : 10000)); vi.stubGlobal('fetch', fetcher)
    const api = new PreparedSessionApi(connection(description()), target, 7)
    const result = api.sessions.create(createInput).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toMatchObject({ message: 'Runtime preparation timed out' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    fetcher.mockClear().mockImplementation(async () => pendingResponse(10000, second, fetcher.mock.calls.length === 1 ? receiptId : '66666666-6666-4666-8666-666666666666'))
    const changed = api.sessions.create(createInput).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await changed).toMatchObject({ message: 'Runtime preparation changed its accepted start' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps in-flight preparation, history and creation separate across different physical placements of one allocation', async () => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const before = '33333333-3333-4333-8333-333333333333' as NonNullable<SessionRuntimeTarget['nodeId']>
    const after = '44444444-4444-4444-8444-444444444444' as NonNullable<SessionRuntimeTarget['nodeId']>
    const requests = new GatewayEntryRequests({ ...connection(description()), entryRequestLimit: 2 }, () => 7, () => true)
    const sessionId = 'one-session' as Parameters<typeof requests.history>[1]['sessionId']
    const draft = { sessionId, draftId: 'draft-one' } as Parameters<typeof requests.create>[1]
    const signal = new AbortController().signal
    try {
      for (const op of [
        (destination: SessionRuntimeTarget) => requests.prepare(destination, signal),
        (destination: SessionRuntimeTarget) => requests.history(destination, { sessionId }, signal),
        (destination: SessionRuntimeTarget) => requests.create(destination, draft, signal),
      ]) {
        const observed: Array<string | null> = []
        const release = Promise.withResolvers<undefined>()
        vi.stubGlobal('fetch', async (incoming: URL | string) => {
          observed.push(new URL(incoming, location.href).searchParams.get('dshNode'))
          await release.promise
          return new Response(null, { status: 403 })
        })
        const settled = Promise.allSettled([op({ ...target, nodeId: before }), op({ ...target, nodeId: after })])
        release.resolve(undefined)
        expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
        expect(observed).toEqual([before, after])
      }
    } finally { await requests.dispose() }
  })

  it.each([true, false])('sends the captured physical computer on every versioned operation when supplied (%s)', async (pinned) => {
    const node = '33333333-3333-4333-8333-333333333333' as NonNullable<SessionRuntimeTarget['nodeId']>
    const urls: URL[] = []
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    vi.stubGlobal('fetch', async (url: URL) => { urls.push(url); return new Response(null, { status: 403 }) })
    const api = new PreparedSessionApi(connection(description()), pinned ? { ...target, nodeId: node } : target, 7)
    const sessionId = 'one-conversation' as Parameters<typeof api.sessions.history>[0]['sessionId']
    const requestId = RpcId('c2d23812-bcc3-4900-8dc5-8416b533784a')
    await expect(api.sessions.create({ sessionId })).rejects.toThrow()
    await expect(api.sessions.history({ sessionId })).rejects.toThrow()
    await expect(api.sessions.prompt({ sessionId, requestId, mode: 'queue', content: [] })).rejects.toThrow()
    await expect(api.status({ sessionId, requestId })).rejects.toThrow()
    expect(urls.map(url => url.pathname)).toEqual(['/api/prepare/v1/session.create', '/api/prepare/v1/session.history',
      '/api/admit/v1/session.prompt', '/api/admit/v1/session.status'])
    for (const url of urls) {
      expect(url.searchParams.getAll('dshNode')).toEqual(pinned ? [node] : [])
      expect(url.searchParams.getAll('dshRuntime')).toEqual([second])
      expect(url.searchParams.getAll('dshTarget')).toEqual(['personal'])
    }
  })

  it.each(['personal', 'project'] as const)('prepares the exact %s allocation without following its destination', async (kind) => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204, headers: { location: `/?dshRuntime=${second}` } }))
    vi.stubGlobal('fetch', fetcher)
    const selected: SessionRuntimeTarget = kind === 'personal' ? target : { kind, projectId: 7, runtimeId: second }
    await prepareGatewayRuntime(connection(description()), selected)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(`/account/api/scope?dshRuntime=${second}`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'manual' })
    expect(init.body).toBe(JSON.stringify(kind === 'personal' ? { kind } : { kind, projectId: 7 }))
  })

  it('keeps standalone and already active target transports free of startup requests', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await prepareGatewayRuntime(undefined, target)
    await prepareGatewayRuntime(connection({ ...description(), executionAuthorityRequired: false }), target)
    await prepareGatewayRuntime(connection(description()), { kind: 'project', projectId: 7 })
    const active = connection(description(second))
    const root: ConnectionHandle = { ...connection(description()), forTarget: () => active }
    await prepareGatewayRuntime(root, target)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([403, 409, 503])('retains the original target after HTTP %s without replaying preparation', async (status) => {
    const fetcher = vi.fn(async () => new Response('refused', { status })); vi.stubGlobal('fetch', fetcher)
    await expect(prepareGatewayRuntime(connection(description()), target)).rejects.toThrow(`HTTP ${status}`)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a response naming another Runtime', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204, headers: { location: `/?dshRuntime=${first}` } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(prepareGatewayRuntime(connection(description()), target)).rejects.toThrow('another destination')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('releases its deadline after a cancelled operation', async () => {
    vi.useFakeTimers()
    const cancelled = new AbortController(), reason = new Error('selection changed')
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { reject(reason) }, { once: true })
    })))
    const pending = prepareGatewayRuntime(connection(description()), target, cancelled.signal).catch((error: unknown) => error)
    cancelled.abort(reason)
    expect(await pending).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })
})
