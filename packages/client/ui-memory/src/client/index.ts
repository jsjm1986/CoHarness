/**
 * The Memory browser: a right-Sidebar tab listing durable entries on a
 * day-grouped timeline, a guide entry opening it, and a `plugins.item`
 * card switching the `memory` settings namespace.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh, type MemoryKey } from './locales.ts'
import { MemoryCard } from './MemoryCard.tsx'
import { MemoryCardController, MEMORY_NS } from './memory-card-controller.ts'
import { IconBrainOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { MemoryTab } from './MemoryTab.tsx'
import { createMemorySource, type MemoryInjected } from './memory-source.ts'

export type { MemoryInjected, MemorySnapshot } from './memory-source.ts'
export type { MemoryCardFace, MemoryCardState, MemorySettingsSection } from './memory-card-controller.ts'
export { MemoryCardController, MEMORY_NS } from './memory-card-controller.ts'
export { createMemorySource } from './memory-source.ts'
export type { MemoryKey } from './locales.ts'
export type { MemoryTabProps } from './MemoryTab.tsx'
export type { MemoryCardProps } from './MemoryCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory tab and card copy. */
    'memory': MemoryKey
  }
}

const namespace = 'memory'
/** The tab type's identity: kind `memory`, registered under this package name. */
const TAB_ID = '@deepseek-ai/dsh-client-ui-memory'

/** Required services: slots, copy, Remote carrier, memory proxy, settings, tab registry, session navigation, session list. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.memory', 'settingsScope', 'uiWorkspace', 'sessions', 'sidebarRightTabs',
]

/**
 * Client plugin body: dictionaries, the `memory` right-Sidebar tab type
 * backed by per-Session Remote sources, and the Plugins-page card bound to
 * the `memory` settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-memory: dictionaries')
  const sourceFor = (sessionId: SessionId): MemoryInjected => createMemorySource({
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
    sessionDirectory: () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
  })
  const card = new MemoryCardController(ctx.settingsScope.bind({ namespace: MEMORY_NS }))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'memory',
    priority: 'builtin',
    title: () => t('guide.title'),
    guide: [{ id: 'open', order: 40, title: () => t('guide.title'), description: () => t('guide.description'), icon: IconBrainOutline16 }],
  }), 'ui-sidebar-right type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: namespace,
    inject: (sessionId): MemoryInjected => sourceFor(sessionId),
  }, MemoryTab))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: MEMORY_NS,
    order: 60,
    locale: namespace,
    label: () => t('card.title'),
    inject: () => card.inject(),
  }, MemoryCard))
}
