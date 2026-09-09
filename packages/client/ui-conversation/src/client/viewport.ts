/** Bounded conversation viewing state and Session-window coordination. */
import type {
  AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { defineStore, type ISessions, type IWorkspaces, type ObservableSnapshot, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

import type { StoreInstance } from '@deepseek-ai/dsh-client-ui-slots'

export type { AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Maximum number of concurrently rendered conversation panes. */
export const WORKBENCH_PANE_LIMIT = 4

interface ViewState {
  mode: ConversationViewportMode
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

function restoredState(value: unknown): ViewState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { mode: 'single', paneIds: [], paneRatios: [] }
  }
  const row = value as Record<string, unknown>
  const paneIds = Array.isArray(row.paneIds)
    ? [...new Set(row.paneIds.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, WORKBENCH_PANE_LIMIT) as SessionId[]
    : []
  const activePaneId = typeof row.activePaneId === 'string' && paneIds.includes(row.activePaneId as SessionId)
    ? row.activePaneId as SessionId
    : paneIds[0]
  return {
    mode: row.mode === 'single' ? 'single' : 'workbench',
    paneIds,
    ...activePaneId === undefined ? {} : { activePaneId },
    paneRatios: normalizedRatios(paneIds.length, Array.isArray(row.paneRatios) ? row.paneRatios as number[] : []),
  }
}

type ViewActions = {
  replace: (draft: ViewState, state: ViewState) => void
}

/** Create the root conversation viewport's persistent viewing store.
 * @returns a handle shared by the root slot and the viewport capability.
 */
export function createConversationViewportStore(): EngineStoreHandle<ViewState, ViewActions> {
  const handle = defineStore({
    init: (): ViewState => ({ mode: 'single', paneIds: [], paneRatios: [] }),
    persist: 'dsh.conversation.workbench.v1',
    actions: {
      replace: (draft, state: ViewState) => {
        draft.mode = state.mode
        draft.paneIds = state.paneIds
        draft.paneRatios = state.paneRatios
        if (state.activePaneId === undefined) delete draft.activePaneId
        else draft.activePaneId = state.activePaneId
      },
    },
  })
  return {
    ...handle,
    create: () => {
      const instance = handle.create()
      instance.store.set(restoredState(instance.getSnapshot()))
      return instance
    },
  }
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
  private readonly workbenches = new Map<
    string,
    { id: string; name: string; paneIds: SessionId[]; paneRatios: number[]; updatedAt: number }
  >()
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
        if (next.mode !== state.mode || next.activePaneId !== state.activePaneId
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
    this.restoreWorkbenches()
    this.restoringWorkbenches = false
    this.persistWorkbenches()
    this.reconcileSessions()
    this.syncStaged()
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
    if (!this.store.getSnapshot().paneIds.includes(sessionId)) return
    this.store.update((draft) => { draft.activePaneId = sessionId })
    if (validSession(this.sessions, sessionId, this.workspaces)) this.select(sessionId)
  }

  replaceActive(sessionId: SessionId): AddPaneResult {
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
    this.select(sessionId)
    return { ok: true }
  }

  move(sessionId: SessionId, direction: 'previous' | 'next'): void {
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
    const count = this.store.getSnapshot().paneIds.length
    this.store.update((draft) => { draft.paneRatios = normalizedRatios(count, ratios) })
  }

  markCatalogReady(): void {
    if (this.catalogReady) return
    this.catalogReady = true
    this.reconcileSessions()
  }

  listWorkbenches() { return [...this.workbenches.values()].map(item => ({ ...item, paneIds: [...item.paneIds] })) }
  currentWorkbench() { const item = this.workbenches.get(this.activeWorkbenchId); return item === undefined ? { id: 'default', name: '我的工作台', paneIds: [], updatedAt: Date.now() } : { ...item, paneIds: [...item.paneIds] } }
  switchWorkbench(id: string): void {
    const target = this.workbenches.get(id)
    if (target === undefined || id === this.activeWorkbenchId) return
    this.saveActiveWorkbench()
    this.activeWorkbenchId = id
    this.store.update((draft) => {
      draft.paneIds = [...target.paneIds]
      if (target.paneIds[0] === undefined) delete draft.activePaneId
      else draft.activePaneId = target.paneIds[0]
      draft.paneRatios = normalizedRatios(target.paneIds.length, [])
    })
    this.reconcileSessions()
  }
  createWorkbench(name: string): string {
    const id = `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.saveActiveWorkbench()
    this.workbenches.set(id, { id, name: name.trim() || '我的工作台', paneIds: [], paneRatios: [], updatedAt: Date.now() })
    this.activeWorkbenchId = id
    this.store.update((draft) => { draft.mode = 'workbench'; draft.paneIds = []; delete draft.activePaneId; draft.paneRatios = [] })
    this.persistWorkbenches()
    return id
  }
  renameWorkbench(id: string, name: string): void { const item = this.workbenches.get(id); if (item !== undefined && name.trim() !== '') { item.name = name.trim(); item.updatedAt = Date.now(); this.persistWorkbenches() } }
  duplicateWorkbench(id: string, name: string): string {
    const source = this.workbenches.get(id)
    const nextId = `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.saveActiveWorkbench()
    const target: { id: string; name: string; paneIds: SessionId[]; paneRatios: number[]; updatedAt: number } = {
      id: nextId,
      name: name.trim() || `${source?.name ?? '我的工作台'} 副本`,
      paneIds: source === undefined ? [] : [...source.paneIds],
      paneRatios: source === undefined ? [] : [...source.paneRatios],
      updatedAt: Date.now(),
    }
    this.workbenches.set(nextId, target)
    this.activeWorkbenchId = nextId
    this.store.update((draft) => {
      draft.mode = 'workbench'
      draft.paneIds = [...target.paneIds]
      draft.paneRatios = [...target.paneRatios]
      if (target.paneIds[0] === undefined) delete draft.activePaneId
      else draft.activePaneId = target.paneIds[0]
    })
    this.persistWorkbenches()
    return nextId
  }
  deleteWorkbench(id: string): void {
    if (this.workbenches.size <= 1 || !this.workbenches.has(id)) return
    this.workbenches.delete(id)
    if (id === this.activeWorkbenchId) {
      this.activeWorkbenchId = this.workbenches.keys().next().value as string
      const target = this.workbenches.get(this.activeWorkbenchId)
      if (target !== undefined) {
        this.store.update((draft) => {
          draft.paneIds = [...target.paneIds]
          draft.paneRatios = [...target.paneRatios]
          if (target.paneIds[0] === undefined) delete draft.activePaneId
          else draft.activePaneId = target.paneIds[0]
        })
      }
    }
    this.persistWorkbenches()
  }

  private saveActiveWorkbench(): void {
    const item = this.workbenches.get(this.activeWorkbenchId)
    if (item !== undefined) {
      const state = this.store.getSnapshot()
      item.paneIds = [...state.paneIds]
      item.paneRatios = [...state.paneRatios]
      item.updatedAt = Date.now()
      this.persistWorkbenches()
    }
  }
  private persistWorkbenches(): void { try { globalThis.localStorage.setItem('dsh.conversation.workbenches.v1', JSON.stringify({ activeId: this.activeWorkbenchId, workbenches: [...this.workbenches.values()] })) } catch { /* private storage */ } }
  private restoreWorkbenches(): void {
    try { const raw = globalThis.localStorage.getItem('dsh.conversation.workbenches.v1'); if (raw === null) throw new Error('empty'); const value = JSON.parse(raw) as { activeId?: string; workbenches?: Array<{ id?: string; name?: string; paneIds?: SessionId[]; paneRatios?: number[]; updatedAt?: number }> }; for (const item of value.workbenches ?? []) if (item.id && item.name && Array.isArray(item.paneIds)) this.workbenches.set(item.id, { id: item.id, name: item.name, paneIds: item.paneIds.slice(0, 4), paneRatios: item.paneRatios ?? [], updatedAt: item.updatedAt ?? Date.now() }); if (this.workbenches.size && value.activeId && this.workbenches.has(value.activeId)) this.activeWorkbenchId = value.activeId } catch { /* defaults below */ }
    if (this.workbenches.size === 0) this.workbenches.set('default', { id: 'default', name: '我的工作台', paneIds: [], paneRatios: [], updatedAt: Date.now() })
    const active = this.workbenches.get(this.activeWorkbenchId)
    if (active !== undefined && active.paneIds.length) {
      this.store.update((draft) => {
        draft.paneIds = [...active.paneIds]
        if (active.paneIds[0] === undefined) delete draft.activePaneId
        else draft.activePaneId = active.paneIds[0]
        draft.paneRatios = normalizedRatios(active.paneIds.length, [])
      })
    }
  }

  private reconcileSessions(): void {
    const list = this.sessions.list.getSnapshot()
    if (list.phase !== 'ready' || (this.workspaces !== undefined && this.workspaces.list.getSnapshot().phase !== 'ready')) return
    const firstBaseline = !this.baselineReady
    this.baselineReady = true
    const state = this.store.getSnapshot()
    const valid = state.paneIds.filter(id => validSession(this.sessions, id, this.workspaces)
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
    if (firstBaseline && this.enabled && state.mode === 'workbench' && active !== undefined) this.select(active)
  }

  private syncStaged(): void {
    if (this.disposed) return
    const state = this.store.getSnapshot()
    const multi = this.enabled && state.mode === 'workbench'
    if (multi && (this.sessions.list.getSnapshot().phase !== 'ready'
      || (this.workspaces !== undefined && this.workspaces.list.getSnapshot().phase !== 'ready'))) return
    const ids = multi ? state.paneIds : []
    if (ids.length === this.stagedIds.length && ids.every((id, index) => id === this.stagedIds[index])) return
    this.stagedIds = ids
    this.sessions.setAdditionalStaged(ids)
  }

  private select(sessionId: SessionId): void {
    if (this.sessions.list.getSnapshot().current !== sessionId) this.sessions.open(sessionId)
  }
}
