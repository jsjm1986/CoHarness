/** Account-scoped pool of SessionRuntime instances used by the workbench. */
import { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle,
  ConnectionFailure,
  HostDescription,
  ConnectionRuntimeTarget,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SessionMaybeProvideInfo, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationRuntime } from './conversation-assembler.ts'
import type { SessionRemotes } from './remotes.ts'
import type {
  SessionReference, SessionTarget, SessionRetainOptions, SessionRetainInfo,
  AgentContext,
  ISessions,
  SessionRuntimeTarget,
} from '../contract/sessions.ts'
import type {
  SessionBinding,
  SessionListState,
  SessionProvideDescriptor,
  SessionSummary,
} from './service.ts'
import { SessionRuntime as Runtime } from './service.ts'
import type { SessionFace } from '../contract/session.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSearchResultItem } from './manager.ts'
import type { RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { remoteSessionId, mapRemoteSessionIds } from '@deepseek-ai/dsh-host-apiproxy/api'
import { WorkspaceResourceError, workspaceResourceProvider } from '../workspace-resources.ts'
import type { WorkspaceResourceTarget } from '../workspace-resources.ts'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '../contract/store.ts'

interface RuntimeEntry {
  references?: number
  key: string
  target: ConnectionRuntimeTarget
  readonly runtime: Runtime
  readonly connection?: ConnectionHandle
  readonly fiber?: Fiber
  stop?: () => void
  stopSubscriptions?: () => void
  stopResources?: (() => void) | undefined
  ready?: Promise<void>
  rejectReady?: (error: unknown) => void
}

function runtimeScope(): void {}

function targetKey(target: ConnectionRuntimeTarget): string {
  return target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
}

/** Bound on a lazily opened target runtime's initial readiness wait. A failed
 *  generation is only a transient while the connection's reconnect loop keeps
 *  retrying inside this window; two generation-handshake budgets give one
 *  stalled attempt plus its retry room to establish before the entry is
 *  released as unavailable. */
const TARGET_RUNTIME_READY_TIMEOUT_MS = 30_000

/**
 * Coordinates one base runtime with lazily opened project runtimes. Every
 * runtime keeps its own transport, event stream, history windows, and scope
 * store; this facade only aggregates list and binding lookups for the renderer.
 */
export class SessionRuntimePool implements ISessions {
  readonly searchResultLimit: number
  readonly list: SnapshotStore<SessionListState>
  readonly currentScopeList: SnapshotStore<SessionListState>
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly archivedByTarget = new Map<string, ReadonlySet<SessionId>>()
  private readonly sessionOwners = new Map<SessionId, RuntimeEntry>()
  private readonly providers = new Map<SessionProvideDescriptor, Map<RuntimeEntry, () => void>>()
  private stagedIds: readonly SessionId[] = []
  private readonly retentionSources = new Map<SessionId, ObservableSnapshot<SessionRetainInfo>>()
  private readonly runtimeOperations = new Map<string, { references: number }>()
  private readonly lifetime = new AbortController()
  private activeSession: SessionId | undefined
  private accountInvalidated = false
  private readonly provideListeners = new Set<() => void>()
  private currentProvideSnapshot: SessionMaybeProvideInfo

  constructor(
    private readonly rootCtx: Context,
    private readonly base: Runtime,
    private readonly baseConnection: ConnectionHandle,
    private readonly remote: SessionRemotes,
    private readonly conversation?: ConversationRuntime,
  ) {
    this.searchResultLimit = base.searchResultLimit
    const baseEntry: RuntimeEntry = {
      key: 'personal', target: { kind: 'personal' }, runtime: base, connection: baseConnection,
    }
    this.entries.set(baseEntry.key, baseEntry)
    base.setPresentationKey(id => clientSessionKey(baseEntry.target, id), baseEntry.target)
    this.currentProvideSnapshot = base.currentProvideInfo.getSnapshot()
    this.currentProvideInfo = {
      getSnapshot: () => this.currentProvideSnapshot,
      subscribe: (listener) => {
        this.provideListeners.add(listener)
        return () => { this.provideListeners.delete(listener) }
      },
    }
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'pending',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    this.currentScopeList = createSnapshotStore<SessionListState>(this.list.getSnapshot())
    this.subscribeEntry(baseEntry)
    this.rebuild()
    rootCtx.reflect.provide('sessions', this, undefined)
    const stopTargets = baseConnection.registerSessionTargetResolver?.(
      id => this.runtimeTargetFor(id), remoteSessionId,
      id => this.wireSessionId(id),
      (endpoint, args, scopeWire) => {
        let runtime: string | undefined
        return mapRemoteSessionIds(endpoint, args, (id) => {
          const address = parseClientSessionKey(id)
          if (address === undefined) return id
          const key = targetKey(address.runtime)
          if (runtime !== undefined && runtime !== key) throw new Error('Remote request spans different runtimes')
          runtime = key
          return this.wireSessionId(id)
        }, scopeWire)
      },
    )
    const stopRuntime = baseConnection.onRuntimeTarget?.((target) => { this.setBaseRuntimeTarget(target) })
    rootCtx.effect(() => () => {
      this.lifetime.abort(new Error('Client runtime disposed'))
      stopRuntime?.()
      stopTargets?.()
      for (const entry of this.entries.values()) {
        entry.stop?.()
        entry.stopSubscriptions?.()
        entry.stopResources?.()
      }
    }, 'runtime: session runtime pool')
  }

  private subscribeEntry(entry: RuntimeEntry): void {
    const stopList = entry.runtime.list.subscribe(() => {
      if (this.accountInvalidated || this.entries.get(entry.key) !== entry) return
      this.indexEntry(entry)
      this.rebuild()
    })
    const stopProvide = entry.runtime.currentProvideInfo.subscribe(() => {
      if (this.accountInvalidated || this.entries.get(entry.key) !== entry) return
      if (this.activeOwner()?.key !== entry.key) return
      this.currentProvideSnapshot = entry.runtime.currentProvideInfo.getSnapshot()
      this.notifyProvide()
    })
    entry.stopSubscriptions = () => { stopList(); stopProvide() }
    this.indexEntry(entry)
  }

  private indexEntry(entry: RuntimeEntry): void {
    for (const [id, owner] of this.sessionOwners) if (owner.key === entry.key) this.sessionOwners.delete(id)
    for (const id of Object.keys(entry.runtime.list.getSnapshot().byId) as SessionId[]) {
      this.sessionOwners.set(clientSessionKey(entry.target, id), entry)
    }
  }

  private ownerFor(id: SessionId): RuntimeEntry | undefined {
    if (this.accountInvalidated) return undefined
    const exact = this.sessionOwners.get(id)
    if (exact !== undefined) return exact
    if (parseClientSessionKey(id) !== undefined) return undefined
    const candidates = [...this.entries.values()].filter(entry => entry.runtime.list.getSnapshot().byId[id] !== undefined)
    if (candidates.length > 1) throw new Error(`Ambiguous Session ID requires a runtime: ${id}`)
    return candidates[0]
  }

  private originalId(id: SessionId, owner: RuntimeEntry): SessionId {
    const address = parseClientSessionKey(id)
    if (address === undefined) return id
    if (targetKey(address.runtime) !== owner.key) throw new Error('Session address belongs to another runtime')
    return address.sessionId
  }

  /** Browser identity for an original Session ID in an explicit runtime.
   * @param target - owning runtime; omission means the bootstrap runtime.
   * @param id - original Host Session ID.
   * @returns browser identity without changing persisted Host data.
   */
  keyFor(id: SessionId, target?: SessionRuntimeTarget): SessionId {
    const owner = target ?? [...this.entries.values()].find(entry => entry.runtime === this.base)?.target
    if (owner === undefined) throw new Error('Bootstrap runtime identity is unavailable')
    return clientSessionKey(owner, id)
  }

  private activeOwner(): RuntimeEntry | undefined {
    return (this.activeSession === undefined ? undefined : this.ownerFor(this.activeSession))
      ?? [...this.entries.values()].find(entry => entry.runtime === this.base)
  }

  private notifyProvide(): void {
    for (const listener of [...this.provideListeners]) {
      try { listener() } catch (error) { console.error('[web-runtime] pooled provide listener failed:', error) }
    }
  }

  private rebuild(): void {
    if (this.accountInvalidated) return
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    const archivedById: Record<SessionId, SessionSummary> = {}
    const subagentsByParent: SessionListState['subagentsByParent'] = {}
    const jobsBySession: SessionListState['jobsBySession'] = {}
    for (const entry of this.entries.values()) {
      const state = this.projectEntry(entry)
      ids.push(...state.ids)
      Object.assign(byId, state.byId)
      Object.assign(archivedById, state.archivedById)
      Object.assign(subagentsByParent, state.subagentsByParent)
      Object.assign(jobsBySession, state.jobsBySession)
      if (entry.runtime === this.base) this.currentScopeList.set(state)
    }
    const current = this.activeSession !== undefined && byId[this.activeSession] !== undefined
      ? this.activeSession
      : this.currentScopeList.getSnapshot().current
    if (current !== undefined && byId[current] === undefined) this.activeSession = undefined
    const owner = current === undefined ? undefined : this.ownerFor(current)
    const nextProvide = owner?.runtime.currentProvideInfo.getSnapshot()
      ?? this.base.currentProvideInfo.getSnapshot()
    if (nextProvide !== this.currentProvideSnapshot) {
      this.currentProvideSnapshot = nextProvide
      this.notifyProvide()
    }
    this.list.set({
      ids, byId, archivedById, current: current !== undefined && byId[current] !== undefined ? current : undefined,
      phase: this.base.list.getSnapshot().phase,
      subagentsByParent, jobsBySession,
      currentAddress: owner === undefined ? undefined : this.projectEntry(owner).currentAddress,
    })
  }

  private projectEntry(entry: RuntimeEntry): SessionListState {
    const state = entry.runtime.list.getSnapshot()
    const key = (id: SessionId): SessionId => clientSessionKey(entry.target, id)
    const archived = this.archivedByTarget.get(entry.key) ?? new Set<SessionId>()
    const byId: Record<SessionId, SessionSummary> = {}
    const archivedById: Record<SessionId, SessionSummary> = {}
    for (const summary of Object.values(state.byId)) {
      const id = key(summary.id)
      const projected = {
        ...summary, id,
        ...(summary.parentId === undefined ? {} : { parentId: key(summary.parentId) }),
        ...(entry.target.kind === 'project' ? { projectId: entry.target.projectId,
          ...(entry.target.projectName === undefined ? {} : { workspaceName: entry.target.projectName }) } : {}),
      }
      ;(archived.has(summary.id) ? archivedById : byId)[id] = projected
    }
    const subagentsByParent = Object.fromEntries(Object.entries(state.subagentsByParent)
      .map(([parent, catalog]) => [key(parent as SessionId), {
        ...catalog, entries: catalog.entries.map(child => child.kind === 'child' ? { ...child, id: key(child.id) } : child),
      }])) as SessionListState['subagentsByParent']
    const jobsBySession = Object.fromEntries(
      Object.entries(state.jobsBySession).map(([id, jobs]) => [key(id as SessionId), jobs]),
    ) as SessionListState['jobsBySession']
    return { ...state, ids: state.ids.filter(id => !archived.has(id)).map(key), byId, archivedById,
      current: state.current === undefined ? undefined : key(state.current), subagentsByParent, jobsBySession,
      currentAddress: state.currentAddress === undefined ? undefined : {
        ...state.currentAddress,
        parentSessionId: key(state.currentAddress.parentSessionId), childSessionId: key(state.currentAddress.childSessionId),
      },
    }
  }

  /** Lazily start and list one target project runtime. */
  private async runtimeForTarget(target: SessionRuntimeTarget, signal = this.lifetime.signal): Promise<RuntimeEntry | undefined> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    if (this.accountInvalidated) throw new Error('Client account identity was invalidated')
    const key = targetKey(target)
    let entry = this.entries.get(key)
    // A later name-bearing descriptor (catalog row, scope-aware create) heals
    // an entry first opened by a nameless target; the key pins projectId, and
    // resource lookups key on {kind, projectId}, never the object identity.
    if (entry !== undefined && entry.target.kind === 'project' && target.kind === 'project'
      && entry.target.projectName === undefined && target.projectName !== undefined) {
      entry.target = target
    }
    if (entry === undefined) {
      const connection = this.baseConnection.forTarget?.(target)
      if (connection === undefined) return undefined
      const fiber = this.rootCtx.plugin(runtimeScope)
      const runtime = new Runtime(fiber.ctx, connection.wireApi ?? connection.api, this.remote, this.conversation, {
        persistSelection: false,
        provideService: false,
        hostDescription: connection.hostDescription,
      })
      entry = { key, target, runtime, connection, fiber }
      runtime.setPresentationKey(id => clientSessionKey(target, id), target)
      this.entries.set(key, entry)
      try {
        for (const [descriptor, disposers] of this.providers) disposers.set(entry, runtime.provide(descriptor))
      } catch (error) {
        this.entries.delete(key)
        for (const disposers of this.providers.values()) {
          disposers.get(entry)?.()
          disposers.delete(entry)
        }
        await fiber.dispose()
        throw error
      }
      const establishedEntry = entry
      this.subscribeEntry(entry)
      let resolveReady: () => void = () => {}
      let rejectReady: (error: unknown) => void = () => {}
      entry.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      entry.rejectReady = rejectReady
      const loop = connection.start({
        onMuxEnvelope: (envelope: Parameters<Runtime['handleMuxEnvelope']>[0]) => {
          if (this.accountInvalidated || this.entries.get(establishedEntry.key) !== establishedEntry) return
          runtime.handleMuxEnvelope(envelope)
        },
        onHostEnvelope: (envelope: Parameters<Runtime['handleHostEnvelope']>[0]) => {
          if (this.accountInvalidated || this.entries.get(establishedEntry.key) !== establishedEntry) return
          runtime.handleHostEnvelope(envelope)
          const frame = envelope.payload
          if (frame.type === 'host/remote-event') {
            this.dispatchRemoteEvent(frame.event, frame.args, establishedEntry.target)
            // The delivering connection's catalog alone repulls; other runtime
            // mirrors keep their own host's value.
            if (frame.event === 'permission-presets/catalog-changed' && establishedEntry.connection !== undefined) {
              this.rootCtx.get('permissionCatalog')?.invalidateFor(establishedEntry.connection)
            }
          }
          if (frame.type === 'host/workspace-file-changed') this.rootCtx.get('workspaceResources')?.handleChange(establishedEntry.target, { ...frame, sessionId: clientSessionKey(establishedEntry.target, frame.sessionId) })
        },
        onConnected: (description) => {
          if (this.accountInvalidated || this.entries.get(establishedEntry.key) !== establishedEntry) return
          if (description.runtimeTarget !== undefined && targetKey(description.runtimeTarget) !== establishedEntry.key) {
            rejectReady(new Error('Target transport connected to another runtime'))
            return
          }
          this.connectResources(establishedEntry, description)
          runtime.handleConnected()
          void runtime.refresh().then(() => {
            if (runtime.list.getSnapshot().phase === 'ready') resolveReady()
            else rejectReady(new Error('target runtime session list unavailable'))
            return connection.api.workspace.list({})
          }).then(({ result }) => {
            if (result.ok && this.entries.get(establishedEntry.key) === establishedEntry) {
              this.archivedByTarget.set(establishedEntry.key, new Set(result.value.archivedSessionIds))
              this.rebuild()
            }
          }, rejectReady)
        },
        onFailure: (failure) => {
          if (this.entries.get(establishedEntry.key) === establishedEntry) this.resourceFailure(establishedEntry.target, failure)
        },
        onStateChange: (state: 'connected' | 'reconnecting') => {
          if (state !== 'reconnecting' || this.accountInvalidated || this.entries.get(establishedEntry.key) !== establishedEntry) return
          this.rootCtx.get('workspaceResources')?.disconnect(establishedEntry.target)
          runtime.handleDisconnected()
        },
      })
      entry.stop = () => { loop.stop() }
      // The connection loop retries a failed generation with backoff; the
      // ready wait must outlast transient outages or the first handshake
      // failure would release a target whose retry was about to succeed.
      const readyDeadline = setTimeout(() => {
        rejectReady(new Error('target runtime connection unavailable'))
      }, TARGET_RUNTIME_READY_TIMEOUT_MS)
      void entry.ready.then(
        () => { clearTimeout(readyDeadline) },
        () => { clearTimeout(readyDeadline) },
      )
    }
    try {
      await this.waitForRuntime(entry, signal)
    } catch (error) {
      if (!signal.aborted) { this.releaseEntry(entry); this.rebuild() }
      throw error
    }
    if (this.entries.get(key) !== entry) return undefined
    this.indexEntry(entry)
    this.rebuild()
    return entry
  }

  private async waitForRuntime(entry: RuntimeEntry, signal: AbortSignal): Promise<void> {
    let handshake = entry.ready === undefined
    let stopList: (() => void) | undefined
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const check = (): void => { if (handshake && entry.runtime.list.getSnapshot().phase === 'ready') resolve() }
        abort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Runtime discovery cancelled', { cause: signal.reason }))
        }
        signal.addEventListener('abort', abort, { once: true })
        stopList = entry.runtime.list.subscribe(check)
        if (signal.aborted) abort()
        else check()
        void entry.ready?.then(() => { handshake = true; check() }, reject)
      })
      signal.throwIfAborted()
    } finally {
      stopList?.()
      if (abort !== undefined) signal.removeEventListener('abort', abort)
    }
  }

  async usingRuntime<T>(target: SessionRuntimeTarget, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const active = AbortSignal.any([signal, this.lifetime.signal])
    active.throwIfAborted()
    const key = targetKey(target)
    const owner = this.runtimeOperations.get(key) ?? { references: 0 }
    this.runtimeOperations.set(key, owner)
    owner.references++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (--owner.references === 0) this.runtimeOperations.delete(key)
      this.releaseUnused(this.stagedIds)
    }
    active.addEventListener('abort', release, { once: true })
    try {
      return await operation(active)
    } finally { active.removeEventListener('abort', release); release() }
  }

  /** Check whether a Session exists in the target runtime. */
  async ensureSession(target: SessionRuntimeTarget, id: SessionId, signal?: AbortSignal): Promise<boolean> {
    const active = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const entry = await this.runtimeForTarget(target, active)
    if (entry === undefined || entry.connection === undefined) return false
    const original = id
    if (!entry.runtime.list.getSnapshot().ids.includes(original)) return false
    const { result } = await entry.connection.api.workspace.list({}, active)
    active.throwIfAborted()
    if (!result.ok) {
      if (result.error.code === 'collaboration-forbidden') throw new WorkspaceResourceError('access-revoked', result.error.message)
      throw new Error(result.error.message)
    }
    return this.entries.get(entry.key) === entry && !result.value.archivedSessionIds.includes(original)
  }

  /** Create a Session in the target runtime and index its owner. */
  async createSession(target: SessionRuntimeTarget, signal?: AbortSignal): Promise<SessionId> {
    const active = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const entry = await this.runtimeForTarget(target, active)
    if (entry === undefined) throw new Error('target runtime transport unavailable')
    const id = await entry.runtime.create()
    active.throwIfAborted()
    if (this.entries.get(entry.key) !== entry) throw new Error('target runtime was released during session creation')
    this.indexEntry(entry)
    this.rebuild()
    return clientSessionKey(entry.target, id)
  }

  /** Create or reuse a blank Session in the bootstrap Workspace runtime.
   * @param opts - draft/session creation options.
   * @param reusableSessionIds - blank Session identities eligible for reuse.
   * @returns the selected Session identity.
   */
  createOrReuse(
    opts: Parameters<Runtime['createOrReuse']>[0],
    reusableSessionIds: readonly SessionId[],
  ): Promise<SessionId> {
    const owner = [...this.entries.values()].find(entry => entry.runtime === this.base)
    if (owner === undefined) throw new Error('Bootstrap runtime is unavailable')
    return this.base.createOrReuse(opts, reusableSessionIds.map(id => this.originalId(id, owner)))
      .then(id => clientSessionKey(owner.target, id))
  }

  /** Withdraw every visible Session before asynchronous account-change teardown begins. */
  invalidateAccount(): void {
    if (this.accountInvalidated) return
    this.accountInvalidated = true
    this.sessionOwners.clear()
    this.activeSession = undefined
    this.currentProvideSnapshot = this.base.unboundProvideInfo()
    const empty: SessionListState = { ids: [], byId: {}, archivedById: {}, current: undefined,
      phase: 'pending', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
    this.list.set(empty)
    this.currentScopeList.set(empty)
    this.notifyProvide()
    this.beginNavigation()
    this.lifetime.abort(new Error('Client account identity was invalidated'))
    for (const entry of this.entries.values()) {
      entry.stopSubscriptions?.()
      entry.runtime.clear()
    }
  }

  /** Route a mux frame to the base runtime.
   * @param envelope - decoded mux envelope.
   */
  handleMuxEnvelope(envelope: Parameters<Runtime['handleMuxEnvelope']>[0]): void {
    if (this.accountInvalidated) return
    this.base.handleMuxEnvelope(envelope)
  }
  /** Deliver application events with the owning runtime's browser Session addresses.
   * @param event - forwarded event name.
   * @param args - unchanged wire values except declared Session address positions.
   * @param target - source runtime, or bootstrap runtime.
   */
  dispatchRemoteEvent(event: string, args: readonly unknown[], target?: SessionRuntimeTarget): void {
    let projected = args
    if (event === 'agent-preset/selected' && typeof args[0] === 'string') {
      projected = [this.keyFor(args[0] as SessionId, target), ...args.slice(1)]
    } else if (/^(?:@deepseek-ai\/)?cordis\/(?:request-run|inspect-query)$/u.test(event)) {
      const first = args[0]
      if (first !== null && typeof first === 'object' && !Array.isArray(first)
        && Object.hasOwn(first, 'agentId') && typeof Reflect.get(first, 'agentId') === 'string') {
        projected = [{ ...first, agentId: this.keyFor(Reflect.get(first, 'agentId') as SessionId, target) }, ...args.slice(1)]
      }
    }
    this.rootCtx.remote.$dispatch(event, projected)
  }

  /** Route a host frame to the base runtime.
   * @param envelope - decoded host envelope.
   */
  handleHostEnvelope(envelope: Parameters<Runtime['handleHostEnvelope']>[0]): void {
    if (this.accountInvalidated) return
    this.base.handleHostEnvelope(envelope)
    if (envelope.payload.type === 'host/workspace-file-changed') this.rootCtx.get('workspaceResources')?.handleChange({ kind: 'base' }, { ...envelope.payload, sessionId: this.keyFor(envelope.payload.sessionId) })
  }
  /** Mark the base runtime connection as ready.
   * @param description - Host capabilities from the completed handshake.
   */
  handleConnected(description?: HostDescription): void {
    if (this.accountInvalidated) return
    if (description?.runtimeTarget !== undefined) this.setBaseRuntimeTarget(description.runtimeTarget)
    else if (description?.executionAuthorityRequired === true) throw new Error('Gateway runtime did not declare its Session identity')
    const entry = [...this.entries.values()].find(candidate => candidate.runtime === this.base)
    if (entry !== undefined && description !== undefined) this.connectResources(entry, description)
    this.base.handleConnected()
    void this.baseConnection.api.workspace.list({}).then(({ result }) => {
      if (result.ok) {
        // The base entry's key tracks its current target (re-keyed by
        // setBaseRuntimeTarget); a hardcoded 'personal' would orphan the set.
        this.archivedByTarget.set(entry?.key ?? 'personal', new Set(result.value.archivedSessionIds))
        this.rebuild()
      }
    }, (error: unknown) => { console.error('[web-runtime] base workspace.list refresh failed:', error) })
  }
  /** Mark the base runtime connection as unavailable. */
  handleDisconnected(): void {
    this.rootCtx.get('workspaceResources')?.disconnect({ kind: 'base' })
    this.base.handleDisconnected()
  }

  /** Invalidate bootstrap resources when the connection reports authorization loss.
   * @param failure - current-generation RPC or transport failure.
   */
  handleConnectionFailure(failure: ConnectionFailure): void {
    this.resourceFailure({ kind: 'base' }, failure)
  }

  private resourceFailure(target: WorkspaceResourceTarget, failure: ConnectionFailure): void {
    const denied = failure.kind === 'rpc' ? failure.error.code === 'collaboration-forbidden'
      : failure.error instanceof Error
        && typeof (failure.error as unknown as { status?: unknown }).status === 'number'
        && ((failure.error as unknown as { status: number }).status === 401
          || (failure.error as unknown as { status: number }).status === 403)
    if (denied) {
      this.beginNavigation()
      this.rootCtx.get('workspaceResources')?.disconnect(target,
        new WorkspaceResourceError('access-revoked', 'Workspace access has expired or been revoked'))
      if (target.kind === 'base') {
        this.invalidateAccount()
        this.baseConnection.invalidatePrincipal?.()
      } else {
        const entry = this.entries.get(targetKey(target))
        if (entry !== undefined) this.releaseEntry(entry, new WorkspaceResourceError('access-revoked', 'Workspace access was revoked'))
        this.rebuild()
      }
    }
  }

  private connectResources(entry: RuntimeEntry, description: HostDescription): void {
    const registry = this.rootCtx.get('workspaceResources')
    if (registry === undefined || entry.connection === undefined) return
    const target: WorkspaceResourceTarget = entry.runtime === this.base ? { kind: 'base' } : entry.target
    if (description.workspaceFiles === undefined) {
      entry.stopResources?.()
      entry.stopResources = undefined
      return
    }
    if (entry.stopResources === undefined) {
      entry.stopResources = registry.register(
        target, workspaceResourceProvider(entry.connection.api), description.workspaceFiles.maxResources,
      )
    }
    registry.connected(target)
  }

  private addressOwner(id: SessionId): RuntimeEntry | undefined {
    if (this.accountInvalidated) throw new Error('Client account identity was invalidated')
    const address = parseClientSessionKey(id)
    if (address === undefined) return this.ownerFor(id)
    const owner = this.entries.get(targetKey(address.runtime))
    if (owner === undefined) throw new Error('Session runtime is not retained or authorized')
    return owner
  }

  private wireSessionId(id: SessionId): SessionId {
    const owner = this.addressOwner(id)
    if (owner === undefined) return id
    return this.originalId(id, owner)
  }

  runtimeIdentityFor(id: SessionId): SessionRuntimeTarget | undefined {
    return this.ownerFor(id)?.target
  }

  runtimeTargetFor(id: SessionId): SessionRuntimeTarget | undefined {
    const owner = this.addressOwner(id)
    // The base runtime's sessions ride the base connection; a target here
    // would reroute every session-addressed Remote call (commands/list,
    // goals/*, …) to a fresh transport instead of the one that serves them.
    if (owner === undefined || owner.runtime === this.base) return undefined
    return owner.target
  }

  setBaseRuntimeTarget(target: SessionRuntimeTarget): void {
    const baseEntry = [...this.entries.values()].find(entry => entry.runtime === this.base)
    if (baseEntry === undefined) return
    if (targetKey(baseEntry.target) === targetKey(target)) {
      if (target.kind === 'project' && target.projectName !== undefined) { baseEntry.target = target; this.rebuild() }
      return
    }
    this.beginNavigation()
    const collision = this.entries.get(targetKey(target))
    if (collision !== undefined && collision !== baseEntry) throw new Error('Bootstrap target already has a live runtime')
    baseEntry.runtime.setPresentationKey(id => clientSessionKey(target, id), target)
    this.baseConnection.setBaseTarget?.(target)
    const archived = this.archivedByTarget.get(baseEntry.key)
    this.entries.delete(baseEntry.key)
    this.archivedByTarget.delete(baseEntry.key)
    baseEntry.target = target
    baseEntry.key = targetKey(target)
    this.entries.set(baseEntry.key, baseEntry)
    if (archived !== undefined) this.archivedByTarget.set(baseEntry.key, archived)
    this.indexEntry(baseEntry)
    this.rebuild()
  }

  beginNavigation(): AbortSignal {
    return this.base.beginNavigation()
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const id = typeof target === 'string' ? target : target.childSessionId
    const owner = typeof target === 'string' ? this.ownerFor(id) : this.ownerFor(target.parentSessionId)
    if (owner === undefined) throw new Error(`sessions.retain: unknown session ${id}`)
    owner.references = (owner.references ?? 0) + 1
    let reference: SessionReference
    try {
      reference = owner.runtime.retain(typeof target === 'string' ? this.originalId(target, owner) : {
        ...target,
        parentSessionId: this.originalId(target.parentSessionId, owner), childSessionId: this.originalId(target.childSessionId, owner),
      }, options)
    } catch (error) {
      owner.references--
      this.releaseUnused(this.stagedIds)
      throw error
    }
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      owner.references = (owner.references ?? 1) - 1
      reference.release()
      this.releaseUnused(this.stagedIds)
    }
    const owned: SessionReference = {
      sessionId: clientSessionKey(owner.target, reference.sessionId),
      get binding() { return reference.binding },
      ready: reference.ready,
      release,
      [Symbol.dispose]: release,
    }
    return owned
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
    const existing = this.retentionSources.get(id)
    if (existing !== undefined) return existing
    const empty: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: Object.freeze({}) })
    const ownerSource = (): ObservableSnapshot<SessionRetainInfo> | undefined => {
      const owner = this.ownerFor(id)
      return owner?.runtime.retainInfo(this.originalId(id, owner))
    }
    const source: ObservableSnapshot<SessionRetainInfo> = {
      getSnapshot: () => ownerSource()?.getSnapshot() ?? empty,
      subscribe: (listener) => {
        let current = ownerSource()
        let stop = current?.subscribe(listener)
        const stopList = this.list.subscribe(() => {
          const next = ownerSource()
          if (next === current) return
          stop?.()
          current = next
          stop = next?.subscribe(listener)
          listener()
        })
        return () => { stopList(); stop?.() }
      },
    }
    this.retentionSources.set(id, source)
    return source
  }

  open(id: SessionId): void {
    this.beginNavigation()
    const owner = this.ownerFor(id)
    if (owner === undefined) throw new Error(`sessions.select: unknown session ${id}`)
    this.activeSession = clientSessionKey(owner.target, this.originalId(id, owner))
    owner.runtime.open(this.originalId(id, owner))
    this.currentProvideSnapshot = owner.runtime.currentProvideInfo.getSnapshot()
    this.rebuild()
    this.notifyProvide()
  }

  clear(): void {
    this.activeSession = undefined
    this.base.clear()
    this.currentProvideSnapshot = this.base.currentProvideInfo.getSnapshot()
    this.rebuild()
    this.notifyProvide()
    this.releaseUnused([])
  }

  setAdditionalStaged(ids: readonly SessionId[]): void {
    this.stagedIds = ids.map((id) => {
      const owner = this.ownerFor(id)
      return owner === undefined ? id : clientSessionKey(owner.target, this.originalId(id, owner))
    })
    const grouped = new Map<RuntimeEntry, SessionId[]>()
    for (const id of ids) {
      const owner = this.ownerFor(id)
      if (owner === undefined) continue
      const list = grouped.get(owner) ?? []
      list.push(this.originalId(id, owner))
      grouped.set(owner, list)
    }
    for (const entry of this.entries.values()) entry.runtime.setAdditionalStaged(grouped.get(entry) ?? [])
    this.releaseUnused(this.stagedIds)
  }

  private releaseUnused(ids: readonly SessionId[]): void {
    const retained = new Set(ids)
    // An active pane is retained only while it is explicitly staged. When
    // the workbench closes or the page changes scope, releasing every
    // non-base target prevents its sessions from leaking into the ordinary
    // current-space navigation list.
    for (const entry of [...this.entries.values()]) {
      if (entry.runtime === this.base || (entry.references ?? 0) > 0
        || this.runtimeOperations.has(entry.key)
        || [...retained].some(id => this.ownerFor(id) === entry)) continue
      this.releaseEntry(entry)
    }
    this.rebuild()
  }

  private releaseEntry(entry: RuntimeEntry, failure = new Error('target runtime was released before it became ready')): void {
    if (entry.runtime === this.base || this.entries.get(entry.key) !== entry) return
    this.entries.delete(entry.key)
    this.archivedByTarget.delete(entry.key)
    for (const [id, owner] of this.sessionOwners) if (owner === entry) this.sessionOwners.delete(id)
    this.rebuild()
    entry.stop?.()
    entry.stopSubscriptions?.()
    entry.stopResources?.()
    entry.rejectReady?.(failure)
    for (const disposers of this.providers.values()) {
      disposers.get(entry)?.()
      disposers.delete(entry)
    }
    void entry.fiber?.dispose().catch((error: unknown) => {
      console.error('[web-runtime] target runtime disposal failed:', error)
    })
  }

  provide(descriptor: SessionProvideDescriptor): () => void {
    const disposers = new Map<RuntimeEntry, () => void>()
    try {
      for (const entry of this.entries.values()) disposers.set(entry, entry.runtime.provide(descriptor))
    } catch (error) {
      for (const disposer of disposers.values()) disposer()
      throw error
    }
    this.providers.set(descriptor, disposers)
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      for (const disposer of disposers.values()) disposer()
      this.providers.delete(descriptor)
    }
    return dispose
  }

  scope(id: SessionId): AgentContext | undefined {
    const owner = this.ownerFor(id)
    return owner?.runtime.scope(this.originalId(id, owner))
  }
  scopeOf(ctx: Context): SessionId | undefined {
    for (const entry of this.entries.values()) {
      const id = entry.runtime.scopeOf(ctx)
      if (id !== undefined) return clientSessionKey(entry.target, id)
    }
    return undefined
  }
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = this.scopeOf(ctx)
    return id === undefined ? undefined : this.ownerFor(id)?.runtime.sessionOf(ctx)
  }
  binding(id: SessionId): SessionBinding | undefined {
    const owner = this.ownerFor(id)
    return owner?.runtime.binding(this.originalId(id, owner))
  }
  provideInfoFor(id: SessionId): SessionProvideInfo | undefined {
    const owner = this.ownerFor(id)
    return owner?.runtime.provideInfoFor(this.originalId(id, owner))
  }
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    const owner = this.ownerFor(id)
    const address = owner?.runtime.subagentAddress(this.originalId(id, owner))
    return address === undefined || owner === undefined ? undefined : { ...address,
      parentSessionId: clientSessionKey(owner.target, address.parentSessionId),
      childSessionId: clientSessionKey(owner.target, address.childSessionId),
    }
  }
  openSubagent(address: SubagentAddress): void {
    this.beginNavigation()
    const owner = this.ownerFor(address.parentSessionId)
    if (owner === undefined) throw new Error(`sessions.selectSubagent: unknown session ${address.childSessionId}`)
    owner.runtime.openSubagent({ ...address,
      parentSessionId: this.originalId(address.parentSessionId, owner), childSessionId: this.originalId(address.childSessionId, owner),
    })
    this.activeSession = clientSessionKey(owner.target, this.originalId(address.childSessionId, owner))
    this.currentProvideSnapshot = owner.runtime.currentProvideInfo.getSnapshot()
    this.rebuild(); this.notifyProvide()
  }
  /** Set whether one parent Session's child catalog is expanded.
   * @param parent - parent Session identity.
   * @param open - whether the catalog is expanded.
   */
  setSubagentCatalogOpen(parent: SessionId, open: boolean): void {
    const owner = this.ownerFor(parent)
    owner?.runtime.setSubagentCatalogOpen(this.originalId(parent, owner), open)
  }
  /** Refresh the child catalog for one parent Session.
   * @param parent - parent Session identity.
   */
  refreshSubagents(parent: SessionId): Promise<void> {
    const owner = this.ownerFor(parent)
    return owner?.runtime.refreshSubagents(this.originalId(parent, owner)) ?? Promise.resolve()
  }
  /** Record the preset observed for one Session.
   * @param id - Session identity.
   * @param preset - preset identifier.
   */
  noteAgentPreset(id: SessionId, preset: string): void {
    const owner = this.ownerFor(id)
    owner?.runtime.noteAgentPreset(this.originalId(id, owner), preset)
  }
  async search(query: string, signal: AbortSignal): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    const result = await this.base.search(query, signal)
    return result.ok ? { ...result, value: { ...result.value,
      items: result.value.items.map(item => ({ ...item, sessionId: this.keyFor(item.sessionId) })),
    } } : result
  }
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId> {
    const owner = this.ownerFor(opts.sessionId)
    if (owner === undefined) return Promise.reject(new Error(`unknown session ${opts.sessionId}`))
    return owner.runtime.fork({ ...opts, sessionId: this.originalId(opts.sessionId, owner) }).then(id => clientSessionKey(owner.target, id))
  }
}
