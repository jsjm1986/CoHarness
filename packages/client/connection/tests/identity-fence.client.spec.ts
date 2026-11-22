// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BrowserIdentityChanged, createBrowserIdentityFence } from '../src/client/identity-fence.ts'
import { ApiTransportError } from '../src/client/api.ts'

const ORIGIN = 'https://gateway.example'
const ADVISORY_RUNTIME = '10000000-0000-4000-8000-000000000001'

it('leaves HTTP/1 capacity for a turn and new conversation while advisory reads wait', async () => {
  const catalog = Promise.withResolvers<Response>()
  const held = new Set(['/api/skill.list', '/api/subagents/list'])
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input =>
    held.has(requestedUrl(input).pathname) ? catalog.promise : new Response('{}'))
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${ADVISORY_RUNTIME}`)
  fence.confirm(7)
  const signal = new AbortController()
  const post = (path: string, init?: RequestInit): Promise<Response> =>
    fence.fetch(`${ORIGIN}${path}?dshRuntime=${ADVISORY_RUNTIME}`, { method: 'POST', ...init })
  const reads = [post('/api/skill.list'), post('/api/subagents/list'), post('/api/session.models', { signal: signal.signal })]
  try {
    const canceled = reads[2]!.catch((reason: unknown) => reason)
    await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2))
    await Promise.all([post('/api/admit/v1/session.prompt'), post('/api/prepare/v1/session.create')])
    expect(fetcher.mock.calls.map(([url, init]) => [requestedUrl(url).pathname, init?.priority])).toEqual([
      ['/api/skill.list', 'low'], ['/api/subagents/list', 'low'],
      ['/api/admit/v1/session.prompt', 'high'], ['/api/prepare/v1/session.create', 'high'],
    ])
    signal.abort('selection changed')
    expect(await canceled).toBe('selection changed')
    const fourth = post('/api/llm.providers')
    expect(fetcher).toHaveBeenCalledTimes(4)
    catalog.resolve(new Response('{}'))
    await Promise.all([reads[0], reads[1], fourth])
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(requestedUrl(fetcher.mock.calls[4]?.[0]).pathname).toBe('/api/llm.providers')
    const fourthHeaders = new Headers(fetcher.mock.calls[4]?.[1]?.headers)
    expect(fourthHeaders.get('x-dsh-expected-principal-id')).toBe('7')
  } finally {
    signal.abort('test finished')
    fence.dispose()
    catalog.resolve(new Response('{}'))
    await Promise.allSettled(reads)
  }
})

it('shares HTTP/1 admission across startup catalogs and directory reads while draft writes and conversation actions proceed', async () => {
  const permissionCatalog = Promise.withResolvers<Response>()
  const historyIndex = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = requestedUrl(input).pathname
    if (path === '/api/permissionPresets/catalog') return permissionCatalog.promise
    if (path === '/api/session.historyIndex') return historyIndex.promise
    return new Response('{}')
  })
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${ADVISORY_RUNTIME}`)
  fence.confirm(7)
  const request = (path: string, method = 'POST', query = ''): Promise<Response> =>
    fence.fetch(`${ORIGIN}${path}?dshRuntime=${ADVISORY_RUNTIME}${query}`, { method })
  const foreground = () => fetcher.mock.calls.map(([input, init]) => [requestedUrl(input).pathname, init?.method, init?.priority])
  const rows = '/account/api/workbench/rows'
  const draft = '/account/api/drafts/20000000-0000-4000-8000-000000000001'
  const reads = [request('/api/permissionPresets/catalog'), request('/api/session.historyIndex'),
    request('/api/settings.describe'), request('/api/session.list'), request(rows, 'GET', '&kind=workspaces&include=conversations')]
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(foreground()).toEqual([
      ['/api/permissionPresets/catalog', 'POST', 'low'], ['/api/session.historyIndex', 'POST', 'low'],
    ])
    await Promise.all([
      request('/api/prepare/v1/session.create'), request(draft, 'GET'), request(draft, 'PUT'),
      request('/api/admit/v1/session.prompt'), request('/api/admit/v1/session.status'),
      request(rows, 'GET', '&kind=conversations&q=query'), request('/api/dynamicCordisRunner/syncInspectManifest'),
    ])
    expect(foreground().slice(2)).toEqual([
      ['/api/prepare/v1/session.create', 'POST', 'high'], [draft, 'GET', undefined], [draft, 'PUT', undefined],
      ['/api/admit/v1/session.prompt', 'POST', 'high'], ['/api/admit/v1/session.status', 'POST', 'high'],
      [rows, 'GET', undefined], ['/api/dynamicCordisRunner/syncInspectManifest', 'POST', undefined],
    ])
    permissionCatalog.resolve(new Response('{}'))
    await Promise.all(reads.filter((_read, index) => index !== 1))
    expect(foreground().slice(-3)).toEqual([
      ['/api/session.list', 'POST', 'low'], [rows, 'GET', 'low'], ['/api/settings.describe', 'POST', 'low'],
    ])
    for (const [input, init] of fetcher.mock.calls) {
      expect(requestedUrl(input).searchParams.get('dshRuntime')).toBe(ADVISORY_RUNTIME)
      expect(new Headers(init?.headers).get('x-dsh-expected-principal-id')).toBe('7')
    }
  } finally {
    fence.dispose()
    permissionCatalog.resolve(new Response('{}'))
    historyIndex.resolve(new Response('{}'))
    await Promise.allSettled(reads)
  }
})

it('reserves capacity when activation, plugin synchronization and draft saving overlap a directory refresh', async () => {
  const synchronization = '/api/dynamicCordisRunner/syncInspectManifest'
  const activation = '/api/session.activate'
  const listing = '/api/session.list'
  const rows = '/account/api/workbench/rows'
  const held = new Map([synchronization, activation, listing].map(path => [path, Promise.withResolvers<Response>()]))
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input =>
    held.get(requestedUrl(input).pathname)?.promise ?? new Response('{}'))
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${ADVISORY_RUNTIME}`)
  const request = (path: string, method = 'POST', query = ''): Promise<Response> =>
    fence.fetch(`${ORIGIN}${path}?dshRuntime=${ADVISORY_RUNTIME}${query}`, { method })
  const pending = [request(synchronization), request(listing), request(activation),
    request(rows, 'GET', '&kind=workspaces&include=conversations')]
  try {
    await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3))
    const issued = () => fetcher.mock.calls.map(([input, init]) => [requestedUrl(input).pathname, init?.priority])
    expect(issued()).toEqual([[synchronization, undefined], [listing, 'low'], [activation, undefined]])
    const draft = '/account/api/drafts/20000000-0000-4000-8000-000000000001'
    await request(draft, 'PUT')
    await request('/api/admit/v1/session.prompt')
    expect(issued().slice(3)).toEqual([[draft, undefined], ['/api/admit/v1/session.prompt', 'high']])
    held.get(synchronization)!.resolve(new Response('{}'))
    await pending[3]
    expect(issued().slice(-1)).toEqual([[rows, 'low']])
  } finally {
    fence.dispose()
    for (const response of held.values()) response.resolve(new Response('{}'))
    await Promise.allSettled(pending)
  }
})

it('keeps simultaneous advisory reads on a multiplexed document', async () => {
  const navigation = { nextHopProtocol: 'h2' } as PerformanceNavigationTiming
  const protocol = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([navigation])
  const pending = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${ADVISORY_RUNTIME}`)
  const reads = ['/api/skill.list', '/api/session.models', '/api/llm.models', '/api/session.list', '/api/settings.describe'].map(path =>
    fence.fetch(`${ORIGIN}${path}?dshRuntime=${ADVISORY_RUNTIME}`, { method: 'POST' }))
  try {
    expect(fetcher.mock.calls.map(([, init]) => init?.priority)).toEqual(['low', 'low', 'low', undefined, undefined])
  } finally {
    pending.resolve(new Response('{}'))
    await Promise.allSettled(reads)
    fence.dispose()
    protocol.mockRestore()
  }
})

it('pins two personal Runtime tabs independently and keeps document locations independent of execution', async () => {
  const first = '10000000-0000-4000-8000-000000000001' as NonNullable<import('../src/client/index.ts').ConnectionRuntimeTarget['runtimeId']>
  const second = '10000000-0000-4000-8000-000000000002' as typeof first
  const node = '20000000-0000-4000-8000-000000000001'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => Response.json({ address: requestedUrl(input).search }, {
    headers: { 'x-dsh-principal-id': '7' },
  }))
  const a = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${first}`)
  const b = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn(), `?dshRuntime=${second}`)
  a.confirm(7); b.confirm(7)
  a.setRuntimeTarget({ kind: 'personal', runtimeId: first }); b.setRuntimeTarget({ kind: 'personal', runtimeId: second })
  try {
    await a.fetch(`${ORIGIN}/api/session.list`)
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('dshRuntime')).toBe(first)
    await b.fetch(`${ORIGIN}/api/session.list`)
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('dshRuntime')).toBe(second)
    await a.fetch(`${ORIGIN}/api/documents/scope/content?scope=personal&dshNode=${node}&id=same.txt`)
    const document = requestedUrl(fetcher.mock.calls.at(-1)?.[0])
    expect(document.searchParams.get('dshNode')).toBe(node)
    expect(document.searchParams.has('dshRuntime')).toBe(false)
    await a.fetch(`${ORIGIN}/api/session.list`)
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('dshRuntime')).toBe(first)
    const socket = await b.socketUrl(new URL('/api/events.mux', ORIGIN), new AbortController().signal)
    expect(socket.searchParams.get('dshRuntime')).toBe(second)
  } finally { a.dispose(); b.dispose() }
})

it('rejects a handshake for another Runtime before exposing account-owned state', () => {
  const runtime = '10000000-0000-4000-8000-000000000001'
  const fence = createBrowserIdentityFence(vi.fn(), ORIGIN, vi.fn(), `?dshRuntime=${runtime}`)
  try {
    expect(() => { fence.setRuntimeTarget({ kind: 'personal', runtimeId: '10000000-0000-4000-8000-000000000002' as NonNullable<import('../src/client/index.ts').ConnectionRuntimeTarget['runtimeId']> }) })
      .toThrow(BrowserIdentityChanged)
  } finally { fence.dispose() }
})

function requestedUrl(input: RequestInfo | URL | undefined): URL {
  if (input === undefined) throw new Error('Expected an emitted request')
  return new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href)
}

describe('browser account identity fence', () => {
  it('identifies a native request failure without treating an unreadable response or external error as a network outage', async () => {
    const cause = new TypeError('Native fetch failed')
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(cause)
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockRejectedValueOnce(cause)
    const reload = vi.fn()
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    fence.setRuntimeTarget(undefined)
    fence.confirm(7)
    try {
      await expect(fence.fetch(`${ORIGIN}/api/workspaceFiles.stat`)).rejects.toMatchObject({
        name: 'ApiTransportError', status: 0, code: 'request-unavailable', cause,
      })
      const response = await fence.fetch(`${ORIGIN}/api/workspaceFiles.read`)
      await expect(response.json()).rejects.toBeInstanceOf(SyntaxError)
      await expect(fence.fetch('https://other.example/api/data')).rejects.toBe(cause)
      expect(reload).not.toHaveBeenCalled()
      expect(new ApiTransportError(403, '/api/workspaceFiles.stat').code).toBe('access-revoked')
      expect(new ApiTransportError(503, '/api/workspaceFiles.stat').code).toBeUndefined()
    } finally { fence.dispose() }
  })

  it('preserves a request abort reason when native fetch rejects during cancellation', async () => {
    const stopped = new AbortController()
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn())
    fence.setRuntimeTarget(undefined)
    try {
      const request = fence.fetch(`${ORIGIN}/api/workspaceFiles.stat`, { signal: stopped.signal })
      const reason = new Error('Preview closed')
      const observed = expect(request).rejects.toBe(reason)
      await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
      stopped.abort(reason)
      pending.reject(new TypeError('Native fetch aborted'))
      await observed
    } finally { fence.dispose(); pending.resolve(new Response('{}')) }
  })

  it('withdraws an explicitly revoked document once even when its principal has not changed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    const reload = vi.fn()
    const wait = Promise.withResolvers<undefined>()
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    const cleanup = vi.fn(() => wait.promise)
    fence.subscribe(cleanup)
    fence.confirm(7)
    fence.setRuntimeTarget({ kind: 'project', projectId: 9 })
    try {
      fence.invalidate()
      fence.invalidate()
      expect(cleanup).toHaveBeenCalledOnce()
      await expect(fence.fetch(`${ORIGIN}/api/session.history`)).rejects.toBeInstanceOf(BrowserIdentityChanged)
      expect(fetcher).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      wait.resolve(undefined)
      await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    } finally { fence.dispose() }
  })

  it('pins known identity on all owned fetch paths and on sockets while preserving external requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'x-dsh-principal-id': '7' } }))
    const reload = vi.fn()
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    fence.setRuntimeTarget(undefined)
    try {
      const socket = fence.socketUrl(new URL('/api/events.mux?dshTarget=project:9', ORIGIN), new AbortController().signal)
      await fence.fetch(`${ORIGIN}/api/host.describe`)
      expect((await socket).searchParams.get('dshPrincipal')).toBe('7')
      await fence.fetch(new Request(`${ORIGIN}/account/api/conversations/same`, { headers: { 'x-original': 'kept' } }), {
        headers: { 'x-new': 'kept', 'x-dsh-expected-principal-id': '8' }, method: 'PATCH', body: '{}',
      })
      const headers = new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers)
      expect(headers.get('x-original')).toBe('kept')
      expect(headers.get('x-new')).toBe('kept')
      expect(headers.get('x-dsh-expected-principal-id')).toBe('7')
      const externalInit = { method: 'GET' }
      await fence.fetch('https://other.example/api/data', externalInit)
      expect(fetcher).toHaveBeenLastCalledWith('https://other.example/api/data', externalInit)
      expect(reload).not.toHaveBeenCalled()
    } finally { fence.dispose() }
  })

  it('aborts old requests and waits for retained Client teardown before reloading on a changed principal', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { headers: { 'x-dsh-principal-id': '7' } }))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(new Response('{"error":"account-changed"}', { status: 409, headers: { 'x-dsh-principal-id': '8' } }))
    const teardown = Promise.withResolvers<undefined>()
    const reload = vi.fn()
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    fence.setRuntimeTarget(undefined)
    const cleanup = vi.fn(() => teardown.promise)
    fence.subscribe(cleanup)
    try {
      await fence.fetch(`${ORIGIN}/api/host.describe`)
      const old = fence.fetch(`${ORIGIN}/api/session.history`)
      await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
      const oldSignal = fetcher.mock.calls[1]?.[1]?.signal
      await expect(fence.fetch(`${ORIGIN}/account/api/context`)).rejects.toBeInstanceOf(BrowserIdentityChanged)
      expect(oldSignal?.aborted).toBe(true)
      expect(cleanup).toHaveBeenCalledOnce()
      expect(reload).not.toHaveBeenCalled()
      pending.resolve(new Response('old owner payload'))
      await expect(old).rejects.toBeInstanceOf(BrowserIdentityChanged)
      await expect(fence.fetch(`${ORIGIN}/api/session.prompt`)).rejects.toBeInstanceOf(BrowserIdentityChanged)
      expect(fetcher).toHaveBeenCalledTimes(3)
      teardown.resolve(undefined)
      await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    } finally { fence.dispose() }
  })

  it('uses confirmed account metadata immediately and keeps ordinary transient failures within the same account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }))
    const reload = vi.fn()
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    fence.setRuntimeTarget(undefined)
    const removed = vi.fn()
    fence.subscribe(removed)()
    fence.confirm(7)
    await fence.fetch(`${ORIGIN}/api`, { signal: new AbortController().signal })
    expect(reload).not.toHaveBeenCalled()
    expect(() => { fence.confirm(8) }).toThrow(BrowserIdentityChanged)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(removed).not.toHaveBeenCalled()
    expect(() => { fence.confirm(7) }).toThrow(BrowserIdentityChanged)
    fence.dispose()
  })

  it.each([{ id: 'invalid', status: 200 }, { id: undefined, status: 401 }])('retracts invalid or revoked authenticated responses', async ({ id, status }) => {
    const reload = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
      status, ...(id === undefined ? {} : { headers: { 'x-dsh-principal-id': id } }),
    }))
    const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
    fence.setRuntimeTarget(undefined)
    fence.confirm(7)
    await expect(fence.fetch(`${ORIGIN}/api/host.describe`)).rejects.toBeInstanceOf(BrowserIdentityChanged)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    fence.dispose()
  })

  it('allows independent hosts without identity headers and cancels sockets waiting for their first response', async () => {
    const fence = createBrowserIdentityFence(vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')), ORIGIN, vi.fn())
    fence.setRuntimeTarget(undefined)
    try {
      const stopped = new AbortController()
      stopped.abort(new Error('closed'))
      await expect(fence.socketUrl(new URL('/api/events.mux', ORIGIN), stopped.signal)).rejects.toThrow('closed')
      await fence.fetch(`${ORIGIN}/api/host.describe`, { signal: null })
      expect((await fence.socketUrl(new URL('/api/events.host', ORIGIN), new AbortController().signal)).searchParams.has('dshPrincipal')).toBe(false)
    } finally { fence.dispose() }
  })
})

it('pins private anchors and iframe sources without changing public links or authorizing another account', () => {
  const fence = createBrowserIdentityFence(vi.fn<typeof fetch>(), ORIGIN, vi.fn())
  fence.setRuntimeTarget(undefined)
  try {
    expect(fence.privateUrl('/api/documents/id/content')).toBe('/api/documents/id/content')
    fence.confirm(7)
    expect(fence.privateUrl('/api/documents/id/content?inline=true')).toBe('/api/documents/id/content?inline=true&dshPrincipal=7')
    expect(fence.privateUrl(`${ORIGIN}/api/session.export?sessionId=same`)).toBe(`${ORIGIN}/api/session.export?sessionId=same&dshPrincipal=7`)
    expect(fence.privateUrl('/public/share/item')).toBe('/public/share/item')
    expect(fence.privateUrl('https://outside.example/api/documents/id')).toBe('https://outside.example/api/documents/id')
  } finally { fence.dispose() }
})

it('reports failed cleanup and still waits for other cleanup before replacing the document', async () => {
  const wait = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => response.promise)
  const reload = vi.fn()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, reload)
  fence.setRuntimeTarget(undefined)
  fence.confirm(7)
  fence.subscribe(() => { throw new Error('fixture disposal failed') })
  fence.subscribe(() => wait.promise)
  const first = fence.fetch(`${ORIGIN}/api`)
  const second = fence.fetch(`${ORIGIN}/api`)
  response.resolve(new Response('{}', { status: 401 }))
  try {
    await expect(first).rejects.toBeInstanceOf(BrowserIdentityChanged)
    await expect(second).rejects.toBeInstanceOf(BrowserIdentityChanged)
    expect(reload).not.toHaveBeenCalled()
    wait.resolve(undefined)
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(error).toHaveBeenCalledWith('Client identity cleanup failed:', expect.any(Error))
  } finally { fence.dispose(); error.mockRestore() }
})

it('waits for decoded runtime identity and pins the old page even when a different scope cookie would route elsewhere', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'x-dsh-principal-id': '7' } }))
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn())
  try {
    await fence.fetch(`${ORIGIN}/api/host.describe`)
    const pending = fence.fetch(`${ORIGIN}/api/session.rename`)
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1)
    fence.setRuntimeTarget({ kind: 'project', projectId: 9 })
    await pending
    let url = requestedUrl(fetcher.mock.calls.at(-1)?.[0])
    expect(url.searchParams.get('dshTarget')).toBe('project:9')
    expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get('x-dsh-expected-principal-id')).toBe('7')
    await fence.fetch(`${ORIGIN}/account/api/context`)
    url = requestedUrl(fetcher.mock.calls.at(-1)?.[0])
    expect(url.searchParams.get('dshTarget')).toBe('project:9')
    await fence.fetch(`${ORIGIN}/account/api/workbench/context`)
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('dshTarget')).toBe('project:9')
    await fence.fetch(`${ORIGIN}/account/api/scope`, { method: 'POST' })
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`${ORIGIN}/account/api/scope`)
    const socket = await fence.socketUrl(new URL('/api/events.mux', ORIGIN), new AbortController().signal)
    expect(socket.searchParams.get('dshTarget')).toBe('project:9')
    expect(socket.searchParams.get('dshPrincipal')).toBe('7')
    expect(fence.privateUrl('/api/documents/id/content')).toContain('dshTarget=project%3A9')
    await fence.fetch(new URL('/api/session.history?dshTarget=personal', ORIGIN))
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('dshTarget')).toBe('personal')
    expect(() => { fence.setRuntimeTarget({ kind: 'project', projectId: 10 }) }).toThrow(BrowserIdentityChanged)
  } finally { fence.dispose() }
})

it('keeps Request bodies and cancellation while fixing a personal runtime independently of the scope cookie', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn())
  try {
    fence.confirm(7)
    fence.setRuntimeTarget({ kind: 'personal' })
    fence.setRuntimeTarget({ kind: 'personal' })
    const abort = new AbortController()
    await fence.fetch(new Request(`${ORIGIN}/api/session.rename`, {
      method: 'POST', body: '{"sessionId":"same","title":"kept"}', signal: abort.signal,
    }))
    const [input, init] = fetcher.mock.calls[0]!
    expect(requestedUrl(input).searchParams.get('dshTarget')).toBe('personal')
    if (typeof input === 'string' || !('text' in input)) throw new Error('Expected a forwarded Request')
    expect(await input.text()).toBe('{"sessionId":"same","title":"kept"}')
    expect(new Headers(init?.headers).get('x-dsh-expected-principal-id')).toBe('7')
    expect(init?.signal?.aborted).toBe(false)
    abort.abort()
    expect(init?.signal?.aborted).toBe(true)
  } finally { fence.dispose() }
})

it('keeps activity pages on the document runtime when another tab changes its scope cookie', async () => {
  let cookieTarget = 'project:9'
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = requestedUrl(input)
    return Response.json({ target: url.searchParams.get('dshTarget') ?? cookieTarget }, {
      headers: { 'x-dsh-principal-id': '7' },
    })
  })
  const fence = createBrowserIdentityFence(fetcher, ORIGIN, vi.fn())
  fence.confirm(7)
  fence.setRuntimeTarget({ kind: 'project', projectId: 9 })
  try {
    expect(await (await fence.fetch(`${ORIGIN}/account/api/activity?limit=50`)).json()).toEqual({ target: 'project:9' })
    cookieTarget = 'project:10'
    const response = await fence.fetch(`${ORIGIN}/account/api/activity?limit=50&before=cursor`)
    expect(await response.json()).toEqual({ target: 'project:9' })
    expect(requestedUrl(fetcher.mock.calls.at(-1)?.[0]).searchParams.get('before')).toBe('cursor')
  } finally { fence.dispose() }
})
