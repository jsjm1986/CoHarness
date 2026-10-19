/**
 * Plugins settings surfaces, browser half. Two registrations: the **Plugins**
 * Settings section (the navigation entry plus the localized tab chrome that
 * feature-owned pages — the read-only inventory ships one — register into
 * through `settings.plugins.tab`), and the official plugin configuration
 * cards the sidebar Plugins page lists in its Configuration group and opens
 * as per-plugin detail pages.
 *
 * The manager page declares `plugins.item`; the Settings shell declares
 * `settings.section`. Each card binds its namespace through the client
 * settings scope, which keeps them unaware of one another, and supplies its
 * own staged edits with save and discard — the page renders the one-liner
 * (`view: 'summary'`) or the form (`view: 'page'`), never a card's internals.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PluginsSettingsSection } from './PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionInjected, PluginsSettingsTabEntry } from './PluginsSettingsSection.tsx'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import { SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController } from './subagent-model-selection-card-controller.ts'
import { SubagentLimitsCard } from './SubagentLimitsCard.tsx'
import { SubagentLimitsCardController } from './subagent-limits-card-controller.ts'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { WEB_API_NS, WEB_NS, WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, zh } from './locales.ts'

export type { PluginsSettingsSectionInjected, PluginsSettingsSectionProps } from './PluginsSettingsSection.tsx'
export type { PluginFormProps } from './PluginForm.tsx'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Mount the plugin configuration cards this package ships on the Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugins: dictionaries')

  const bash = new BashCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))
  const agentLoop = new AgentLoopCardController(ctx.settingsScope.bind({ namespace: AGENT_LOOP_NS }))
  const subagent = new SubagentLimitsCardController(ctx.settingsScope.bind({ namespace: 'subagent' }))
  const subagentModels = new SubagentModelSelectionCardController(
    ctx.settingsScope.bind({ namespace: SUBAGENT_MODEL_SELECTION_NS }), api)
  const webSearch = new WebSearchCardController({
    web: ctx.settingsScope.bind({ namespace: WEB_NS }),
    messages: ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }),
    api: ctx.settingsScope.bind({ namespace: WEB_API_NS }),
  }, api)

  // The credential a card reports is not part of any settings section, so its
  // scope publishes nothing when one is written. This is the only signal that
  // a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { webSearch.refreshCredential(ref) }),
    'ui-settings-plugins: credential invalidations',
  )

  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { subagentModels.refreshCatalog() }),
    'ui-settings-plugins: subagent model catalog')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { subagentModels.refreshCatalog() }),
    'ui-settings-plugins: subagent model settings')
  ctx.effect(() => ctx.on('connection/reset', () => { subagentModels.resetConnection() }),
    'ui-settings-plugins: subagent model connection')
  ctx.effect(() => () => { subagentModels.dispose() }, 'ui-settings-plugins: subagent model form')

  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly PluginsSettingsTabEntry[] = []
  const sectionInjected = (): PluginsSettingsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('settings.plugins.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // This package owns the one Plugins navigation entry and the tab chrome;
  // feature plugins contribute pages without competing for Settings nav rows.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))

  // One card per host-plane namespace, listed on the Plugins page in `order`
  // order; the card's own page shows its staged form. Each card registers
  // only while the Host serves the namespace it edits, so a deployment that
  // never composed the owner shows no trace of the page.
  ctx.effect(() => ctx.settingsScope.whileServed([SHELL_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: SHELL_NS,
    order: 10,
    label: () => t('bashTitle'),
    locale: NS,
    inject: () => bash.inject(),
  }, BashCard))), 'ui-settings-plugins: shell card')
  ctx.effect(() => ctx.settingsScope.whileServed([AGENT_LOOP_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: AGENT_LOOP_NS,
    order: 20,
    label: () => t('agentLoopTitle'),
    locale: NS,
    inject: () => agentLoop.inject(),
  }, AgentLoopCard))), 'ui-settings-plugins: agent-loop card')
  ctx.effect(() => ctx.settingsScope.whileServed(['subagent'], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'subagent',
    order: 30,
    label: () => t('subagentTitle'),
    locale: NS,
    inject: () => subagent.inject(),
  }, SubagentLimitsCard))), 'ui-settings-plugins: subagent card')
  ctx.effect(() => ctx.settingsScope.whileServed(['subagent', SUBAGENT_MODEL_SELECTION_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: SUBAGENT_MODEL_SELECTION_NS,
    order: 40,
    label: () => t('subagentModelSelectionTitle'),
    locale: NS,
    inject: () => subagentModels.inject(),
  }, SubagentModelSelectionCard))), 'ui-settings-plugins: subagent model selection card')
  ctx.effect(() => ctx.settingsScope.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: WEB_SEARCH_NS,
    order: 50,
    label: () => t('webSearchTitle'),
    locale: NS,
    inject: () => webSearch.inject(),
  }, WebSearchCard))), 'ui-settings-plugins: web search card')
}
