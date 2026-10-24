// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'

const target = { kind: 'project' as const, projectId: 7 }
const ids = ['one', 'two', 'three', 'four'].map(id => id as SessionId)
const description = { version: 'fixture', cwd: '/project', home: '/fixture', attachedSessions: 0, canOpenPath: false }

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(() => {}).await()
  const api = new FakeApiClient()
  const signals: (AbortSignal | undefined)[] = []
  const list = api.workspace.list.bind(api.workspace)
  api.workspace.list = (args, signal) => { signals.push(signal); return list(args, signal) }
  api.onList = async () => ok({ items: ids.map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false })) })
  let sinks: Parameters<ConnectionHandle['start']>[0] | undefined
  const connection: ConnectionHandle = {
    api, isLoopback: true, interactions: 'none',
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('Unexpected RPC')) },
    reconnect: () => {},
    start: (next) => { sinks = next; return { stop: () => {} } },
  }
  const baseApi = new FakeApiClient()
  const base = new SessionRuntime(ctx, baseApi, fakeRemote(), undefined, { provideService: false })
  const pool = new SessionRuntimePool(ctx, base, { ...connection, api: baseApi, forTarget: () => connection }, fakeRemote())
  return { ctx, api, pool, signals,
    connect: () => sinks?.onConnected?.(description),
    disconnect: () => sinks?.onStateChange?.('reconnecting'),
    archive: (archivedSessionIds: SessionId[], archiveRevision: number) => sinks?.onHostEnvelope?.({
      rpcId: 'archive-frame' as never,
      payload: { type: 'host/archived-sessions-changed', archivedSessionIds, archiveRevision },
    }),
  }
}

describe('pooled Workspace archive reads', () => {
  it('shares one pending Workspace read across four restored panes and repulls after settlement', async () => {
    const { ctx, api, pool, connect } = await fixture()
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const pending = ids.map(id => pool.ensureSession(target, id))
    const settled = Promise.allSettled(pending)
    try {
      connect()
      await requested.promise
      workspace.resolve(ok({ items: [] }))
      expect(await Promise.all(pending)).toEqual([true, true, true, true])
      expect(api.callsOf('workspace.list')).toHaveLength(1)
      api.onWorkspaceList = async () => ok({ items: [], archivedSessionIds: [ids[0]!] })
      expect(await pool.ensureSession(target, ids[0]!)).toBe(false)
      expect(api.callsOf('workspace.list')).toHaveLength(2)
    } finally {
      workspace.resolve(ok({ items: [] }))
      await ctx.fiber.dispose()
      await settled
    }
  })

  it('lets one caller cancel while another caller completes the shared verification', async () => {
    const { ctx, api, pool, connect, signals } = await fixture()
    const initial = pool.ensureSession(target, ids[0]!)
    connect()
    await initial
    const before = api.callsOf('workspace.list').length
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const cancelled = new AbortController()
    const first = pool.ensureSession(target, ids[0]!, cancelled.signal)
    const second = pool.ensureSession(target, ids[1]!)
    const settled = Promise.allSettled([first, second])
    const rejected = expect(first).rejects.toThrow('Pane navigation cancelled')
    try {
      await requested.promise
      cancelled.abort(new Error('Pane navigation cancelled'))
      await rejected
      expect(signals.at(-1)?.aborted).toBe(false)
      workspace.resolve(ok({ items: [] }))
      expect(await second).toBe(true)
      expect(api.callsOf('workspace.list').length - before).toBe(1)
    } finally { workspace.resolve(ok({ items: [] })); await ctx.fiber.dispose(); await settled }
  })

  it('aborts an unowned warm read and permits a fresh verification', async () => {
    const { ctx, api, pool, connect, signals } = await fixture()
    const initial = pool.ensureSession(target, ids[0]!)
    connect()
    await initial
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const cancelled = new AbortController()
    const pending = pool.ensureSession(target, ids[0]!, cancelled.signal)
    const settled = Promise.allSettled([pending])
    const rejected = expect(pending).rejects.toThrow('Cancelled')
    try {
      await requested.promise
      const oldSignal = signals.at(-1)
      cancelled.abort(new Error('Cancelled'))
      await rejected
      expect(oldSignal?.aborted).toBe(true)
      api.onWorkspaceList = async () => ok({ items: [] })
      expect(await pool.ensureSession(target, ids[0]!)).toBe(true)
      workspace.resolve(ok({ items: [], archivedSessionIds: [ids[0]!] }))
      await workspace.promise
      expect(await pool.ensureSession(target, ids[0]!)).toBe(true)
    } finally { workspace.resolve(ok({ items: [] })); await ctx.fiber.dispose(); await settled }
  })

  it.each(['denial', 'transport'] as const)('shares %s failure and retries the next verification', async (failure) => {
    const { ctx, api, pool, connect } = await fixture()
    const initial = pool.ensureSession(target, ids[0]!)
    connect()
    await initial
    const before = api.callsOf('workspace.list').length
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const pending = ids.slice(0, 2).map(id => pool.ensureSession(target, id))
    const settled = Promise.allSettled(pending)
    try {
      await requested.promise
      if (failure === 'denial') {
        workspace.resolve(err({ code: 'collaboration-forbidden', message: 'Access revoked',
          details: { action: 'read', reason: 'not-member' } }))
      } else workspace.reject(new Error('Transport unavailable'))
      const results = await settled
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
      if (failure === 'denial') {
        for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'access-revoked' })
      }
      expect(api.callsOf('workspace.list').length - before).toBe(1)
      api.onWorkspaceList = async () => ok({ items: [] })
      expect(await pool.ensureSession(target, ids[0]!)).toBe(true)
      expect(api.callsOf('workspace.list').length - before).toBe(2)
    } finally { workspace.resolve(ok({ items: [] })); await ctx.fiber.dispose(); await settled }
  })

  it('keeps a newer archive frame when an older shared baseline settles', async () => {
    const { ctx, api, pool, connect, archive } = await fixture()
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const pending = pool.ensureSession(target, ids[0]!)
    const settled = Promise.allSettled([pending])
    try {
      connect()
      await requested.promise
      archive([ids[0]!], 2)
      workspace.resolve(ok({ items: [], archivedSessionIds: [], archiveRevision: 1 }))
      expect(await pending).toBe(false)
      api.onWorkspaceList = async () => ok({ items: [], archivedSessionIds: [], archiveRevision: 3 })
      expect(await pool.ensureSession(target, ids[0]!)).toBe(true)
    } finally { workspace.resolve(ok({ items: [] })); await ctx.fiber.dispose(); await settled }
  })

  it.each(['reconnect', 'release', 'account', 'dispose'] as const)('withdraws pending reads on %s and ignores late responses', async (cause) => {
    const { ctx, api, pool, connect, disconnect, signals } = await fixture()
    const initial = pool.ensureSession(target, ids[0]!)
    connect()
    await initial
    const workspace = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const requested = deferred<undefined>()
    api.onWorkspaceList = () => { requested.resolve(undefined); return workspace.promise }
    const pending = pool.ensureSession(target, ids[0]!)
    const settled = Promise.allSettled([pending])
    try {
      await requested.promise
      const oldSignal = signals.at(-1)
      if (cause === 'reconnect') disconnect()
      else if (cause === 'release') pool.setAdditionalStaged([])
      else if (cause === 'account') pool.invalidateAccount()
      else await ctx.fiber.dispose()
      expect((await settled)[0]?.status).toBe('rejected')
      expect(oldSignal?.aborted).toBe(true)
      if (cause === 'reconnect' || cause === 'release') {
        api.onWorkspaceList = async () => ok({ items: [], archivedSessionIds: [], archiveRevision: 1 })
        const next = pool.ensureSession(target, ids[0]!)
        connect()
        expect(await next).toBe(true)
        workspace.resolve(ok({ items: [], archivedSessionIds: [ids[0]!], archiveRevision: 999 }))
        await workspace.promise
        expect(await pool.ensureSession(target, ids[0]!)).toBe(true)
      } else {
        workspace.resolve(ok({ items: [], archivedSessionIds: [ids[0]!] }))
        await workspace.promise
        expect(pool.list.getSnapshot().archivedById).toEqual({})
      }
    } finally { workspace.resolve(ok({ items: [] })); await ctx.fiber.dispose(); await settled }
  })
})
