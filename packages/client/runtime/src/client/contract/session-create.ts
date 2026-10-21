import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionDraftId, SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'

/** Browser-owned options for creating one root session through the Host API. */
export interface SessionCreateOptions {
  /** Client-only owner for preparation hooks; never sent to the Host create API. */
  readonly runtimeTarget?: ConnectionRuntimeTarget
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  /** Stable browser draft reservation key. */
  readonly draftId?: SessionDraftId
  /** Project-conversation visibility supplied by an optional collaboration plugin. */
  readonly visibility?: 'project' | 'private'
  /** Registered SSH target the session executes on; fixed at creation. */
  readonly sshTarget?: number
  /** Agent preset the conversation runs; the deployment default when omitted. */
  readonly agentPreset?: string
  /**
   * Treat `sessionId` as a blank-reuse candidate instead of an explicit
   * adoption: the Host leaves a candidate that filled or lost its writer
   * untouched and answers a fresh Session. Only meaningful with `sessionId`.
   */
  readonly reuseWorkspaceBlank?: boolean
}

/** One existing blank session offered against fully prepared root-create options. */
export interface SessionBlankReuseRequest {
  readonly sessionId: SessionId
  readonly options: SessionCreateOptions
}
