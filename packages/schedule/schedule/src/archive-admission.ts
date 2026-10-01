/**
 * The `schedule` family of the Workspace registry's archive admission: the
 * armed reminders of a Session's live root Agent, and their durable deletion
 * when the Session is archived with its work. A reminder is armed only
 * while its owning Session's root Agent is live — delivery is
 * session-local, and a Session with no Agent has nothing running — so only
 * a live root Agent's Session answers, reading the maintained projection
 * state rather than folding historical events.
 *
 * @module @deepseek-ai/dsh-schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from './projection.ts'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import type { ScheduleRecord } from './types.ts'
import { flushSchedulePersistence } from './persistence.ts'
import { runScheduleTransaction } from './transaction.ts'

/**
 * Answer `workspace/session-activity` with the Session's armed reminders,
 * and `workspace/session-stop` by durably deleting each of them through the
 * same agent-scoped queue the tools and the live owner serialize on. Both
 * listeners live as long as `ctx`'s fiber. Without the optional
 * `sessionProjections` service the maintained state this provider reads
 * does not exist, so the family stays silent and the stop removes nothing.
 * @param ctx - the plugin's registration context, carrying `agents` and `sessions`.
 * @param drive - recompute the exact owner's timers after a durable delete.
 */
export function installScheduleArchiveAdmission(ctx: Context, drive: (agent: Agent) => void): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const agent = armedOwner(ctx, sessionId)
    const active = agent === undefined ? [] : activeReminders(ctx, agent)
    const rest = await next()
    if (active.length === 0) return rest
    const own: SessionActivity = {
      kind: 'schedule',
      items: active.map(record => ({ id: record.id, label: record.prompt })),
    }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    const agent = armedOwner(ctx, sessionId)
    if (agent === undefined) return
    return runScheduleTransaction(agent, async () => {
      // Joining the exact owner's queue orders the stop behind a management
      // mutation or due dispatch still in flight, so the fold it deletes
      // from cannot miss a create that is about to commit.
      await flushSchedulePersistence(ctx, agent.session)
      const active = activeReminders(ctx, agent)
      if (active.length === 0) return
      // Every record is attempted: one append that throws must not leave a
      // sibling armed in the archived Session. The deletes that landed are
      // checkpointed before the first failure reaches the caller.
      let failure: Error | undefined
      for (const record of active) {
        try {
          agent.session.append('schedule/change', { version: 1, operation: 'delete', id: record.id })
        } catch (error: unknown) {
          failure ??= error instanceof Error ? error : new Error('Schedule change append failed', { cause: error })
        }
      }
      await flushSchedulePersistence(ctx, agent.session)
      drive(agent)
      if (failure !== undefined) throw failure
    })
  })
}

/** The live root Agent whose runtime arms the asked Session's reminders, when one exists. */
function armedOwner(ctx: Context, sessionId: SessionId): Agent | undefined {
  const agent = ctx.agents.get(sessionId)
  return agent !== undefined && ctx.agents.roots().includes(agent) ? agent : undefined
}

/** The Session's active reminder records from the maintained Schedule projection, or none when it is not composed. */
function activeReminders(ctx: Context, agent: Agent): readonly ScheduleRecord[] {
  try {
    return ctx.get('sessionProjections')?.stateOf(agent.session, 'schedule')?.active ?? []
  } catch {
    // An unreadable fold arms nothing: the live owner's own fold faults on the
    // same decode failure and every already-armed timer dies on its next wake
    // without dispatching, so this Session honestly reports no running work.
    return []
  }
}
