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
    const { ctx, slots } = await bench()
    declarePluginsItem(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const entries = slots.entries('plugins.item')
    expect(entries.map(entry => entry.options.id))
      .toEqual(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek'])
    expect(resolveSlotLabel(entries[0]!.options.label)).toBe('终端')
  })

  it('injects one business face per card', async () => {
    const { ctx, slots } = await bench()
    declarePluginsItem(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

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

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declarePluginsItem(slots)

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(5) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declarePluginsItem(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('plugins.item')).toHaveLength(5)

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})

describe('ui-settings-plugins node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
