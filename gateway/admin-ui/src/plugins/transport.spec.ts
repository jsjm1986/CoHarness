/** Admin transport uses generated wire validation and never resumes an effectful install. */
import { afterEach, expect, it, vi } from 'vitest'
import { pluginManagementRemote } from './transport.ts'
import { AdminRequestError, pluginManagementInvoke } from '../api.ts'
import type { PluginInstallFrame, PluginInstallRequestId } from '../../../../packages/boot/plugin-manager/src/types.ts'

vi.mock('../api.ts', async importOriginal => ({ ...await importOriginal<typeof import('../api.ts')>(), pluginManagementInvoke: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
const target = { nodeId: 'node', target: { kind: 'user' as const, id: 4 }, generation: 2 }
const requestId = '00000000-0000-4000-8000-000000000002' as PluginInstallRequestId
const complete: PluginInstallFrame = { type: 'result', value: { changed: true, application: 'applied', stage: 'install', target: 'bundle', bundle: 'bundle' } }

it('validates correlation and the generated result while preserving exact target arguments', async () => {
  const remote = pluginManagementRemote(target, new AbortController().signal, () => {}, () => {})
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId, result: { ok: true, value: [] } }))
  expect(await remote.pluginManager.listBundles()).toEqual({ ok: true, value: [] })
  expect(pluginManagementInvoke).toHaveBeenCalledWith(expect.objectContaining({ ...target, endpoint: 'pluginManager/listBundles', args: {} }), expect.any(AbortSignal))
  vi.mocked(pluginManagementInvoke).mockResolvedValue({ rpcId: 'wrong', result: { ok: true, value: [] } })
  expect(await remote.pluginManager.listBundles()).toMatchObject({ ok: false, error: { message: '插件响应与当前请求不一致。' } })
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId, result: { ok: true, value: [{ name: 'missing-required-fields' }] } }))
  expect(await remote.pluginManager.listBundles()).toMatchObject({ ok: false })
})

it('delivers installation progress then resolves only after the correlated clean end', async () => {
  const frames: PluginInstallFrame[] = []
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    expect(input).toMatchObject({ ...target, endpoint: 'pluginManager/installBundleStream', args: { spec: 'bundle', options: { requestId, enabled: false } } })
    const values: PluginInstallFrame[] = [{ type: 'progress', progress: { requestId, phase: 'installing' } }, complete]
    return new Response(values.map(value => JSON.stringify({ rpcId: input.rpcId, type: 'result', result: { ok: true, value } })).join('\n') + '\n' + JSON.stringify({ rpcId: input.rpcId, type: 'end' }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
  })
  vi.stubGlobal('fetch', send)
  const remote = pluginManagementRemote(target, new AbortController().signal, frame => frames.push(frame), () => {})
  expect(await remote.pluginManager.installBundle('bundle', { requestId, enabled: false })).toEqual({ ok: true, value: complete.value })
  expect(frames).toEqual([{ type: 'progress', progress: { requestId, phase: 'installing' } }])
  expect(send).toHaveBeenCalledOnce()
})

it('refuses truncated or extra results instead of retrying a possibly completed install', async () => {
  for (const extra of [false, true]) {
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body))
      const frame = JSON.stringify({ rpcId: input.rpcId, type: 'result', result: { ok: true, value: complete } }) + '\n'
      return new Response(frame + (extra ? frame + JSON.stringify({ rpcId: input.rpcId, type: 'end' }) + '\n' : ''), { headers: { 'content-type': 'application/x-ndjson' } })
    })
    vi.stubGlobal('fetch', send)
    const remote = pluginManagementRemote(target, new AbortController().signal, () => {}, () => {})
    expect(await remote.pluginManager.installBundle('bundle', { requestId })).toMatchObject({ ok: false })
    expect(send).toHaveBeenCalledOnce()
  }
})

it('cancels an installation before opening transport when its target is already gone', async () => {
  const abort = new AbortController(); abort.abort(new Error('target changed'))
  const send = vi.fn(); vi.stubGlobal('fetch', send)
  const remote = pluginManagementRemote(target, abort.signal, () => {}, () => {})
  expect(await remote.pluginManager.installBundle('bundle', { requestId })).toMatchObject({ ok: false })
  expect(send).not.toHaveBeenCalled()
})

it.each([401, 403, 404, 409])('invalidates private state on HTTP %s from either transport', async status => {
  const invalidate = vi.fn()
  const remote = pluginManagementRemote(target, new AbortController().signal, () => {}, invalidate)
  vi.mocked(pluginManagementInvoke).mockRejectedValue(new AdminRequestError(status, 'scope lost'))
  expect(await remote.pluginManager.listBundles()).toMatchObject({ ok: false })
  expect(invalidate).toHaveBeenCalledWith('scope lost')
  invalidate.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status })))
  expect(await remote.pluginManager.installBundle('bundle', { requestId })).toMatchObject({ ok: false })
  expect(invalidate).toHaveBeenCalledOnce()
})
it('clears explicit wire revocation but preserves state after an ordinary network failure', async () => {
  const invalidate = vi.fn()
  const remote = pluginManagementRemote(target, new AbortController().signal, () => {}, invalidate)
  vi.mocked(pluginManagementInvoke).mockRejectedValue(new Error('network interrupted'))
  expect(await remote.pluginManager.listBundles()).toMatchObject({ ok: false })
  expect(invalidate).not.toHaveBeenCalled()
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId, result: { ok: false, error: { code: 'plugin-management/forbidden', message: 'revoked' } } }))
  expect(await remote.pluginManager.listBundles()).toMatchObject({ ok: false })
  expect(invalidate).toHaveBeenCalledWith('revoked')
})

it('ignores a late refusal from an already disposed target', async () => {
  const abort = new AbortController(), invalidate = vi.fn()
  const pending = Promise.withResolvers<unknown>()
  vi.mocked(pluginManagementInvoke).mockReturnValue(pending.promise)
  const remote = pluginManagementRemote(target, abort.signal, () => {}, invalidate)
  const result = remote.pluginManager.listBundles()
  abort.abort()
  pending.reject(new AdminRequestError(403, 'old target revoked'))
  expect(await result).toMatchObject({ ok: false })
  expect(invalidate).not.toHaveBeenCalled()
})

it('validates configuration replies and preserves conflict codes for draft recovery', async () => {
  const invalidate = vi.fn()
  const remote = pluginManagementRemote(target, new AbortController().signal, () => {}, invalidate)
  const view = { ns: 'shell', schema: {}, value: {}, revision: 3, applies: 'live', secrets: [] }
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId,
    result: { ok: true, value: { writable: true, hasDocument: false, namespaces: [view] } } }))
  expect(await remote.settings.describe()).toMatchObject({ ok: true, value: { namespaces: [view] } })
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId, result: { ok: true, value: view } }))
  expect(await remote.settings.mutate({ ns: 'shell', expectedRevision: 2, ops: [] })).toMatchObject({ ok: true, value: view })
  expect(pluginManagementInvoke).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: 'settings.mutate', args: { ns: 'shell', expectedRevision: 2, ops: [] }, ...target }), expect.any(AbortSignal))
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId,
    result: { ok: false, error: { code: 'settings-conflict', message: 'changed elsewhere' } } }))
  expect(await remote.settings.mutate({ ns: 'shell', expectedRevision: 2, ops: [] })).toMatchObject({ ok: false, error: { code: 'settings-conflict' } })
  expect(invalidate).not.toHaveBeenCalled()
  vi.mocked(pluginManagementInvoke).mockImplementation(async input => ({ rpcId: (input as { rpcId: string }).rpcId,
    result: { ok: false, error: { code: 'collaboration-forbidden', message: 'administrator revoked' } } }))
  await remote.settings.describe()
  expect(invalidate).toHaveBeenCalledWith('administrator revoked')
})
