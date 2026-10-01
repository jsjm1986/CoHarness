// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BrowserIdentityChanged, createBrowserIdentityFence } from '../src/client/identity-fence.ts'

const ORIGIN = 'https://gateway.example'

function requestedUrl(input: RequestInfo | URL | undefined): URL {
  if (input === undefined) throw new Error('Expected an emitted request')
  return new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href)
}

describe('browser account identity fence', () => {
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
