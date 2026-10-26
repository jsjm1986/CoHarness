/** Catalog reads preserve profile authority and own every pending response through cancellation and disposal. */
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import PluginManagerCatalogGateway from '../src/catalog.ts'
import type { PluginManager } from '../src/index.ts'
import type { BundleInfo, PluginInfo } from '../src/types.ts'

async function fixture(managed = true) {
  const ctx = new Context()
  const manager = {
    authorize: vi.fn(async (_capability?: 'read' | 'manage') => {}),
    listBundles: vi.fn(async (): Promise<BundleInfo[]> => []),
    listPlugins: vi.fn(async (): Promise<PluginInfo[]> => []),
    access: vi.fn(async () => ({ manage: true })),
  }
  if (managed) ctx.provide('pluginManager', manager as unknown as PluginManager)
  const fiber = ctx.plugin(PluginManagerCatalogGateway)
  await fiber.await()
  onTestFinished(() => ctx.fiber.dispose())
  return { ctx, manager, fiber, catalog: ctx.pluginManagerCatalog }
}

it('reports an unmanaged profile without starting any profile read', async () => {
  const { catalog, manager } = await fixture(false)
  await expect(catalog.catalog()).resolves.toEqual({
    managementAvailable: false, manage: false, bundles: [], plugins: [],
  })
  expect(manager.authorize).not.toHaveBeenCalled()
  expect(manager.listBundles).not.toHaveBeenCalled()
  expect(manager.listPlugins).not.toHaveBeenCalled()
  expect(manager.access).not.toHaveBeenCalled()
})

it('refuses an unauthorized catalog before starting any profile read', async () => {
  const { catalog, manager } = await fixture()
  const failure = new RemoteError('plugin-management/forbidden', 'read denied', {})
  manager.authorize.mockRejectedValueOnce(failure)
  await expect(catalog.catalog(undefined, new AbortController().signal)).rejects.toBe(failure)
  expect(manager.authorize).toHaveBeenCalledWith('read')
  expect(manager.listBundles).not.toHaveBeenCalled()
  expect(manager.listPlugins).not.toHaveBeenCalled()
  expect(manager.access).not.toHaveBeenCalled()
})

it('returns a readable catalog with manage false without requesting a mutation', async () => {
  const { catalog, manager } = await fixture()
  manager.access.mockResolvedValueOnce({ manage: false })
  await expect(catalog.catalog(undefined, new AbortController().signal)).resolves.toEqual({
    managementAvailable: true, manage: false, bundles: [], plugins: [],
  })
  expect(manager.authorize.mock.calls).toEqual([['read'], ['read']])
  expect(manager.listBundles).toHaveBeenCalledOnce()
  expect(manager.listPlugins).toHaveBeenCalledOnce()
  expect(manager.listPlugins).toHaveBeenCalledWith(true)
  expect(manager.access).toHaveBeenCalledOnce()
})

it('rechecks read authority before publishing completed values', async () => {
  const { catalog, manager } = await fixture()
  const failure = new RemoteError('plugin-management/forbidden', 'read revoked', {})
  manager.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure)
  await expect(catalog.catalog(undefined, new AbortController().signal)).rejects.toBe(failure)
})

it.each([true, false])('passes entry metadata selection %s without changing bundle reads or authority', async (includeEntryMetadata) => {
  const { catalog, manager } = await fixture()
  await expect(catalog.catalog(includeEntryMetadata, new AbortController().signal)).resolves.toMatchObject({
    managementAvailable: true, manage: true,
  })
  expect(manager.listPlugins).toHaveBeenCalledExactlyOnceWith(includeEntryMetadata)
  expect(manager.listBundles).toHaveBeenCalledExactlyOnceWith()
  expect(manager.authorize.mock.calls).toEqual([['read'], ['read']])
})

it('starts no reads when cancellation arrives during authorization', async () => {
  const { catalog, manager } = await fixture()
  const pending = Promise.withResolvers<undefined>()
  manager.authorize.mockReturnValueOnce(pending.promise)
  const controller = new AbortController()
  const operation = catalog.catalog(undefined, controller.signal)
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  pending.resolve(undefined)
  await rejected
  expect(manager.listBundles).not.toHaveBeenCalled()
  expect(manager.listPlugins).not.toHaveBeenCalled()
})

it('drains sibling reads before returning a failed catalog', async () => {
  const { catalog, manager } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<PluginInfo[]>()
  manager.listPlugins.mockImplementationOnce(() => { entered.resolve(undefined); return pending.promise })
  const failure = new Error('profile read interrupted')
  manager.listBundles.mockRejectedValueOnce(failure)
  const operation = catalog.catalog(undefined, new AbortController().signal)
  let settled = false
  void operation.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(operation).rejects.toBe(failure)
  try {
    await entered.promise
    expect(settled).toBe(false)
  } finally {
    pending.resolve([])
    await rejected
  }
})

it('waits for owned reads at disposal and rejects their late result', async () => {
  const { catalog, manager, fiber } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<BundleInfo[]>()
  manager.listBundles.mockImplementationOnce(() => { entered.resolve(undefined); return pending.promise })
  const operation = catalog.catalog(undefined, new AbortController().signal)
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  try {
    expect(disposed).toBe(false)
  } finally {
    pending.resolve([])
    await Promise.all([rejected, disposal])
  }
  await expect(catalog.catalog(undefined, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
})
