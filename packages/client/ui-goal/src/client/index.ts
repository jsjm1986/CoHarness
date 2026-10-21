/**
 * Goal dock and command-input presentation. Durable goal state comes from the
 * Session projection; process-local activation comes from Goal Remote reads
 * and forwarded events. Mutations read the current projected CAS ref at call
 * time. Goal creation belongs to the /goal Host command.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `goal` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type { GoalProjection, GoalRef } from '@deepseek-ai/dsh-goal/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GoalActionResult, GoalBarInjected } from './slots.ts'
import { createGoalActivationSource } from './activation-source.ts'
import { GoalDock } from './GoalBar.tsx'
import { GoalCommandInputView } from './GoalCommandInputView.tsx'
import { goalCommandInputDefinition } from './goal-command-input.ts'
import { en, zh, type GoalKey } from './locales.ts'

export { GoalBar, GoalDock } from './GoalBar.tsx'
export type { GoalActionResult, GoalBarActions } from './slots.ts'
export type { GoalKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal strip's copy. */
    goal: GoalKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'goal'

/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents']

/**
 * Client plugin body: the GoalBar dock entry with its mutation verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(goalCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command-input',
    locale: NS,
  }, GoalCommandInputView))

  const sessions = ctx.sessions

  /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
  const refOf = (sessionId: SessionId): GoalRef | undefined => {
    const face = sessions.binding(sessionId)?.session.projections.faceOf('goal')
    const projection = face?.getSnapshot() as GoalProjection | null | undefined
    if (projection == null) return undefined
    return { id: projection.goal.id, revision: projection.goal.revision }
  }

  const noCurrentGoal: GoalActionResult = {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate' },
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal',
    order: 10,
    locale: NS,
    inject: (sessionId): GoalBarInjected => {
      const binding = sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`ui-goal: session "${sessionId}" is unavailable`)
      const goalActivation = createGoalActivationSource({
        projection: binding.session.projections.faceOf('goal') as HostObservable<GoalProjection | null | undefined>,
        session: binding.session,
        getGoal: () => ctx.remote.goals.get(sessionId),
        subscribeActivation: listener => ctx.remote.$on('goal/activation-changed', (event) => {
          if (event.sessionId === sessionId) listener(event.goal)
        }),
        subscribeReset: listener => ctx.on('connection/reset', listener),
      })
      return {
        hooks: { goalActivation },
        onEdit: async (objective) => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.edit(sessionId, ref, { objective })
        },
        onPause: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.pause(sessionId, ref)
        },
        onResume: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.resume(sessionId, ref)
        },
        onClear: async () => {
          const ref = refOf(sessionId)
          if (ref === undefined) return noCurrentGoal
          return await ctx.remote.goals.clear(sessionId, ref)
        },
      }
    },
  }, GoalDock))
}
