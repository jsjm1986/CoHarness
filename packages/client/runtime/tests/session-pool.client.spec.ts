// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { WorkspaceResourceRegistry, workspaceResourceAddress } from '../src/client/workspace-resources.ts'
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
    expect(pool.list.getSnapshot().byId['project-session' as SessionId]).toMatchObject({
      cwd: '/projects/demo', projectId: 7, workspaceName: 'Demo',
    })
    expect(baseApi.callsOf('session.list')).toHaveLength(0)
    expect(projectApi.callsOf('session.list')).toHaveLength(1)
    expect(pool.provideInfoFor('project-session' as SessionId)?.hooks.marker?.getSnapshot()).toBe('owned')
    stopProvider()
    expect(pool.provideInfoFor('project-session' as SessionId)?.hooks.marker).toBeUndefined()

    pool.open('project-session' as SessionId)
    expect(pool.list.getSnapshot().current).toBe('project-session')
    pool.setAdditionalStaged([])
    expect(pool.list.getSnapshot().byId['project-session' as SessionId]).toBeUndefined()
    pool.clear()
    expect(pool.runtimeTargetFor('project-session' as SessionId)).toBeUndefined()
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
  })
})

describe('SessionRuntimePool Workspace resources', () => {
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
    const request = { runtimeTarget: target, sessionId, path: 'a.txt', address: workspaceResourceAddress(sessionId, 'a.txt') }
    const release = registry.pin(request)
    const source = registry.source(request)
    await vi.waitFor(() => { expect(source.get().status).toBe('live') })

    sinks.onHostEnvelope?.({ rpcId: 'frame-1' as never, payload: { type: 'host/workspace-file-changed', sessionId, path: 'a.txt', present: true, version: 'v9' } })
    expect(source.get()).toMatchObject({ value: { changed: true } })

    sinks.onStateChange?.('reconnecting')
    expect(source.get().status).toBe('failed')

    sinks.onConnected?.(description())
    await vi.waitFor(() => { expect(source.get()).toMatchObject({ status: 'live' }) })

    sinks.onFailure?.({ kind: 'rpc', error: { code: 'collaboration-forbidden', message: 'denied', details: { sessionId, action: 'read', reason: 'not-member' } } })
    expect(source.get()).toMatchObject({ status: 'failed', error: { code: 'access-revoked' } })
    expect(source.get().value).toBeUndefined()
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
