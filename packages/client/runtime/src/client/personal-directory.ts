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
  workspacesCursor?: string | null
  conversationsCursor?: string | null
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid personal directory')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid personal directory text')
  return value
}
const runtimeIdFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function target(value: unknown): PersonalRuntimeDirectory['runtime'] {
  const row = object(value)
  if (row.kind !== 'personal') throw new Error('Invalid personal Runtime')
  const runtimeId = text(row.runtimeId), nodeId = text(row.nodeId)
  if (![runtimeId, nodeId].every(id => runtimeIdFormat.test(id))) {
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
  type Selection = { sessionId?: SessionId; nodeId?: NonNullable<SessionRuntimeTarget['nodeId']> }
  let selection: SnapshotStore<Selection> | undefined
  let initialNavigation: AbortSignal | undefined
  let recovery: {
    saved: SessionId
    address: NonNullable<ReturnType<typeof parseClientSessionKey>>
    nodeId?: NonNullable<SessionRuntimeTarget['nodeId']>
    signal: AbortSignal
    intent?: string
  } | undefined
  let restoredDirectory: { runtimeId: string; rows: readonly SessionSummary[]; paged: boolean } | undefined
  let restoreWork: Promise<void> | undefined
  let retryQueued = false
  const restoreSelection = (retry = false): void => {
    const bootstrap = sessions.bootstrapRuntimeTarget().runtimeId
    if (initialNavigation === undefined && account !== undefined && bootstrap !== undefined
      && new URLSearchParams(browser.location?.search).get('dshRuntime') === bootstrap) initialNavigation = sessions.navigationSignal
    const catalog = restoredDirectory
    if (catalog === undefined || account === undefined || sessions.bootstrapRuntimeTarget().runtimeId !== catalog.runtimeId) return
    const drafts = ctx.get('conversationIntents')
    if (selection === undefined) {
      selection = createSnapshotStore<Selection>({}, { persist: {
        name: `dsh.personal.current.v1.account:${account}.runtime:${catalog.runtimeId}`, storage: 'session' } })
      const committed = sessions.committedSelection.getSnapshot()
      if (committed !== undefined) { rememberSelection(); return }
      const { sessionId: saved, nodeId } = selection.getSnapshot()
      const address = typeof saved === 'string' ? parseClientSessionKey(saved) : undefined
      if (initialNavigation === undefined || initialNavigation.aborted || saved === undefined || address?.runtime.kind !== 'personal'
        || drafts?.snapshot.getSnapshot().active !== undefined) return
      recovery = { saved, address, ...(nodeId === undefined ? {} : { nodeId }),
        signal: AbortSignal.any([initialNavigation, lifetime.signal, accountLifetime.signal]) }
    } else if (!retry) return
    const attempt = recovery
    if (attempt === undefined || attempt.signal.aborted) return
    // An in-flight open was issued against the world as it was when it started;
    // a retry arriving now must run once after it settles, not be dropped.
    if (restoreWork !== undefined) { if (retry) retryQueued = true; return }
    const { saved, address } = attempt
    const catalogTarget = (): SessionRuntimeTarget | undefined =>
      directory.getSnapshot().find(group => group.runtime.runtimeId === address.runtime.runtimeId)?.runtime
    const known = catalogTarget()
    const nodeId = attempt.nodeId ?? known?.nodeId
    const target = known !== undefined && known.nodeId === nodeId ? known
      : { ...address.runtime, ...(nodeId === undefined ? {} : { nodeId }) }
    const showComputer = ctx.deploymentContext.getSnapshot().showComputer
    const intents = showComputer || target.runtimeId !== catalog.runtimeId ? drafts : undefined
    const available = (): boolean => {
      const visible = catalogTarget(), latest = restoredDirectory, deployment = ctx.deploymentContext.getSnapshot()
      return target.runtimeId !== undefined && deployment.phase === 'ready' && latest !== undefined
        && (target.runtimeId === latest.runtimeId || deployment.aggregateComputers)
        && (nodeId === undefined || typeof nodeId === 'string' && runtimeIdFormat.test(nodeId) && (visible === undefined || visible.nodeId === nodeId))
        && (latest.paged || latest.rows.some(row => row.id === saved))
    }
    const open = (signal: AbortSignal, transfer?: () => void): Promise<void> => {
      if (!available()) return Promise.reject(new Error('Saved computer or conversation is unavailable in this entry'))
      const flight = sessions.usingRuntime(target, signal, async (active) => {
        if (!await sessions.ensureSession(target, address.sessionId, active)) throw new Error('Saved conversation is unavailable')
        if (transfer !== undefined && await ctx.bail('conversation/prepare-input', saved) !== true) throw new Error('Saved draft is unavailable')
        await commitSessionNavigation(sessions, saved, active, () => {
          if (recovery !== attempt) return
          if (!available() || sessions.list.getSnapshot().archivedById[saved] !== undefined
            || workspaces.list.getSnapshot().archivedSessionIds.includes(saved)) throw new Error('Saved conversation is unavailable')
          const draft = intents?.snapshot.getSnapshot().active
          if (transfer !== undefined && (draft?.id !== attempt.intent || draft?.text &&
            ctx.bail('conversation/append-input', { sessionId: saved, text: draft.text }) !== true)) return
          sessions.open(saved)
          transfer?.()
        })
      }).finally(() => { if (restoreWork === flight) { restoreWork = undefined
        if (retryQueued) { retryQueued = false; restoreSelection(true) } } })
      restoreWork = flight
      return flight
    }
    if (intents !== undefined) {
      if (attempt.intent === undefined) {
        attempt.intent = intents.begin({ target, label: showComputer ? target.nodeName ?? '' : '' }, (_intent, editing, transfer) =>
          open(AbortSignal.any([attempt.signal, editing]), transfer))
      } else if (intents.snapshot.getSnapshot().active?.id === attempt.intent) intents.resume(attempt.intent)
    } else void open(attempt.signal).catch((error: unknown) => {
      if (!attempt.signal.aborted) console.error('[personal-directory] Selected conversation could not be restored:', error)
    })
  }
  const rememberSelection = (): void => {
    const committed = sessions.committedSelection.getSnapshot()
    if (selection === undefined || committed === undefined) return
    recovery = undefined
    if (committed.sessionId === undefined) { selection.set({}); return }
    const runtime = parseClientSessionKey(committed.sessionId)?.runtime
    if (runtime?.kind !== 'personal' || runtime.runtimeId === undefined) return
    const nodeId = committed.nodeId ?? directory.getSnapshot().find(group => group.runtime.runtimeId === runtime.runtimeId)?.runtime.nodeId
    selection.set({ sessionId: committed.sessionId, ...(nodeId === undefined ? {} : { nodeId }) })
  }
  const stopSelection = sessions.committedSelection.subscribe(rememberSelection)
  const stopBootstrap = sessions.list.subscribe(() => { restoreSelection() })
  const refresh = (retrySelection = false): Promise<void> => {
    if (disposed || work !== undefined) return work ?? Promise.resolve()
    if (ctx.projectUiPolicy.getSnapshot().verifiedAccountId === undefined
      || connection.hostDescription.getSnapshot()?.executionAuthorityRequired !== true
      || ctx.deploymentContext.getSnapshot().phase !== 'ready') return Promise.resolve()
    restoreSelection()
    const request = new AbortController()
    pending = request
    workspaces.setDirectoryState('loading')
    let expired = false
    const deadline = setTimeout(() => { expired = true; request.abort() }, connection.metadataTiming.requestTimeoutMs)
    const flight = (async () => {
      const query = new URLSearchParams(browser.location?.search)
      const runtime = query.get('dshRuntime')
      const shared = ctx.get('gatewayEntryRequests')
      let metadata: unknown
      if (shared !== undefined) metadata = await shared.catalog(request.signal)
      else {
        const response = await fetch(`/account/api/workbench/catalog${runtime === null ? '' : `?dshRuntime=${encodeURIComponent(runtime)}`}`,
          { signal: request.signal, credentials: 'same-origin', headers: { accept: 'application/json', 'x-dsh-expected-principal-id': String(account) } })
        if (response.status !== 404 && response.status !== 501) {
          if (!response.ok) throw Object.assign(new Error(`Personal directory returned HTTP ${response.status}`), { status: response.status })
          metadata = await readApiResponseJson(response)
        }
      }
      if (metadata === undefined) { workspaces.setDirectoryState(undefined); return }
      const root = object(metadata)
      if (root.personalWorkspaces === undefined) { workspaces.setDirectoryState(undefined); return }
      if (!Array.isArray(root.personalWorkspaces) || !Array.isArray(root.items)) throw new Error('Invalid personal directory')
      const groups: PersonalRuntimeDirectory[] = root.personalWorkspaces.map((value) => {
        const row = object(value)
        if (!Array.isArray(row.items) || row.syncedAt !== null && typeof row.syncedAt !== 'string') throw new Error('Invalid Workspace directory')
        return { runtime: target(row.runtime), status: text(row.status), observedState: text(row.observedState),
          ...(typeof row.workspacesCursor === 'string' ? { workspacesCursor: row.workspacesCursor } : {}),
          ...(typeof row.conversationsCursor === 'string' ? { conversationsCursor: row.conversationsCursor } : {}),
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
        || !runtimeIdFormat.test(activeId)
        || active.kind === 'project' && (!Number.isSafeInteger(active.projectId) || Number(active.projectId) <= 0)
        || runtime !== null && activeId !== runtime) throw new Error('Personal directory returned another or invalid active Runtime')
      directory.set(groups)
      const aggregate = ctx.deploymentContext.getSnapshot().aggregateComputers
      sessions.installPersonalDirectory(rows, active.kind === 'personal', aggregate)
      workspaces.installPersonalDirectory(active.kind === 'personal' ? groups : [], activeId, aggregate, typeof root.computerCursor === 'string')
      workspaces.setDirectoryState('ready')
      if (active.kind === 'personal' && runtime !== null && account !== undefined) {
        restoredDirectory = { runtimeId: text(active.runtimeId), rows, paged: root.paged === true }
        restoreSelection(retrySelection)
      }
    })().catch((error: unknown) => {
      if (pending === request && (!request.signal.aborted || expired)) {
        if (error instanceof Error && 'status' in error && (error.status === 401 || error.status === 403)) {
          directory.set([])
          const bootstrap = sessions.bootstrapRuntimeTarget(), aggregate = ctx.deploymentContext.getSnapshot().aggregateComputers
          sessions.installPersonalDirectory([], bootstrap.kind === 'personal', aggregate)
          workspaces.installPersonalDirectory([], bootstrap.runtimeId ?? '', aggregate)
        }
        workspaces.setDirectoryState('error')
        console.error('[personal-directory] Metadata refresh failed:', error)
      }
    }).finally(() => {
      clearTimeout(deadline); requests.delete(flight)
      if (pending === request) { pending = undefined; work = undefined }
    })
    requests.add(flight); work = flight
    return flight
  }
  workspaces.refreshPersonalDirectory = () => refresh(true)
  workspaces.loadPersonalRows = async (target, more, signal) => {
    const shared = ctx.get('gatewayEntryRequests')
    if (shared === undefined || ctx.deploymentContext.getSnapshot().context?.mode !== 'multi') return refresh()
    const current = directory.getSnapshot().find(group => group.runtime.runtimeId === target.runtimeId)
    if (current === undefined) throw new Error('Computer is unavailable')
    const active = AbortSignal.any([accountLifetime.signal, lifetime.signal, ...(signal === undefined ? [] : [signal])])
    await shared.personalRows(current.runtime, more ? {
      ...(current.workspacesCursor ? { workspaces: current.workspacesCursor } : {}),
      ...(current.conversationsCursor ? { conversations: current.conversationsCursor } : {}),
    } : undefined, active)
    active.throwIfAborted()
    await refresh()
  }
  workspaces.loadMoreComputers = async () => {
    const shared = ctx.get('gatewayEntryRequests')
    if (shared === undefined) return
    await shared.moreComputers(AbortSignal.any([accountLifetime.signal, lifetime.signal]))
    await refresh()
  }
  const identity = (): void => {
    const next = ctx.projectUiPolicy.getSnapshot().verifiedAccountId
    // A bare revocation is the unverified renewal interval, not an account
    // change: keep the last verified identity so pending restores and their
    // conversation intents survive it. Only a different verified account
    // forfeits this document's account-scoped work.
    if (next !== undefined && next !== account) {
      account = next; pending?.abort(); pending = undefined; work = undefined
      accountLifetime.abort(); accountLifetime = new AbortController()
      selection = undefined; restoredDirectory = undefined; recovery = undefined; initialNavigation = undefined
      directory.set([])
      sessions.installPersonalDirectory([], false); workspaces.installPersonalDirectory([], '')
    }
    void refresh(true)
  }
  const stopAccount = ctx.projectUiPolicy.subscribe(identity)
  const stopDeployment = ctx.deploymentContext.subscribe(() => {
    const aggregate = ctx.deploymentContext.getSnapshot().aggregateComputers
    sessions.setPersonalDirectoryAggregation(aggregate); workspaces.setComputerGrouping(aggregate)
    pending?.abort(); pending = undefined; work = undefined
    if (ctx.deploymentContext.getSnapshot().phase === 'error') workspaces.setDirectoryState('error')
    else void refresh()
  })
  const stopHost = connection.hostDescription.subscribe(() => { void refresh(true) })
  let revisit: Promise<void> | undefined
  let revisitQueued = false
  const focus = (): void => {
    if (disposed) return
    // Coalesce attention events into one deferred pass: a revisit already in
    // flight predates this event's state change, so dropping it loses the
    // retry the event exists to trigger.
    if (revisit !== undefined) { revisitQueued = true; return }
    const previous = work, owner = accountLifetime
    const flight = (async () => {
      if (previous !== undefined) await previous
      if (lifetime.signal.aborted || owner.signal.aborted) return
      ctx.get('gatewayEntryRequests')?.refreshDirectory()
      await refresh(true)
    })().finally(() => { if (revisit === flight) revisit = undefined
      if (revisitQueued) { revisitQueued = false; focus() } })
    revisit = flight
  }
  browser.addEventListener?.('focus', focus)
  browser.addEventListener?.('online', focus)
  ctx.effect(() => async () => {
    disposed = true; lifetime.abort(); pending?.abort(); stopAccount(); stopHost(); stopSelection(); stopBootstrap(); stopDeployment()
    browser.removeEventListener?.('online', focus); browser.removeEventListener?.('focus', focus)
    await Promise.allSettled([...requests, restoreWork, revisit])
  }, 'runtime: personal Workspace directory')
  identity()
  return directory
}
