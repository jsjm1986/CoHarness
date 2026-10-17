/** Shared-project activity tab: member messages and chosen answers in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewport } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActivityBody, type ActivityInjected } from './ActivityBody.tsx'
import { ActivityTitle } from './ActivityTitle.tsx'
import { ACTIVITY_ID, activityDefinition } from './definition.tsx'
import { fetchActivity } from './feed.ts'
import { en, zh, type ActivityKey } from './locales.ts'
import { createActivityStore } from './store.ts'

export { type ActivityBodyProps, type ActivityInjected } from './ActivityBody.tsx'
export type { ActivityItem, ActivityPage, ActivityGrouping, ActivitySection } from './feed.ts'
export type { ActivityKey } from './locales.ts'
export { createActivityStore } from './store.ts'
export type { ActivityState, ActivityStore } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project activity feed copy. */
    'projectActivity': ActivityKey
  }
}

const namespace = 'projectActivity'

/** Required services: tab registry, locale face, scope policy, sessions, and the reveal target. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'projectUiPolicy', 'sessions', 'conversationViewport']

/**
 * Client plugin body: dictionaries, the scope-gated tab type, and the two
 * keyed seats. The type definition follows `projectUiPolicy.scope` — the feed
 * exists only while the shared project scope is active — while the keyed body
 * and title registrations stay mounted; without a live tab they are inert.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(namespace)
  const store = createActivityStore()
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-project-activity.copy')
  ctx.effect(() => {
    let disposeType: (() => void) | undefined
    const sync = (): void => {
      const inProject = ctx.projectUiPolicy.getSnapshot().scope === 'project'
      if (inProject && disposeType === undefined) {
        disposeType = ctx.sidebarRightTabs.register(activityDefinition(t))
      } else if (!inProject && disposeType !== undefined) {
        const dispose = disposeType
        disposeType = undefined
        dispose()
      }
    }
    sync()
    const unsubscribe = ctx.projectUiPolicy.subscribe(sync)
    return () => { unsubscribe(); disposeType?.() }
  }, 'ui-project-activity.scope')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ACTIVITY_ID, locale: namespace, store,
    inject: (_sessionId, actions): ActivityInjected => {
      let inFlight: AbortController | undefined
      const load = async (before: string | undefined): Promise<void> => {
        inFlight?.abort()
        const controller = new AbortController()
        inFlight = controller
        actions.loading()
        try {
          const page = await fetchActivity(before, controller.signal)
          if (before === undefined) actions.refreshed(page.items, page.nextBefore)
          else actions.appended(page.items, page.nextBefore)
        } catch {
          if (!controller.signal.aborted) actions.failed()
        }
      }
      return {
        refresh: () => { void load(undefined) },
        loadMore: (before) => { void load(before) },
        reveal: (sessionId, seq) => {
          const viewport: ConversationViewport | undefined = ctx.get('conversationViewport')
          if (viewport === undefined) return
          // The feed carries wire session ids; the pane set and the sessions
          // list key rows by the runtime-scoped client identity, so translate
          // through the project runtime target the feed belongs to.
          const policy = ctx.projectUiPolicy.getSnapshot()
          const raw = sessionId as SessionId
          const target = policy.scope === 'project' && policy.projectId !== undefined
            ? ctx.sessions.keyFor?.(raw, { kind: 'project', projectId: policy.projectId }) ?? raw
            : raw
          if (seq === null) viewport.replaceActive(target)
          else viewport.reveal(target, seq)
        },
      }
    },
  }, ActivityBody))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ACTIVITY_ID, locale: namespace,
  }, ActivityTitle))
}
