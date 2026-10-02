/**
 * Host Session-resolution contract published as the `sessionController`
 * cordis service. Non-session capabilities (Schedule, …) resolve a Session
 * identity to its live Agent through it — resuming a cold identity when the
 * composition allows — instead of duplicating the resolver's live/ownership/
 * admission rules. The file carries only the contract so consumers that do
 * not mount the rest of this package can reference it without a project
 * cycle: `agent-lookup.ts` owns the implementation.
 *
 * @module @deepseek-ai/dsh-api-remotes/session-controller
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Caller-facing failures preserved by the Gateway's RPC adapter. */
export type ApiRemoteLookupError =
  | { readonly code: 'agent-busy'; readonly message: string; readonly details: { readonly reason: string } }
  | { readonly code: 'session-not-found'; readonly message: string; readonly details: { readonly sessionId: SessionId } }
  | { readonly code: 'session-writer-held'; readonly message: string; readonly details: { readonly sessionId: SessionId } }
  /**
   * The session's durable execution binding (a managed SSH target) could not
   * be re-qualified for the joining caller — same wire code the managed
   * authorization service raises for a refused resolve.
   */
  | { readonly code: 'ssh/forbidden'; readonly message: string; readonly details: Record<never, never> }
  | { readonly code: 'internal'; readonly message: string; readonly details: Record<never, never> }

/** Result of resolving one session identity to its live Agent. */
export type ApiRemoteAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiRemoteLookupError }

/**
 * The Host Session-resolution surface published as the `sessionController`
 * cordis service.
 */
export interface ApiSessionController {
  /**
   * Resolve one Session identity to its live Agent.
   * @param sessionId - the Session identity to resolve.
   * @returns the live Agent, or a typed refusal preserving the resolver's code.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiRemoteAgentResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session resolution shared with non-session capabilities. */
    sessionController: ApiSessionController
  }
}
