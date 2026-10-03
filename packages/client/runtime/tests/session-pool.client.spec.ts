import { clientSessionKey } from '@deepseek-ai/dsh-client-connection/client'
// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { WorkspaceResourceRegistry, workspaceResourceAddress } from '../src/client/workspace-resources.ts'
import { PermissionCatalogDirectory } from '../src/client/permission-catalog.ts'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import type { WorkspaceResourceTarget } from '../src/client/workspace-resources.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

function connection(api: FakeApiClient, onStart?: (sinks: Parameters<ConnectionHandle['start']>[0]) => void): ConnectionHandle {
  return {
    api,
    isLoopback: true,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('unexpected rpc')) },
    reconnect: () => {},
    start: (sinks) => {
      onStart?.(sinks)
      return { stop: () => {} }
    },
  }
}

describe('SessionRuntimePool', () => {
  it('loads a project session through a target runtime without merging its transport', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    projectApi.onList = () => Promise.resolve(ok({ items: [{
      sessionId: 'project-session' as SessionId,
      updatedAt: 10,
      running: false,
      blank: false,
      cwd: '/projects/demo',
    }] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const targetConnection = connection(projectApi, (sinks) => {
      queueMicrotask(() => sinks.onConnected?.({
        version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      }))
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    const stopProvider = pool.provide({
      hooks: ['marker'],
      resolve: () => ({ hooks: { marker: { getSnapshot: () => 'owned', subscribe: () => () => {} } } }),
    })

    await expect(pool.ensureSession({ kind: 'project', projectId: 7, projectName: 'Demo' }, 'project-session' as SessionId)).resolves.toBe(true)
    expect(pool.runtimeTargetFor('project-session' as SessionId)).toEqual({ kind: 'project', projectId: 7, projectName: 'Demo' })
    expect(pool.binding('project-session' as SessionId)).toBeUndefined()
    pool.open('project-session' as SessionId)
    expect(pool.binding('project-session' as SessionId)?.hostDescription).toBe(targetConnection.hostDescription)
    expect(pool.binding('project-session' as SessionId)?.hostDescription).not.toBe(baseConnection.hostDescription)
    expect(pool.list.getSnapshot().byId[clientSessionKey({ kind: 'project', projectId: 7 }, 'project-session' as SessionId)]).toMatchObject({
      cwd: '/projects/demo', projectId: 7, workspaceName: 'Demo',
    })
    expect(baseApi.callsOf('session.list')).toHaveLength(0)
    expect(projectApi.callsOf('session.list')).toHaveLength(1)
    expect(pool.provideInfoFor('project-session' as SessionId)?.hooks.marker?.getSnapshot()).toBe('owned')
    stopProvider()
    expect(pool.provideInfoFor('project-session' as SessionId)?.hooks.marker).toBeUndefined()

    pool.open('project-session' as SessionId)
    expect(pool.list.getSnapshot().current).toBe(clientSessionKey({ kind: 'project', projectId: 7 }, 'project-session' as SessionId))
    pool.setAdditionalStaged([])
    expect(pool.list.getSnapshot().byId[clientSessionKey({ kind: 'project', projectId: 7 }, 'project-session' as SessionId)]).toBeUndefined()
    pool.clear()
    expect(pool.runtimeTargetFor('project-session' as SessionId)).toBeUndefined()
  })

  it('rejects Session verification when the target runtime transport is unavailable', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => undefined }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    // Unverifiable is not absent: workbench restore treats a rejection as a
    // recoverable transport failure while false would drop the pane as denied.
    await expect(pool.ensureSession({ kind: 'project', projectId: 7 }, 'unknown' as SessionId))
      .rejects.toThrow('target runtime unavailable for Session verification')
  })

  it('withdraws Session catalog ownership before stopping its connection and never falls back to another runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(() => {}).await()
    const baseApi = new FakeApiClient(), projectApi = new FakeApiClient()
    const id = 'shared' as SessionId
    const key = clientSessionKey({ kind: 'project', projectId: 7 }, id)
    projectApi.onList = async () => ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: false }] })
    const description = { version: 'fixture', cwd: '/project', attachedSessions: 0, home: '/fixture', canOpenPath: true }
    const host = createSnapshotStore<typeof description | undefined>(undefined)
    const rootRead = vi.fn(() => Promise.reject(new Error('A withdrawn project cannot read the root catalog')))
    const projectRead = vi.fn(async () => ({ ok: true as const, value: { options: [{ value: 'project', name: 'Project' }] } }))
    let stopping = (): void => {}
    const project: ConnectionHandle = { ...connection(projectApi), hostDescription: host, rpc: { call: projectRead },
      start: (sinks) => {
        queueMicrotask(() => { host.set({ ...description }); sinks.onConnected?.(description) })
        return { stop: () => { stopping(); host.set(undefined) } }
      },
    }
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const root: ConnectionHandle = { ...connection(baseApi), rpc: { call: rootRead }, forTarget: () => project,
      forSession: value => pool.runtimeTargetFor(value) === undefined ? root : project,
    }
    const pool = new SessionRuntimePool(ctx, base, root, fakeRemote())
    const directory = new PermissionCatalogDirectory(root, pool.list)
    try {
      await pool.ensureSession({ kind: 'project', projectId: 7 }, id)
      const face = directory.forSession(key)
      const seen: unknown[] = []
      const off = face.subscribe(() => { seen.push(face.getSnapshot()) })
      expect(await face.read()).toEqual({ options: [{ value: 'project', name: 'Project' }] })
      stopping = () => {
        expect(pool.list.getSnapshot().byId[key]).toBeUndefined()
        expect(face.getSnapshot()).toBeUndefined()
      }
      pool.setAdditionalStaged([])
      expect(seen.at(-1)).toBeUndefined()
      await expect(face.read()).rejects.toThrow('no owned runtime')
      expect(rootRead).not.toHaveBeenCalled()
      await pool.ensureSession({ kind: 'project', projectId: 7 }, id)
      await vi.waitFor(() => { expect(seen.at(-1)).toEqual({ options: [{ value: 'project', name: 'Project' }] }) })
      const stopScope = pool.currentScopeList.subscribe(() => { expect(face.getSnapshot()).toBeUndefined() })
      expect(() => { pool.invalidateAccount() }).not.toThrow()
      await expect(face.read()).rejects.toThrow('no owned runtime')
      stopScope()
      off()
    } finally { stopping = () => {}; directory.dispose(); await ctx.fiber.dispose() }
  })

  it('keeps an independent reference after the workbench releases its target and closes it after the final release', async () => {
    const ctx = new Context()
    await ctx.plugin(() => {}).await()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    const id = 'project-owned' as SessionId
    projectApi.onList = () => Promise.resolve(ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: true }] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const stop = vi.fn()
    const targetConnection: ConnectionHandle = {
      ...connection(projectApi),
      start: (sinks) => {
        queueMicrotask(() => sinks.onConnected?.({ version: 'test', cwd: '/project', attachedSessions: 0, home: '/home/test', canOpenPath: true }))
        return { stop }
      },
    }
    const pool = new SessionRuntimePool(ctx, base, { ...connection(baseApi), forTarget: () => targetConnection }, fakeRemote())
    try {
      const source = pool.retainInfo(id)
      const changed = vi.fn()
      const off = source.subscribe(changed)
      await pool.ensureSession({ kind: 'project', projectId: 7 }, id)
      const reference = pool.retain(id, { source: 'controllerOperation' })
      await reference.ready
      pool.setAdditionalStaged([])
      expect(stop).not.toHaveBeenCalled()
      expect(pool.binding(id)).toBe(reference.binding)
      expect(source.getSnapshot().referenceCount).toBe(1)
      reference.release()
      expect(stop).toHaveBeenCalledOnce()
      expect(source.getSnapshot().referenceCount).toBe(0)
      expect(pool.binding(id)).toBeUndefined()
      expect(pool.retainInfo(id)).toBe(source)
      expect(changed).toHaveBeenCalled()
      off()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains an acquiring runtime through handshake and directory lookup while the base pane stage changes', async () => {
    const ctx = new Context()
    await ctx.plugin(() => {}).await()
    const baseApi = new FakeApiClient(), projectApi = new FakeApiClient()
    const id = 'joining' as SessionId
    projectApi.onList = async () => ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: false }] })
    const directory = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    projectApi.onWorkspaceList = () => directory.promise
    let sinks: Parameters<ConnectionHandle['start']>[0] | undefined
    const stop = vi.fn()
    const target: ConnectionHandle = { ...connection(projectApi), start: (next) => { sinks = next; return { stop } } }
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const pool = new SessionRuntimePool(ctx, base, { ...connection(baseApi), forTarget: () => target }, fakeRemote())
    const discovered = Promise.withResolvers<undefined>()
    const takeover = Promise.withResolvers<undefined>()
    const admission = pool.usingRuntime({ kind: 'project', projectId: 7 }, new AbortController().signal, async (signal) => {
      expect(await pool.ensureSession({ kind: 'project', projectId: 7 }, id, signal)).toBe(true)
      discovered.resolve(undefined)
      await takeover.promise
      const reference = pool.retain(id, { source: 'controllerOperation' })
      await reference.ready
      return reference
    })
    const settled = admission.then(value => value, (error: unknown) => error)
    try {
      pool.setAdditionalStaged([])
      expect(stop).not.toHaveBeenCalled()
      sinks?.onConnected?.({ version: 'fixture', cwd: '/project', attachedSessions: 0, home: '/fixture', canOpenPath: true })
      await vi.waitFor(() => { expect(projectApi.callsOf('workspace.list').length).toBeGreaterThan(0) })
      pool.setAdditionalStaged([])
      expect(stop).not.toHaveBeenCalled()
      directory.resolve(ok({ items: [] }))
      await discovered.promise
      pool.setAdditionalStaged([])
      expect(stop).not.toHaveBeenCalled()
      takeover.resolve(undefined)
      const reference = await admission
      expect(stop).not.toHaveBeenCalled()
      pool.setAdditionalStaged([])
      expect(stop).not.toHaveBeenCalled()
      reference.release()
      expect(stop).toHaveBeenCalledOnce()
    } finally { directory.resolve(ok({ items: [] })); takeover.resolve(undefined); await ctx.fiber.dispose(); await settled }
  })

  it.each(['cancel', 'account'] as const)('releases incomplete runtime discovery after %s withdrawal without late adoption', async (kind) => {
    const ctx = new Context()
    await ctx.plugin(() => {}).await()
    const baseApi = new FakeApiClient(), projectApi = new FakeApiClient()
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const stop = vi.fn()
    const target: ConnectionHandle = { ...connection(projectApi), start: () => ({ stop }) }
    const pool = new SessionRuntimePool(ctx, base, { ...connection(baseApi), forTarget: () => target }, fakeRemote())
    const cancel = new AbortController()
    const pending = pool.usingRuntime({ kind: 'project', projectId: 7 }, cancel.signal,
      signal => pool.ensureSession({ kind: 'project', projectId: 7 }, 'pending' as SessionId, signal))
    const rejection = expect(pending).rejects.toThrow(kind === 'cancel' ? 'cancelled intent' : 'identity was invalidated')
    if (kind === 'cancel') cancel.abort(new Error('cancelled intent'))
    else pool.invalidateAccount()
    await rejection
    expect(stop).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('keeps the pending target entry across a transient reconnect', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    projectApi.onList = () => Promise.resolve(ok({ items: [{
      sessionId: 'project-session' as SessionId,
      updatedAt: 10, running: false, blank: false, cwd: '/projects/demo',
    }] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const targetConnection = connection(projectApi, (sinks) => {
      queueMicrotask(() => {
        sinks.onStateChange?.('reconnecting')
        sinks.onConnected?.({
          version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
        })
      })
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    await expect(pool.ensureSession({ kind: 'project', projectId: 7, projectName: 'Demo' }, 'project-session' as SessionId)).resolves.toBe(true)
    expect(projectApi.callsOf('session.list')).toHaveLength(1)
  })

  it('releases a target runtime that stays unready past the ready window', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const targetConnection = connection(projectApi, (sinks) => {
      queueMicrotask(() => sinks.onStateChange?.('reconnecting'))
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    vi.useFakeTimers()
    try {
      const attempt = pool.ensureSession({ kind: 'project', projectId: 7, projectName: 'Demo' }, 'project-session' as SessionId)
      const rejection = expect(attempt).rejects.toThrow('target runtime connection unavailable')
      await vi.advanceTimersByTimeAsync(60_000)
      await rejection
      expect(pool.runtimeTargetFor('project-session' as SessionId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('heals a nameless project target when a later descriptor carries the name', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    projectApi.onCreate = () => Promise.resolve(ok({ sessionId: 'created' as SessionId }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const targetConnection = connection(projectApi, (sinks) => {
      queueMicrotask(() => sinks.onConnected?.({
        version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      }))
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())

    const created = await pool.createSession({ kind: 'project', projectId: 7 })
    expect(created).toBe(clientSessionKey({ kind: 'project', projectId: 7 }, 'created' as SessionId))
    expect(projectApi.callsOf('session.create')).toHaveLength(1)
    expect(pool.runtimeTargetFor('created' as SessionId)).toEqual({ kind: 'project', projectId: 7 })
    expect(pool.list.getSnapshot().byId[clientSessionKey({ kind: 'project', projectId: 7 }, 'created' as SessionId)]?.workspaceName).toBeUndefined()

    await expect(pool.ensureSession({ kind: 'project', projectId: 7, projectName: 'Demo' }, 'created' as SessionId)).resolves.toBe(true)
    expect(pool.runtimeTargetFor('created' as SessionId)).toEqual({ kind: 'project', projectId: 7, projectName: 'Demo' })
    expect(pool.list.getSnapshot().byId[clientSessionKey({ kind: 'project', projectId: 7 }, 'created' as SessionId)]?.workspaceName).toBe('Demo')
  })

  it('stamps the project name on sessions created through a name-bearing target', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    projectApi.onCreate = () => Promise.resolve(ok({ sessionId: 'created' as SessionId }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const targetConnection = connection(projectApi, (sinks) => {
      queueMicrotask(() => sinks.onConnected?.({
        version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      }))
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())

    await pool.createSession({ kind: 'project', projectId: 7, projectName: 'Demo' })
    expect(pool.list.getSnapshot().byId[clientSessionKey({ kind: 'project', projectId: 7 }, 'created' as SessionId)]).toMatchObject({ projectId: 7, workspaceName: 'Demo' })
  })

  it('keeps base-runtime sessions on the base connection with no rerouted target', async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    baseApi.onList = () => Promise.resolve(ok({ items: [{
      sessionId: 'base-session' as SessionId,
      updatedAt: 1, running: false, blank: false, cwd: '/home/test',
    }] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    await base.refresh()
    const baseConnection = connection(baseApi)
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    expect(pool.runtimeTargetFor('base-session' as SessionId)).toBeUndefined()
    expect(pool.runtimeIdentityFor('base-session' as SessionId)).toEqual({ kind: 'personal' })
    pool.setBaseRuntimeTarget({ kind: 'project', projectId: 17 })
    expect(pool.runtimeTargetFor('base-session' as SessionId)).toBeUndefined()
    expect(pool.runtimeIdentityFor('base-session' as SessionId)).toEqual({ kind: 'project', projectId: 17 })
    expect(pool.runtimeIdentityFor('unknown' as SessionId)).toBeUndefined()
  })

  it("keeps an archived base session's summary reachable through archivedById", async () => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const id = 'archived-session' as SessionId
    baseApi.onList = () => Promise.resolve(ok({ items: [{
      sessionId: id, updatedAt: 1, running: false, blank: false, cwd: '/home/test',
    }] }))
    baseApi.onWorkspaceList = () => Promise.resolve(ok({ items: [], archivedSessionIds: [id] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const pool = new SessionRuntimePool(ctx, base, connection(baseApi), fakeRemote())
    pool.handleConnected({ version: 'test', cwd: '/home/test', attachedSessions: 0, home: '/home/test', canOpenPath: true })
    await vi.waitFor(() => { expect(pool.list.getSnapshot().archivedById[clientSessionKey({ kind: 'personal' }, id)]?.id).toBe(clientSessionKey({ kind: 'personal' }, id)) })
    expect(pool.list.getSnapshot().byId[id]).toBeUndefined()
    expect(pool.list.getSnapshot().ids).not.toContain(id)
  })
})

describe('SessionRuntimePool Workspace resources', () => {
  it.each([401, 403, 'rpc'] as const)('withdraws all base-owned sessions before reloading on explicit authorization loss (%s)', async (failure) => {
    const ctx = new Context()
    await ctx.plugin(() => {}).await()
    const api = new FakeApiClient()
    const id = 'private' as SessionId
    const key = clientSessionKey({ kind: 'project', projectId: 7 }, id)
    api.onList = async () => ok({ items: [{ sessionId: id, title: 'Private content', updatedAt: 1, running: false, blank: false }] })
    const base = new SessionRuntime(ctx, api, fakeRemote(), undefined, { provideService: false })
    const invalidate = vi.fn(() => {
      expect(pool.list.getSnapshot().ids).toEqual([])
      expect(pool.binding(key)).toBeUndefined()
    })
    const pool = new SessionRuntimePool(ctx, base, { ...connection(api), invalidatePrincipal: invalidate }, fakeRemote())
    try {
      pool.handleConnected({ version: 'test', cwd: '/project', home: '/home', canOpenPath: false, attachedSessions: 0, runtimeTarget: { kind: 'project', projectId: 7 } })
      await vi.waitFor(() => { expect(pool.list.getSnapshot().ids).toEqual([key]) })
      pool.open(key)
      expect(pool.binding(key)).toBeDefined()
      pool.handleConnectionFailure({ kind: 'transport', error: Object.assign(new Error('temporary'), { status: 503 }) })
      pool.handleDisconnected()
      expect(pool.binding(key)).toBeDefined()
      expect(invalidate).not.toHaveBeenCalled()
      pool.handleConnectionFailure(failure === 'rpc'
        ? { kind: 'rpc', error: { code: 'collaboration-forbidden', message: 'Denied', details: { sessionId: id, action: 'read', reason: 'not-member' } } }
        : { kind: 'transport', error: Object.assign(new Error('Denied'), { status: failure }) })
      expect(invalidate).toHaveBeenCalledOnce()
      pool.handleConnected({ version: 'late', cwd: '/project', home: '/home', canOpenPath: false, attachedSessions: 0 })
      expect(pool.list.getSnapshot().ids).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  const workspaceFiles = { maxBytes: 1024, maxLines: 100, maxEntries: 100, maxResources: 8 }
  function description(withFiles = true) {
    return {
      version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
      ...(withFiles ? { workspaceFiles } : {}),
    } as never
  }

  it('routes change frames to the owning target, revalidates on reconnect, and clears revoked content', async () => {
    const ctx = new Context()
    const registry = new WorkspaceResourceRegistry()
    ctx.provide('workspaceResources', registry)
    const baseApi = new FakeApiClient()
    const projectApi = new FakeApiClient()
    projectApi.onList = () => Promise.resolve(ok({ items: [{
      sessionId: 'project-session' as SessionId,
      updatedAt: 10, running: false, blank: false, cwd: '/projects/demo',
    }] }))
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    let sinks!: Parameters<ConnectionHandle['start']>[0]
    const targetConnection = connection(projectApi, (s) => {
      sinks = s
      queueMicrotask(() => s.onConnected?.(description()))
    })
    const baseConnection: ConnectionHandle = { ...connection(baseApi), forTarget: () => targetConnection }
    const pool = new SessionRuntimePool(ctx, base, baseConnection, fakeRemote())
    const target: WorkspaceResourceTarget = { kind: 'project', projectId: 7 }
    await expect(pool.ensureSession({ kind: 'project', projectId: 7, projectName: 'Demo' }, 'project-session' as SessionId)).resolves.toBe(true)
    expect(registry.hasProvider(target)).toBe(true)

    const sessionId = 'project-session' as SessionId
    const key = clientSessionKey({ kind: 'project', projectId: 7 }, sessionId)
    const request = { runtimeTarget: target, sessionId: key, path: 'a.txt', address: workspaceResourceAddress(key, 'a.txt') }
    const release = registry.pin(request)
    const source = registry.source(request)
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })

    sinks.onHostEnvelope?.({ rpcId: 'frame-1' as never, payload: { type: 'host/workspace-file-changed', sessionId, path: 'a.txt', present: true, version: 'v9' } })
    expect(source.getSnapshot()).toMatchObject({ value: { changed: true } })

    sinks.onStateChange?.('reconnecting')
    expect(source.getSnapshot().status).toBe('failed')

    sinks.onConnected?.(description())
    await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live' }) })

    sinks.onFailure?.({ kind: 'rpc', error: { code: 'collaboration-forbidden', message: 'denied', details: { sessionId, action: 'read', reason: 'not-member' } } })
    expect(source.getSnapshot()).toMatchObject({ status: 'failed', error: { code: 'access-revoked' } })
    expect(source.getSnapshot().value).toBeUndefined()
    release()
  })

  it('registers no provider when the handshake omits Workspace files', async () => {
    const ctx = new Context()
    const registry = new WorkspaceResourceRegistry()
    ctx.provide('workspaceResources', registry)
    const baseApi = new FakeApiClient()
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
    const pool = new SessionRuntimePool(ctx, base, connection(baseApi), fakeRemote())
    pool.handleConnected(description(false))
    await Promise.resolve()
    expect(registry.hasProvider({ kind: 'base' })).toBe(false)
  })
})

it('retains four colliding Host IDs with independent scopes, payloads, holds, and event ownership', async () => {
  const ctx = new Context()
  await ctx.plugin(() => {}).await()
  const id = 'same-session' as SessionId
  const targets = [{ kind: 'personal' as const }, ...[7, 8, 9].map(projectId => ({ kind: 'project' as const, projectId }))]
  const apis = targets.map((_target, index) => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [{ sessionId: id, title: `runtime ${index}`, updatedAt: 1, blank: false, running: false }] }))
    return api
  })
  const dispatch = vi.fn()
  ctx.provide('remote', { $dispatch: dispatch } as never)
  const handles = apis.map(api => connection(api, (sinks) =>{  queueMicrotask(() => sinks.onConnected?.({
    version: 'test', cwd: '/workspace', home: '/home/test', attachedSessions: 0, canOpenPath: true,
  })) }))
  const baseApi = apis[0]!
  const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
  const pool = new SessionRuntimePool(ctx, base, { ...handles[0]!,
    forTarget: target => handles[targets.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(target))]!,
  }, fakeRemote())
  try {
    await base.refresh()
    for (const target of targets.slice(1)) await pool.ensureSession(target, id)
    const keys = targets.map(target => clientSessionKey(target, id))
    expect(pool.list.getSnapshot().ids).toEqual(keys)
    expect(() =>{  pool.open(id) }).toThrow('Ambiguous Session ID')
    pool.setAdditionalStaged(keys)
    const bindings = keys.map(key => pool.binding(key)!)
    expect(new Set(bindings.map(binding => binding.ctx)).size).toBe(4)
    for (const [index, key] of keys.entries()) {
      pool.open(key)
      const binding = bindings[index]!
      expect(pool.scopeOf(binding.ctx)).toBe(key)
      expect(binding.session.getSnapshot().sessionId).toBe(key)
      expect(pool.sessionOf(binding.ctx)).toBe(binding.session)
      expect(pool.provideInfoFor(key)?.sessionId).toBe(key)
      await binding.session.rename(`renamed ${index}`)
      expect(apis[index]!.callsOf('session.rename').at(-1)).toMatchObject({ sessionId: id, title: `renamed ${index}` })
    }
    pool.dispatchRemoteEvent('agent-preset/selected', [id, 'plain'], targets[2])
    expect(dispatch).toHaveBeenLastCalledWith('agent-preset/selected', [keys[2], 'plain'])
    expect(() =>{  pool.openSubagent({ parentSessionId: keys[0]!, childSessionId: keys[1]!, mode: 'continuable' }) }).toThrow('another runtime')
    pool.setAdditionalStaged([keys[0]!, keys[2]!, keys[3]!])
    expect(pool.binding(keys[1]!)).toBeUndefined()
    expect(pool.binding(keys[2]!)).toBe(bindings[2])
  } finally { await ctx.fiber.dispose() }
})

it('forwards pooled job reads and kills to the owner runtime under the original Session ID', async () => {
  const ctx = new Context()
  const baseApi = new FakeApiClient()
  const projectApi = new FakeApiClient()
  projectApi.onList = () => Promise.resolve(ok({ items: [{
    sessionId: 'project-session' as SessionId,
    updatedAt: 10,
    running: false,
    blank: false,
    cwd: '/projects/demo',
  }] }))
  const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
  const targetConnection = connection(projectApi, (sinks) => {
    queueMicrotask(() => sinks.onConnected?.({
      version: 'test', cwd: '/projects/demo', attachedSessions: 0, home: '/home/test', canOpenPath: true,
    }))
  })
  const pool = new SessionRuntimePool(ctx, base, { ...connection(baseApi), forTarget: () => targetConnection }, fakeRemote())
  try {
    const target = { kind: 'project' as const, projectId: 7 }
    await expect(pool.ensureSession(target, 'project-session' as SessionId)).resolves.toBe(true)
    const key = clientSessionKey(target, 'project-session' as SessionId)
    await pool.killJob(key, 'bash-1' as never)
    expect(projectApi.callsOf('jobs.kill').at(-1)).toMatchObject({ sessionId: 'project-session', jobId: 'bash-1' })
    expect(baseApi.callsOf('jobs.kill')).toHaveLength(0)
    const release = pool.observeJob(key, 'bash-1' as never)
    await vi.waitFor(() => {
      expect(projectApi.callsOf('jobs.output').at(-1)).toMatchObject({ sessionId: 'project-session', jobId: 'bash-1' })
    })
    release()
    expect(baseApi.callsOf('jobs.output')).toHaveLength(0)
    // The observed view lands under its runtime-scoped key, not the bare job id.
    await vi.waitFor(() => { expect(pool.list.getSnapshot().observedJobs['project:7:bash-1']).toBeDefined() })
    expect(pool.list.getSnapshot().observedJobs['bash-1']).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
