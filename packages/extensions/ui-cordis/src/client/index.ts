/** Cordis dynamic-plugin cards, inventory panel, business-view host, and `@pluginId` source. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { InputTriggerService, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from './events.ts'
import { CordisActionRow } from './CordisActionRow.tsx'
import { CordisDefineRow } from './CordisDefineRow.tsx'
import { CordisRunRow } from './CordisRunRow.tsx'
import { CordisPanel } from './CordisPanel.tsx'
import { createRuntimeCordisInventories } from './runtime-inventory.ts'
import { CordisRunCardRegistry } from './run-card-index.ts'
import type { CordisCardFace, CordisPanelFace, CordisRunCardFace } from './slots.ts'
import { en, NS, zh } from './locales.ts'

export type { CordisCardFace, CordisPanelFace, CordisRunCardFace, CordisToolViewOwnerProps } from './slots.ts'
export type { CordisActionResult, CordisDynamicPort, CordisInventoryRow } from './dynamic-port.ts'
export type { CordisDefineRowProps } from './CordisDefineRow.tsx'
export type { CordisActionRowProps } from './CordisActionRow.tsx'
export type { CordisRunRowProps } from './CordisRunRow.tsx'
export type {
  CordisRunCardPointer, CordisRunCardStore, CordisToolViewKey,
} from './run-card-index.ts'
export type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisInventoryRow, DynamicCordisPackage, DynamicCordisRetracted,
} from './events.ts'
export type { CordisKey } from './locales.ts'

/** Required services for the two Tool cards, panel, Remote lifecycle, and Slash source. */
export const inject = [
  'slots', 'locale', 'inputTriggers', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner', 'sessions', 'connection', 'runtimeEnvironments',
]

/** Mount every Cordis browser surface over the shared Host inventory. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cordis: dictionaries')

  const sources = createRuntimeCordisInventories(ctx)
  const runCards = new CordisRunCardRegistry()

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',
    locale: NS,
    inject: (): CordisPanelFace => ({
      hooks: { pendingApprovals: ctx.dynamicCordisRunner.pendingApprovals, runtimeEnvironments: ctx.runtimeEnvironments },
      keyedHooks: {
        inventory: key => sources.forSession(key === 'base' ? undefined : key as SessionId).inventory,
        activeRuns: key => sources.forSession(key === 'base' ? undefined : key as SessionId).runner.activeRuns,
        runErrors: key => sources.forSession(key === 'base' ? undefined : key as SessionId).runner.lastRunError,
        renderFailures: key => sources.forSession(key === 'base' ? undefined : key as SessionId).runner.renderFailures,
        loaded: key => sources.forSession(key === 'base' ? undefined : key as SessionId).loaded,
      },
      actionsForSession: id => sources.forSession(id).actions,
    }),
  }, CordisPanel))

  const cardFace = (sessionId: SessionId): CordisCardFace => {
    const source = sources.forSession(sessionId)
    return { hooks: { inventory: source.inventory, loaded: source.loaded } }
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'cordis_define',
    locale: NS,
    inject: cardFace,
  }, CordisDefineRow))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'cordis_run',
    locale: NS,
    children: { 'tool.view.cordis': { kind: 'keyed', scope: 'session' } },
    inject: (sessionId: SessionId): CordisRunCardFace => {
      const store = runCards.forSession(sessionId)
      const source = sources.forSession(sessionId)
      return {
        viewPrefix: source.runner.viewPrefix,
        hooks: { inventory: source.inventory, loaded: source.loaded, runCards: store, activeRuns: source.runner.activeRuns },
        onObserveRunCard: (pointer) => { store.observe(pointer) },
      }
    },
  }, CordisRunRow))

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({
      name: 'tool.call.toolview', key: 'cordis_stop', locale: NS,
    }, CordisActionRow)
    yield ctx.slots.register({
      name: 'tool.call.toolview', key: 'cordis_undefine', locale: NS,
    }, CordisActionRow)
  })

  const rowsOf = (sessionId: SessionId, query: string) => sources.forSession(sessionId).inventory.getSnapshot().rows
    .filter(row => row.agentId === sessionId && String(row.pluginId).includes(query))
  const source: InputTriggerSource = {
    trigger: '@',
    name: '@deepseek-ai/cordis',
    order: 1,
    candidates(session, { query }) {
      const rows = rowsOf(session.sessionId, query)
      return Promise.resolve(rows.map((row) => {
        const packageId = row.nextPackageId ?? row.currentPackageId ?? row.packages.at(-1)?.packageId
        const pkg = packageId === undefined ? undefined : row.packages.find(candidate => candidate.packageId === packageId)
        return {
          name: String(row.pluginId),
          ...pkg === undefined ? {} : { description: pkg.purpose },
        }
      }))
    },
    warm(session) { sources.forSession(session.sessionId).inventory.refresh() },
    lexicon(session) { return rowsOf(session.sessionId, '').map(row => String(row.pluginId)) },
    subscribeLexicon(session, listener) { return sources.forSession(session.sessionId).inventory.subscribe(listener) },
    onPick({ candidate }) { return { text: `@${candidate.name} ` } },
  }
  const slash = ctx.get('inputTriggers') as InputTriggerService
  ctx.effect(() => slash.registerSource(source), 'ui-cordis: @pluginId source')

  sources.forSession().inventory.refresh()
}
