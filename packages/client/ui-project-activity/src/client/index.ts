/** Shared-project activity tab: member messages and chosen answers in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewport } from '@deepseek-ai/dsh-client-runtime/client'
import { clientSessionKey, parseClientSessionKey, type SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActivityBody, type ActivityInjected } from './ActivityBody.tsx'
import { ActivityTitle } from './ActivityTitle.tsx'
import { ACTIVITY_ID, activityDefinition } from './definition.tsx'
import { en, zh, type ActivityKey } from './locales.ts'
import { activityRequests } from './requests.ts'
import { createActivityStore } from './store.ts'

export { type ActivityBodyProps, type ActivityInjected } from './ActivityBody.tsx'
export type {
  ActivityGrouping, ActivityItem, ActivityMember, ActivityMode, ActivityPage, ActivitySection,
  ProgressContent, ProgressEntry, ProgressItem, ProgressPage, ProgressStatus,
} from './feed.ts'
export type { ActivityKey } from './locales.ts'
export { createActivityStore } from './store.ts'
export type { ActivityState, ActivityStore, ProgressObservation, ProgressReadFailure } from './store.ts'

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
 * Client plugin body: dictionaries, the project-Session tab type and keyed seats.
 * Session ownership selects the type; unqualified standalone Sessions use the
 * page policy. Each body captures its Runtime for requests and source links.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(namespace)
  const store = createActivityStore()
  const lifetime = new AbortController()
  const pending = new Set<Promise<void>>()
  const track = (task: Promise<void>): void => {
    pending.add(task)
    void task.then(() => { pending.delete(task) }, (error: unknown) => {
      pending.delete(task)
      console.error('Project activity request failed', error)
    })
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  }, 'ui-project-activity.requests')
  const targetFor = (sessionId: SessionId | undefined): SessionRuntimeTarget | undefined => {
    const owner = sessionId === undefined ? undefined
      : ctx.sessions.runtimeIdentityFor?.(sessionId) ?? parseClientSessionKey(sessionId)?.runtime
    if (owner !== undefined) return owner
    const policy = ctx.projectUiPolicy.getSnapshot()
    return policy.scope === 'project' && policy.projectId !== undefined
      ? { kind: 'project', projectId: policy.projectId } : undefined
  }
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-project-activity.copy')
  ctx.effect(() => {
    let disposeType: (() => void) | undefined
    const sync = (): void => {
      const inProject = targetFor(ctx.sessions.list.getSnapshot().current)?.kind === 'project'
      if (inProject && disposeType === undefined) {
        disposeType = ctx.sidebarRightTabs.register(activityDefinition(t))
      } else if (!inProject && disposeType !== undefined) {
        const dispose = disposeType
        disposeType = undefined
        dispose()
      }
    }
    sync()
    const unsubscribePolicy = ctx.projectUiPolicy.subscribe(sync)
    const unsubscribeSessions = ctx.sessions.list.subscribe(sync)
    return () => { unsubscribePolicy(); unsubscribeSessions(); disposeType?.() }
  }, 'ui-project-activity.scope')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ACTIVITY_ID, locale: namespace, store,
    inject: (sessionId, actions): ActivityInjected => {
      const target = targetFor(sessionId)
      return {
        ...activityRequests(target, actions, lifetime.signal, track),
        reveal: (sourceSessionId, seq, sourceRuntimeId) => {
          const viewport: ConversationViewport | undefined = ctx.get('conversationViewport')
          if (viewport === undefined) return
          const raw = sourceSessionId as SessionId
          const owner = target?.kind === 'project' && sourceRuntimeId !== undefined && sourceRuntimeId !== target.runtimeId
            ? { kind: 'project' as const, projectId: target.projectId, runtimeId: sourceRuntimeId } : target
          const key = owner === undefined ? raw : ctx.sessions.keyFor?.(raw, owner) ?? clientSessionKey(owner, raw)
          if (seq === null) viewport.replaceActive(key)
          else viewport.reveal(key, seq)
        },
      }
    },
  }, ActivityBody))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ACTIVITY_ID, locale: namespace,
  }, ActivityTitle))
}
