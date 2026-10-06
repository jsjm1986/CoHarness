// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type { PluginInventorySettingsTabInjected } from '../src/client/PluginInventorySettingsTab.tsx'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { ChangeResult, PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { apply as nodeApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY = { entries: [] }
type RemoteAnswer<V> =
  | { readonly ok: true; readonly value: V }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
type ListResult = RemoteAnswer<typeof EMPTY>

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  ctx.provide('remote.pluginInventory', { list })
  const listPlugins = vi.fn<() => Promise<RemoteAnswer<PluginInfo[]>>>()
    .mockResolvedValue({ ok: true, value: [] })
  const setPluginEnabled = vi.fn<() => Promise<RemoteAnswer<ChangeResult>>>()
    .mockResolvedValue({ ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'x' } })
  const access = vi.fn<() => Promise<RemoteAnswer<{ manage: boolean }>>>()
    .mockResolvedValue({ ok: true, value: { manage: true } })
  ctx.provide('remote.pluginManager', { listPlugins, setPluginEnabled, access })
  const retry = vi.fn(async () => {})
  const state = { getSnapshot: () => ({ syncing: false, failures: [] }), subscribe: () => () => {} }
  ctx.provide('modules', { entries: { state, retry } } as unknown as ClientModuleLoader)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, listPlugins, setPluginEnabled, access, retry, state }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugin-inventory browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginManager', 'modules'])
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(PluginInventorySettingsTab)
    expect(entry.options).toMatchObject({ id: 'all', order: 10 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件列表')
    expect(b.list).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => PluginInventorySettingsTabInjected)()
    expect(injected.hooks.clientSync).toBe(b.state)
    const text = { en: 'Local tools', zh: '本地工具' }
    expect(injected.resolveText(text)).toBe('本地工具')
    b.locale.setLocale('en')
    expect(injected.resolveText(text)).toBe('Local tools')
    b.locale.setLocale('zh')
    injected.retryClient()
    expect(b.retry).toHaveBeenCalledOnce()
    const failure = new Error('page retry failed')
    const logged = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => {})
    b.retry.mockRejectedValueOnce(failure)
    injected.retryClient()
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith(failure) })
    logged.mockRestore()
    await expect(injected.list()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.list()).rejects.toThrow('pluginInventory.list failed: REMOTE_ERROR: unavailable')
    await expect(injected.management()).resolves.toEqual({ status: 'granted', plugins: [] })
    b.access.mockResolvedValueOnce({ ok: true, value: { manage: false } })
    await expect(injected.management()).resolves.toEqual({ status: 'denied' })
    b.access.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unknown-remote', message: 'no such remote' } })
    b.listPlugins.mockResolvedValueOnce({ ok: false, error: { code: 'plugin-management/forbidden', message: 'denied' } })
    await expect(injected.management()).resolves.toEqual({ status: 'denied' })
    b.listPlugins.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'offline' } })
    await expect(injected.management()).rejects.toThrow('pluginManager.listPlugins failed: REMOTE_ERROR: offline')
    b.setPluginEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'plugin-management/forbidden', message: 'denied' } })
    await expect(injected.setPluginEnabled('include:x' as never, false)).rejects.toThrow('pluginManager.setPluginEnabled failed: plugin-management/forbidden: denied')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Plugin list')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(PluginInventorySettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})

describe('ui-settings-plugin-inventory node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
