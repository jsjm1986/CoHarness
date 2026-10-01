/**
 * The archive-admission surface the Workspace registry installs itself: the
 * `turn` family of its admission events, and the `agent/pre-step` gate that
 * keeps an archived Session — or a subagent descendant of one — from running
 * a model step until it is restored. The Agent registry cannot install
 * either — this repo's session-persistence → format-catalog chain makes
 * workspace transitively reachable from the Agent program, so an Agent →
 * Workspace import would close a project-reference cycle — so the registry
 * answers for every Agent the `agents` service publishes and reads its own
 * durable archive set for the gate.
 *
 * @module @deepseek-ai/dsh-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from './types.ts'

/**
 * Answer `workspace/session-activity` with the `turn` family while the
 * Session's Agent is running (a turn waiting for an approval or an answer
 * included), `workspace/session-stop` by cancelling that turn the way the
 * user's own stop does — `agent.cancel({ kind: 'user' })`, but without the
 * stop button's `keepInbox`, so queued input is discarded with a logged
 * inbox splice instead of waking the archived Session later — and
 * `agent/pre-step` with a rejection whenever an archived Session owns the
 * proposed step. Stops are issued without awaiting settlement; the written
 * archive set is what the gate reads, so every wake a stop induces — a
 * cancelled child's settlement, a queued follow-up — is already blocked.
 * All listeners live as long as `ctx`'s fiber.
 * @param ctx - the registry's registration context.
 * @param lookup - live-Agent lookup by Session id.
 * @param isArchived - durable archive-set membership by Session id.
 */
export function installArchiveAdmission(
  ctx: Context,
  lookup: (sessionId: SessionId) => Agent | undefined,
  isArchived: (sessionId: SessionId) => boolean,
): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = lookup(sessionId)?.status === 'running'
    const rest = await next()
    if (!running) return rest
    const own: SessionActivity = { kind: 'turn' }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    const agent = lookup(sessionId)
    if (agent?.status === 'running') agent.cancel({ kind: 'user' })
  })
  ctx.on('agent/pre-step', ({ agent }, next) =>
    underArchivedSession(ctx, agent, isArchived)
      ? Promise.resolve({ kind: 'reject' as const })
      : next())
}

/**
 * Whether the Agent's Session, or a Session above it in its subagent lineage,
 * is archived. Lineage follows the durable header fields through
 * subagent-origin Sessions only: a fork of an archived Session is an
 * independent conversation.
 * @param ctx - Host context.
 * @param agent - the Agent proposing a step.
 * @param isArchived - durable archive-set membership by Session id.
 * @returns whether an archived Session owns the step.
 */
function underArchivedSession(ctx: Context, agent: Agent, isArchived: (sessionId: SessionId) => boolean): boolean {
  let header = agent.session.header
  const visited = new Set<SessionId>()
  while (!visited.has(header.id)) {
    if (isArchived(header.id)) return true
    visited.add(header.id)
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    const parent = ctx.get('sessions')?.get(header.parentSession)
    if (parent === undefined) return isArchived(header.parentSession)
    header = parent.header
  }
  return false
}
