/** Process-owned execution restrictions leave durable Session history readable. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A restored Session requires a fresh conversation before execution can continue. */
export interface AgentExecutionRestriction {
  readonly code: 'recovery-read-only'
  readonly message: string
}

/** Admission supplied before plugin composition and retained for the root Context lifetime. */
export interface AgentExecutionAdmission {
  /**
   * Inspect execution eligibility without loading or attaching the Session.
   * @param sessionId - exact durable identity.
   * @returns the reason execution is prohibited, or undefined when it is allowed.
   */
  restriction(sessionId: SessionId): AgentExecutionRestriction | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentExecutionAdmission: AgentExecutionAdmission
    /** Process-owned signal that closes Agent execution admission during planned shutdown. */
    agentShutdownSignal?: AbortSignal
  }
}

/** Execution refusal whose stable code can be displayed without losing the original target. */
export class AgentExecutionRestrictedError extends Error {
  /** Stable refusal shared by HTTP, RPC and client history views. */
  readonly code = 'recovery-read-only'
  /** @param sessionId - retained historical identity that must not execute. */
  constructor(readonly sessionId: SessionId) {
    super('This restored conversation is read-only. Start a new conversation to continue.')
    this.name = 'AgentExecutionRestrictedError'
  }
}

/**
 * Reject execution before loading a Session preset or constructing its Agent.
 * @param ctx - root or Agent scope inheriting process-owned admission.
 * @param ids - Session and parent identities touched by the operation.
 */
export function assertAgentExecutionAllowed(ctx: Context, ids: readonly (SessionId | undefined)[]): void {
  ctx.root.get('agentShutdownSignal')?.throwIfAborted()
  const admission = ctx.get('agentExecutionAdmission')
  if (admission === undefined) return
  for (const id of ids) {
    if (id !== undefined && admission.restriction(id) !== undefined) throw new AgentExecutionRestrictedError(id)
  }
}

/**
 * Install the immutable historical-Session restriction before mounting the recovered profile.
 * @param ctx - process-owned root Context, outside editable profile entries.
 * @param blockedIds - all Session identities retained by the approved recovery point.
 * @returns the root-lifetime registration disposer.
 */
export function installAgentExecutionAdmission(ctx: Context, blockedIds: readonly SessionId[]): () => void {
  const blocked = new Set(blockedIds)
  const restriction: AgentExecutionRestriction = Object.freeze({ code: 'recovery-read-only',
    message: 'This restored conversation is read-only. Start a new conversation to continue.' })
  return ctx.provide('agentExecutionAdmission', Object.freeze({
    restriction: (sessionId: SessionId) => blocked.has(sessionId) ? restriction : undefined,
  } satisfies AgentExecutionAdmission))
}
