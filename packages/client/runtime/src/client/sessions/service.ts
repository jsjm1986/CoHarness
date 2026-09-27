/** Session catalog, view references, local scope generations, and renderer bindings. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type {
  IApiClient, RpcError, RpcResult, SessionId, SubagentAddress, WorkspaceId, JobView,
} from '@deepseek-ai/dsh-api-remotes/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  HostObservable, SessionMaybeProvideInfo, SessionProvideInfo,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionCreateOptions } from '../contract/session-create.ts'
import type { SessionReferenceSource } from '../index.ts'
import type { ObservableSnapshot } from '../contract/store.ts'
import type { SessionReference, SessionTarget, SessionRetainOptions, SessionRetainInfo } from '../contract/sessions.ts'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionFace } from '../contract/session.ts'
import type { AgentContext, ISessions } from '../contract/sessions.ts'
import { NavigationController } from '../navigation.ts'
import { createScope, scopeIdentityOf, scopeOf as scopeTagOf } from '../scope.ts'
import type { ConversationRuntime } from './conversation-assembler.ts'
import { SessionManager } from './manager.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './manager.ts'
import type { PendingInteractionStatus } from './pending.ts'
import { SessionProvideChannel } from './provide.ts'
import type { Session } from './session.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  /**
   * Client-local Workspace association for a blank Session while Host
   * membership is catching up. It keeps the current blank row beside the
   * Workspace during that interval and is never sent on the wire.
   */
  workspaceId?: WorkspaceId
  /** Account catalog label for a project runtime session. */
  workspaceName?: string
  /**
   * Agent preset this session's agent was composed from; absent when the
   * deployment composes no presets. The session header labels what the
   * session actually runs rather than the deployment's current default.
   */
  agentPreset?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  running: boolean
  /** User interaction currently blocking this session (sidebar amber-dot state). */
  pendingInteraction?: PendingInteractionStatus
  /** Finished while not selected and not yet opened — the sidebar's green "done" reminder. Absent = false. */
  completed?: boolean
  /**
   * No-visible-content bit (host summary derivation mirror). New Session reuses a blank
   * one targeting the same workspace. Filtering stays with the consumer: the
   * store carries every row, while the Workspace browser shows only the
   * selected blank entry.
   */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
  /**
   * Collaboration visibility for this session in a project runtime.
   * Present only for project-scoped sessions; personal scope omits it.
   */
  visibility?: 'project' | 'private'
  /** Owning project id, when this session belongs to a project runtime. */
  projectId?: number
}

/**
 * Session list store shape. `current` rides the same snapshot (arbitrated:
 * the single useSessions standard hook reads list and selection together —
 * sidebar highlighting and SessionProvider share one fact source).
 */
export interface SessionListState {
  /** Host-list order; addressed breadcrumb-only rows are excluded. */
  ids: SessionId[]
  /** Host rows plus the current addressed subagent route used by navigation. */
  byId: Record<SessionId, SessionSummary>
  /**
   * Summaries the Workspace-domain archive filter keeps out of `ids`/`byId`.
   * A runtime with no archive view leaves this empty and keeps every Host row
   * inside `byId`, so a restore surface reads `byId[id] ?? archivedById[id]`.
   */
  archivedById: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  /** Direct durable catalogs keyed by their selected parent address. */
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /**
   * Background jobs each session can see, mirrored last-wins from
   * `session/jobs`. A missing key is an empty set — the Host sends no baseline
   * for a session without tasks — so consumers read absence, never a sentinel.
   */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  /** Current session's catalog-derived address, absent on ordinary navigation. */
  currentAddress: SubagentAddress | undefined
}

/** Persisted navigation cell: address survives refresh for correct history routing. */
interface SessionSelection {
  sessionId?: SessionId
  subagentAddress?: SubagentAddress
}

/** Structured session-create failure. */
export class SessionCreateError extends Error {
  override readonly name = 'SessionCreateError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param requestedSessionId - caller-preallocated id used for later stream/list reconciliation.
   */
  constructor(
    readonly rpcError: RpcError,
    readonly requestedSessionId: SessionId | undefined,
  ) {
    super(`session create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Structured session-fork failure. */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param sourceSessionId - the session the fork was cut from.
   */
  constructor(
    readonly rpcError: RpcError,
    readonly sourceSessionId: SessionId,
  ) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Session assembly handle for SessionProvider/inject factories (identity-stable per session). */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  readonly ctx: AgentContext
  /** Description of the exact connection that owns this Session. */
  readonly hostDescription?: HostDescriptionSource
}

// Scope primitives live in ../scope.ts (the client mirror of host
// dsh-scope, keyed by Agent identity); re-exported here so existing
// consumers keep their import site.
export { scopeOf } from '../scope.ts'

/**
 * Workspace display title of a session cwd: the path's last non-empty
 * segment (both separators accepted; trailing separators ignored), or ''
 * for separator-only paths — callers own their fallback (session id, raw
 * cwd, default-directory copy). The repo-wide single basename derivation —
 * every surface naming a workspace (picker rows, toggle labels, list titles)
 * calls this instead of re-splitting paths.
 * @param cwd - workspace directory path.
 * @returns basename title, or '' when no non-empty segment exists.
 */
export function workspaceTitleOf(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
}

/**
 * Display title projection: durable title, project directory basename, then
 * the raw id.
 */
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  if (title !== undefined) return title
  if (cwd !== undefined && cwd !== '') {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

/**
 * Increment a trailing fork number while preserving its half-width or
 * full-width parentheses; an unnumbered title starts with ` (1)`.
 * @param title - source session's durable title.
 * @returns the title assigned to the fork child.
 */
function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

/** Source labels are dictionary keys, including names also present on Object.prototype. */
function freezeRetainedBy(counts: Partial<Record<SessionReferenceSource, number>>): SessionRetainInfo['retainedBy'] {
  Object.setPrototypeOf(counts, null)
  return Object.freeze(counts)
}

const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: freezeRetainedBy({}) })

/** Shared empty `archivedById` for runtimes with no Workspace-domain archive filter. */
const NO_ARCHIVED_SUMMARIES: Record<SessionId, SessionSummary> = {}

interface ScopeRecord {
  retention: SessionRetainInfo
  ended: AbortController
  fiber: Fiber
  ctx: AgentContext
  binding: SessionBinding
  /** The concrete Session for runtime-internal stage entry/leave; the binding carries only the outward face. */
  session: Session
  /** Render-layer standard-props bundle (identity-stable per scope; the renderer's per-info caches key off it). */
  provideInfo: SessionProvideInfo
}

interface RetentionObserver {
  readonly source: ObservableSnapshot<SessionRetainInfo>
  readonly listeners: Set<() => void>
  published: SessionRetainInfo
}

/** A cancelled waiter releases only its own reference, not the shared opening. */
async function waitForOpen(opening: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return opening
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) onAbort()
    await Promise.race([opening, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

class ClientSessionReference implements SessionReference {
  private readonly released = new AbortController()
  private readonly readiness = Promise.withResolvers<SessionBinding>()
  readonly ready = this.readiness.promise

  constructor(
    readonly sessionId: SessionId,
    private record: ScopeRecord | undefined,
    private releaseReference: (() => void) | undefined,
  ) {
    void this.ready.catch(() => {})
  }

  get binding(): SessionBinding {
    if (this.record === undefined || this.record.ended.signal.aborted) throw new Error(`Session reference "${this.sessionId}" is released`)
    return this.record.binding
  }

  attachOpening(opening: Promise<void>, signal?: AbortSignal): void {
    const signals = [this.released.signal]
    if (this.record !== undefined) signals.push(this.record.ended.signal)
    if (signal !== undefined) signals.push(signal)
    const waitSignal = AbortSignal.any(signals)
    void waitForOpen(opening, waitSignal).then(
      () => {
        try {
          waitSignal.throwIfAborted()
          this.readiness.resolve(this.binding)
        } catch (error: unknown) {
          this.readiness.reject(error)
        }
      },
      (error: unknown) => { this.readiness.reject(error) },
    )
  }

  release(): void {
    const reason = new Error(`Session reference "${this.sessionId}" is released`)
    const release = this.releaseReference
    this.released.abort(reason)
    this.readiness.reject(reason)
    this.record = undefined
    this.releaseReference = undefined
    release?.()
  }

  [Symbol.dispose](): void {
    this.release()
  }
}

/** One plugin's per-session standard-props contribution (see {@link SessionRuntime.provide}). */
export interface SessionProvideContribution {
  /** Bare observable sources, keyed by hook base name ('input' → useInput). */
  hooks?: Record<string, HostObservable<unknown>>
  /** Stable plain members (action callbacks etc.), spread into standard props verbatim. */
  props?: Record<string, unknown>
}

/**
 * Static declaration plus per-session resolver for one standard-kit
 * contribution. The declared names let the renderer construct the same hook
 * and prop surface while no session is current.
 */
export interface SessionProvideDescriptor {
  /** Hook base names (`input` becomes `useInput`). */
  hooks?: readonly string[]
  /** Plain standard-prop names. */
  props?: readonly string[]
  /** Resolve every declared member for one definite session. */
  resolve(binding: SessionBinding): SessionProvideContribution
}

/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, and breadcrumb routes. */
export class SessionRuntime implements ISessions {
  /**
   * The wire schema's own result bound, re-exposed for presentation plugins as
   * injected data. Not per-connection state: the `session.search` response
   * schema caps `items` at this constant, so every transport (fixture included)
   * reports the same number.
   */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  /** List snapshot store (list RPC + host stream increments; re-pulled on reconnect) — the useSessions standard feed, current included. */
  readonly list: SnapshotStore<SessionListState>
  /** The object-layer instance cluster and frame dispatch entry. */
  private readonly manager: SessionManager
  /**
   * Atomic current-session provide projection: selection changes and
   * provider-roster changes publish through this one source (the renderer
   * host's `sessions.provide` feed), so a roster change under a stable
   * current id republishes the bundle instead of stranding mounted entries.
   */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>

  /**
   * Persisted selection cell (the durable half of `list.current`). Private on
   * purpose: reads go through the list snapshot; writes through {@link
   * SessionRuntime.open} / {@link SessionRuntime.clear}. The in-memory
   * projection is non-destructive — a masked current resurfaces when its
   * session returns — but a projection with no current also wipes this cell,
   * so a reload lands on empty even when the live selection would have
   * resurfaced a masked id.
   */
  private readonly selection: SnapshotStore<SessionSelection>

  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** The provide channel (roster, materialization rules, current projection) — shared with the test runtime's double. */
  private readonly provideChannel: SessionProvideChannel
  /** Extra windows requested by a multi-pane surface and their active stage set. */
  private readonly additionalStaged = new Set<SessionId>()
  private readonly staged = new Map<SessionId, SessionReference>()
  private reconcilingStage = false
  private pendingStage: { current: SessionId | undefined; preserveMaskedCurrent: boolean } | undefined
  private readonly retainObservers = new Map<SessionId, RetentionObserver>()
  private closed = false
  private readonly navigation = new NavigationController()
  /** Last selected id retained across a transient list mask on reconnect. */
  private watched: SessionId | undefined
  /** Scope-fiber teardowns in progress; root disposal waits for every one. */
  private readonly pendingScopeDisposals = new Set<Promise<void>>()
  private readonly hostDescription: HostDescriptionSource | undefined

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param api - wire client shared with every Session.
   * @param remote - generated Remote namespaces shared with every Session.
   * @param conversationRuntime - same-pass registry instances, when runtime apply owns them.
   * @param options - optional selection persistence and service-registration controls.
   */
  constructor(
    private readonly rootCtx: Context,
    api: IApiClient,
    remote: SessionRemotes,
    conversationRuntime?: ConversationRuntime,
    options: { persistSelection?: boolean; provideService?: boolean; hostDescription?: HostDescriptionSource } = {},
  ) {
    this.hostDescription = options.hostDescription
    rootCtx.effect(() => () => { this.navigation.dispose() }, 'sessions: navigation lifetime')
    this.selection = createSnapshotStore<SessionSelection>(
      {},
      options.persistSelection === false ? undefined : { persist: { name: 'dsh.sessions.current' } })
    const restored = this.selection.getSnapshot()
    const conversationEvents = rootCtx.get('conversationEvents')
    const conversationViews = rootCtx.get('conversationViews')
    const conversation = conversationRuntime ?? (
      conversationEvents === undefined || conversationViews === undefined
        ? undefined
        : { events: conversationEvents, views: conversationViews }
    )
    this.manager = new SessionManager(
      api,
      remote,
      restored.sessionId,
      restored.subagentAddress,
      conversation,
    )
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'pending',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    // The manager owns wire truth; the store is its projection. Manager
    // notifications are already microtask-batched.
    const disposeManagerSubscription = this.manager.subscribe(() => { this.projectList() })
    // Selection and Workbench windows acquire ordinary references. Reentrant
    // retention observers queue another reconciliation after ownership is published.
    const disposeListSubscription = this.list.subscribe(() => {
      this.followCurrent()
      this.provideChannel.publishCurrent()
    })
    rootCtx.effect(() => () => {
      disposeManagerSubscription()
      disposeListSubscription()
      this.manager.dispose()
    }, 'sessions: manager and list subscriptions')
    this.provideChannel = new SessionProvideChannel({
      rebuildBundles: () => {
        for (const record of this.scopes.values()) {
          record.provideInfo = this.provideChannel.materializeInfo(record.binding)
        }
      },
      resolveCurrent: () => this.maybeProvideInfo(this.list.getSnapshot().current),
    })
    this.currentProvideInfo = this.provideChannel.currentProvideInfo
    let registryRebuildQueued = false
    const scheduleRegistryRebuild = (): void => {
      if (registryRebuildQueued) return
      registryRebuildQueued = true
      queueMicrotask(() => {
        registryRebuildQueued = false
        this.manager.rebuildConversationRegistry()
      })
    }
    if (conversation !== undefined) {
      rootCtx.effect(() => {
        const disposeEvents = conversation.events.subscribe(scheduleRegistryRebuild)
        const disposeViews = conversation.views.subscribe(scheduleRegistryRebuild)
        return () => {
          disposeEvents()
          disposeViews()
        }
      }, 'sessions: conversation registry rebuild')
    }
    // Root shutdown invalidates references before draining generation teardown.
    rootCtx.effect(() => async () => {
      this.closed = true
      this.additionalStaged.clear()
      this.watched = undefined
      this.staged.clear()
      for (const [id, record] of this.scopes) {
        record.ended.abort(new Error(`Session generation "${id}" is disposed`))
        this.scopes.delete(id)
        this.publishRetention(id)
        this.scheduleDrop(id, record)
      }
      while (this.pendingScopeDisposals.size > 0) {
        const results = await Promise.allSettled([...this.pendingScopeDisposals])
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason as unknown)
        if (failures.length > 0) {
          throw new AggregateError(failures, 'client session scope disposal failed')
        }
      }
      for (const observer of this.retainObservers.values()) observer.listeners.clear()
    }, 'sessions: scope disposal')
    if (options.provideService !== false) rootCtx.reflect.provide('sessions', this, undefined)
  }

  beginNavigation(): AbortSignal {
    return this.navigation.begin()
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const { source, signal } = options
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Session Controller is disposed')
    const id = typeof target === 'string' && this.scopes.has(target) ? target : this.manager.resolveTarget(target)
    const reference = this.retainScope(id, source)
    try {
      this.manager.get(id).enterStage()
      reference.attachOpening(this.manager.get(id).open(), signal)
      return reference
    } catch (error) {
      reference.release()
      throw error
    }
  }

  async using<T>(
    target: SessionTarget,
    options: SessionRetainOptions,
    operation: (reference: SessionReference) => T | Promise<T>,
  ): Promise<T> {
    const reference = this.retain(target, options)
    try {
      await reference.ready
      return await operation(reference)
    } finally {
      reference.release()
    }
  }

  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let observer = this.retainObservers.get(id)
    if (observer === undefined) {
      const listeners = new Set<() => void>()
      observer = {
        listeners,
        published: this.retentionSnapshot(id),
        source: {
          getSnapshot: () => this.retentionSnapshot(id),
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      }
      this.retainObservers.set(id, observer)
    }
    return observer.source
  }

  /**
   * Register a per-session standard-props provider: every session-scope slot
   * component receives the contributed members as standard props (`hooks`
   * sources become `use<Name>` selector hooks on the render side; `props`
   * spread verbatim). Contributions materialize lazily with the session's
   * scope record and die with it. Registration order is resolution order;
   * duplicate member names fail loud at materialization.
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider (already-materialized bundles keep their members until their scope drops).
   */
  provide(descriptor: SessionProvideDescriptor): () => void {
    // Scopes may already exist (boot order: the list lands and resolves
    // scopes before later plugins register) — the channel rebuilds their
    // bundles through the host hooks so every provider lands by first render.
    return this.provideChannel.provide(descriptor)
  }

  /**
   * Select a listed or retained catalog-addressed session as current.
   * @param id - listed or addressed session id.
   */
  open(id: SessionId): void {
    this.beginNavigation()
    this.manager.select(id)
  }

  /**
   * Open a healthy catalog child through its direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void {
    this.beginNavigation()
    this.manager.selectSubagent(address)
  }

  /**
   * Resolve an already discovered direct-parent address without opening it.
   * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
   * @param id - possible addressed child id.
   * @returns The retained address, when present.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * Inform the runtime whether a catalog menu is consuming membership updates.
   * @param parentSessionId - selected parent.
   * @param open - menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    this.manager.setSubagentCatalogOpen(parentSessionId, open)
  }

  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    return this.manager.refreshSubagents(parentSessionId)
  }

  noteAgentPreset(sessionId: SessionId, agentPreset: string): void {
    this.manager.noteAgentPreset(sessionId, agentPreset)
  }

  /**
   * Clear the current selection so the layout shows the no-session empty
   * state (new-session affordance and the workspace preselection flow).
   * Wipes the persisted selection too — a reload stays on empty until the
   * user opens or starts a session. The explicit clear also releases the
   * staged browser history window; a transient list mask does not.
   */
  clear(): void {
    this.beginNavigation()
    this.watched = undefined
    this.manager.clearSelection()
  }

  /** Replace the additional staged sessions retained by a multi-pane view. */
  setAdditionalStaged(ids: readonly SessionId[]): void {
    this.additionalStaged.clear()
    for (const id of ids) {
      if (this.eligible(id)) this.additionalStaged.add(id)
    }
    this.reconcileStage(this.list.getSnapshot().current, true)

  }

  /**
   * Refresh the real Session baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refreshList()
  }

  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.manager.search(query, signal)
  }

  /**
   * Route a mux stream envelope into the Session object layer.
   * @param envelope - validated mux stream envelope.
   */
  handleMuxEnvelope(envelope: Parameters<SessionManager['handleMuxEnvelope']>[0]): void {
    this.manager.handleMuxEnvelope(envelope)
  }

  /**
   * Route a Host stream envelope into the Session object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<SessionManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Session baseline and every opened window after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  /** Drop generation-scoped live interaction state the moment a connection generation dies. */
  handleDisconnected(): void {
    this.manager.handleDisconnected()
  }

  /**
   * Create a Host Session and publish its catalog row before resolving.
   * Callers retain the returned identity before borrowing its binding.
   * @param opts - target workspace or directory and an optional preallocated id.
   * @returns the new session id.
   * @throws {SessionCreateError} with the requested id.
   */
  async create(opts: SessionCreateOptions = {}): Promise<SessionId> {
    return this.createPrepared(await this.prepareCreate(opts))
  }

  /**
   * Prepare one root-session request, reuse the first blank candidate every
   * plugin confirms, or create a fresh Host session with the same prepared
   * options. Candidate discovery remains with the owning Workspace domain.
   * @param opts - caller-selected create options.
   * @param reusableSessionIds - blank candidates in preferred order.
   * @returns the reused or newly created session id.
   */
  async createOrReuse(
    opts: SessionCreateOptions,
    reusableSessionIds: readonly SessionId[],
  ): Promise<SessionId> {
    const prepared = await this.prepareCreate(opts)
    for (const sessionId of reusableSessionIds) {
      const reusable = await this.rootCtx.waterfall(
        'sessions/confirm-blank-reuse',
        { sessionId, options: prepared },
        () => Promise.resolve(true),
      )
      if (reusable) return this.createPrepared(prepared, sessionId)
    }
    return this.createPrepared(prepared)
  }

  private prepareCreate(opts: SessionCreateOptions): Promise<SessionCreateOptions> {
    return this.rootCtx.waterfall(
      'sessions/prepare-create', opts, () => Promise.resolve(opts),
    )
  }

  private async createPrepared(prepared: SessionCreateOptions, reuseSessionId?: SessionId): Promise<SessionId> {
    const sessionId = reuseSessionId ?? prepared.sessionId
    // A reservation belongs only to a newly minted draft. Reusing an existing
    // blank session must not attach or consume another tab's reservation key.
    const request = reuseSessionId === undefined
      ? prepared
      : (() => {
        const { draftId: _draftId, ...rest } = prepared
        return { ...rest, sessionId: reuseSessionId }
      })()
    const result = await this.manager.create(
      request,
      reuseSessionId !== undefined,
    )
    if (!result.ok) throw new SessionCreateError(result.error, sessionId)
    this.projectList()
    return result.value.sessionId
  }

  /**
   * Fork a session from a completed-turn prefix of the source (same
   * synchronous-addressability guarantee as {@link SessionRuntime.create}:
   * on resolution the child is in the list store and open() can target it).
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   *   A fractional anchor floors to a real event seq: the frozen nodes of an
   *   interrupted turn carry flow-ordering seqs between two events, and the
   *   wire takes integers only.
   * @returns the child session id.
   * @throws {SessionForkError} with the source id.
   * @throws {Error} when a requested child-title rename fails after creation.
   */
  async fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
  }): Promise<SessionId> {
    const sourceTitle = opts.increaseTitle
      ? this.list.getSnapshot().byId[opts.sessionId]?.title
      : undefined
    const result = await this.manager.fork({
      sessionId: opts.sessionId,
      // Flooring lands inside the anchor's own turn (every turn opens with a
      // turn/start), so the host's first-turn/end-at-or-after cut still ends
      // on that turn — never clipped back to the previous one.
      ...(opts.atSeq === undefined ? {} : { atSeq: Math.floor(opts.atSeq) }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    this.projectList()
    const childId = result.value.sessionId
    if (sourceTitle !== undefined) {
      await this.using(childId, { source: 'controllerOperation' }, async (reference) => {
        const renamed = await reference.binding.session.rename(increasedForkTitle(sourceTitle))
        if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
      })
    }
    return childId
  }

  /**
   * Borrow an already-retained Agent-scoped context.
   * @param id - Session identity.
   * @returns the live context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined {
    return this.scopes.get(id)?.ctx
  }

  /**
   * Read the Agent scope tag off a context. Service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions — a cross-bundle
   * value import of the standalone helper would inline a second module
   * instance whose private tag Symbol never matches.
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeTagOf(ctx)
  }

  /**
   * Resolve the business Session behind an Agent-scoped context — the one
   * hop every scoped consumer (event listeners, per-session controllers)
   * takes from ctx-space into object-space (the client mirror of host
   * `agent.session`). Same service-method boundary as
   * {@link SessionRuntime.scopeOf}.
   * @param ctx - an Agent-scoped context.
   * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    const record = this.scopes.get(id)
    return record !== undefined && scopeIdentityOf(record.ctx) === scopeIdentityOf(ctx)
      ? record.binding.session
      : undefined
  }

  /**
   * Borrow an already-retained binding without extending its lifetime.
   * @param id - Session identity.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.scopes.get(id)?.binding
  }

  /**
   * Resolve one session's render-layer standard-props bundle (ctx never
   * enters the render layer; the renderer subscribes to
   * {@link SessionRuntime.currentProvideInfo}). Pure resolution — render-safe:
   * no staging, no window side effects (StrictMode double-invokes and
   * concurrent discarded passes must stay free).
   */
  provideInfoFor(id: SessionId): SessionProvideInfo | undefined {
    return this.scopes.get(id)?.provideInfo
  }

  /**
   * Resolve the current-session-optional standard kit. Unknown or absent ids
   * return the static no-session projection rather than removing hook props.
   */
  private maybeProvideInfo(id: string | undefined): SessionMaybeProvideInfo {
    return (id === undefined ? undefined : this.provideInfoFor(id as SessionId)) ?? this.provideChannel.maybeInfo
  }

  /** Reconcile staged history windows with current selection and pane requests. */
  private followCurrent(): void {
    const snapshot = this.list.getSnapshot()
    if (snapshot.current !== undefined) this.watched = snapshot.current
    this.reconcileStage(snapshot.current, snapshot.current === undefined)
  }

  /** Reconcile Session stage membership without touching current selection. */
  private reconcileStage(current: SessionId | undefined, preserveMaskedCurrent = false): void {
    this.pendingStage = { current, preserveMaskedCurrent }
    if (this.reconcilingStage) return
    this.reconcilingStage = true
    try {
      while (this.pendingStage !== undefined) {
        const request = this.pendingStage
        this.pendingStage = undefined
        this.applyStage(request.current, request.preserveMaskedCurrent)
      }
    } finally {
      this.reconcilingStage = false
    }
  }

  private applyStage(current: SessionId | undefined, preserveMaskedCurrent: boolean): void {
    const desired = new Set<SessionId>(this.additionalStaged)
    if (current !== undefined && this.eligible(current)) desired.add(current)
    if (preserveMaskedCurrent && current === undefined && this.watched !== undefined) desired.add(this.watched)
    for (const id of desired) {
      if (this.staged.has(id)) continue
      const reference = this.retain(id, { source: this.additionalStaged.has(id) ? 'workbench' : 'conversation' })
      this.staged.set(id, reference)
      void this.manager.refreshSubagents(id)
    }
    for (const [id, reference] of this.staged) {
      if (desired.has(id)) continue
      this.staged.delete(id)
      reference.release()
    }
  }

  private retainScope(id: SessionId, source: SessionReferenceSource): ClientSessionReference {
    const record = this.scopes.get(id) ?? this.materializeScope(id)
    const previous = record.retention
    record.retention = Object.freeze({
      referenceCount: previous.referenceCount + 1,
      retainedBy: freezeRetainedBy({ ...previous.retainedBy, [source]: (previous.retainedBy[source] ?? 0) + 1 }),
    })
    const reference = new ClientSessionReference(id, record, () => {
      if (record.ended.signal.aborted) return
      const count = record.retention.referenceCount - 1
      const { [source]: sourceCount = 0, ...otherSources } = record.retention.retainedBy
      const retainedBy = sourceCount > 1 ? { ...otherSources, [source]: sourceCount - 1 } : otherSources
      record.retention = count === 0
        ? EMPTY_RETAIN_INFO
        : Object.freeze({ referenceCount: count, retainedBy: freezeRetainedBy(retainedBy) })
      if (count === 0) this.retireScope(id, record)
      else this.publishRetention(id)
    })
    this.publishRetention(id)
    return reference
  }

  private retentionSnapshot(id: SessionId): SessionRetainInfo {
    return this.scopes.get(id)?.retention ?? EMPTY_RETAIN_INFO
  }

  private publishRetention(id: SessionId): void {
    const observer = this.retainObservers.get(id)
    const snapshot = this.retentionSnapshot(id)
    if (observer === undefined || observer.published === snapshot) return
    observer.published = snapshot
    for (const listener of [...observer.listeners]) {
      try { listener() } catch (error) { this.rootCtx.logger.error(error) }
    }
  }

  private retireScope(id: SessionId, record: ScopeRecord, disposeFiber = true): void {
    if (record.ended.signal.aborted) return
    record.ended.abort(new Error(`Session generation "${id}" is disposed`))
    if (this.scopes.get(id) === record) this.scopes.delete(id)
    record.session.unbindScope()
    this.scheduleDrop(id, record, disposeFiber)
    if (!this.closed) this.projectList()
    this.publishRetention(id)
  }

  /** Materialize one validated local generation for its first reference. */
  private materializeScope(id: SessionId): ScopeRecord {
    const { fiber, ctx } = createScope(this.rootCtx, id)
    const session = this.manager.get(id)
    // The Session owns its scoped dispatch point (host Agent.loopCtx mirror);
    // mint and bind are one step so a live scope record implies a bound actx.
    session.bindScope(ctx)
    const binding: SessionBinding = {
      sessionId: id, session, ctx,
      ...this.hostDescription === undefined ? {} : { hostDescription: this.hostDescription },
    }
    const record: ScopeRecord = {
      retention: EMPTY_RETAIN_INFO,
      ended: new AbortController(),
      fiber,
      ctx,
      binding,
      session,
      // Sources are bare observables; React binds selector hooks at its own boundary.
      provideInfo: this.provideChannel.materializeInfo(binding),
    }
    this.scopes.set(id, record)
    ctx.effect(() => () => { this.retireScope(id, record, false) }, 'sessions: exact generation')
    return record
  }

  /** View admission follows the Host list or the selected catalog address. */
  private eligible(id: SessionId): boolean {
    const { ids, current } = this.list.getSnapshot()
    return current === id || ids.includes(id)
  }

  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    const {
      items, current, phase, subagentsByParent, jobsBySession, currentAddress,
    } = this.manager.getListSnapshot()
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        ...(entry.completed ? { completed: true } : {}),
        blank: entry.blank,
        updatedAt: entry.updatedAt,
        ...(entry.pendingInteraction === undefined
          ? {}
          : { pendingInteraction: entry.pendingInteraction }),
        ...(entry.projectionValues === undefined
          ? {}
          : { projectionValues: entry.projectionValues }),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.workspaceId !== undefined ? { workspaceId: entry.workspaceId } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
        ...(entry.agentPreset !== undefined ? { agentPreset: entry.agentPreset } : {}),
      }
    }
    if (current !== undefined && currentAddress !== undefined) {
      const seen = new Set<SessionId>()
      let address: SubagentAddress | undefined = currentAddress
      while (address !== undefined && !seen.has(address.childSessionId)) {
        const childId = address.childSessionId
        seen.add(childId)
        const child = subagentsByParent[address.parentSessionId]?.entries
          .find(entry => entry.kind === 'child' && entry.id === childId)
        if (child?.kind !== 'child') break
        const displayTitle = child.label ?? childId
        const summary = byId[childId]
        if (summary === undefined) {
          byId[childId] = {
            id: childId,
            displayTitle,
            parentId: address.parentSessionId,
            origin: 'subagent',
            running: child.activity === 'running',
            blank: false,
            updatedAt: 0,
          }
        } else if (summary.displayTitle !== displayTitle) {
          byId[childId] = { ...summary, displayTitle }
        }
        const parent = byId[address.parentSessionId]
        if (parent !== undefined && parent.origin !== 'subagent') break
        address = this.manager.navigationAddress(address.parentSessionId)
      }
    }
    for (const [id, record] of this.scopes) {
      if (byId[id] !== undefined) continue
      const previous = this.list.getSnapshot().byId[id]
      const snapshot = record.session.getSnapshot()
      byId[id] = { ...(previous ?? { id, displayTitle: id, updatedAt: 0 }), running: snapshot.running, blank: snapshot.blank }
    }
    const persisted = this.selection.getSnapshot().sessionId
    // No current (cleared, or masked gap) wipes the persisted cell — a reload
    // stays on empty; the in-memory selection still resurfaces a masked id.
    if (current === undefined) {
      if (persisted !== undefined) this.selection.set({})
    } else if (byId[current] !== undefined
      && (persisted !== current
        || this.selection.getSnapshot().subagentAddress?.childSessionId !== currentAddress?.childSessionId
        || this.selection.getSnapshot().subagentAddress?.parentSessionId !== currentAddress?.parentSessionId
        || this.selection.getSnapshot().subagentAddress?.mode !== currentAddress?.mode)) {
      this.selection.set({
        sessionId: current,
        ...(currentAddress === undefined ? {} : { subagentAddress: currentAddress }),
      })
    }
    this.list.set({ ids, byId, archivedById: NO_ARCHIVED_SUMMARIES, current, phase, subagentsByParent, jobsBySession, currentAddress })

  }

  /**
   * One teardown for the whole per-session axis: the scope
   * fiber (cascading every actx-registered effect: input shell, slash
   * controller, popup, plugin stores, listeners), the session-keyed slot
   * stores, and the Session instance itself — the host session log is the
   * durable truth, a reopen lazily rebuilds and backfills via open().
   */
  private scheduleDrop(id: SessionId, record: ScopeRecord, disposeFiber = true): void {
    const disposal = this.dropScope(id, record, disposeFiber)
    this.pendingScopeDisposals.add(disposal)
    // Prunes are triggered from synchronous projection notifications and have
    // no caller to await. Observe failures here; root teardown still awaits
    // the same promise and reports an aggregate failure to its owner.
    void disposal.catch((error: unknown) => {
      this.rootCtx.logger.error('client session scope disposal failed for "%s"', id)
      this.rootCtx.logger.error(error)
    }).finally(() => {
      this.pendingScopeDisposals.delete(disposal)
    })
  }

  /** Dispose one scope and only then release its session-owned dispatch point. */
  private async dropScope(id: SessionId, record: ScopeRecord, disposeFiber: boolean): Promise<void> {
    record.session.dispose()
    record.session.leaveStage()
    // Remove the manager instance before awaiting the fiber so a session that
    // is re-added during teardown receives a fresh instance. The identity
    // guard prevents this old teardown from deleting that replacement.
    this.manager.drop(id, record.session)
    // Optional lookup: slots and sessions are sibling services with no
    // declared dependency; a slots-less boot (object-layer tests) skips.
    this.rootCtx.get('slots')?.pruneStoreScope(id)
    try {
      if (disposeFiber) await record.fiber.dispose()
    } finally {
      // Release the Session's dispatch point with the scope it belongs to (a
      // surviving instance — the live Intent — rebinds when resolve re-mints).
      record.session.unbindScope()
    }
  }

}
