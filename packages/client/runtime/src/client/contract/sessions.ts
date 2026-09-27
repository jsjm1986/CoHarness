/**
 * The outward sessions-service face — what `ctx.sessions` exposes to feature
 * packages and the renderer host, and therefore exactly what the test
 * runtime's sessions double must implement. Wire-pump entry points
 * (handleMuxEnvelope/handleConnected/refresh) and runtime internals stay on
 * the concrete class; cross-domain consumers keep the narrower
 * [SessionsPort](./sessions-port.ts). Widening this interface is the
 * explicit act of widening what features may do to the sessions domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  RpcResult, SessionId, SubagentAddress,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SessionMaybeProvideInfo, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReferenceSource } from '../index.ts'
import type { AgentContext } from '../scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type {
  SessionBinding, SessionListState, SessionProvideDescriptor,
} from '../sessions/service.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from './store.ts'

export type { AgentContext } from '../scope.ts'

/** Account Gateway target used to bind a workbench pane to one runtime. */
export type SessionRuntimeTarget = ConnectionRuntimeTarget

/** Known Session identity or durable direct-parent subagent address; an address owns no lifetime. */
export type SessionTarget = SessionId | SubagentAddress

/** One independent use of an exact Client generation, without Host Agent ownership. */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** Shared binding; access fails after reference release or generation disposal. */
  readonly binding: SessionBinding
  /** This reference's cancellable wait for the shared initial `Session.open()` attempt to settle. */
  readonly ready: Promise<SessionBinding>
  /** Release once; the final reference starts local scope and history teardown. */
  release(): void
}

/** Consumer identity and optional cancellation of one acquisition waiter. */
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  readonly signal?: AbortSignal | undefined
}

/** Local ownership counts, independent of catalog membership and never persisted. */
export interface SessionRetainInfo {
  readonly referenceCount: number
  /** Positive source counts only; a source without references is absent. */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /**
   * Begin an asynchronous navigation intent, superseding any earlier intent.
   * Selecting, clearing, scope changes, and owner disposal cancel it.
   * @returns cancellation to check before publishing a late navigation result.
   */
  beginNavigation(): AbortSignal
  /**
   * Retain an exact Client generation and start its shared initial history opening.
   * @param target - known identity or durable direct-parent address.
   * @param options - required consumer source and optional independent waiter cancellation.
   * @returns an owned reference immediately; await `reference.ready` when the initial open attempt must settle first.
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  /**
   * Hold one reference through callback settlement, including synchronous and asynchronous failures.
   * @param target - Session to acquire.
   * @param options - source and acquisition cancellation.
   * @param operation - callback using the reference only until its returned value or Promise settles.
   * @returns the callback result after release; acquisition and callback failures propagate unchanged.
   */
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  /**
   * Observe local reference counts without retaining, creating a scope, or opening history.
   * The returned source keeps stable identity across same-id generations and remains allocated
   * until the Client root is disposed, even after its final subscriber leaves.
   * @param id - explicit Session identity; Host existence is not implied.
   * @returns a stable read-only source across same-id generations, with zero counts when none is live.
   */
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  /** The useSessions standard feed (list rows + current selection; read face — writes stay inside the domain). */
  readonly list: ObservableSnapshot<SessionListState>
  /** Current authenticated space list; unlike list, it excludes staged workbench targets. */
  readonly currentScopeList?: ObservableSnapshot<SessionListState>
  /** Atomic current-session provide projection (the renderer host's `sessions.provideInfo` feed). */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  /** Resolve the standard-props bundle without selecting or staging a Session.
   * @param id - listed or retained Session identity.
   * @returns the bundle, or undefined when the identity cannot be resolved.
   */
  provideInfoFor(id: SessionId): SessionProvideInfo | undefined
  /**
   * The `session.search` result bound the wire schema fixes, exposed to
   * presentation as injected data. Not per-connection state: every transport
   * (fixture included) reports the same number.
   */
  readonly searchResultLimit: number
  /**
   * Select a session as current.
   * @param id - session id (must exist in the list; unknown ids fail loud).
   */
  open(id: SessionId): void
  /**
   * Open a healthy catalog child through its exact direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void
  /**
   * Resolve an already discovered direct-parent address without opening it.
   * @param id - possible addressed child id.
   * @returns the retained address, when present.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined
  /**
   * Mark whether a catalog menu is consuming live membership updates.
   * @param parentSessionId - catalog owner.
   * @param open - current menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void
  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   * @returns completion of the current or newly started refresh.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void>

  /**
   * Record the composition one session now runs. The agent-preset seat calls
   * this after a successful blank-session switch, so the header label moves
   * with the composition instead of waiting for the next full list refresh.
   * @param sessionId - the switched session.
   * @param agentPreset - the preset id the host confirmed.
   */
  noteAgentPreset(sessionId: SessionId, agentPreset: string): void
  /** Clear the current selection into the no-session view state. */
  clear(): void
  /** Replace additional history windows retained alongside the current Session.
   * @param ids - eligible Session identities; duplicates and unknown ids are ignored.
   */
  setAdditionalStaged(ids: readonly SessionId[]): void
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * Fork a session from a completed-turn prefix of the source; on resolution
   * the child is in the list store and `open()` can target it.
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * Register a per-session standard-props provider (hooks become `use<Name>`
   * selector hooks on the render side; props spread verbatim).
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider.
   */
  provide(descriptor: SessionProvideDescriptor): () => void
  /**
   * Borrow an already-retained Agent-scoped context without extending its lifetime.
   * @param id - session id.
   * @returns the live context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * Read the Agent scope tag off a context (service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - an Agent-scoped context.
   * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
   */
  sessionOf(ctx: Context): SessionFace | undefined
  /**
   * Borrow an already-retained Session binding without extending its lifetime.
   * @param id - session id.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined
  /** Ensure an account-visible session is loaded into its target runtime.
   * @param target - account runtime that owns the session's workbench binding.
   * @param id - listed session identity to materialize.
   * @returns whether the runtime accepted the load; false means the session stays list-only.
   */
  ensureSession?(target: SessionRuntimeTarget, id: SessionId): Promise<boolean>
  /** Create a new conversation in an explicitly selected account runtime.
   * @param target - account runtime that hosts the new session.
   * @returns the created session identity.
   */
  createSession?(target: SessionRuntimeTarget): Promise<SessionId>
  /** Reconcile the bootstrap connection with the account's current scope.
   * @param target - runtime the account scope now resolves to.
   */
  setBaseRuntimeTarget?(target: SessionRuntimeTarget): void
  /** Resolve the durable runtime identity, including a Session using the base connection.
   * @param id - known Session identity.
   * @returns its account runtime, or undefined when ownership is unknown.
   */
  runtimeIdentityFor?(id: SessionId): SessionRuntimeTarget | undefined
  /** Resolve an alternate transport target for one Session.
   * @param id - session identity to locate.
   * @returns the alternate target; undefined also denotes the existing base connection.
   */
  runtimeTargetFor?(id: SessionId): SessionRuntimeTarget | undefined
}
