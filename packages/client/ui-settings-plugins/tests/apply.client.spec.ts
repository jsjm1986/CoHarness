/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import type { PluginsSettingsSectionInjected } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which is what most of these specs want (no card has anything to render).
 */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({ rpcId: 'c', result: { ok: false, error: {} } }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { rpcId: 's', result: { ok: false, error: {} } }
    : {
      rpcId: 's',
      result: {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: served.map(ns => ({
            ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
          })),
        },
      },
    }))
  // The cards bind their scopes through the Settings surface's service, and
  // forwarded Host events reach them through the same `$dispatch` handoff the
  // connection sink makes.
  new TestRemote(ctx)
  ctx.provide('connection', {
    isLoopback: true,
    api: {
      settings: { describe: describeSettings },
      credentials: { describe: describeCredentials },
    },
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings }
}

/** Stand in for the Plugins page: it declares `plugins.item` for its entries. */
function declarePluginsItem(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** Stand in for the Settings shell: it declares `settings.section` for its pages. */
function declareSettingsSection(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** Stand in for both owners at once: `root` admits a single registration. */
function declareBothSurfaces(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'plugins.item': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('invalidates the subagent directory on adapter changes', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const { ctx, slots } = await bench()
    try {
      declarePluginsItem(slots)
      await ctx.plugin({ inject: [...inject], apply }).await()
      ctx.remote.$dispatch('llm/adapters-updated', [])
      expect(refresh).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      refresh.mockRestore()
    }
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('keys each card it ships on the settings namespace that card edits', async () => {
    const { ctx, slots } = await bench(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    declarePluginsItem(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(5) })
    const entries = slots.entries('plugins.item')
    expect(entries.map(entry => entry.options.id))
      .toEqual(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    expect(entries.map(entry => resolveSlotLabel(entry.options.label)))
      .toEqual(['终端', 'Agent 循环', '子智能体', '模型选择', '网页搜索'])
  })

  it('registers a card only while the Host serves the namespace it edits', async () => {
    const { ctx, slots, describeSettings } = await bench(['shell'])
    declarePluginsItem(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    expect(slots.entries('plugins.item')[0]!.options.id).toBe('shell')

    describeSettings.mockResolvedValue({
      rpcId: 's',
      result: {
        ok: true,
        value: {
          writable: true,
          hasDocument: true,
          namespaces: [{ ns: 'agent-loop', schema: {}, value: {}, applies: 'live', secrets: [], revision: 1 }],
        },
      },
    })
    ctx.remote.$dispatch('settings/document-updated', ['agent-loop', 1])
    await vi.waitFor(() => { expect(slots.entries('plugins.item').map(entry => entry.options.id)).toEqual(['agent-loop']) })
  })

  it('injects one business face per card', async () => {
    const { ctx, slots } = await bench(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    declarePluginsItem(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(5) })
    for (const entry of slots.entries('plugins.item')) {
      const face = (entry as { inject?: () => unknown }).inject?.() as { hooks: Record<string, unknown> }
      // Each card injects exactly one snapshot store plus its own actions.
      expect(Object.keys(face.hooks)).toHaveLength(1)
    }
  })

  it('re-reads the credential when the Host reports the watched reference changed', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declarePluginsItem(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the card.
    ctx.remote.$dispatch('credentials/reference-updated', ['DEEPSEEK_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('ignores a credential change for a reference no card watches', async () => {
    const { ctx, slots, describeCredentials } = await bench()
    declarePluginsItem(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    ctx.remote.$dispatch('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()

    expect(describeCredentials).not.toHaveBeenCalled()
  })

  it('re-reads the subagent catalog when the Host commits a settings document', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const { ctx, slots } = await bench()
    try {
      declarePluginsItem(slots)
      await ctx.plugin({ inject: [...inject], apply }).await()
      refresh.mockClear()

      ctx.remote.$dispatch('settings/document-updated', ['subagent-model-selection', 1])

      expect(refresh).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      refresh.mockRestore()
    }
  })

  it('drops the connection-scoped model catalog when the connection resets', async () => {
    const reset = vi.spyOn(SubagentModelSelectionCardController.prototype, 'resetConnection')
    const { ctx, slots } = await bench()
    try {
      declarePluginsItem(slots)
      await ctx.plugin({ inject: [...inject], apply }).await()

      ctx.emit('connection/reset')

      expect(reset).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      reset.mockRestore()
    }
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    await ctx.plugin({ inject: [...inject], apply }).await()

    declarePluginsItem(slots)

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(5) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    declareBothSurfaces(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(5) })
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('registers one Built-in plugins section and declares its tab slot, contributing no tab of its own', async () => {
    const { ctx, slots } = await bench()
    declareSettingsSection(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('内置插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('injects a live tab projection ordered by the contributions', async () => {
    const { ctx, slots } = await bench()
    declareSettingsSection(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as () => Pick<PluginsSettingsSectionInjected, 'hooks'>)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const unsubscribe = sectionFace.hooks.tabs.subscribe(vi.fn())
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    slots.register({ name: 'settings.plugins.tab', id: 'first', order: -1 } as never, () => null)
    // Tabs follow their contribution's order, whatever order they registered in.
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'first', order: -1, label: '' },
      { id: 'plain', order: 0, label: '' },
    ])
    unsubscribe()
  })

  it('registers the section into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareSettingsSection(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })
})

describe('ui-settings-plugins node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
