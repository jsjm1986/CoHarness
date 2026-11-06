/**
 * Cross-domain sessions face: the contract surface sibling domains (today:
 * workspaces) consume instead of the sessions implementation. The sessions
 * domain satisfies it structurally — SessionRuntime is assignable, checked
 * wherever the assembly layer or a test injects the real service — so
 * widening this face is the explicit act of widening the inter-domain
 * dependency.
 */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from './sessions.ts'
import type { SessionCreateOptions } from './session-create.ts'
import type { ObservableSnapshot } from './store.ts'
import type { SessionRuntimeTarget } from './sessions.ts'
import type { WorkspaceListSnapshot } from '../workspaces/manager.ts'

/** One connected Runtime's live Workspace projection. */
export interface RuntimeWorkspaceSnapshot {
  target: SessionRuntimeTarget
  state: WorkspaceListSnapshot
}

/** Session-list row facts sibling domains read: recency, blank-reuse eligibility, and its cwd canon. */
export interface SessionsPortSummary {
  id: SessionId
  /** No-visible-content bit (blank sessions are reused by Workspace reconnect instead of minting another). */
  blank: boolean
  /** Highest visible-content event sequence known to the Host or live stream. */
  visibleContentSeq?: number
  /** Durable subagent origin; Workspace entry never selects these as the default conversation. */
  origin?: 'subagent'
  cwd?: string
  /** Preset the Session's log records; a cached hint for cold rows, absent with no roster. */
  agentPreset?: string
  /** Client-local Workspace association retained while a Session is blank. */
  workspaceId?: WorkspaceId
  updatedAt: number
}

/** Session-list facts sibling domains read: readiness, selection, and the row maps. */
export interface SessionsPortList {
  ids: SessionId[]
  byId: Record<SessionId, SessionsPortSummary>
  /**
   * Archived summaries partitioned out of `byId`, merged across every pooled
   * runtime; an archived-elsewhere check that reads only `byId` or one
   * runtime's mirror mis-classifies the session.
   */
  archivedById: Record<SessionId, SessionsPortSummary>
  current: SessionId | undefined
  phase: 'pending' | 'ready'
}

/** The sessions-service face injected into sibling domains. */
export interface SessionsPort extends Pick<ISessions, 'retain' | 'keyFor' | 'runtimeTargetFor' | 'usingRuntime' | 'createSession'> {
  /** Workspace frames from explicitly opened foreign Runtimes; reading starts no transport. */
  readonly workspaceSnapshots?: ObservableSnapshot<readonly RuntimeWorkspaceSnapshot[]>
  /**
   * Begin an asynchronous navigation intent, superseding any earlier intent.
   * Selecting, clearing, scope changes, and owner disposal cancel it.
   * @param options - Optional originating composer to hold until preparation settles.
   * @returns cancellation to check before publishing a late navigation result.
   */
  beginNavigation(options?: { readonly blockInputFor?: SessionId | undefined }): AbortSignal
  /** Release only the input hold owned by the original intent.
   * @param signal - Intent returned by beginNavigation.
   */
  finishNavigation(signal: AbortSignal): void
  /** Observable list snapshot (read face only; writes stay inside the sessions domain). */
  readonly list: ObservableSnapshot<SessionsPortList>
  /**
   * Prepare one root-session request, reuse the first plugin-compatible blank
   * candidate, or create a fresh session on the Host.
   * @param opts - target workspace and plugin-owned create options.
   * @param reusableSessionIds - blank candidates already validated by the owning domain.
   * @returns the reused or newly created session id.
   */
  createOrReuse(
    opts: SessionCreateOptions & { workspaceId: WorkspaceId },
    reusableSessionIds: readonly SessionId[],
  ): Promise<SessionId>
  /**
   * Create or adopt a Session the request names directly — the reuse-candidate
   * path when `reuseWorkspaceBlank` is set, an explicit adoption otherwise. A
   * named create skips the blank-confirmation waterfall: the caller names the
   * exact Session rather than offering candidates.
   * @param opts - caller-selected create options.
   * @returns the created, reused, or adopted session id.
   */
  create(opts?: SessionCreateOptions): Promise<SessionId>
  /**
   * Select a session as current.
   * @param id - session id (must exist in the list store).
   * @param options - `activate: false` keeps the presented Session cold
   *   (startup restore never publishes an Agent on its own).
   */
  open(id: SessionId, options?: { activate?: boolean }): void
  /**
   * Whether the Session was selected through an explicit open during this
   * connection lifetime; ambient restores use it to yield a selection the
   * user committed rather than superseding it.
   * @param id - runtime-qualified session id.
   */
  isActivated(id: SessionId | undefined): boolean
  /** Clear the current selection into the no-session view state. */
  clear(): void
}
