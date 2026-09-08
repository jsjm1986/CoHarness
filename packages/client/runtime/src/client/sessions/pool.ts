/** Account-scoped pool of SessionRuntime instances used by the workbench. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle,
  ConnectionRuntimeTarget,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SessionMaybeProvideInfo, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationRuntime } from './conversation-assembler.ts'
import type { SessionRemotes } from './remotes.ts'
import type {
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
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '../contract/store.ts'

interface RuntimeEntry {
  key: string
  target: ConnectionRuntimeTarget
  readonly runtime: Runtime
  readonly connection?: ConnectionHandle
  readonly fiber?: Fiber
  stop?: () => void
  stopSubscriptions?: () => void
  ready?: Promise<void>
  rejectReady?: (error: unknown) => void
}

function runtimeScope(): void {}

function targetKey(target: ConnectionRuntimeTarget): string {
  return target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
}

/**
 * Coordinates one base runtime with lazily opened project runtimes. Every
 * runtime keeps its own transport, event stream, history windows, and scope
 * store; this facade only aggregates list and binding lookups for the renderer.
 */
export class SessionRuntimePool implements ISessions {
  readonly searchResultLimit: number
  readonly list: SnapshotStore<SessionListState>
  readonly currentScopeList: ObservableSnapshot<SessionListState>
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly archivedByTarget = new Map<string, ReadonlySet<SessionId>>()
  private readonly sessionOwners = new Map<SessionId, RuntimeEntry>()
  private readonly providers = new Map<SessionProvideDescriptor, Map<RuntimeEntry, () => void>>()
  private activeSession: SessionId | undefined
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
    this.currentProvideSnapshot = base.currentProvideInfo.getSnapshot()
    this.currentProvideInfo = {
      getSnapshot: () => this.currentProvideSnapshot,
      subscribe: (listener) => {
        this.provideListeners.add(listener)
        return () => { this.provideListeners.delete(listener) }
      },
    }
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'pending',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    this.currentScopeList = base.list
    this.subscribeEntry(baseEntry)
    this.rebuild()
    rootCtx.reflect.provide('sessions', this, undefined)
    const stopTargets = baseConnection.registerSessionTargetResolver?.(id => this.runtimeTargetFor(id))
    rootCtx.effect(() => () => {
      stopTargets?.()
      for (const entry of this.entries.values()) {
        entry.stop?.()
        entry.stopSubscriptions?.()
      }
    }, 'runtime: session runtime pool')
  }

  private subscribeEntry(entry: RuntimeEntry): void {
    const stopList = entry.runtime.list.subscribe(() => {
      if (this.entries.get(entry.key) !== entry) return
      this.indexEntry(entry)
      this.rebuild()
    })
    const stopProvide = entry.runtime.currentProvideInfo.subscribe(() => {
      if (this.entries.get(entry.key) !== entry) return
      if (this.activeOwner()?.key !== entry.key) return
      this.currentProvideSnapshot = entry.runtime.currentProvideInfo.getSnapshot()
      this.notifyProvide()
    })
    entry.stopSubscriptions = () => { stopList(); stopProvide() }
    this.indexEntry(entry)
  }

  private indexEntry(entry: RuntimeEntry): void {
    for (const [id, owner] of this.sessionOwners) if (owner.key === entry.key) this.sessionOwners.delete(id)
    for (const id of Object.keys(entry.runtime.list.getSnapshot().byId) as SessionId[]) this.sessionOwners.set(id, entry)
  }

  private activeOwner(): RuntimeEntry | undefined {
    return (this.activeSession === undefined ? undefined : this.sessionOwners.get(this.activeSession))
      ?? [...this.entries.values()].find(entry => entry.runtime === this.base)
  }

  private notifyProvide(): void {
    for (const listener of [...this.provideListeners]) {
      try { listener() } catch (error) { console.error('[web-runtime] pooled provide listener failed:', error) }
    }
  }

  private rebuild(): void {
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    const subagentsByParent: SessionListState['subagentsByParent'] = {}
    const jobsBySession: SessionListState['jobsBySession'] = {}
    for (const entry of this.entries.values()) {
      const state = entry.runtime.list.getSnapshot()
      const archived = this.archivedByTarget.get(entry.key) ?? new Set<SessionId>()
      for (const id of state.ids) if (!archived.has(id) && !ids.includes(id)) ids.push(id)
      for (const id of Object.keys(state.byId) as SessionId[]) {
        const summary = state.byId[id]
        if (summary === undefined || archived.has(id) || byId[id] !== undefined) continue
        byId[id] = entry.target.kind === 'project'
          ? {
            ...summary,
            projectId: entry.target.projectId,
            ...(entry.target.projectName === undefined ? {} : { workspaceName: entry.target.projectName }),
          }
          : summary
      }
      Object.assign(subagentsByParent, state.subagentsByParent)
      Object.assign(jobsBySession, state.jobsBySession)
    }
    const current = this.activeSession !== undefined && byId[this.activeSession] !== undefined
      ? this.activeSession
      : this.base.list.getSnapshot().current
    if (current !== undefined && byId[current] === undefined) this.activeSession = undefined
    const owner = current === undefined ? undefined : this.sessionOwners.get(current)
    const nextProvide = owner?.runtime.currentProvideInfo.getSnapshot()
      ?? this.base.currentProvideInfo.getSnapshot()
    if (nextProvide !== this.currentProvideSnapshot) {
      this.currentProvideSnapshot = nextProvide
      this.notifyProvide()
    }
    this.list.set({
      ids, byId, current: current !== undefined && byId[current] !== undefined ? current : undefined,
      phase: this.base.list.getSnapshot().phase,
      subagentsByParent, jobsBySession,
      currentAddress: owner?.runtime.list.getSnapshot().currentAddress,
    })
  }

  /** Lazily start and list one target project runtime. */
  private async runtimeForTarget(target: SessionRuntimeTarget): Promise<RuntimeEntry | undefined> {
    const key = targetKey(target)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      const connection = this.baseConnection.forTarget?.(target)
      if (connection === undefined) return undefined
      const fiber = this.rootCtx.plugin(runtimeScope)
      const runtime = new Runtime(fiber.ctx, connection.api, this.remote, this.conversation, {
        persistSelection: false,
        provideService: false,
      })
      entry = { key, target, runtime, connection, fiber }
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
          runtime.handleMuxEnvelope(envelope)
        },
        onHostEnvelope: (envelope: Parameters<Runtime['handleHostEnvelope']>[0]) => {
          runtime.handleHostEnvelope(envelope)
          const frame = envelope.payload
          if (frame.type === 'host/remote-event') this.rootCtx.remote.$dispatch(frame.event, frame.args)
        },
        onConnected: () => {
          runtime.handleConnected()
          void runtime.refresh().then(() => {
            if (runtime.list.getSnapshot().phase === 'ready') resolveReady()
            else rejectReady(new Error('target runtime session list unavailable'))
            return connection.api.workspace.list({})
          }).then(({ result }) => {
            if (result.ok) {
              this.archivedByTarget.set(establishedEntry.key, new Set(result.value.archivedSessionIds))
              this.rebuild()
            }
          }, rejectReady)
        },
        onStateChange: (state: 'connected' | 'reconnecting') => {
          if (state !== 'reconnecting') return
          runtime.handleDisconnected()
          rejectReady(new Error('target runtime connection unavailable'))
        },
      })
      entry.stop = () => { loop.stop() }
    }
    try {
      if (entry.ready !== undefined) await entry.ready
    } catch (error) {
      this.releaseEntry(entry)
      this.rebuild()
      throw error
    }
    if (this.entries.get(key) !== entry) return undefined
    this.indexEntry(entry)
    this.rebuild()
    return entry
  }

  /** Check whether a Session exists in the target runtime. */
  async ensureSession(target: SessionRuntimeTarget, id: SessionId): Promise<boolean> {
    const entry = await this.runtimeForTarget(target)
    if (entry?.runtime.list.getSnapshot().ids.includes(id) !== true || entry.connection === undefined) return false
    const { result } = await entry.connection.api.workspace.list({})
    if (!result.ok) throw new Error(result.error.message)
    return !result.value.archivedSessionIds.includes(id)
  }

  /** Create a Session in the target runtime and index its owner. */
  async createSession(target: SessionRuntimeTarget): Promise<SessionId> {
    const entry = await this.runtimeForTarget(target)
    if (entry === undefined) throw new Error('target runtime transport unavailable')
    const id = await entry.runtime.create()
    if (this.entries.get(entry.key) !== entry) throw new Error('target runtime was released during session creation')
    this.indexEntry(entry)
    this.rebuild()
    return id
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
    return this.base.createOrReuse(opts, reusableSessionIds)
  }

  /** Route a mux frame to the base runtime.
   * @param envelope - decoded mux envelope.
   */
  handleMuxEnvelope(envelope: Parameters<Runtime['handleMuxEnvelope']>[0]): void {
    this.base.handleMuxEnvelope(envelope)
  }
  /** Route a host frame to the base runtime.
   * @param envelope - decoded host envelope.
   */
  handleHostEnvelope(envelope: Parameters<Runtime['handleHostEnvelope']>[0]): void {
    this.base.handleHostEnvelope(envelope)
  }
  /** Mark the base runtime connection as ready. */
  handleConnected(): void {
    this.base.handleConnected()
    void this.baseConnection.api.workspace.list({}).then(({ result }) => {
      if (result.ok) {
        this.archivedByTarget.set('personal', new Set(result.value.archivedSessionIds))
        this.rebuild()
      }
    })
  }
  /** Mark the base runtime connection as unavailable. */
  handleDisconnected(): void { this.base.handleDisconnected() }

  runtimeTargetFor(id: SessionId): SessionRuntimeTarget | undefined {
    return this.sessionOwners.get(id)?.target
  }

  setBaseRuntimeTarget(target: SessionRuntimeTarget): void {
    const baseEntry = [...this.entries.values()].find(entry => entry.runtime === this.base)
    if (baseEntry === undefined || targetKey(baseEntry.target) === targetKey(target)) return
    this.entries.delete(baseEntry.key)
    baseEntry.target = target
    baseEntry.key = targetKey(target)
    this.entries.set(baseEntry.key, baseEntry)
    this.indexEntry(baseEntry)
    this.rebuild()
  }

  open(id: SessionId): void {
    const owner = this.sessionOwners.get(id)
    if (owner === undefined) throw new Error(`sessions.select: unknown session ${id}`)
    this.activeSession = id
    owner.runtime.open(id)
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
    const grouped = new Map<RuntimeEntry, SessionId[]>()
    for (const id of ids) {
      const owner = this.sessionOwners.get(id)
      if (owner === undefined) continue
      const list = grouped.get(owner) ?? []
      list.push(id)
      grouped.set(owner, list)
    }
    for (const entry of this.entries.values()) entry.runtime.setAdditionalStaged(grouped.get(entry) ?? [])
    this.releaseUnused(ids)
  }

  private releaseUnused(ids: readonly SessionId[]): void {
    const retained = new Set(ids)
    // An active pane is retained only while it is explicitly staged. When
    // the workbench closes or the page changes scope, releasing every
    // non-base target prevents its sessions from leaking into the ordinary
    // current-space navigation list.
    for (const entry of [...this.entries.values()]) {
      if (entry.runtime === this.base || [...retained].some(id => this.sessionOwners.get(id) === entry)) continue
      this.releaseEntry(entry)
    }
    this.rebuild()
  }

  private releaseEntry(entry: RuntimeEntry): void {
    if (entry.runtime === this.base || this.entries.get(entry.key) !== entry) return
    this.entries.delete(entry.key)
    this.archivedByTarget.delete(entry.key)
    entry.stop?.()
    entry.stopSubscriptions?.()
    entry.rejectReady?.(new Error('target runtime was released before it became ready'))
    for (const disposers of this.providers.values()) {
      disposers.get(entry)?.()
      disposers.delete(entry)
    }
    for (const [id, owner] of this.sessionOwners) if (owner === entry) this.sessionOwners.delete(id)
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

  scope(id: SessionId): AgentContext | undefined { return this.sessionOwners.get(id)?.runtime.scope(id) }
  scopeOf(ctx: Context): SessionId | undefined {
    for (const entry of this.entries.values()) {
      const id = entry.runtime.scopeOf(ctx)
      if (id !== undefined) return id
    }
    return undefined
  }
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = this.scopeOf(ctx)
    return id === undefined ? undefined : this.sessionOwners.get(id)?.runtime.sessionOf(ctx)
  }
  binding(id: SessionId): SessionBinding | undefined { return this.sessionOwners.get(id)?.runtime.binding(id) }
  provideInfoFor(id: SessionId): SessionProvideInfo | undefined { return this.sessionOwners.get(id)?.runtime.provideInfoFor(id) }
  subagentAddress(id: SessionId): SubagentAddress | undefined { return this.sessionOwners.get(id)?.runtime.subagentAddress(id) }
  openSubagent(address: SubagentAddress): void {
    const owner = this.sessionOwners.get(address.childSessionId) ?? this.sessionOwners.get(address.parentSessionId)
    if (owner === undefined) throw new Error(`sessions.selectSubagent: unknown session ${address.childSessionId}`)
    owner.runtime.openSubagent(address)
    this.activeSession = address.childSessionId
    this.currentProvideSnapshot = owner.runtime.currentProvideInfo.getSnapshot()
    this.rebuild(); this.notifyProvide()
  }
  /** Set whether one parent Session's child catalog is expanded.
   * @param parent - parent Session identity.
   * @param open - whether the catalog is expanded.
   */
  setSubagentCatalogOpen(parent: SessionId, open: boolean): void {
    this.sessionOwners.get(parent)?.runtime.setSubagentCatalogOpen(parent, open)
  }
  /** Refresh the child catalog for one parent Session.
   * @param parent - parent Session identity.
   */
  refreshSubagents(parent: SessionId): Promise<void> {
    return this.sessionOwners.get(parent)?.runtime.refreshSubagents(parent) ?? Promise.resolve()
  }
  /** Record the preset observed for one Session.
   * @param id - Session identity.
   * @param preset - preset identifier.
   */
  noteAgentPreset(id: SessionId, preset: string): void { this.sessionOwners.get(id)?.runtime.noteAgentPreset(id, preset) }
  search(query: string, signal: AbortSignal): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.base.search(query, signal)
  }
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId> {
    const owner = this.sessionOwners.get(opts.sessionId)
    if (owner === undefined) return Promise.reject(new Error(`unknown session ${opts.sessionId}`))
    return owner.runtime.fork(opts)
  }
}
