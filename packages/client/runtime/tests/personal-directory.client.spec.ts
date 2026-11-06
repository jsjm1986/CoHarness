import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import { ProjectUiPolicyRuntime } from '../src/client/project-policy.ts'
import { installPersonalDirectory, type PersonalRuntimeDirectory } from '../src/client/personal-directory.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'

afterEach(() => { vi.unstubAllGlobals() })

const target = (n: number) => ({ kind: 'personal' as const,
  runtimeId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never,
  nodeId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never, nodeName: `Computer ${n}` })
const workspace: WorkspaceView = { workspaceId: 'workspace' as never, path: '/work/project', title: 'Project', sessionIds: [],
  createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }
const group = (n: number): PersonalRuntimeDirectory => ({ runtime: target(n), status: 'active', observedState: 'stopped',
  syncedAt: workspace.createdAt, items: [workspace] })

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(() => {}).await()
  ctx.provide('deploymentContext', { ...createSnapshotStore({ phase: 'ready', showComputer: true, aggregateComputers: true }) } as never)
  const api = new FakeApiClient(), remoteApi = new FakeApiClient()
  const hostDescription = createSnapshotStore<ReturnType<ConnectionHandle['hostDescription']['getSnapshot']>>(undefined)
  const handle = (owned: FakeApiClient): ConnectionHandle => ({ metadataTiming: { requestTimeoutMs: 15000, retryAfterMs: 10000 }, api: owned, isLoopback: false, interactions: 'none', hostDescription,
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('Unexpected Remote call')) }, reconnect: () => {},
    start: (sinks) => {
      queueMicrotask(() => sinks.onConnected?.({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: true }))
      return { stop: () => {} }
    } })
  const forTarget = vi.fn((_target: SessionRuntimeTarget) => handle(remoteApi))
  const connection = { ...handle(api), forTarget }
  ctx.provide('connection', connection)
  const base = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { provideService: false })
  const sessions = new SessionRuntimePool(ctx, base, connection, fakeRemote(api))
  sessions.setBaseRuntimeTarget(target(1))
  const workspaces = new WorkspaceRuntime(ctx, api, sessions)
  return { ctx, api, remoteApi, connection, hostDescription, forTarget, base, sessions, workspaces }
}

it('lists twenty authorized computers and colliding Host ids without opening any target transport', async () => {
  const f = await fixture()
  try {
    const groups = Array.from({ length: 20 }, (_, index) => group(index + 1))
    const raw = 'same-host-id' as SessionId
    const rows = groups.map(item => ({ id: clientSessionKey(item.runtime, raw), runtime: item.runtime,
      title: item.runtime.nodeName, displayTitle: item.runtime.nodeName, updatedAt: 1, running: false, blank: false }))
    f.sessions.installPersonalDirectory(rows, true)
    f.workspaces.installPersonalDirectory(groups, target(1).runtimeId)
    expect(f.forTarget).not.toHaveBeenCalled()
    expect(f.sessions.currentScopeList.getSnapshot().ids).toHaveLength(20)
    expect(new Set(f.sessions.currentScopeList.getSnapshot().ids).size).toBe(20)
    expect(f.workspaces.list.getSnapshot().computerGroups).toHaveLength(20)
    f.workspaces.setDirectoryState('error')
    expect(f.workspaces.list.getSnapshot().computerGroups).toHaveLength(20)
  } finally { await f.ctx.fiber.dispose() }
})

it('creates and keeps the selected foreign conversation under its own Runtime and Workspace', async () => {
  const f = await fixture(), raw = 'created-on-b' as SessionId
  f.remoteApi.onCreate = async () => ok({ sessionId: raw })
  try {
    f.sessions.installPersonalDirectory([], true)
    f.workspaces.installPersonalDirectory([group(1), group(2)], target(1).runtimeId)
    const foreign = f.workspaces.list.getSnapshot().items[0]!
    f.workspaces.startSession(foreign.workspaceId)
    const id = clientSessionKey(target(2), raw)
    await vi.waitFor(() => { expect(f.sessions.list.getSnapshot().current).toBe(id) })
    expect(f.remoteApi.callsOf('session.create')).toEqual([{ workspaceId: workspace.workspaceId }])
    expect(f.api.callsOf('session.create')).toEqual([])
    expect(f.sessions.runtimeIdentityFor(id)).toMatchObject({ runtimeId: target(2).runtimeId, nodeName: 'Computer 2' })
  } finally { await f.ctx.fiber.dispose() }
})

it('computer creation attaches the exact foreign Workspace even when Host workspace ids collide', async () => {
  const f = await fixture(), raw = 'computer-new-on-b' as SessionId
  try {
    f.remoteApi.onWorkspaceList = async () => ok({ items: [workspace], archivedSessionIds: [], pinnedSessionIds: [], archiveRevision: 0 })
    f.workspaces.installPersonalDirectory([group(1), group(2), group(3)], target(1).runtimeId)
    const foreign = f.workspaces.list.getSnapshot().items.find(item =>
      f.workspaces.runtimeForWorkspace(item.workspaceId)?.runtimeId === target(2).runtimeId)!
    f.remoteApi.onCreate = async () => ok({ sessionId: raw })
    const id = await f.sessions.usingRuntime(target(2), new AbortController().signal, async (signal) => {
      const created = await f.workspaces.createRuntimeSession(target(2), foreign.workspaceId, signal)
      expect(f.sessions.list.getSnapshot().byId[created]?.workspaceId).toBe(foreign.workspaceId)
      return created
    })
    expect(id).toBe(clientSessionKey(target(2), raw))
    expect(f.remoteApi.callsOf('session.create')).toEqual([{ workspaceId: workspace.workspaceId }])
    expect(f.api.callsOf('session.create')).toEqual([])
    await expect(f.workspaces.createRuntimeSession(target(3), foreign.workspaceId)).rejects.toThrow('another Runtime')
    expect(f.remoteApi.callsOf('session.create')).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})

it('an empty computer registers its own default directory before creating its conversation', async () => {
  const f = await fixture(), raw = 'default-on-b' as SessionId
  try {
    f.remoteApi.onDescribe = async () => ok({ version: 'test', cwd: '/computer-b/home', home: '/computer-b/home', attachedSessions: 0, canOpenPath: false })
    f.remoteApi.onWorkspaceCreate = async () => ok({ workspace: { ...workspace, path: '/computer-b/home' }, created: true })
    f.remoteApi.onWorkspaceList = async () => ok({ items: [{ ...workspace, path: '/computer-b/home' }], archivedSessionIds: [], pinnedSessionIds: [], archiveRevision: 0 })
    f.remoteApi.onCreate = async () => ok({ sessionId: raw })
    f.workspaces.installPersonalDirectory([{ ...group(2), items: [] }], target(1).runtimeId)
    const id = await f.sessions.usingRuntime(target(2), new AbortController().signal,
      signal => f.workspaces.createRuntimeSession(target(2), undefined, signal))
    expect(id).toBe(clientSessionKey(target(2), raw))
    expect(f.remoteApi.callsOf('workspace.create')).toEqual([{ path: '/computer-b/home' }])
    expect(f.remoteApi.callsOf('session.create')).toEqual([{ workspaceId: workspace.workspaceId }])
    expect(f.api.callsOf('workspace.create')).toEqual([])
    expect(f.workspaces.list.getSnapshot().items.some(item => item.path === '/computer-b/home')).toBe(true)
  } finally { await f.ctx.fiber.dispose() }
})

it('creates in a bootstrap Workspace before the personal directory has loaded', async () => {
  const f = await fixture(), raw = 'local-before-directory' as SessionId
  try {
    f.hostDescription.set({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test',
      canOpenPath: true, runtimeTarget: target(1) })
    f.api.onWorkspaceList = async () => ok({ items: [workspace] })
    f.api.onCreate = async () => ok({ sessionId: raw })
    void f.workspaces.handleConnected()
    await Promise.all([f.workspaces.refresh(), f.base.refresh()])
    const created = await f.workspaces.createRuntimeSession(target(1), workspace.workspaceId)
    expect(created).toBe(clientSessionKey(target(1), raw))
    expect(f.api.callsOf('session.create')).toEqual([{ workspaceId: workspace.workspaceId }])
    expect(f.remoteApi.callsOf('session.create')).toEqual([])
    expect(f.forTarget).not.toHaveBeenCalled()
  } finally { await f.ctx.fiber.dispose() }
})

it('cancelled default-directory registration and refused Workspace creation leave the current conversation untouched', async () => {
  const f = await fixture(), controller = new AbortController()
  try {
    const held = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceCreate']>>>()
    f.remoteApi.onWorkspaceCreate = () => held.promise
    const pending = f.workspaces.createRuntimeSession(target(2), undefined, controller.signal)
    await vi.waitFor(() => { expect(f.remoteApi.callsOf('workspace.create')).toHaveLength(1) })
    controller.abort(new Error('navigation superseded'))
    held.resolve(ok({ workspace, created: true }))
    await expect(pending).rejects.toThrow('navigation superseded')
    expect(f.remoteApi.callsOf('session.create')).toEqual([])
    f.remoteApi.onWorkspaceCreate = async () => err({ code: 'collaboration-forbidden', message: 'Computer use revoked', details: { action: 'write', reason: 'forbidden' } })
    await expect(f.workspaces.createRuntimeSession(target(2))).rejects.toMatchObject({ rpcError: { code: 'collaboration-forbidden' } })
    expect(f.remoteApi.callsOf('session.create')).toEqual([])
    expect(f.sessions.list.getSnapshot().current).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})

it('renames a foreign Workspace through its exact target and rejects a cross-Runtime reorder', async () => {
  const f = await fixture()
  f.remoteApi.onWorkspaceRename = async () => ok({ workspace: { ...workspace, title: 'Renamed on B' } })
  try {
    f.workspaces.installPersonalDirectory([group(1), group(2), group(3)], target(1).runtimeId)
    const [b, c] = f.workspaces.list.getSnapshot().items
    expect(b && c).toBeTruthy()
    await expect(f.workspaces.rename(b!.workspaceId, 'Renamed on B')).resolves.toMatchObject({ title: 'Renamed on B' })
    expect(f.forTarget).toHaveBeenCalledWith(target(2))
    expect(f.api.callsOf('workspace.rename')).toEqual([])
    await expect(f.workspaces.insertBefore(b!.workspaceId, c!.workspaceId)).rejects.toThrow('Workspaces cannot move between Runtimes')
  } finally { await f.ctx.fiber.dispose() }
})

it('loads central directory metadata after account verification without waking a remote Runtime', async () => {
  const f = await fixture(), policy = new ProjectUiPolicyRuntime()
  ctxPolicy(f.ctx, policy)
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ activeRuntime: target(1),
    personalWorkspaces: [group(1), group(2)], items: [] }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  try {
    installPersonalDirectory(f.ctx, f.connection, f.sessions, f.workspaces)
    expect(fetcher).not.toHaveBeenCalled()
    f.hostDescription.set({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      executionAuthorityRequired: true })
    policy.setVerifiedAccountId(7)
    await vi.waitFor(() => { expect(f.workspaces.list.getSnapshot().directoryState).toBe('ready') })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(f.forTarget).not.toHaveBeenCalled()
    expect(f.workspaces.list.getSnapshot().computerGroups).toHaveLength(2)
  } finally { await f.ctx.fiber.dispose() }
})

function ctxPolicy(ctx: Context, policy: ProjectUiPolicyRuntime): void { ctx.provide('projectUiPolicy', policy) }

it('rejects an active Runtime mismatch before publishing new directory metadata and clears the cache on account change', async () => {
  const f = await fixture(), policy = new ProjectUiPolicyRuntime()
  ctxPolicy(f.ctx, policy)
  vi.stubGlobal('location', { search: `?dshRuntime=${target(1).runtimeId}` })
  let response = { activeRuntime: target(1), personalWorkspaces: [group(1), group(2)], items: [] }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const directory = installPersonalDirectory(f.ctx, f.connection, f.sessions, f.workspaces)
    f.hostDescription.set({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      executionAuthorityRequired: true })
    policy.setVerifiedAccountId(7)
    await vi.waitFor(() => { expect(f.workspaces.list.getSnapshot().directoryState).toBe('ready') })
    const before = directory.getSnapshot(), beforeGroups = f.workspaces.list.getSnapshot().computerGroups
    response = { activeRuntime: target(2), personalWorkspaces: [group(3)], items: [] }
    await f.workspaces.refreshPersonalDirectory()
    expect(f.workspaces.list.getSnapshot().directoryState).toBe('error')
    expect(directory.getSnapshot()).toBe(before)
    expect(f.workspaces.list.getSnapshot().computerGroups).toBe(beforeGroups)
    expect(f.forTarget).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    policy.setVerifiedAccountId(undefined)
    expect(directory.getSnapshot()).toEqual([])
  } finally { await f.ctx.fiber.dispose(); report.mockRestore() }
})

it('waits for bootstrap identity verification before restoring only the saved foreign conversation', async () => {
  const storage = new Map<string, string>(), raw = 'restore-on-b' as SessionId
  const saved = clientSessionKey(target(2), raw)
  storage.set(`dsh.personal.current.v1.account:7.runtime:${target(1).runtimeId}`, JSON.stringify({ sessionId: saved }))
  vi.stubGlobal('location', { search: `?dshRuntime=${target(1).runtimeId}` })
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) } })
  const f = await fixture(), policy = new ProjectUiPolicyRuntime()
  ctxPolicy(f.ctx, policy)
  f.sessions.setBaseRuntimeTarget({ kind: 'personal' })
  f.remoteApi.onList = async () => ok({ items: [{ sessionId: raw, updatedAt: 1, running: false, blank: false }] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/account/api/scope?')
    ? new Response(null, { status: 204, headers: { location: `/?dshRuntime=${target(2).runtimeId}` } })
    : new Response(JSON.stringify({ activeRuntime: target(1),
      personalWorkspaces: Array.from({ length: 20 }, (_, i) => group(i + 1)), items: [{ sessionId: raw, runtime: target(2),
        title: 'Saved on B', updatedAt: 1, blank: false }] }), { headers: { 'content-type': 'application/json' } })))
  try {
    installPersonalDirectory(f.ctx, f.connection, f.sessions, f.workspaces)
    f.hostDescription.set({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      executionAuthorityRequired: true })
    policy.setVerifiedAccountId(7)
    await vi.waitFor(() => { expect(f.workspaces.list.getSnapshot().directoryState).toBe('ready') })
    expect(f.forTarget).not.toHaveBeenCalled()
    f.sessions.setBaseRuntimeTarget(target(1))
    await vi.waitFor(() => { expect(f.sessions.list.getSnapshot().current).toBe(saved) })
    expect(f.forTarget).toHaveBeenCalledWith(target(2))
    expect(f.forTarget.mock.calls.every(([selected]) => selected.runtimeId === target(2).runtimeId)).toBe(true)
  } finally { await f.ctx.fiber.dispose() }
})

it('does not overwrite a completed user selection when the saved restore lands late', async () => {
  const storage = new Map<string, string>()
  const rawSaved = 'saved-on-b' as SessionId, rawLocal = 'picked-local' as SessionId
  const saved = clientSessionKey(target(2), rawSaved)
  const picked = clientSessionKey(target(1), rawLocal)
  storage.set(`dsh.personal.current.v1.account:7.runtime:${target(1).runtimeId}`, JSON.stringify({ sessionId: saved }))
  vi.stubGlobal('location', { search: `?dshRuntime=${target(1).runtimeId}` })
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) } })
  const f = await fixture(), policy = new ProjectUiPolicyRuntime()
  ctxPolicy(f.ctx, policy)
  f.api.onList = async () => ok({ items: [{ sessionId: rawLocal, updatedAt: 1, running: false, blank: false }] })
  f.remoteApi.onList = async () => ok({ items: [{ sessionId: rawSaved, updatedAt: 1, running: false, blank: false }] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/account/api/scope?')
    ? new Response(null, { status: 204, headers: { location: `/?dshRuntime=${target(2).runtimeId}` } })
    : new Response(JSON.stringify({ activeRuntime: target(1),
      personalWorkspaces: [group(1), group(2)], items: [{ sessionId: rawSaved, runtime: target(2),
        title: 'Saved on B', updatedAt: 1, blank: false }] }), { headers: { 'content-type': 'application/json' } })))
  try {
    await f.base.refresh()
    // The user selection commits before the ambient restore begins.
    f.sessions.open(rawLocal)
    expect(f.sessions.list.getSnapshot().current).toBe(picked)
    installPersonalDirectory(f.ctx, f.connection, f.sessions, f.workspaces)
    f.hostDescription.set({ version: 'test', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      executionAuthorityRequired: true })
    policy.setVerifiedAccountId(7)
    // The restore still reaches its retained open on B, then must yield: the
    // selection it would fill is already owned by the user's Session.
    await vi.waitFor(() => { expect(f.remoteApi.callsOf('session.history')).not.toHaveLength(0) })
    await Promise.resolve()
    expect(f.sessions.list.getSnapshot().current).toBe(picked)
  } finally { await f.ctx.fiber.dispose() }
})

it('keeps captured directory operations on B after selection returns to the bootstrap computer', async () => {
  const f = await fixture()
  try {
    await f.workspaces.listDirectory(undefined, undefined, target(2))
    await f.workspaces.create({ path: '/work/new-on-b', runtimeTarget: target(2) })
    await f.workspaces.createDirectory('/work', 'new-on-b', target(2))
    expect(f.remoteApi.callsOf('host.listDirectory')).toEqual([{}])
    expect(f.remoteApi.callsOf('workspace.create')).toEqual([{ path: '/work/new-on-b' }])
    expect(f.api.callsOf('host.listDirectory')).toEqual([])
    await f.workspaces.create({ path: '/work/new-on-a', runtimeTarget: null })
    expect(f.api.callsOf('workspace.create')).toEqual([{ path: '/work/new-on-a' }])
  } finally { await f.ctx.fiber.dispose() }
})
