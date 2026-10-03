/** Administrator-granted Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: supplies the settings.agentPreset locale namespace used for
// built-in preset display names.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { presetDisplayText } from '@deepseek-ai/dsh-agent-presets/display'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginManager', 'modules']

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  // The manager's own capability answer is the probe: `access` reports the
  // manage grant while inventory reads stay open, and an older Host without
  // the remote still refuses the read itself on denial.
  const management: PluginInventorySettingsTabInjected['management'] = async () => {
    const access = await ctx.remote.pluginManager.access()
    if (access.ok && !access.value.manage) return { status: 'denied' }
    const result = await ctx.remote.pluginManager.listPlugins()
    if (!result.ok) {
      if (result.error.code === 'plugin-management/forbidden') return { status: 'denied' }
      throw new Error(`pluginManager.listPlugins failed: ${result.error.code}: ${result.error.message}`)
    }
    return { status: 'granted', plugins: result.value }
  }
  const setPluginEnabled: PluginInventorySettingsTabInjected['setPluginEnabled'] = async (entryId, enabled) => {
    const result = await ctx.remote.pluginManager.setPluginEnabled(entryId, enabled)
    if (!result.ok) {
      throw new Error(`pluginManager.setPluginEnabled failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  // Built-in preset ids use the active Agent-preset dictionaries; custom
  // metadata remains literal. Resolve on every render so locale switches are
  // reflected without refetching the Host snapshot.
  const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
  const presetName: PluginInventorySettingsTabInjected['presetName'] = preset =>
    presetDisplayText(preset, agentPresetCopy).name
  const injected = (): PluginInventorySettingsTabInjected => ({
    list, presetName, management, setPluginEnabled,
    resolveText: text => ctx.locale.resolveText(text),
    hooks: { clientSync: ctx.modules.entries.state },
    retryClient: () => { void ctx.modules.entries.retry().catch((error: unknown) => { ctx.logger.error(error) }) },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}
