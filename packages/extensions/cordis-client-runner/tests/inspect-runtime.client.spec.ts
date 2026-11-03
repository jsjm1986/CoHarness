/** Runtime-owned inspect requests and independent manifest delivery. */
import { expect, it, vi } from 'vitest'
import type { CordisInspectQueryRequest, JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import { ClientCordisInspectRegistry } from '../src/client/inspect-registry.ts'
import type { ClientCordisInspectHost, ClientCordisInspectProviderRegistration } from '../src/client/inspect-registry.ts'

const manifest: ClientCordisInspectProviderRegistration['manifest'] = {
  id: 'Fixture', description: 'Inspect the selected Runtime',
  methods: [{ name: 'read', description: 'Read metadata', inputSchema: {}, outputSchema: {} }],
}
const request = (agentId: string): CordisInspectQueryRequest => ({
  agentId, requestId: 'same-query', provider: manifest.id, method: 'read',
}) as CordisInspectQueryRequest
const host = () => ({ sync: vi.fn<ClientCordisInspectHost['sync']>(async () => {}),
  resolve: vi.fn<ClientCordisInspectHost['resolve']>(async () => {}) })

it('cancels a colliding query only on its Runtime and answers the other Host', async () => {
  const a = host(), b = host(), registry = new ClientCordisInspectRegistry(a)
  const remove = registry.addHost(b)
  const first = Promise.withResolvers<JsonValue>(), second = Promise.withResolvers<JsonValue>()
  const signals = new Map<string, AbortSignal>()
  registry.register({ manifest, query: (_method, _input, context) => {
    signals.set(context.sessionId, context.signal)
    return context.sessionId === 'a' ? first.promise : second.promise
  } })
  try {
    const pendingA = registry.query(request('a'))
    const pendingB = registry.query(request('b'), b)
    registry.close(request('b').requestId, b)
    expect(signals.get('a')?.aborted).toBe(false)
    expect(signals.get('b')?.aborted).toBe(true)
    first.resolve('a-result'); second.resolve('discarded-b-result')
    await Promise.all([pendingA, pendingB])
    expect(a.resolve).toHaveBeenCalledExactlyOnceWith('a', 'same-query', { ok: true, data: 'a-result' })
    expect(b.resolve).not.toHaveBeenCalled()
  } finally { remove(); registry.dispose() }
})

it('does not make a healthy Host wait for another Runtime manifest publication', async () => {
  const a = host(), b = host(), pending = Promise.withResolvers<undefined>()
  b.sync.mockReturnValue(pending.promise)
  const registry = new ClientCordisInspectRegistry(a)
  registry.addHost(b)
  try {
    registry.register({ manifest, query: async () => null })
    await vi.waitFor(() => { expect(b.sync).toHaveBeenCalledOnce() })
    registry.register({ manifest: { ...manifest, id: 'Second' }, query: async () => null })
    await vi.waitFor(() => { expect(a.sync).toHaveBeenCalledTimes(2) })
    expect(a.sync.mock.calls[1]![0].map(row => row.id)).toEqual(['Fixture', 'Second'])
    expect(b.sync).toHaveBeenCalledOnce()
    pending.resolve(undefined)
    await vi.waitFor(() => { expect(b.sync).toHaveBeenCalledTimes(2) })
  } finally { pending.resolve(undefined); registry.dispose() }
})

it('publishes a reconnect only to its Runtime', async () => {
  const a = host(), b = host(), registry = new ClientCordisInspectRegistry(a)
  registry.addHost(b)
  try {
    registry.register({ manifest, query: async () => null })
    await vi.waitFor(() => { expect(a.sync).toHaveBeenCalledOnce(); expect(b.sync).toHaveBeenCalledOnce() })
    registry.publish(b)
    await vi.waitFor(() => { expect(b.sync).toHaveBeenCalledTimes(2) })
    expect(a.sync).toHaveBeenCalledOnce()
  } finally { registry.dispose() }
})

it('retires queued publications and pending queries when the registry is disposed', async () => {
  const a = host(), b = host(), registry = new ClientCordisInspectRegistry(a)
  const remove = registry.addHost(b), pending = Promise.withResolvers<JsonValue>()
  const signals: AbortSignal[] = []
  registry.register({ manifest, query: async (_method, _input, context) => {
    signals.push(context.signal)
    return pending.promise
  } })
  const query = registry.query(request('a'))
  registry.dispose()
  expect(signals[0]?.aborted).toBe(true)
  pending.resolve('late-result')
  await query
  await registry.query(request('b'), b)
  expect(a.sync).not.toHaveBeenCalled()
  expect(a.resolve).not.toHaveBeenCalled()
  expect(b.resolve).not.toHaveBeenCalled()
  expect(() => registry.register({ manifest, query: async () => null })).toThrow('disposed')
  expect(() => registry.addHost(b)).toThrow('disposed')
  remove(); registry.dispose()
})
