/** Metadata-only personal Workspace discovery; execution stays with the exact selected Runtime. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import type { SessionSummary } from './sessions/service.ts'
import type { SessionRuntimePool } from './sessions/pool.ts'
import type { WorkspaceRuntime } from './workspaces/service.ts'
import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'
import { createSnapshotStore, type SnapshotStore } from './contract/store.ts'
import { commitSessionNavigation } from './navigation.ts'

/** One personal Runtime's last synchronized directory; null time denotes an unknown catalog. */
export interface PersonalRuntimeDirectory {
  runtime: Extract<SessionRuntimeTarget, { kind: 'personal' }>
    & Required<Pick<SessionRuntimeTarget, 'runtimeId' | 'nodeId' | 'nodeName'>>
  status: string
  observedState: string
  syncedAt: string | null
  items: WorkspaceView[]
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid personal directory')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid personal directory text')
  return value
}
function target(value: unknown): PersonalRuntimeDirectory['runtime'] {
  const row = object(value)
  if (row.kind !== 'personal') throw new Error('Invalid personal Runtime')
  const runtimeId = text(row.runtimeId), nodeId = text(row.nodeId)
  if (![runtimeId, nodeId].every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id))) {
    throw new Error('Invalid personal Runtime identity')
  }
  return { kind: 'personal', runtimeId, nodeId, nodeName: text(row.nodeName) } as PersonalRuntimeDirectory['runtime']
}

/**
 * Own central directory requests for this browser document; focus and explicit refresh never start Runtimes.
 * @param ctx - Client lifetime and verified account policy.
 * @param connection - bootstrap identity and exact-target transports.
 * @param sessions - live Session pool receiving metadata previews.
 * @param workspaces - Workspace projection receiving foreign directory rows.
 * @returns the authorized personal Runtime metadata for this account, independent of the open space.
 */
export function installPersonalDirectory(ctx: Context, connection: ConnectionHandle,
  sessions: SessionRuntimePool, workspaces: WorkspaceRuntime): SnapshotStore<readonly PersonalRuntimeDirectory[]> {
  const directory = createSnapshotStore<readonly PersonalRuntimeDirectory[]>([])
  const browser = globalThis as {
    location?: { search: string }
    addEventListener?: typeof globalThis.addEventListener
    removeEventListener?: typeof globalThis.removeEventListener }
  let account: number | undefined
  let pending: AbortController | undefined
  let work: Promise<void> | undefined
  const requests = new Set<Promise<void>>()
  let disposed = false
  const lifetime = new AbortController()
  let accountLifetime = new AbortController()
  let selection: SnapshotStore<{ sessionId?: SessionId }> | undefined
  let restoring = false
  let restoreWork: Promise<void> | undefined
  let restoredDirectory: { runtimeId: string; rows: readonly SessionSummary[] } | undefined
  const restoreSelection = (): void => {
    const directory = restoredDirectory
    if (selection !== undefined || directory === undefined || account === undefined
      || sessions.bootstrapRuntimeTarget().runtimeId !== directory.runtimeId) return
    restoredDirectory = undefined
    selection = createSnapshotStore<{ sessionId?: SessionId }>({}, { persist: {
      name: `dsh.personal.current.v1.account:${account}.runtime:${directory.runtimeId}`, storage: 'session' } })
    const saved = selection.getSnapshot().sessionId
    const address = typeof saved === 'string' ? parseClientSessionKey(saved) : undefined
    if (saved === undefined || address?.runtime.kind !== 'personal' || !directory.rows.some(row => row.id === saved)) return
    restoring = true
    const navigation = AbortSignal.any([sessions.beginNavigation(), lifetime.signal, accountLifetime.signal])
    restoreWork = sessions.usingRuntime(address.runtime, navigation, async (signal) => {
      if (!await sessions.ensureSession(address.runtime, address.sessionId, signal)) return
      signal.throwIfAborted()
      await commitSessionNavigation(sessions, saved, signal, () => { sessions.open(saved) })
    }).catch((error: unknown) => {
      if (!navigation.aborted) console.error('[personal-directory] Selected conversation could not be restored:', error)
    }).finally(() => { restoring = false })
  }
  const stopSelection = sessions.list.subscribe(() => {
    restoreSelection()
    if (selection === undefined || restoring) return
    const state = sessions.list.getSnapshot(), current = state.current
    if (current !== undefined && state.byId[current]?.runtime?.kind === 'personal') selection.set({ sessionId: current })
    else if (current === undefined && state.phase === 'ready') selection.set({})
  })
  const refresh = (): Promise<void> => {
    if (disposed || work !== undefined) return work ?? Promise.resolve()
    if (ctx.projectUiPolicy.getSnapshot().verifiedAccountId === undefined
      || connection.hostDescription.getSnapshot()?.executionAuthorityRequired !== true
      || ctx.deploymentContext.getSnapshot().phase !== 'ready') return Promise.resolve()
    const request = new AbortController()
    pending = request
    workspaces.setDirectoryState('loading')
    let expired = false
    const deadline = setTimeout(() => { expired = true; request.abort() }, connection.metadataTiming.requestTimeoutMs)
    const flight = (async () => {
      const query = new URLSearchParams(browser.location?.search)
      const runtime = query.get('dshRuntime')
      const response = await fetch(`/account/api/workbench/catalog${runtime === null ? '' : `?dshRuntime=${encodeURIComponent(runtime)}`}`,
        { signal: request.signal, credentials: 'same-origin', headers: { accept: 'application/json', 'x-dsh-expected-principal-id': String(account) } })
      if (response.status === 404 || response.status === 501) { workspaces.setDirectoryState(undefined); return }
      if (!response.ok) throw new Error(`Personal directory returned HTTP ${response.status}`)
      const root = object(await readApiResponseJson(response))
      if (root.personalWorkspaces === undefined) { workspaces.setDirectoryState(undefined); return }
      if (!Array.isArray(root.personalWorkspaces) || !Array.isArray(root.items)) throw new Error('Invalid personal directory')
      const groups: PersonalRuntimeDirectory[] = root.personalWorkspaces.map((value) => {
        const row = object(value)
        if (!Array.isArray(row.items) || row.syncedAt !== null && typeof row.syncedAt !== 'string') throw new Error('Invalid Workspace directory')
        return { runtime: target(row.runtime), status: text(row.status), observedState: text(row.observedState),
          syncedAt: row.syncedAt, items: row.items.map((candidate) => {
            const item = object(candidate)
            if (!Array.isArray(item.sessionIds)) throw new Error('Invalid Workspace membership')
            return { workspaceId: text(item.workspaceId), path: text(item.path), title: text(item.title),
              sessionIds: item.sessionIds.map(text), createdAt: text(item.createdAt), updatedAt: text(item.updatedAt) } as WorkspaceView
          }) }
      })
      const rows: SessionSummary[] = root.items.flatMap((candidate) => {
        const item = object(candidate), owner = object(item.runtime)
        if (owner.kind !== 'personal') return []
        if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || typeof item.blank !== 'boolean') throw new Error('Invalid conversation metadata')
        const runtime = target(owner), rawId = text(item.sessionId) as SessionId
        return [{ id: clientSessionKey(runtime, rawId), runtime, displayTitle: typeof item.title === 'string' ? item.title : '',
          ...(typeof item.title === 'string' ? { title: item.title } : {}),
          ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}), running: false, blank: item.blank, updatedAt: item.updatedAt }]
      })
      request.signal.throwIfAborted()
      const active = object(root.activeRuntime)
      const activeId = text(active.runtimeId)
      if (active.kind !== 'personal' && active.kind !== 'project'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(activeId)
        || active.kind === 'project' && (!Number.isSafeInteger(active.projectId) || Number(active.projectId) <= 0)
        || runtime !== null && activeId !== runtime) throw new Error('Personal directory returned another or invalid active Runtime')
      directory.set(groups)
      const aggregate = ctx.deploymentContext.getSnapshot().aggregateComputers
      sessions.installPersonalDirectory(rows, active.kind === 'personal', aggregate)
      workspaces.installPersonalDirectory(active.kind === 'personal' ? groups : [], activeId, aggregate)
      workspaces.setDirectoryState('ready')
      if (selection === undefined && active.kind === 'personal' && runtime !== null && account !== undefined) {
        restoredDirectory = { runtimeId: text(active.runtimeId), rows }
        restoreSelection()
      }
    })().catch((error: unknown) => {
      if (pending === request && (!request.signal.aborted || expired)) { workspaces.setDirectoryState('error'); console.error('[personal-directory] Metadata refresh failed:', error) }
    }).finally(() => {
      clearTimeout(deadline); requests.delete(flight)
      if (pending === request) { pending = undefined; work = undefined }
    })
    requests.add(flight); work = flight
    return flight
  }
  workspaces.refreshPersonalDirectory = refresh
  const identity = (): void => {
    const next = ctx.projectUiPolicy.getSnapshot().verifiedAccountId
    if (account !== next) {
      account = next; pending?.abort(); pending = undefined; work = undefined
      accountLifetime.abort(); accountLifetime = new AbortController()
      selection = undefined; restoredDirectory = undefined
      directory.set([])
      sessions.installPersonalDirectory([], false); workspaces.installPersonalDirectory([], '')
    }
    void refresh()
  }
  const stopAccount = ctx.projectUiPolicy.subscribe(identity)
  const stopDeployment = ctx.deploymentContext.subscribe(() => {
    const aggregate = ctx.deploymentContext.getSnapshot().aggregateComputers
    sessions.setPersonalDirectoryAggregation(aggregate); workspaces.setComputerGrouping(aggregate)
    pending?.abort(); pending = undefined; work = undefined
    if (ctx.deploymentContext.getSnapshot().phase === 'error') workspaces.setDirectoryState('error')
    else void refresh()
  })
  const stopHost = connection.hostDescription.subscribe(() => { void refresh() })
  browser.addEventListener?.('focus', identity)
  ctx.effect(() => async () => {
    disposed = true; lifetime.abort(); pending?.abort(); stopAccount(); stopHost(); stopSelection(); stopDeployment()
    browser.removeEventListener?.('focus', identity); await Promise.allSettled([...requests, restoreWork])
  }, 'runtime: personal Workspace directory')
  identity()
  return directory
}
