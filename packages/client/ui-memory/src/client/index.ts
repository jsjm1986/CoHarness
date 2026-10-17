/**
 * The Memory browser: a `main` page listing durable entries by scope and
 * kind, a `sidebar.panellist` entry opening it, and a `plugins.item` card
 * switching the `memory` settings namespace.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh, type MemoryKey } from './locales.ts'
import { MemoryCard } from './MemoryCard.tsx'
import { MemoryCardController, MEMORY_NS } from './memory-card-controller.ts'
import { MemoryIcon } from './MemoryIcon.tsx'
import { MemoryPage } from './MemoryPage.tsx'
import { createMemorySource, type MemoryInjected } from './memory-source.ts'

export type { MemoryInjected, MemorySnapshot } from './memory-source.ts'
export type { MemoryCardFace, MemoryCardState, MemorySettingsSection } from './memory-card-controller.ts'
export { MemoryCardController, MEMORY_NS } from './memory-card-controller.ts'
export { createMemorySource } from './memory-source.ts'
export type { MemoryKey } from './locales.ts'
export type { MemoryPageProps } from './MemoryPage.tsx'
export type { MemoryCardProps } from './MemoryCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory page and card copy. */
    'memory': MemoryKey
  }
}

const namespace = 'memory'
const PANEL_ID = 'memory' as MainPanelId

/** Required services: slots, copy, the Remote carrier, the memory proxy, settings, and session navigation. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.memory', 'settingsScope', 'uiWorkspace', 'sessions',
]

/**
 * Client plugin body: dictionaries, the Remote-backed memory source behind
 * the main page and sidebar entry, and the Plugins-page card bound to the
 * `memory` settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-memory: dictionaries')
  const memory = createMemorySource({
    scopes: () => ctx.remote.memory.scopes(),
    list: scope => ctx.remote.memory.list({ scope }),
    save: request => ctx.remote.memory.save(request),
    remove: request => ctx.remote.memory.delete(request),
    subscribeChanged: listener => ctx.remote.$on('memory/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
    // Entries attribute writes by Host Session id; the session list keys rows
    // by the runtime-scoped client identity, so translate once at navigation.
    openSource: (sessionId: SessionId) => {
      ctx.uiWorkspace.openSession(ctx.sessions.keyFor?.(sessionId) ?? sessionId)
    },
  })
  const card = new MemoryCardController(ctx.settingsScope.bind({ namespace: MEMORY_NS }))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: namespace,
    inject: (): MemoryInjected => memory,
  }, MemoryPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    locale: namespace,
    label: () => t('panel'),
  }, MemoryIcon))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: MEMORY_NS,
    order: 60,
    locale: namespace,
    label: () => t('card.title'),
    inject: () => card.inject(),
  }, MemoryCard))
}
