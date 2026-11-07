/** Interactive desktop methods through real fetch parsing and response validation. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createDesktopApi } from '../src/desktop.ts'
import { RpcId } from '../src/api/rpc.ts'
import type { ApiProxy, RpcError } from '../src/api/index.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'
import { InProcessApiClient } from '../src/fetch/client.ts'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'

async function fixture() {
  const ctx = new Context(), id = SessionId('pane'), agent = { id } as Agent
  const value = {
    rootSessionId: SessionId('root'), nodeId: 'node', desktop: 'screen', userId: 3, eligible: true, confirmed: false,
    occupancy: { available: true, inUse: false, heldByThisSession: false, queued: 0 },
  }
  const read = vi.fn(async () => value), set = vi.fn(async () => ({ ...value, confirmed: true }))
  const forbidden: RpcError = { code: 'collaboration-forbidden', message: 'denied', details: { action: 'write', reason: 'forbidden', sessionId: id } }
  const authorize = vi.fn(async (): Promise<{ authority: undefined } | { error: RpcError }> => ({ authority: undefined }))
  const resolve = vi.fn(async (): Promise<{ agent: Agent } | { error: RpcError }> => ({ agent }))
  const agentsGet = vi.fn((want: SessionId) => want === id ? agent : undefined)
  ctx.provide('agents', { get: agentsGet } as never)
  ctx.provide('computerUseAuthorization', { run: async (_execution, operation) => operation(new AbortController().signal), confirmation: { read, set } })
  let api!: ReturnType<typeof createDesktopApi>
  const fiber = ctx.plugin((inner: Context) => { api = createDesktopApi(inner, { authorize, agent: resolve, signal: signal => signal }) })
  await fiber
  onTestFinished(async () => { await fiber.dispose() })
  const handler = toFetchHandler({ desktop: api } as ApiProxy), client = new InProcessApiClient(handler)
  return { ctx, fiber, api, handler, client, id, agent, value, read, set, authorize, resolve, agentsGet, forbidden }
}

it.each(['headless', 'disabled'] as const)('reports %s availability through the wire and refuses confirmation before the policy', async (unavailableReason) => {
  const f = await fixture()
  await f.ctx.plugin(ComputerUseRegistry)
  const dispose = f.ctx.computerUse.register(ComputerUseProviderName('native'), { unavailableReason })
  onTestFinished(async () => { await dispose(); await f.ctx.fiber.dispose() })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: { unavailableReason } })
  const saved = await f.client.desktop.confirm({ sessionId: f.id, rootSessionId: f.value.rootSessionId, nodeId: 'node', desktop: 'screen', confirmed: true })
  expect(saved.result).toMatchObject({ ok: false, error: { code: 'desktop-unavailable', details: { reason: unavailableReason } } })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.set).not.toHaveBeenCalled()
  f.authorize.mockResolvedValue({ error: f.forbidden })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: false, error: f.forbidden })
})

it.each(['headless', 'disabled'] as const)('reports %s without installing a desktop registry or consent policy', async (unavailableReason) => {
  const f = await fixture()
  f.ctx.set('computerUseAuthorization', { run: async (_execution, operation) => operation(new AbortController().signal) })
  f.ctx.provide('computerUseEnvironment', { unavailableReason })
  onTestFinished(async () => { await f.ctx.fiber.dispose() })
  expect(f.ctx.get('computerUse')).toBeUndefined()
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: { unavailableReason } })
  const target = { sessionId: f.id, rootSessionId: f.value.rootSessionId, nodeId: 'node', desktop: 'screen', confirmed: true }
  expect((await f.client.desktop.confirm(target)).result).toMatchObject({ ok: false, error: { code: 'desktop-unavailable', details: { reason: unavailableReason } } })
  expect(f.read).not.toHaveBeenCalled()
  expect(f.set).not.toHaveBeenCalled()
  f.authorize.mockResolvedValue({ error: f.forbidden })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: false, error: f.forbidden })
})

it('keeps a configured external desktop available despite a headless local environment', async () => {
  const f = await fixture()
  f.ctx.provide('computerUseEnvironment', { unavailableReason: 'headless' })
  await f.ctx.plugin(ComputerUseRegistry)
  f.ctx.computerUse.register(ComputerUseProviderName('remote'))
  onTestFinished(async () => { await f.ctx.fiber.dispose() })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: f.value })
  expect(f.read).toHaveBeenCalledOnce()
})

it('routes exact pane and expected target through the real fetch carrier', async () => {
  const f = await fixture()
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: f.value })
  expect((await f.client.desktop.confirm({ sessionId: f.id, ...f.value, confirmed: true })).result.ok).toBe(false)
  const target = { sessionId: f.id, rootSessionId: f.value.rootSessionId, nodeId: 'node', desktop: 'screen', confirmed: true }
  expect((await f.client.desktop.confirm(target)).result).toEqual({ ok: true, value: { ...f.value, confirmed: true } })
  expect(f.set).toHaveBeenCalledWith(f.agent, target, true, expect.any(AbortSignal))
  expect(f.authorize).toHaveBeenCalledWith(f.id, undefined)
})

it('refuses forged actor fields and nonboolean confirmation before the policy', async () => {
  const f = await fixture()
  for (const payload of [{ sessionId: f.id, userId: 99 }, { sessionId: f.id, desktop: 'screen' }]) {
    const response = await f.handler.fetch(new Request('http://host/api/desktop.status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: 'r', payload }) }))
    expect(((await response.json()) as { result?: { ok?: boolean } }).result?.ok).toBe(false)
  }
  expect(f.read).not.toHaveBeenCalled()
  const invalid = await f.handler.fetch(new Request('http://host/api/desktop.confirm', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'r', payload: { sessionId: f.id, rootSessionId: 'root', nodeId: 'node', desktop: 'screen', confirmed: 'yes' } }) }))
  expect(((await invalid.json()) as { result?: { ok?: boolean } }).result?.ok).toBe(false)
  expect(f.set).not.toHaveBeenCalled()
})

it('refuses a private or read-only Session before resolving an Agent or reading confirmation', async () => {
  const f = await fixture()
  f.authorize.mockResolvedValue({ error: f.forbidden })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: false, error: f.forbidden })
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
})

it('refuses missing Sessions and authority revoked during the read', async () => {
  const f = await fixture()
  f.resolve.mockResolvedValueOnce({ error: { code: 'session-not-found', message: 'missing', details: { sessionId: f.id } } })
  expect((await f.client.desktop.confirm({ sessionId: f.id, rootSessionId: f.value.rootSessionId, nodeId: 'node', desktop: 'screen', confirmed: true })).result.ok).toBe(false)
  f.authorize.mockResolvedValueOnce({ authority: undefined }).mockResolvedValueOnce({ error: f.forbidden })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: false, error: f.forbidden })
})

it('reports no consent for a Session without a live Agent instead of resuming one', async () => {
  const f = await fixture()
  f.agentsGet.mockReturnValue(undefined)
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: null })
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
})

it('reports unconfigured consent and refuses saves through the same public methods', async () => {
  const f = await fixture()
  f.ctx.set('computerUseAuthorization', { run: async (_execution, operation) => operation(new AbortController().signal) })
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toEqual({ ok: true, value: null })
  expect((await f.client.desktop.confirm({ sessionId: f.id, rootSessionId: f.value.rootSessionId, nodeId: 'node', desktop: 'screen', confirmed: true })).result.ok).toBe(false)
})

it('awaits cancelled confirmation work during policy disposal and suppresses late results', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  f.read.mockImplementationOnce(async () => { entered.resolve(undefined); await finish.promise; return f.value })
  const result = f.api.status({ rpcId: RpcId('r'), payload: { sessionId: f.id } })
  await entered.promise
  const closing = f.fiber.dispose()
  finish.resolve(undefined)
  expect((await result).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  await closing
})

it('rejects caller cancellation and failed consent reads', async () => {
  const f = await fixture()
  expect((await f.api.status({ rpcId: RpcId('r'), payload: { sessionId: f.id } }, AbortSignal.abort())).result.ok).toBe(false)
  f.read.mockRejectedValueOnce(new Error('denied'))
  expect((await f.client.desktop.status({ sessionId: f.id })).result).toMatchObject({ ok: false, error: { code: 'internal' } })
})
