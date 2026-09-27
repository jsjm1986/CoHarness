/** Bounded conversation viewing state and Session-window coordination. */
import type {
  AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { parseClientSessionKey, defineStore, type ISessions, type IWorkspaces, type ObservableSnapshot, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

import { readWorkbenchRecord, writeWorkbenchRecord, readLegacyWorkbenchRecord } from './workbench-persistence.ts'
import type { SavedWorkbench, WorkbenchRecord } from './workbench-persistence.ts'
import type { StoreInstance } from '@deepseek-ai/dsh-client-ui-slots'

export type { AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Maximum number of concurrently rendered conversation panes. */
export const WORKBENCH_PANE_LIMIT = 4

interface ViewState {
  mode: ConversationViewportMode
  pendingIdentity?: true
  paneIds: SessionId[]
  activePaneId?: SessionId
  paneRatios: number[]
}

function validSession(sessions: ISessions, id: SessionId, workspaces?: IWorkspaces): boolean {
  const list = sessions.list.getSnapshot()
  const summary = list.byId[id]
  if (!list.ids.includes(id) || summary === undefined || summary.origin === 'subagent') return false
  return workspaces?.list.getSnapshot().archivedSessionIds.includes(id) !== true
}

function normalizedRatios(count: number, ratios: readonly number[]): number[] {
  if (count === 0) return []
  if (count === 1) return [1]
  const values = Array.from({ length: count }, (_, index) => {
    const value = ratios[index]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  })
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total)) return Array.from({ length: count }, () => 1 / count)
  return values.map(value => value / total)
}

type ViewActions = {
  replace: (draft: ViewState, state: ViewState) => void
}

/** Create the root conversation viewport's in-memory viewing store.
 * @returns a handle shared by the root slot and the viewport capability.
 */
export function createConversationViewportStore(): EngineStoreHandle<ViewState, ViewActions> {
  return defineStore({
    init: (): ViewState => ({ mode: 'single', paneIds: [], paneRatios: [] }),
    actions: {
      replace: (draft, state: ViewState) => {
        draft.mode = state.mode
        if (state.pendingIdentity === undefined) delete draft.pendingIdentity
        else draft.pendingIdentity = state.pendingIdentity
        draft.paneIds = state.paneIds
        draft.paneRatios = state.paneRatios
        if (state.activePaneId === undefined) delete draft.activePaneId
        else draft.activePaneId = state.activePaneId
      },
    },
  })

}

/** Owns persistent pane selection and coordinates staged Session windows. */
export class ConversationViewportController implements ConversationViewport {
  readonly snapshot: ObservableSnapshot<ConversationViewportSnapshot>
  private readonly store: { getSnapshot: () => ViewState; update: (mutate: (draft: ViewState) => void) => void }
  private disposed = false
  private enabled = false
  private catalogReady = false
  private baselineReady = false
  private stagedIds: readonly SessionId[] = []
  private spaceSessionId: SessionId | undefined
  private restoringWorkbenches = false
  private readonly workbenches = new Map<string, SavedWorkbench>()
  private persistenceScope: string | undefined
  private legacyPending = false
  private keyVersion: 2 | 3 = 3
  private restorationPending = false
  private readonly unavailablePanes = new Set<SessionId>()
  private activeWorkbenchId = 'default'
  private readonly stopList: () => void
  private readonly stopView: () => void
  private readonly stopWorkspaces: () => void

  constructor(
    private readonly sessions: ISessions,
    instance: StoreInstance<ViewState, ViewActions>,
    private readonly workspaces?: IWorkspaces,
  ) {
    this.store = {
      getSnapshot: () => instance.getSnapshot(),
      update: (mutate) => {
        const state = instance.getSnapshot()
        const next = { ...state, paneIds: [...state.paneIds], paneRatios: [...state.paneRatios] }
        mutate(next)
        if (next.mode !== state.mode || next.pendingIdentity !== state.pendingIdentity || next.activePaneId !== state.activePaneId
          || next.paneIds.length !== state.paneIds.length
          || next.paneIds.some((id, index) => id !== state.paneIds[index])
          || next.paneRatios.some((ratio, index) => ratio !== state.paneRatios[index])) {
          instance.actions.replace(next)
        }
      },
    }
    this.snapshot = instance
    this.spaceSessionId = sessions.list.getSnapshot().current
    this.stopView = instance.subscribe(() => { this.syncStaged(); if (!this.restoringWorkbenches) this.saveActiveWorkbench() })
    this.stopList = sessions.list.subscribe(() => { this.reconcileSessions() })
    this.stopWorkspaces = workspaces?.list.subscribe(() => { this.reconcileSessions() }) ?? (() => {})
    this.baselineReady = sessions.list.getSnapshot().phase === 'ready'
    this.restoringWorkbenches = true
    this.restoreWorkbenches(undefined)
    this.restoringWorkbenches = false
    this.reconcileSessions()
    this.syncStaged()
  }

  /** Change the verified principal, clearing private layouts and holds before restoration.
   * @param principal - verified account identity, explicit local identity, or undefined after proof loss.
   */
  setPersistenceScope(principal: string | undefined): void {
    if (this.disposed || principal === this.persistenceScope) return
    if (this.persistenceScope !== undefined) this.sessions.beginNavigation()
    this.persistenceScope = principal
    this.unavailablePanes.clear()
    this.spaceSessionId = undefined
    const saved = principal === undefined ? undefined : readWorkbenchRecord(principal)
    this.legacyPending = principal === 'local' && saved === undefined
    this.catalogReady = false
    this.restoringWorkbenches = true
    try { this.restoreWorkbenches(saved) }
    finally { this.restoringWorkbenches = false }
    this.reconcileSessions()
    this.syncStaged()
    if (!this.legacyPending) this.persistWorkbenches()
  }

  /** Release subscriptions and additional history windows without cancelling tasks. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopList()
    this.stopView()
    this.stopWorkspaces()
    this.sessions.setAdditionalStaged([])
  }

  /** Enable retained windows only while the workbench contribution is mounted.
   * @param enabled - whether the optional controls are mounted.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.syncStaged()
    const state = this.store.getSnapshot()
    if (enabled && state.mode === 'workbench' && state.activePaneId !== undefined
      && validSession(this.sessions, state.activePaneId, this.workspaces)) this.select(state.activePaneId)
  }

  setMode(mode: ConversationViewportMode): void {
    this.sessions.beginNavigation()
    if (mode === 'workbench') this.prepareWorkbenchRestore(this.store.getSnapshot().paneIds)
    const previousMode = this.store.getSnapshot().mode
    if (mode === 'workbench' && previousMode !== 'workbench') this.spaceSessionId = this.sessions.list.getSnapshot().current
    this.store.update((draft) => { draft.mode = mode })
    if (mode === 'workbench') this.reconcileSessions()
    if (mode === 'single') {
      if (this.spaceSessionId !== undefined
        && validSession(this.sessions, this.spaceSessionId, this.workspaces)) this.select(this.spaceSessionId)
      return
    }
    const active = this.store.getSnapshot().activePaneId
    if (active !== undefined && validSession(this.sessions, active, this.workspaces)) this.select(active)
  }

  add(sessionId: SessionId): AddPaneResult {
    if (this.store.getSnapshot().pendingIdentity === true) return { ok: false, reason: 'unknown' }
    this.sessions.beginNavigation()
    if (this.disposed || !validSession(this.sessions, sessionId, this.workspaces)) return { ok: false, reason: 'unknown' }
    const state = this.store.getSnapshot()
    if (state.paneIds.includes(sessionId)) {
      this.focus(sessionId)
      return { ok: false, reason: 'duplicate' }
    }
    if (state.paneIds.length >= WORKBENCH_PANE_LIMIT) return { ok: false, reason: 'limit' }
    this.store.update((draft) => {
      draft.paneIds.push(sessionId)
      draft.activePaneId = sessionId
      draft.paneRatios = normalizedRatios(draft.paneIds.length, [])
      draft.mode = 'workbench'
    })
    this.select(sessionId)
    return { ok: true }
  }

  remove(sessionId: SessionId): void {
    this.assertEditable()
    this.sessions.beginNavigation()
    const state = this.store.getSnapshot()
    const index = state.paneIds.indexOf(sessionId)
    if (index < 0) return
    const nextIds = state.paneIds.filter(id => id !== sessionId)
    const nextActive = state.activePaneId === sessionId
      ? nextIds[Math.min(index, nextIds.length - 1)]
      : state.activePaneId
    this.store.update((draft) => {
      draft.paneIds = nextIds
      if (nextActive === undefined) delete draft.activePaneId
      else draft.activePaneId = nextActive
      draft.paneRatios = normalizedRatios(nextIds.length, state.paneRatios.filter((_, i) => i !== index))
    })
    if (nextActive !== undefined && validSession(this.sessions, nextActive, this.workspaces)) this.select(nextActive)
    else if (nextIds.length === 0) this.sessions.clear()
  }

  focus(sessionId: SessionId): void {
    this.sessions.beginNavigation()
    if (!this.store.getSnapshot().paneIds.includes(sessionId)) return
    this.store.update((draft) => { draft.activePaneId = sessionId })
    if (validSession(this.sessions, sessionId, this.workspaces)) this.select(sessionId)
  }

  replaceActive(sessionId: SessionId): AddPaneResult {
    if (this.store.getSnapshot().pendingIdentity === true) return { ok: false, reason: 'unknown' }
    this.sessions.beginNavigation()
    if (this.disposed || !validSession(this.sessions, sessionId, this.workspaces)) return { ok: false, reason: 'unknown' }
    const state = this.store.getSnapshot()
    if (state.paneIds.includes(sessionId)) {
      this.focus(sessionId)
      return { ok: true }
    }
    if (state.paneIds.length === 0) {
      return this.add(sessionId)
    }
    const fallback = state.paneIds[0]
    if (fallback === undefined) return { ok: true }
    const index = Math.max(0, state.paneIds.indexOf(state.activePaneId ?? fallback))
    this.store.update((draft) => {
      draft.paneIds[index] = sessionId
      draft.activePaneId = sessionId
    })
    if (validSession(this.sessions, sessionId, this.workspaces)) this.select(sessionId)
    return { ok: true }
  }

  move(sessionId: SessionId, direction: 'previous' | 'next'): void {
    this.assertEditable()
    const state = this.store.getSnapshot()
    const index = state.paneIds.indexOf(sessionId)
    const target = index + (direction === 'previous' ? -1 : 1)
    if (index < 0 || target < 0 || target >= state.paneIds.length) return
    this.store.update((draft) => {
      const [id] = draft.paneIds.splice(index, 1)
      const [ratio] = draft.paneRatios.splice(index, 1)
      // The validated index addresses both normalized, equally sized arrays.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      draft.paneIds.splice(target, 0, id!)
      // oxlint-disable-next-line typescript/no-non-null-assertion
      draft.paneRatios.splice(target, 0, ratio!)
    })
  }

  setPaneRatios(ratios: readonly number[]): void {
    this.assertEditable()
    const count = this.store.getSnapshot().paneIds.length
    this.store.update((draft) => { draft.paneRatios = normalizedRatios(count, ratios) })
  }

  /** Resolve saved browser identities against the complete current account catalog.
   * @param resolve - catalog-derived mapping; ambiguous or inaccessible legacy IDs return undefined.
   */
  reconcileSessionKeys(resolve: (id: SessionId, version: 2 | 3) => SessionId | undefined): void {
    const version = this.keyVersion
    const migrate = (row: { paneIds: SessionId[]; activePaneId?: SessionId; paneRatios: number[] }): void => {
      const pairs = row.paneIds.flatMap((id, index) => {
        const key = resolve(id, version)
        return key === undefined ? [] : [{ key, ratio: row.paneRatios[index] ?? 1 }]
      })
      const unique = pairs.filter((pair, index) => pairs.findIndex(other => other.key === pair.key) === index)
      const active = row.activePaneId === undefined ? undefined : resolve(row.activePaneId, version)
      row.paneIds = unique.map(pair => pair.key)
      row.paneRatios = normalizedRatios(unique.length, unique.map(pair => pair.ratio))
      if (active !== undefined && row.paneIds.includes(active)) row.activePaneId = active
      else if (row.paneIds[0] !== undefined) row.activePaneId = row.paneIds[0]
      else delete row.activePaneId
    }
    this.restoringWorkbenches = true
    try {
      for (const row of this.workbenches.values()) migrate(row)
      this.keyVersion = this.sessions.keyFor === undefined ? 2 : 3
      this.store.update((draft) => {
        delete draft.pendingIdentity
        if (version === 2 && this.sessions.keyFor !== undefined) {
          const active = this.workbenches.get(this.activeWorkbenchId)
          draft.paneIds = [...active?.paneIds ?? []]
          draft.paneRatios = [...active?.paneRatios ?? []]
          if (active?.activePaneId === undefined) delete draft.activePaneId
          else draft.activePaneId = active.activePaneId
        } else migrate(draft)
      })
    } finally { this.restoringWorkbenches = false }
    this.persistWorkbenches()
  }

  /** Encoding version of the owned restoration record; a legacy ID is never guessed from its text.
   * @returns the stored encoding, retained until catalog reconciliation completes.
   */
  sessionKeyVersion(): 2 | 3 { return this.keyVersion }

  /** Whether a saved record still needs the authenticated catalog before it can request its panes.
   * @returns true while the record awaits catalog reconciliation.
   */
  needsCatalogRestore(): boolean { return this.restorationPending }

  markCatalogReady(unavailable: ReadonlySet<SessionId> = this.unavailablePanes): void {
    const restoring = this.restorationPending
    if (this.persistenceScope === 'local' && this.keyVersion === 2 && this.sessions.keyFor !== undefined) {
      if (this.sessions.list.getSnapshot().phase !== 'ready') { this.catalogReady = true; return }
      const visible = this.sessions.list.getSnapshot().ids
      this.reconcileSessionKeys((id) => {
        const matches = visible.filter(candidate => parseClientSessionKey(candidate)?.sessionId === id)
        return matches.length === 1 ? matches[0] : undefined
      })
    }
    const retained = [...unavailable]
    this.unavailablePanes.clear()
    for (const id of retained) this.unavailablePanes.add(id)
    this.restorationPending = retained.length > 0
    if (this.catalogReady && !restoring) return
    this.catalogReady = true
    this.reconcileSessions()
    const state = this.store.getSnapshot()
    if (restoring && this.enabled && state.mode === 'workbench' && state.activePaneId !== undefined
      && validSession(this.sessions, state.activePaneId, this.workspaces)) this.select(state.activePaneId)
  }

  listWorkbenches() { return [...this.workbenches.values()].map(item => ({ ...item, paneIds: [...item.paneIds] })) }
  currentWorkbench() { const item = this.workbenches.get(this.activeWorkbenchId); return item === undefined ? { id: 'default', name: '我的工作台', paneIds: [], updatedAt: Date.now() } : { ...item, paneIds: [...item.paneIds] } }
  switchWorkbench(id: string): void {
    this.sessions.beginNavigation()
    const target = this.workbenches.get(id)
    if (target === undefined || id === this.activeWorkbenchId) return
    this.saveActiveWorkbench()
    this.activeWorkbenchId = id
    this.prepareWorkbenchRestore(target.paneIds)
    this.store.update((draft) => {
      const pending = this.keyVersion === 2 && this.sessions.keyFor !== undefined
      draft.paneIds = pending ? [] : [...target.paneIds]
      const active = pending ? undefined : target.activePaneId ?? target.paneIds[0]
      if (active === undefined) delete draft.activePaneId
      else draft.activePaneId = active
      draft.paneRatios = normalizedRatios(draft.paneIds.length, target.paneRatios)
    })
    this.reconcileSessions()
  }
  createWorkbench(name: string): string {
    this.assertEditable()
    this.sessions.beginNavigation()
    const id = `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.saveActiveWorkbench()
    this.workbenches.set(id, { id, name: name.trim() || '我的工作台', paneIds: [], paneRatios: [], updatedAt: Date.now() })
    this.activeWorkbenchId = id
    this.store.update((draft) => { draft.mode = 'workbench'; draft.paneIds = []; delete draft.activePaneId; draft.paneRatios = [] })
    this.persistWorkbenches()
    return id
  }
  renameWorkbench(id: string, name: string): void { this.assertEditable(); const item = this.workbenches.get(id); if (item !== undefined && name.trim() !== '') { item.name = name.trim(); item.updatedAt = Date.now(); this.persistWorkbenches() } }
  duplicateWorkbench(id: string, name: string): string {
    this.assertEditable()
    this.sessions.beginNavigation()
    const source = this.workbenches.get(id)
    const nextId = `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.saveActiveWorkbench()
    const target: SavedWorkbench = {
      id: nextId,
      name: name.trim() || `${source?.name ?? '我的工作台'} 副本`,
      paneIds: source === undefined ? [] : [...source.paneIds],
      paneRatios: source === undefined ? [] : [...source.paneRatios],
      updatedAt: Date.now(),
    }
    this.workbenches.set(nextId, target)
    this.activeWorkbenchId = nextId
    this.prepareWorkbenchRestore(target.paneIds)
    this.store.update((draft) => {
      draft.mode = 'workbench'
      const pending = this.keyVersion === 2 && this.sessions.keyFor !== undefined
      draft.paneIds = pending ? [] : [...target.paneIds]
      draft.paneRatios = pending ? [] : [...target.paneRatios]
      const active = pending ? undefined : target.activePaneId ?? target.paneIds[0]
      if (active === undefined) delete draft.activePaneId
      else draft.activePaneId = active
    })
    this.persistWorkbenches()
    return nextId
  }
  deleteWorkbench(id: string): void {
    this.assertEditable()
    this.sessions.beginNavigation()
    if (this.workbenches.size <= 1 || !this.workbenches.has(id)) return
    this.workbenches.delete(id)
    if (id === this.activeWorkbenchId) {
      this.activeWorkbenchId = this.workbenches.keys().next().value as string
      const target = this.workbenches.get(this.activeWorkbenchId)
      if (target !== undefined) {
        this.prepareWorkbenchRestore(target.paneIds)
        this.store.update((draft) => {
          const pending = this.keyVersion === 2 && this.sessions.keyFor !== undefined
          draft.paneIds = pending ? [] : [...target.paneIds]
          draft.paneRatios = pending ? [] : [...target.paneRatios]
          if (pending || target.paneIds[0] === undefined) delete draft.activePaneId
          else draft.activePaneId = target.paneIds[0]
        })
      }
    }
    this.persistWorkbenches()
  }

  private saveActiveWorkbench(): void {
    if (this.keyVersion === 2 && this.sessions.keyFor !== undefined) return
    const item = this.workbenches.get(this.activeWorkbenchId)
    if (item !== undefined) {
      const state = this.store.getSnapshot()
      item.paneIds = [...state.paneIds]
      item.paneRatios = [...state.paneRatios]
      if (state.activePaneId === undefined) delete item.activePaneId
      else item.activePaneId = state.activePaneId
      item.updatedAt = Date.now()
      this.persistWorkbenches()
    }
  }
  private assertEditable(): void {
    if (this.store.getSnapshot().pendingIdentity === true) throw new Error('Saved layout identities are not verified; retry the account directory before editing the layout')
  }
  private prepareWorkbenchRestore(ids: readonly SessionId[]): void {
    if (this.sessions.keyFor === undefined || !ids.some(id => !validSession(this.sessions, id, this.workspaces))) return
    this.restorationPending = true
    this.catalogReady = false
  }
  private persistWorkbenches(): void {
    if (this.persistenceScope === undefined || this.restoringWorkbenches || this.legacyPending) return
    if (this.keyVersion === 2 && this.sessions.keyFor !== undefined) return
    if (this.sessions.keyFor !== undefined
      && [...this.workbenches.values()].some(row => row.paneIds.some(id => parseClientSessionKey(id) === undefined))) return
    writeWorkbenchRecord(this.persistenceScope, {
      version: this.sessions.keyFor === undefined ? 2 : 3, mode: this.store.getSnapshot().mode,
      activeId: this.activeWorkbenchId, workbenches: [...this.workbenches.values()],
    })
  }

  private restoreWorkbenches(record: WorkbenchRecord | undefined): void {
    this.restorationPending = record !== undefined
    this.keyVersion = record?.version ?? (this.sessions.keyFor === undefined ? 2 : 3)
    this.workbenches.clear()
    this.activeWorkbenchId = record?.activeId ?? 'default'
    for (const item of record?.workbenches ?? []) this.workbenches.set(item.id, item)
    if (this.workbenches.size === 0) this.workbenches.set('default', { id: 'default', name: '我的工作台', paneIds: [], paneRatios: [], updatedAt: Date.now() })
    const active = this.workbenches.get(this.activeWorkbenchId)
    this.store.update((draft) => {
      draft.mode = record?.mode ?? 'single'
      const pending = this.keyVersion === 2 && this.sessions.keyFor !== undefined
      if (pending) draft.pendingIdentity = true
      else delete draft.pendingIdentity
      draft.paneIds = pending || active === undefined ? [] : [...active.paneIds]
      draft.paneRatios = normalizedRatios(draft.paneIds.length, active?.paneRatios ?? [])
      const id = pending ? undefined : active?.activePaneId ?? draft.paneIds[0]
      if (id === undefined) delete draft.activePaneId
      else draft.activePaneId = id
    })
  }

  private reconcileSessions(): void {
    const list = this.sessions.list.getSnapshot()
    if (list.phase !== 'ready' || (this.workspaces !== undefined && this.workspaces.list.getSnapshot().phase !== 'ready')) return
    if (this.catalogReady && this.keyVersion === 2 && this.restorationPending && this.persistenceScope === 'local') this.markCatalogReady()
    if (this.legacyPending) {
      this.legacyPending = false
      const legacy = readLegacyWorkbenchRecord(id => validSession(this.sessions, id, this.workspaces))
      this.restoringWorkbenches = true
      try { if (legacy !== undefined) this.restoreWorkbenches(legacy) }
      finally { this.restoringWorkbenches = false }
      this.persistWorkbenches()
    }
    const firstBaseline = !this.baselineReady
    this.baselineReady = true
    const state = this.store.getSnapshot()
    if (state.mode === 'single') { this.syncStaged(); return }
    for (const id of this.unavailablePanes) if (validSession(this.sessions, id, this.workspaces)) this.unavailablePanes.delete(id)
    const valid = state.paneIds.filter(id => validSession(this.sessions, id, this.workspaces)
      || this.unavailablePanes.has(id)
      || (!this.catalogReady && !this.sessions.list.getSnapshot().ids.includes(id)))
    const active = state.activePaneId !== undefined && valid.includes(state.activePaneId)
      ? state.activePaneId
      : valid[0]
    if (valid.length !== state.paneIds.length || active !== state.activePaneId) {
      this.store.update((draft) => {
        draft.paneIds = valid
        if (active === undefined) delete draft.activePaneId
        else draft.activePaneId = active
        draft.paneRatios = normalizedRatios(valid.length, state.paneRatios.filter((_, index) => {
          const id = state.paneIds[index]
          return id !== undefined && valid.includes(id)
        }))
      })
    }
    this.syncStaged()
    if (firstBaseline && this.enabled && active !== undefined
      && validSession(this.sessions, active, this.workspaces)) this.select(active)
  }

  private syncStaged(): void {
    if (this.disposed) return
    const state = this.store.getSnapshot()
    const multi = this.enabled && state.mode === 'workbench' && (this.keyVersion === 3 || this.sessions.keyFor === undefined)
    if (multi && (this.sessions.list.getSnapshot().phase !== 'ready'
      || (this.workspaces !== undefined && this.workspaces.list.getSnapshot().phase !== 'ready'))) return
    const ids = multi ? state.paneIds.filter(id => validSession(this.sessions, id, this.workspaces)) : []
    if (ids.length === this.stagedIds.length && ids.every((id, index) => id === this.stagedIds[index])) return
    this.stagedIds = ids
    this.sessions.setAdditionalStaged(ids)
  }

  private select(sessionId: SessionId): void {
    if (this.sessions.list.getSnapshot().current !== sessionId) this.sessions.open(sessionId)
  }
}
