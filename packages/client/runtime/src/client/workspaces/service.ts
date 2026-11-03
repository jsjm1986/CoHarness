/** WorkspaceRuntime projects the Workspace object manager for UI consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { clientSessionKey, runtimeTargetKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionRuntimeTarget } from '../contract/sessions.ts'
import type { PersonalRuntimeDirectory } from '../personal-directory.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  DirectoryListing, IApiClient, RpcError,
  SessionDraftId, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsPort, SessionsPortList } from '../contract/sessions-port.ts'
import type { IWorkspaces, StartSessionOptions } from '../contract/workspaces.ts'
import { commitSessionNavigation } from '../navigation.ts'
import { WorkspaceManager, type WorkspaceArchiveSnapshot, type WorkspaceListPhase } from './manager.ts'
import { prepareGatewayRuntime } from '../prepare-runtime.ts'

/** Generate one opaque browser draft reservation id. */
function newDraftId(): SessionDraftId {
  return `draft-${randomUUID()}` as SessionDraftId
}

/** Generate the Session identity paired with one browser draft. */
function newDraftSessionId(): SessionId {
  return `session-${randomUUID()}` as SessionId
}

interface ActiveDraft {
  draftId: SessionDraftId
  sessionId: SessionId
  workspacePath: string
}

const ACTIVE_DRAFTS_KEY = 'dsh.workspace.drafts.v1'

function loadActiveDrafts(storage: Storage | undefined, name: string): Map<WorkspaceId, ActiveDraft> {
  if (storage === undefined) return new Map()
  try {
    const parsed: unknown = JSON.parse(storage.getItem(name) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
    const result = new Map<WorkspaceId, ActiveDraft>()
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const row = value as Record<string, unknown>
      if (typeof row.draftId !== 'string' || row.draftId.length === 0
        || typeof row.sessionId !== 'string' || row.sessionId.length === 0
        || typeof row.workspacePath !== 'string' || row.workspacePath.length === 0) continue
      result.set(workspaceId as WorkspaceId, {
        draftId: row.draftId as SessionDraftId,
        sessionId: row.sessionId as SessionId,
        workspacePath: row.workspacePath,
      })
    }
    return result
  } catch {
    return new Map()
  }
}

function saveActiveDrafts(drafts: ReadonlyMap<WorkspaceId, ActiveDraft>, storage: Storage | undefined, name: string): void {
  if (storage === undefined) return
  try {
    const value: Record<string, ActiveDraft> = {}
    for (const [workspaceId, draft] of drafts) value[workspaceId] = draft
    storage.setItem(name, JSON.stringify(value))
  } catch {
    // A private-mode or quota failure only disables recovery; the live draft remains usable.
  }
}

/** Workspace list plus the two-baseline readiness and default-target projection. */
export interface WorkspaceListState {
  items: readonly WorkspaceView[]
  /** Runtime captured when a directory operation opens; null denotes the bootstrap Host. */
  directoryRuntime?: SessionRuntimeTarget | null
  /** Authorized metadata-only personal Runtime groups; absent outside the unified personal view. */
  computerGroups?: readonly PersonalRuntimeDirectory[]
  /** Exact owning Runtime for each projected Workspace identity. */
  workspaceRuntimeIds?: Readonly<Record<string, string>>
  /** Central catalog load state; a failure retains the preceding directory. */
  directoryState?: 'loading' | 'ready' | 'error'
  /**
   * Registry-global archive set in Host order: grouping surfaces hide these
   * sessions everywhere (workspace groups and the ungrouped bucket) while
   * their session logs and workspace accounting slots remain. A plain array
   * (store-engine vocabulary; immer drafts reject Sets) — membership lookups
   * build their own transient Set.
   */
  archivedSessionIds: readonly SessionId[]
  /**
   * Registry-global pin set in Host pin order (most recently pinned first):
   * pinned sessions lead their grouping-surface section. Same plain-array
   * posture as `archivedSessionIds`.
   */
  pinnedSessionIds: readonly SessionId[]
  /** Versioned archive snapshot revision, when supplied by the Host. */
  archiveRevision?: number
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
  /** True only after both workspace.list and session.list have succeeded. */
  baselinesReady: boolean
  /** First default navigation awaits baselines or its selected Session;
   * absent after completion, failure, supersession or disposal. */
  initialSelectionPending?: true
  /** Most recently active Workspace, derived without changing `items` order. */
  recentWorkspaceId: WorkspaceId | undefined
}

/** Structured create failure for UI flows that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorkspaceCreateError'
  }
}

/** Structured browse failure so the directory browser can branch on Host business codes. */
export class DirectoryBrowseError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'DirectoryBrowseError'
  }
}

/**
 * Archive failed on the Host. `rpcError.code` distinguishes the active-session
 * refusal (`session-active`, whose details name what still runs) from a
 * missing session or a carrier fault. Client plugin bundles do not share
 * error-class identity: consumers branch on `name` and `rpcError`, not
 * `instanceof`.
 */
export class WorkspaceArchiveError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`session archive failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorkspaceArchiveError'
  }
}

/** Real Workspace object layer and Host actions. */
export class WorkspaceRuntime implements IWorkspaces {
  private externalItems: WorkspaceView[] = []
  private readonly externalOwners = new Map<WorkspaceId, { runtime: SessionRuntimeTarget; workspaceId: WorkspaceId }>()
  private computerGroups: readonly PersonalRuntimeDirectory[] | undefined
  private groupComputers = true
  private directoryState: WorkspaceListState['directoryState']
  private baseRuntimeId = ''
  private readonly foreignPins = new Map<string, readonly SessionId[]>()
  private readonly foreignPinRequests = new Map<string, number>()
  /** Refresh central metadata; the installed directory owner supplies this callback. */
  refreshPersonalDirectory: () => Promise<void> = async () => {}

  /** Publish directory state while retaining cached metadata.
   * @param state - central metadata request state.
   */
  setDirectoryState(state: WorkspaceListState['directoryState']): void { this.directoryState = state; this.project() }

  /** Install foreign Workspace identities without opening connections.
   * @param groups - currently authorized personal Runtime metadata.
   * @param baseRuntimeId - verified bootstrap Runtime identity.
   * @param groupComputers - whether the entry exposes computer groups.
   */
  installPersonalDirectory(groups: readonly PersonalRuntimeDirectory[], baseRuntimeId: string, groupComputers = true): void {
    this.groupComputers = groupComputers
    this.externalOwners.clear()
    this.externalItems = []
    this.computerGroups = groups.length === 0 ? undefined : groups
    this.baseRuntimeId = baseRuntimeId
    for (const group of groups) {
      if (group.runtime.runtimeId === baseRuntimeId) continue
      for (const item of group.items) {
        const workspaceId = `dsh-workspace:${group.runtime.runtimeId}:${encodeURIComponent(item.workspaceId)}` as WorkspaceId
        this.externalOwners.set(workspaceId, { runtime: group.runtime, workspaceId: item.workspaceId })
        this.externalItems.push({ ...item, workspaceId, sessionIds: item.sessionIds.map(id => clientSessionKey(group.runtime, id)) })
      }
    }
    this.project()
  }

  /** Reproject retained Workspaces when entry policy changes.
   * @param enabled - whether to group computers.
   */
  setComputerGrouping(enabled: boolean): void { this.groupComputers = enabled; this.project() }

  private workspaceRequest(workspaceId: WorkspaceId): { workspaceId: WorkspaceId; runtimeTarget?: SessionRuntimeTarget } {
    const owner = this.externalOwners.get(workspaceId)
    return owner === undefined ? { workspaceId } : { workspaceId: owner.workspaceId, runtimeTarget: owner.runtime }
  }

  /** Resolve the Runtime owning a foreign Workspace.
   * @param workspaceId - projected Workspace identity.
   * @returns exact Runtime, or undefined for the bootstrap Host.
   */
  runtimeForWorkspace(workspaceId: WorkspaceId): SessionRuntimeTarget | undefined {
    return this.externalOwners.get(workspaceId)?.runtime
  }

  private foreignApi(workspaceId: WorkspaceId): IApiClient | undefined {
    const owner = this.externalOwners.get(workspaceId)
    if (owner === undefined) return undefined
    const connection = this.rootCtx.get('connection') as ConnectionHandle
    const api = connection.forTarget?.(owner.runtime).api
    if (api === undefined) throw new Error('Workspace Runtime connection is unavailable')
    return api
  }

  private selectedTarget(): SessionRuntimeTarget | undefined {
    const current = this.sessions.list.getSnapshot().current
    return current === undefined ? undefined : this.sessions.runtimeTargetFor?.(current)
  }

  private selectedApi(runtimeTarget?: SessionRuntimeTarget | null): IApiClient {
    const target = runtimeTarget === undefined ? this.selectedTarget() : runtimeTarget ?? undefined
    if (target === undefined) return this.api
    const api = (this.rootCtx.get('connection') as ConnectionHandle).forTarget?.(target).api
    if (api === undefined) throw new Error('Selected Runtime connection is unavailable')
    return api
  }

  private async preparedApi(runtimeTarget?: SessionRuntimeTarget | null, signal?: AbortSignal): Promise<IApiClient> {
    const target = runtimeTarget === undefined ? this.selectedTarget() : runtimeTarget ?? undefined
    if (target !== undefined) await prepareGatewayRuntime(this.rootCtx.get('connection') as ConnectionHandle | undefined, target, signal)
    signal?.throwIfAborted()
    return this.selectedApi(target ?? null)
  }

  /**
   * Create on the captured computer with explicit Workspace membership.
   * @param target - exact Runtime owning the new conversation.
   * @param workspaceId - projected Workspace chosen on that Runtime; omission uses its Host default directory.
   * @param signal - owning navigation cancellation, checked before publishing a result.
   * @returns a runtime-qualified Session identity for navigation.
   */
  async createRuntimeSession(target: SessionRuntimeTarget, workspaceId?: WorkspaceId, signal?: AbortSignal): Promise<SessionId> {
    signal?.throwIfAborted()
    const create = this.sessions.createSession?.bind(this.sessions)
    if (create === undefined) throw new Error('Runtime conversation creation is unavailable')
    let originalId: WorkspaceId
    if (workspaceId === undefined) {
      const api = await this.preparedApi(target, signal)
      const description = await api.host.describe({}, signal)
      if (!description.result.ok) throw new WorkspaceCreateError(description.result.error)
      signal?.throwIfAborted()
      const registration = await api.workspace.create({ path: description.result.value.cwd }, signal)
      if (!registration.result.ok) throw new WorkspaceCreateError(registration.result.error)
      signal?.throwIfAborted()
      const view = registration.result.value.workspace
      originalId = view.workspaceId
      if (target.runtimeId === this.baseRuntimeId) await this.manager.refresh()
      else this.presentRuntimeWorkspace(target, view)
    } else {
      this.requireWorkspace(workspaceId)
      const owner = this.externalOwners.get(workspaceId)
      if ((owner?.runtime.runtimeId ?? this.baseRuntimeId) !== target.runtimeId) throw new Error('Workspace belongs to another Runtime')
      originalId = owner?.workspaceId ?? workspaceId
    }
    signal?.throwIfAborted()
    const id = await create(target, signal, { workspaceId: originalId })
    signal?.throwIfAborted()
    return id
  }

  private presentRuntimeWorkspace(runtime: SessionRuntimeTarget, view: WorkspaceView): WorkspaceView {
    const workspaceId = `dsh-workspace:${runtime.runtimeId}:${encodeURIComponent(view.workspaceId)}` as WorkspaceId
    this.externalOwners.set(workspaceId, { runtime, workspaceId: view.workspaceId })
    const projected = { ...view, workspaceId, sessionIds: view.sessionIds.map(id => clientSessionKey(runtime, id)) }
    this.externalItems = [...this.externalItems.filter(item => item.workspaceId !== workspaceId), projected]
    this.project()
    return projected
  }

  private adoptForeign(workspaceId: WorkspaceId, view: WorkspaceView): WorkspaceView {
    const owner = this.externalOwners.get(workspaceId)
    if (owner === undefined) throw new Error('Foreign Workspace target was withdrawn')
    const projected = { ...view, workspaceId, sessionIds: view.sessionIds.map(id => clientSessionKey(owner.runtime, id)) }
    this.externalItems = this.externalItems.map(item => item.workspaceId === workspaceId ? projected : item)
    this.project(); return projected
  }
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<WorkspaceListState>
  /** Workspace baseline and frame owner. */
  private readonly manager: WorkspaceManager
  /**
   * In-flight Session creates keyed by workspace. Connects coalesce only
   * within one arm — a bare New Session (`fresh`) never joins a reuse
   * connect, which may land on a member blank carrying an earlier preset.
   */
  private readonly connecting = new Map<WorkspaceId, {
    readonly fresh?: true
    readonly agentPreset?: string
    readonly attempt: Promise<SessionId>
  }>()
  /** Draft reservations survive a reload without storing prompt text or credentials. */
  private readonly activeDrafts = new Map<WorkspaceId, ActiveDraft>()
  private draftStorageKey: string | undefined
  /** Guards the runtime-owned one-shot initial-selection subscription. */
  private initialSelectionStarted = false

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - cross-domain sessions face used for recency and blank-session reuse.
   */
  constructor(private readonly rootCtx: Context, private readonly api: IApiClient, private readonly sessions: SessionsPort) {
    // Whole-set echoes install only for sessions owned by the runtime this
    // mirror tracks; a session-addressed call routed elsewhere returns a
    // foreign registry's set, which its own runtime frames own.
    this.restoreDrafts()
    this.manager = new WorkspaceManager(api, id => this.sessions.runtimeTargetFor?.(id) === undefined)
    this.list = createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'pending', error: null,
      archiveRevision: 0,
      baselinesReady: false, recentWorkspaceId: undefined,
    })
    this.manager.subscribe(() => { this.project() })
    this.sessions.list.subscribe(() => { this.project() })
    const stopForeign = this.sessions.workspaceSnapshots?.subscribe(() => {
      for (const { target, state } of this.sessions.workspaceSnapshots?.getSnapshot() ?? []) {
        if (target.kind !== 'personal' || !this.computerGroups?.some(group => runtimeTargetKey(group.runtime) === runtimeTargetKey(target))) continue
        const previous = new Set([...this.externalOwners]
          .filter(([, owner]) => runtimeTargetKey(owner.runtime) === runtimeTargetKey(target)).map(([id]) => id))
        this.externalItems = this.externalItems.filter(item => !previous.has(item.workspaceId))
        for (const id of previous) this.externalOwners.delete(id)
        for (const item of state.items) {
          const workspaceId = `dsh-workspace:${target.runtimeId}:${encodeURIComponent(item.workspaceId)}` as WorkspaceId
          this.externalOwners.set(workspaceId, { runtime: target, workspaceId: item.workspaceId })
          this.externalItems.push({ ...item, workspaceId, sessionIds: item.sessionIds.map(id => clientSessionKey(target, id)) })
        }
        const key = runtimeTargetKey(target)
        this.foreignPins.set(key, state.pinnedSessionIds.map(id => clientSessionKey(target, id)))
        this.foreignPinRequests.set(key, (this.foreignPinRequests.get(key) ?? 0) + 1)
      }
      this.project()
    })
    rootCtx.effect(() => () => { stopForeign?.() }, 'workspaces: foreign Workspace projections')
    rootCtx.reflect.provide('workspaces', this, undefined)
  }

  private draftStorage(): { storage: Storage | undefined; name: string } | undefined {
    // Programmatic clients can instantiate this service without a browser Location.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    const runtimeId = new URLSearchParams(globalThis.location?.search).get('dshRuntime')
    if (runtimeId === null) return { storage: globalThis.localStorage, name: ACTIVE_DRAFTS_KEY }
    const accountId = this.rootCtx.get('projectUiPolicy')?.getSnapshot().verifiedAccountId
    if (accountId === undefined) return undefined
    return { storage: globalThis.sessionStorage, name: `dsh.workspace.drafts.v2.account:${accountId}.runtime:${runtimeId}` }
  }

  private restoreDrafts(): void {
    const owner = this.draftStorage()
    if (owner === undefined || owner.name === this.draftStorageKey) return
    this.activeDrafts.clear()
    for (const [id, draft] of loadActiveDrafts(owner.storage, owner.name)) this.activeDrafts.set(id, draft)
    this.draftStorageKey = owner.name
  }

  private persistDrafts(): void {
    const owner = this.draftStorage()
    if (owner === undefined || owner.name !== this.draftStorageKey) return
    saveActiveDrafts(this.activeDrafts, owner.storage, owner.name)
  }

  /**
   * Resolve the session a Workspace reconnection lands in: reuse the
   * workspace's existing blank member when one is in the list mirror, else
   * create a fresh one on the host (`session.create` births the full
   * Session+Agent — the client holds no intermediate state). This is the
   * `openWorkspace` history fallback and the draft-preparation arm of {@link
   * startSession}; a bare New Session goes through {@link connectFreshSession}
   * instead, which never offers member blanks. The caller owns navigation:
   * take the returned id to `sessions.open`.
   * The returned identity is already catalogued. Retain it before borrowing
   * its binding for a draft hand-off, or open it to acquire a view reference.
   * @param workspaceId - chosen Workspace (must be in the workspace list).
   * @param options - `agentPreset` names the composition the conversation
   *   runs; omitted composes the deployment default.
   * @returns the reused or newly created session id.
   */
  async connectWorkspace(workspaceId: WorkspaceId, options?: { readonly agentPreset?: string }): Promise<SessionId> {
    this.restoreDrafts()
    const workspace = this.requireWorkspace(workspaceId)
    // Coalesce concurrent connects: a create's summary lands without cwd
    // until the host frame arrives, so a second call inside that window
    // would miss the reuse scan and mint another hidden blank session. Two
    // connects asking for different presets cannot coalesce — each request
    // names the composition its conversation must run. A bare New Session
    // create in flight is never joined either: it offers no member blank, so
    // its resolution cannot satisfy this contract.
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined && inflight.fresh !== true && inflight.agentPreset === options?.agentPreset) return inflight.attempt
    // Reuse requires workspace membership (id in sessionIds AND same
    // canonical cwd — the host's own membership rule), never cwd alone:
    // a cwd match can belong to no account (sessions the CLI/TUI birthed at
    // the host cwd, or a deleted/recreated registration) and reusing it
    // would open a session no grouping surface shows under this workspace.
    // An archived blank is never reused either: reuse would open a session
    // no grouping surface can show, so the connect mints a fresh one instead.
    const archived = this.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    const reusableSessionIds: SessionId[] = []
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) reusableSessionIds.push(summary.id)
    }
    const active = this.activeDrafts.get(workspaceId)
    const draft = active !== undefined && active.workspacePath === workspace.path
      ? active
      : { draftId: newDraftId(), sessionId: newDraftSessionId(), workspacePath: workspace.path }
    this.activeDrafts.set(workspaceId, draft)
    this.persistDrafts()
    const attempt = this.sessions.createOrReuse({
      ...this.workspaceRequest(workspaceId),
      draftId: draft.draftId,
      sessionId: draft.sessionId,
      ...(options?.agentPreset !== undefined ? { agentPreset: options.agentPreset } : {}),
    }, reusableSessionIds)
      .then((sessionId) => {
        if (reusableSessionIds.includes(sessionId)) {
          this.activeDrafts.delete(workspaceId)
        } else {
          const current = this.activeDrafts.get(workspaceId)
          if (current !== undefined) {
            const original = this.sessions.keyFor === undefined ? sessionId : parseClientSessionKey(sessionId)?.sessionId
            if (original === undefined) throw new Error('Pooled Session creation returned no runtime-qualified identity')
            this.activeDrafts.set(workspaceId, { ...current, sessionId: original })
          }
        }
        this.persistDrafts()
        return sessionId
      })
      .finally(() => {
        if (this.connecting.get(workspaceId)?.attempt === attempt) this.connecting.delete(workspaceId)
      })
    this.connecting.set(workspaceId, {
      ...(options?.agentPreset !== undefined ? { agentPreset: options.agentPreset } : {}),
      attempt,
    })
    return attempt
  }

  /**
   * The bare New Session arm: create through `sessions.create` with only the
   * Workspace identity, so the Host mints a fresh Session and composes a new
   * Agent under the current preset definition. Member blanks stay parked for
   * {@link connectWorkspace} reuse — a blank minted by an earlier gesture can
   * carry a stale composition, and adopting it would reopen that generation.
   * The Workspace's live draft reservation is likewise never offered: its
   * Session would resume under the composition it recorded, so the
   * reservation stays untouched for draft preparation to reuse or retire.
   * Concurrent New Session calls for one Workspace join the same in-flight
   * create; a settled create never satisfies a later call.
   * @param workspaceId - chosen Workspace (must be in the workspace list).
   * @returns the fresh session id.
   */
  private connectFreshSession(workspaceId: WorkspaceId): Promise<SessionId> {
    this.requireWorkspace(workspaceId)
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined && inflight.fresh === true) return inflight.attempt
    const attempt = this.sessions.create(this.workspaceRequest(workspaceId))
      .finally(() => {
        if (this.connecting.get(workspaceId)?.attempt === attempt) this.connecting.delete(workspaceId)
      })
    this.connecting.set(workspaceId, { fresh: true, attempt })
    return attempt
  }

  /**
   * The listed Workspace a connect targets; unknown ids fail loud rather than
   * creating a Session no account can show.
   */
  private requireWorkspace(workspaceId: WorkspaceId): WorkspaceView {
    const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspaces.connectWorkspace: unknown workspace ${workspaceId}`)
    return workspace
  }

  /**
   * Resolve the default conversation for an existing Workspace. The list
   * snapshot is the complete input: this method performs no additional Host
   * request and opens only the selected Session. A Workspace with no visible
   * historical Session falls back to {@link connectWorkspace}, preserving
   * Workspace reconnection's blank-reuse semantics.
   * @param workspaceId - target workspace.
   * @param options - forwarded to {@link connectWorkspace} when the Workspace
   *   has no selectable history (`agentPreset` names the fallback
   *   conversation's composition).
   * @returns the historical or fallback blank session id.
   */
  async openWorkspace(workspaceId: WorkspaceId, options?: { readonly agentPreset?: string }): Promise<SessionId> {
    const state = this.list.getSnapshot()
    const workspace = state.items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspaces.openWorkspace: unknown workspace ${workspaceId}`)
    const archived = new Set(state.archivedSessionIds)
    const sessions = this.sessions.list.getSnapshot().byId
    let selected: { id: SessionId; updatedAt: number; order: number } | undefined
    for (const [order, id] of workspace.sessionIds.entries()) {
      const summary = sessions[id]
      if (summary === undefined || summary.blank || summary.origin === 'subagent' || archived.has(id)) continue
      if (selected === undefined
        || summary.updatedAt > selected.updatedAt
        || (summary.updatedAt === selected.updatedAt && order < selected.order)) {
        selected = { id, updatedAt: summary.updatedAt, order }
      }
    }
    return selected?.id ?? this.connectWorkspace(workspaceId, options)
  }

  /**
   * Follow the first complete Workspace/Session baseline and select a default
   * session exactly once. A restored current session wins; otherwise the
   * newest eligible historical Session across Workspaces opens, falling back
   * to the recent Workspace's reusable or newly created blank session when no
   * history exists.
   * Later explicit clears stay cleared instead of retriggering this startup
   * policy. A failed open may retry on the next baseline projection.
   * @returns disposer for the baseline subscription; late work cannot navigate after disposal.
   */
  startInitialSelection(): () => void {
    if (this.initialSelectionStarted) {
      throw new Error('workspaces.startInitialSelection: already started')
    }
    this.initialSelectionStarted = true
    const lifetime = new AbortController()
    const navigation = AbortSignal.any([this.sessions.beginNavigation(), lifetime.signal])
    type InitialSelectionState = 'waiting' | 'opening' | 'failed' | 'done'
    let state: InitialSelectionState = 'waiting'
    let failedBaseline: { workspaces: object; sessions: object } | undefined
    let disposed = false
    const setState = (next: InitialSelectionState): void => {
      state = next
      if (next !== 'failed') failedBaseline = undefined
      const pending = next === 'waiting' || next === 'opening'
      const snapshot = this.list.getSnapshot()
      if ((snapshot.initialSelectionPending === true) === pending) return
      const value = { ...snapshot }
      if (pending) value.initialSelectionPending = true
      else delete value.initialSelectionPending
      this.list.set(value)
    }
    const reconcile = (): void => {
      if (disposed || navigation.aborted || (state !== 'waiting' && state !== 'failed')) return
      const workspace = this.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (state === 'failed' && failedBaseline !== undefined
        && failedBaseline.workspaces === this.manager.getSnapshot() && failedBaseline.sessions === sessions) return
      if (!workspace.baselinesReady) {
        if (workspace.state === 'error') {
          failedBaseline = { workspaces: this.manager.getSnapshot(), sessions }
          setState('failed')
        } else setState('waiting')
        return
      }
      const current = sessions.current
      // Startup is history-first across the whole registry. Keep
      // recentWorkspaceId as the New Session target, where an empty Workspace
      // is still a valid destination, but do not let a newer blank/subagent
      // row hide an older visible conversation in another Workspace.
      const target = recentHistoryWorkspace(
        workspace.items.filter(item => !this.externalOwners.has(item.workspaceId)), sessions.byId, workspace.archivedSessionIds,
      ) ?? workspace.items.find(item => !this.externalOwners.has(item.workspaceId))?.workspaceId
      if (current !== undefined) {
        // A saved blank re-adopts under the preset its log recorded through
        // the same reuse path a Workspace connect takes: an unclean exit may
        // have left the Agent cold, and a preset deleted since must not
        // strand the restore — the reuse arm degrades it to the default.
        const summary = sessions.byId[current]
        const owner = summary === undefined || !summary.blank || workspace.archivedSessionIds.includes(current)
          ? undefined
          : workspace.items.find(item => item.path === summary.cwd && item.sessionIds.includes(current))
        if (owner === undefined || summary === undefined) {
          setState('done')
          return
        }
        setState('opening')
        void this.sessions.create({
          workspaceId: owner.workspaceId,
          sessionId: current,
          reuseWorkspaceBlank: true,
          ...(summary.agentPreset !== undefined ? { agentPreset: summary.agentPreset } : {}),
        }).then((sessionId) => {
          if (disposed || navigation.aborted) return
          return commitSessionNavigation(this.sessions, sessionId, navigation, () => {
            if (sessionId !== current) this.sessions.open(sessionId)
            setState('done')
          })
        }).catch((reason: unknown) => {
          if (disposed || navigation.aborted) return
          failedBaseline = { workspaces: this.manager.getSnapshot(), sessions: this.sessions.list.getSnapshot() }
          setState('failed')
          console.warn('saved blank Session restore failed:', reason)
        })
        return
      }
      if (target === undefined) {
        setState('done')
        return
      }
      setState('opening')
      void this.openWorkspace(target).then((sessionId) => {
        if (disposed || navigation.aborted) return
        return commitSessionNavigation(this.sessions, sessionId, navigation, () => {
          const snapshot = this.sessions.list.getSnapshot()
          if (snapshot.archivedById[sessionId] !== undefined
            || this.list.getSnapshot().archivedSessionIds.includes(sessionId)) {
            throw new Error('Session was archived during initial selection')
          }
          if (snapshot.current === undefined) this.sessions.open(sessionId)
          setState('done')
        })
      }).catch((reason: unknown) => {
        if (disposed || navigation.aborted) return
        failedBaseline = { workspaces: this.manager.getSnapshot(), sessions: this.sessions.list.getSnapshot() }
        setState('failed')
        console.warn('initial workspace selection failed:', reason)
      })
    }
    const unsubscribe = this.list.subscribe(reconcile)
    const cancel = (): void => {
      unsubscribe()
      setState('done')
    }
    navigation.addEventListener('abort', cancel, { once: true })
    if (navigation.aborted) cancel()
    else {
      setState('waiting')
      reconcile()
    }
    return () => {
      if (disposed) return
      disposed = true
      navigation.removeEventListener('abort', cancel)
      unsubscribe()
      lifetime.abort()
      setState('done')
    }
  }

  /**
   * The shared New Session action behind the shell entry points (sidebar
   * button, workspace browser): resolve the target Workspace — explicit wins,
   * then the current Session's Workspace, then the recent-Workspace
   * projection — create its Session and navigate there; with no Workspace at
   * all, clear the selection into the New Session view state.
   * A bare call always mints a fresh Session+Agent under the current preset
   * definition ({@link connectFreshSession}); draft-preparation options keep
   * the reconnect arm ({@link connectWorkspace}), so a landed draft the
   * Workspace already knows stays open. Connect failures are non-fatal
   * (console diagnostics plus `onFailure`). The originating composer is held
   * until preparation settles; its draft and any running task remain owned.
   * @param workspaceId - explicit target Workspace for scoped actions.
   * @param options - draft initialization for the landed Session and the
   * rejected-connect observer.
   */
  startSession(workspaceId?: WorkspaceId, options: StartSessionOptions = {}): void {
    const { prompt, clearPreviousDraft, onFailure } = options
    const workspace = this.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = sessions.current
    const selectedRuntime = this.selectedTarget()
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
        ?? workspace.items.find(item => item.workspaceId === sessions.byId[current]?.workspaceId)?.workspaceId
        ?? workspace.items.find(item => item.path === sessions.byId[current]?.cwd
          && this.externalOwners.get(item.workspaceId)?.runtime.runtimeId === selectedRuntime?.runtimeId)?.workspaceId
    const target = workspaceId ?? currentWorkspaceId ?? (selectedRuntime === undefined ? workspace.recentWorkspaceId : undefined)
    if (target === undefined && selectedRuntime === undefined) {
      this.sessions.clear()
      return
    }
    const navigation = this.sessions.beginNavigation({ blockInputFor: current })
    const create = () => {
      if (target !== undefined) return prompt !== undefined || clearPreviousDraft === true
        ? this.connectWorkspace(target) : this.connectFreshSession(target)
      if (selectedRuntime === undefined) throw new Error('New conversation requires a Runtime')
      return this.sessions.create({ runtimeTarget: selectedRuntime })
    }
    const perform = async () => {
      const sessionId = await create()
      if (navigation.aborted) return
      if (this.sessions.list.getSnapshot().archivedById[sessionId] !== undefined
        || this.list.getSnapshot().archivedSessionIds.includes(sessionId)) throw new Error('Session was archived during navigation')
      return commitSessionNavigation(this.sessions, sessionId, navigation, () => {
        if (this.sessions.list.getSnapshot().archivedById[sessionId] !== undefined
          || this.list.getSnapshot().archivedSessionIds.includes(sessionId)) throw new Error('Session was archived during navigation')
        this.sessions.open(sessionId)
        // Draft initialization is a prefill only: nothing is sent, and the
        // input hub applies it when (or if) the Session's composer exists.
        if (prompt !== undefined || clearPreviousDraft === true) {
          this.rootCtx.emit('conversation/draft-initialize', {
            sessionId,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(clearPreviousDraft === true ? { clearPreviousDraft: true } : {}),
          })
        }
      })
    }
    const runtime = target === undefined ? selectedRuntime : this.externalOwners.get(target)?.runtime
    const creating = runtime !== undefined && this.sessions.usingRuntime !== undefined
      ? this.sessions.usingRuntime(runtime, navigation, perform) : perform()
    void creating.finally(() => { this.sessions.finishNavigation(navigation) }).catch((reason: unknown) => {
      console.warn('new session failed:', reason)
      onFailure?.(reason)
    })
  }

  /**
   * Register an existing path as a Workspace.
   * @param input - directory and captured Runtime; null uses the bootstrap Host, omission uses current selection.
   * @returns the created or idempotently resolved Workspace.
   */
  async create(input: { path: string; runtimeTarget?: SessionRuntimeTarget | null }): Promise<WorkspaceView> {
    const runtime = input.runtimeTarget === undefined ? this.selectedTarget() : input.runtimeTarget ?? undefined
    if (runtime !== undefined) {
      const api = await this.preparedApi(runtime)
      const { result } = await api.workspace.create({ path: input.path })
      if (!result.ok) throw new WorkspaceCreateError(result.error)
      return this.presentRuntimeWorkspace(runtime, result.value.workspace)
    }
    const result = await this.manager.create({ path: input.path })
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return this.presentWorkspace(result.value.workspace)
  }

  /**
   * Open the Host's native directory picker (the `native` capability).
   * @param runtimeTarget - captured Runtime; null uses the bootstrap Host, omission uses current selection.
   * @returns the selected path, or null when the user cancelled.
   */
  async pickDirectory(runtimeTarget?: SessionRuntimeTarget | null): Promise<string | null> {
    const api = await this.preparedApi(runtimeTarget)
    const response = await api.host.pickDirectory({})
    if (!response.result.ok) {
      throw new Error(`directory picker failed: ${response.result.error.message}`)
    }
    return response.result.value.path
  }

  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @param runtimeTarget - captured Runtime; null uses the bootstrap Host, omission uses current selection.
   * @returns the level's listing with breadcrumb ancestry.
   */
  async listDirectory(path?: string, signal?: AbortSignal, runtimeTarget?: SessionRuntimeTarget | null): Promise<DirectoryListing> {
    const api = await this.preparedApi(runtimeTarget, signal)
    const response = await api.host.listDirectory(path === undefined ? {} : { path }, signal)
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @param runtimeTarget - captured Runtime; null uses the bootstrap Host, omission uses current selection.
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string, runtimeTarget?: SessionRuntimeTarget | null): Promise<string> {
    const api = await this.preparedApi(runtimeTarget)
    const response = await api.host.createDirectory({ path, name })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value.path
  }

  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  async openPath(path: string): Promise<void> {
    const response = await this.selectedApi().host.openPath({ path })
    if (!response.result.ok) {
      throw new Error(`path open failed: ${response.result.error.message}`)
    }
  }

  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - new display title (trimmed non-empty by the Host).
   * @returns the renamed Workspace view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const api = this.foreignApi(workspaceId)
    if (api !== undefined) {
      const { result } = await api.workspace.rename({ workspaceId: this.workspaceRequest(workspaceId).workspaceId, title })
      if (!result.ok) throw new Error(result.error.message)
      return this.adoptForeign(workspaceId, result.value.workspace)
    }
    const result = await this.manager.rename(workspaceId, title)
    if (!result.ok) throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`)
    return this.presentWorkspace(result.value.workspace)
  }

  /**
   * Delete one Workspace registration. Sessions, session logs, and the
   * directory remain Host-owned outside this operation.
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    const api = this.foreignApi(workspaceId)
    if (api !== undefined) {
      const { result } = await api.workspace.delete({ workspaceId: this.workspaceRequest(workspaceId).workspaceId })
      if (!result.ok) throw new Error(result.error.message)
      this.externalItems = this.externalItems.filter(item => item.workspaceId !== workspaceId)
      this.externalOwners.delete(workspaceId); this.project(); return
    }
    const result = await this.manager.delete(workspaceId)
    if (!result.ok) throw new Error(`workspace delete failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Move a Workspace within the durable registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const api = this.foreignApi(workspaceId)
    if (api !== undefined) {
      const owner = this.externalOwners.get(workspaceId)
      if (owner === undefined) throw new Error('Workspace Runtime was withdrawn')
      const anchor = beforeWorkspaceId === undefined ? undefined : this.externalOwners.get(beforeWorkspaceId)
      if (beforeWorkspaceId !== undefined
        && (anchor === undefined || runtimeTargetKey(owner.runtime) !== runtimeTargetKey(anchor.runtime))) {
        throw new Error('Workspaces cannot move between Runtimes')
      }
      const { result } = await api.workspace.insertBefore({ workspaceId: owner.workspaceId,
        ...(anchor === undefined ? {} : { beforeWorkspaceId: anchor.workspaceId }) })
      if (!result.ok) throw new Error(result.error.message)
      const positions = new Map(result.value.workspaceIds.map((id, index) => [id, index]))
      const inRuntime = this.externalItems.filter(item =>
        this.externalOwners.get(item.workspaceId)?.runtime.runtimeId === owner.runtime.runtimeId)
        .sort((left, right) => (positions.get(this.workspaceRequest(left.workspaceId).workspaceId) ?? 0)
          - (positions.get(this.workspaceRequest(right.workspaceId).workspaceId) ?? 0))
      let index = 0
      this.externalItems = this.externalItems.map((item) => {
        if (this.externalOwners.get(item.workspaceId)?.runtime.runtimeId !== owner.runtime.runtimeId) return item
        const next = inRuntime[index++]
        if (next === undefined) throw new Error('Workspace order is incomplete')
        return next
      })
      this.project(); return
    }
    const result = await this.manager.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw new Error(`workspace reorder failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Archive a session into the registry-global set. Clearing an archived
   * current selection is the projection sweep's job (one rule for the local
   * echo and a remote tab's frame alike).
   * @param sessionId - session to archive.
   * @param options - `stopActivity` asks the Host to stop the session's running work instead of refusing.
   * @throws {WorkspaceArchiveError} when the Host refuses; without `stopActivity` a session with
   *   running work fails as `session-active`, its details naming what runs.
   */
  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    const result = await this.manager.archiveSession(sessionId, options)
    if (!result.ok) throw new WorkspaceArchiveError(result.error)
  }

  /**
   * Restore an archived session to its recorded Workspace position. The
   * echoed archive set re-shows the session on every grouping surface; no
   * selection change is needed because a restored session was never current.
   * @param sessionId - archived session to restore.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.manager.unarchiveSession(sessionId)
    if (!result.ok) throw new Error(`session unarchive failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Pin a session so it leads its grouping-surface section in Host pin
   * order. The echoed pin set re-orders every grouping surface; a
   * superseded echo (a later pin request, a pushed pin frame, or a refresh
   * baseline) installs nothing.
   * @param sessionId - session to pin.
   */
  async pinSession(sessionId: SessionId): Promise<void> {
    const request = this.beginForeignPin(sessionId)
    const result = await this.manager.pinSession(sessionId)
    if (!result.ok) throw new Error(`session pin failed: ${result.error.code}: ${result.error.message}`)
    this.installForeignPin(request, result.value.pinnedSessionIds)
  }

  /**
   * Drop a session from the registry-global pin set, restoring it to the
   * ordinary part of every grouping-surface section. Idempotent: an id
   * that is not pinned resolves as a no-op, and a superseded echo installs
   * nothing — the same race posture as {@link pinSession}.
   * @param sessionId - pinned session to unpin.
   */
  async unpinSession(sessionId: SessionId): Promise<void> {
    const request = this.beginForeignPin(sessionId)
    const result = await this.manager.unpinSession(sessionId)
    if (!result.ok) throw new Error(`session unpin failed: ${result.error.code}: ${result.error.message}`)
    this.installForeignPin(request, result.value.pinnedSessionIds)
  }

  private beginForeignPin(id: SessionId): { target: SessionRuntimeTarget; seq: number } | undefined {
    const target = this.sessions.runtimeTargetFor?.(id)
    if (target === undefined) return undefined
    const key = runtimeTargetKey(target), seq = (this.foreignPinRequests.get(key) ?? 0) + 1
    this.foreignPinRequests.set(key, seq)
    return { target, seq }
  }

  private installForeignPin(request: { target: SessionRuntimeTarget; seq: number } | undefined, ids: readonly SessionId[]): void {
    if (request === undefined || this.foreignPinRequests.get(runtimeTargetKey(request.target)) !== request.seq) return
    this.foreignPins.set(runtimeTargetKey(request.target), ids.map(id => clientSessionKey(request.target, id)))
    this.project()
  }

  /**
   * Move a session within its Workspace's manual order (DOM-insertBefore-like).
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const api = this.foreignApi(workspaceId)
    if (api !== undefined) {
      const owner = this.externalOwners.get(workspaceId)
      if (owner === undefined) throw new Error('Workspace Runtime was withdrawn')
      const raw = (id: SessionId): SessionId => {
        const address = parseClientSessionKey(id)
        if (address === undefined || runtimeTargetKey(address.runtime) !== runtimeTargetKey(owner.runtime)) {
          throw new Error('Sessions cannot move between Runtimes')
        }
        return address.sessionId
      }
      const { result } = await api.workspace.insertSessionBefore({ workspaceId: owner.workspaceId, sessionId: raw(sessionId),
        ...(beforeSessionId === undefined ? {} : { beforeSessionId: raw(beforeSessionId) }) })
      if (!result.ok) throw new Error(result.error.message)
      return this.adoptForeign(workspaceId, result.value.workspace)
    }
    const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`)
    return this.presentWorkspace(result.value.workspace)
  }

  /**
   * Refresh the workspace baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started workspace baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refresh()
  }

  /**
   * Route a Host stream envelope into the Workspace object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<WorkspaceManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /**
   * Rebuild the Workspace baseline after connection.
   * @returns the archive snapshot produced by the baseline read, or undefined when none applies.
   */
  handleConnected(): Promise<WorkspaceArchiveSnapshot | undefined> {
    const runtimeId = (this.rootCtx.get('connection') as ConnectionHandle | undefined)
      ?.hostDescription.getSnapshot()?.runtimeTarget?.runtimeId
    if (runtimeId !== undefined) this.baseRuntimeId = runtimeId
    return this.manager.handleConnected()
  }

  /** Invalidate pending Workspace baseline work when its connection generation ends. */
  handleDisconnected(): void {
    this.manager.handleDisconnected()
  }

  private presentWorkspace(workspace: WorkspaceView): WorkspaceView {
    return { ...workspace, sessionIds: workspace.sessionIds.map(id => this.sessions.keyFor?.(id) ?? id) }
  }

  private project(): void {
    const raw = this.manager.getSnapshot()
    const key = (id: SessionId): SessionId => this.sessions.keyFor?.(id) ?? id
    const workspace = { ...raw,
      items: [...raw.items.map(item => this.presentWorkspace(item)), ...this.externalItems],
      archivedSessionIds: raw.archivedSessionIds.map(key),
    }
    const sessions = this.sessions.list.getSnapshot()
    for (const [workspaceId, draft] of this.activeDrafts) {
      const summary = sessions.byId[key(draft.sessionId)]
      if (summary !== undefined && !summary.blank) this.activeDrafts.delete(workspaceId)
    }
    this.persistDrafts()
    const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready'
    // An archived current selection clears into the New Session view state —
    // a hidden row must not stay open behind the list. Sweeping here covers
    // every install path with one rule: the local unary echo, another tab's
    // changed frame, and a reconnect baseline restoring a persisted
    // selection that was archived while this client was away.
    if (sessions.current !== undefined && workspace.archivedSessionIds.includes(sessions.current)) {
      this.sessions.clear()
    }
    this.list.set({
      items: this.groupComputers || this.computerGroups === undefined ? workspace.items : workspace.items.filter(item =>
        (this.externalOwners.get(item.workspaceId)?.runtime.runtimeId ?? this.baseRuntimeId)
          === (this.selectedTarget()?.runtimeId ?? this.baseRuntimeId)),
      directoryRuntime: this.selectedTarget() ?? null,
      ...(this.computerGroups === undefined ? {} : { workspaceRuntimeIds: Object.fromEntries(workspace.items.map(item =>
        [item.workspaceId, this.externalOwners.get(item.workspaceId)?.runtime.runtimeId ?? this.baseRuntimeId])) }),
      ...(this.computerGroups === undefined || !this.groupComputers ? {} : { computerGroups: this.computerGroups }),
      ...(this.directoryState === undefined ? {} : { directoryState: this.directoryState }),
      archivedSessionIds: workspace.archivedSessionIds,
      pinnedSessionIds: [...workspace.pinnedSessionIds.map(key), ...[...this.foreignPins].filter(([target]) =>
        this.computerGroups?.some(group => runtimeTargetKey(group.runtime) === target)).flatMap(([, ids]) => ids)],
      ...(workspace.archiveRevision === undefined ? {} : { archiveRevision: workspace.archiveRevision }),
      state: workspace.state,
      phase: workspace.phase,
      error: workspace.error,
      baselinesReady,
      ...(this.list.getSnapshot().initialSelectionPending === true ? { initialSelectionPending: true as const } : {}),
      recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
    })
  }
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionsPortList['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/** Select the Workspace containing the newest eligible historical Session. */
function recentHistoryWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionsPortList['byId'],
  archivedSessionIds: readonly SessionId[],
): WorkspaceId | undefined {
  const archived = new Set(archivedSessionIds)
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session === undefined || session.blank || session.origin === 'subagent' || archived.has(sessionId)) continue
      latest = Math.max(latest, session.updatedAt)
    }
    if (selected === undefined || latest > selectedTime) {
      if (latest === Number.NEGATIVE_INFINITY) continue
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
