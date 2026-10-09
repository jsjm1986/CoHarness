/**
 * Plugin configuration cards, browser half — the official settings cards the
 * Plugins page lists in its Configuration group and opens as per-plugin
 * detail pages.
 *
 * The manager page declares `plugins.item`; this package registers one card
 * per host-plane namespace it edits. Each card binds its namespace through
 * the client settings scope, which keeps them unaware of one another, and
 * supplies its own staged edits with save and discard — the page renders the
 * one-liner (`view: 'summary'`) or the form (`view: 'page'`), never a card's
 * internals.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: merges the Plugins page's `plugins.item` slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import { SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController } from './subagent-model-selection-card-controller.ts'
import { SubagentLimitsCard } from './SubagentLimitsCard.tsx'
import { SubagentLimitsCardController } from './subagent-limits-card-controller.ts'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, zh } from './locales.ts'

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
  const webSearch = new WebSearchCardController(ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), api)

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

  // One card per host-plane namespace, listed on the Plugins page in
  // registration order; the card's own page shows its staged form.
  ctx.slots.inject('plugins.item', function* () {
    yield ctx.slots.register({
      name: 'plugins.item',
      id: SHELL_NS,
      order: 10,
      label: () => t('bashTitle'),
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'plugins.item',
      id: AGENT_LOOP_NS,
      order: 20,
      label: () => t('agentLoopTitle'),
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    yield ctx.slots.register({
      name: 'plugins.item',
      id: 'subagent',
      order: 30,
      label: () => t('subagentTitle'),
      locale: NS,
      inject: () => subagent.inject(),
    }, SubagentLimitsCard)
    yield ctx.slots.register({
      name: 'plugins.item',
      id: SUBAGENT_MODEL_SELECTION_NS,
      order: 40,
      label: () => t('subagentModelSelectionTitle'),
      locale: NS,
      inject: () => subagentModels.inject(),
    }, SubagentModelSelectionCard)
    yield ctx.slots.register({
      name: 'plugins.item',
      id: WEB_SEARCH_NS,
      order: 50,
      label: () => t('webSearchTitle'),
      locale: NS,
      inject: () => webSearch.inject(),
    }, WebSearchCard)
  })
}
