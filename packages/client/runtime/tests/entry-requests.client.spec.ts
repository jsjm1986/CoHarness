/** Exact target read sharing and account-scoped cancellation in a single browser document. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { GatewayEntryRequests } from '../src/client/entry-requests.ts'
import { PreparedSessionApi } from '../src/client/prepare-runtime.ts'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'
const target = { kind: 'personal', runtimeId: '00000000-0000-4000-8000-000000000001' } as SessionRuntimeTarget
const raw = { sessionId: 'same-session', maxMessages: 50, detail: 'conversation' } as const
const connection = { entryRequestLimit: 2, metadataTiming: { requestTimeoutMs: 3000, retryAfterMs: 1000 }, interactions: 'none' } as ConnectionHandle
afterEach(() => { vi.unstubAllGlobals() })

describe('entry request owners', () => {
  it('correlates only versioned creates, opens, sends and status using opaque UUIDs', async () => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const ids: string[] = []
    const stable = 'd621f467-8677-4165-9062-14cb446b36c9'
    const privateValue = 'synthetic untrusted/ID material'
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { rpcId: string; method: string; payload: Record<string, unknown> }
      expect(init.priority).toBe('high')
      const id = new Headers(init.headers).get('x-dsh-operation-id')
      expect(id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu)
      ids.push(id!)
      if (body.method === 'session.history' || Object.values(body.payload).includes(privateValue)) expect(id).toBe(body.rpcId)
      return new Response(null, { status: 403 })
    }))
    const carrier = new PreparedSessionApi(connection, target, 7)
    const sessions = carrier.sessions
    const sessionId = 'synthetic-owner-session' as Parameters<typeof sessions.history>[0]['sessionId']
    const create = { sessionId, draftId: `draft-${stable}` } as Parameters<typeof sessions.create>[0]
    const prompt = { sessionId, requestId: RpcId(stable), mode: 'queue', content: [] } satisfies Parameters<typeof sessions.prompt>[0]
    await expect(sessions.create(create)).rejects.toThrow()
    await expect(sessions.prompt(prompt)).rejects.toThrow()
    await expect(carrier.status({ sessionId, requestId: prompt.requestId })).rejects.toThrow()
    await expect(sessions.history({ sessionId })).rejects.toThrow()
    await expect(sessions.prompt({ ...prompt, requestId: RpcId(privateValue) })).rejects.toThrow()
    expect(ids.slice(0, 3)).toEqual([stable, stable, stable])
    expect(new Set(ids.slice(3)).size).toBe(2)
    expect(ids).not.toContain(privateValue)
    const native = new class extends AbstractApiClient {
      protected async doFetch(_url: URL, init?: RequestInit): Promise<Response> {
        expect(new Headers(init?.headers).has('x-dsh-operation-id')).toBe(false)
        return new Response(null, { status: 403 })
      }
    }()
    await expect(native.sessions.history({ sessionId })).rejects.toThrow()
  })
  it('reads one owner page for the verified account and rejects absent, excess, or differently bound projects', async () => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const node = '20000000-0000-4000-8000-000000000001'
    const ref = { projectId: 9, runtimeId: target.runtimeId! }
    const item = { ...ref, nodeId: node, name: 'Authorized on Ubuntu', rootPath: '/srv/project' }
    const request = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(Response.json({ items: [item] })))
    vi.stubGlobal('fetch', request)
    const owner = new GatewayEntryRequests(connection, () => 7, () => true)
    await expect(owner.projectMetadata(node, Array.from({ length: 33 }, (_, i) => ({ projectId: i + 1 })))).rejects.toThrow()
    await expect(owner.projectMetadata('not-a-computer', [ref])).rejects.toThrow()
    await expect(owner.projectMetadata(node, [ref, ref])).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    await expect(owner.projectMetadata(node, [ref])).resolves.toEqual([item])
    expect(String(request.mock.calls[0]![0])).toContain(`/account/api/project-metadata?dshNode=${node}&ids=9`)
    expect(new Headers(request.mock.calls[0]![1].headers).get('x-dsh-expected-principal-id')).toBe('7')
    for (const items of [[], [item, item], [{ ...item, projectId: 10 }], [{ ...item, nodeId: target.runtimeId }],
      [{ ...item, runtimeId: node }], [{ ...item, rootPath: '' }]]) {
      request.mockResolvedValueOnce(Response.json({ items }))
      await expect(owner.projectMetadata(node, [ref])).rejects.toThrow()
    }
    await owner.dispose()
  })

  it('coalesces matching readers, refuses a wrong Runtime receipt, and lets another reader cancel independently', async () => {
    vi.stubGlobal('location', new URL('https://harness.invalid/'))
    const held = Promise.withResolvers<Response>()
    const request = vi.fn((_url: URL, _init: RequestInit) => held.promise)
    vi.stubGlobal('fetch', request)
    const owner = new GatewayEntryRequests(connection, () => 7, () => true)
    const first = new AbortController(), second = new AbortController()
    const one = owner.history(target, raw as Parameters<typeof owner.history>[1], first.signal)
    const two = owner.history(target, raw as Parameters<typeof owner.history>[1], second.signal)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url.pathname).toBe('/api/prepare/v1/session.history')
    expect(url.searchParams.get('dshRuntime')).toBe(target.runtimeId)
    expect(new Headers(init.headers).get('x-dsh-expected-principal-id')).toBe('7')
    first.abort()
    await expect(one).rejects.toThrow()
    expect(init.signal?.aborted).toBe(false)
    held.resolve(Response.json({}, { headers: { 'x-dsh-runtime-id': 'wrong' } }))
    await expect(two).rejects.toThrow('another Runtime')
    expect(request).toHaveBeenCalledTimes(1)
    await owner.dispose()
  })
})

it('loads separate personal pages concurrently after a legacy computer omits the optional conversation page', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  const runtimeId = target.runtimeId!
  const catalog = { items: [{ id: runtimeId, owner: { kind: 'personal', id: 7, name: 'Me' },
    node: { id: '20000000-0000-4000-8000-000000000001', name: 'Computer', status: 'active' }, observedState: 'stopped' }], nextCursor: null }
  const served: string[] = []
  const gate = Promise.withResolvers<void>()
  let hold = false
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, 'https://harness.invalid')
    if (url.pathname === '/account/api/runtimes') return Response.json(catalog)
    if (url.pathname === '/account/api/context') return Response.json({ user: { id: 7, displayName: 'Me' }, projects: [], environment: { id: runtimeId } })
    served.push(url.searchParams.get('include') ?? url.searchParams.get('kind')!)
    if (hold) await gate.promise
    return Response.json({ runtimeId, items: [], workspaces: [], nextCursor: null })
  }))
  const owner = new GatewayEntryRequests({ ...connection, hostDescription: { getSnapshot: () => ({ runtimeTarget: target }) } } as ConnectionHandle, () => 7, () => true)
  try {
    await owner.catalog()
    await owner.personalRows(target)
    expect(served).toEqual(['conversations', 'conversations'])
    owner.refreshDirectory()
    await owner.catalog()
    served.length = 0; hold = true
    const flight = owner.personalRows(target)
    await vi.waitFor(() => { expect(served).toEqual(['workspaces', 'conversations']) })
    gate.resolve(); await flight
  } finally { gate.resolve(); await owner.dispose() }
})
