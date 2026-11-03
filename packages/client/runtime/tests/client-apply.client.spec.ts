import { clientSessionKey } from '@deepseek-ai/dsh-client-connection/client'
/**
 * Runtime plugin browser-half apply: slots + object services mounting over the
 * connection handle, stream-loop sink wiring into the object layer, and the
 * fiber-scoped loop teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionSinks } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientConnectionRpc, HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-host-apiproxy/api'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as RuntimeClient from '../src/client/index.ts'
import type { ConversationNodeDefinition } from '../src/client/contract/conversation.ts'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRuntime } from '../src/client/sessions/service.ts'
import type { WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'

interface Bench {
  ctx: Context
  api: FakeApiClient
  sinks: ConnectionSinks | undefined
  stopped: number
  remote: Record<string, unknown>
  /** Spec-owned `/api` channel endpoint stub; unset calls reject. */
  onRpcCall: ((channel: string, endpoint: string) => ReturnType<ClientConnectionRpc['call']>) | undefined
  /** Publish the base connection's description the way the controller does per generation. */
  publishDescription: (next: HostDescription | undefined) => void
  /** Drive the forwarded-event bridge the same way the connection sink does. */
  dispatchForwarded: (event: string, args?: readonly unknown[]) => void
}

async function mount(overrides: Partial<ConnectionHandle> = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const api = new FakeApiClient()
  const forwarded = new Map<string, Set<(...args: never[]) => void>>()
  const remote: Record<string, unknown> = {
    $on: (event: string, listener: (...args: never[]) => void) => {
      let set = forwarded.get(event)
      if (set === undefined) forwarded.set(event, set = new Set())
      set.add(listener)
      return () => { set.delete(listener) }
    },
    $dispatch: (event: string, args: readonly unknown[] = []) => {
      for (const listener of forwarded.get(event) ?? []) listener(...args as never[])
    },
  }
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const bench: Bench = {
    ctx, api, sinks: undefined, stopped: 0, remote, onRpcCall: undefined,
    publishDescription: (next) => {
      description = next
      for (const listener of [...descriptionListeners]) listener()
    },
    dispatchForwarded: (event, args = []) => {
      for (const listener of forwarded.get(event) ?? []) listener(...args as never[])
    },
  }
  const handle: ConnectionHandle = {
    metadataTiming: { requestTimeoutMs: 15000, retryAfterMs: 10000 },
    api,
    isLoopback: true,
    interactions: 'none',
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    rpc: {
      call: (channel, endpoint) => bench.onRpcCall?.(channel, endpoint)
        ?? Promise.reject(new Error('unexpected generic RPC call')),
    },
    reconnect: () => {},
    start: (sinks) => {
      bench.sinks = sinks
      return { stop: () => { bench.stopped += 1 } }
    },
    ...overrides,
  }
  ctx.reflect.provide('connection', handle)
  ctx.reflect.provide('remote', remote)
  ctx.reflect.provide('remote.commands', fakeRemote().commands)
  ctx.reflect.provide('remote.subagents', fakeRemote().subagents)
  await ctx.plugin(RuntimeClient).await()
  return bench
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('runtime client apply', () => {
  it.each([
    { principalId: 7, runtimeTarget: { kind: 'personal' } as const, suffix: '7.personal', sessionId: 'personal-seven' },
    { principalId: 7, runtimeTarget: { kind: 'project', projectId: 42 } as const, suffix: '7.project-42', sessionId: 'project-seven' },
    { principalId: 8, runtimeTarget: { kind: 'personal' } as const, suffix: '8.personal', sessionId: 'personal-eight' },
  ])('restores only account/Runtime $suffix while its baseline is pending', async ({ principalId, runtimeTarget, suffix, sessionId }) => {
    const storage = new Map([
      ['dsh.sessions.current', JSON.stringify({ sessionId: 'legacy-other-space' })],
      ['dsh.sessions.current.v2.7.personal', JSON.stringify({ sessionId: 'personal-seven' })],
      ['dsh.sessions.current.v2.7.project-42', JSON.stringify({ sessionId: 'project-seven' })],
      ['dsh.sessions.current.v2.8.personal', JSON.stringify({ sessionId: 'personal-eight' })],
    ])
    const before = new Map(storage)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
    let bench: Bench | undefined
    const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    try {
      bench = await mount({ documentIdentity: { principalId, runtimeTarget } })
      bench.api.onList = () => list.promise
      bench.api.onHistory = () => history.promise
      bench.ctx.on('connection/reset', () => { bench?.ctx.get('sessions')!.beginNavigation() })
      bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true, runtimeTarget })
      expect(bench.api.callsOf('session.history')).toEqual([{ sessionId, maxMessages: 50, detail: 'conversation' }])
      expect(bench.api.callsOf('session.list')).toHaveLength(1)
      expect(bench.ctx.get('sessions')!.list.getSnapshot().current).toBeUndefined()
      for (const [key, value] of before) {
        if (key !== `dsh.sessions.current.v2.${suffix}`) expect(storage.get(key)).toBe(value)
      }
    } finally {
      list.resolve(ok({ items: [] }))
      history.resolve(ok({ events: [], hasMore: false }))
      try { await bench?.ctx.fiber.dispose() }
      finally { vi.unstubAllGlobals() }
    }
  })

  it('leaves an unscoped saved selection untouched on the first authenticated space visit', async () => {
    const saved = JSON.stringify({ sessionId: 'another-space' })
    const storage = new Map([['dsh.sessions.current', saved]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
    let bench: Bench | undefined
    const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    try {
      bench = await mount({ documentIdentity: { principalId: 7, runtimeTarget: { kind: 'personal' } } })
      bench.api.onList = () => list.promise
      bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true, runtimeTarget: { kind: 'personal' } })
      expect(bench.api.callsOf('session.history')).toHaveLength(0)
      expect(storage.get('dsh.sessions.current')).toBe(saved)
    } finally {
      list.resolve(ok({ items: [] }))
      try { await bench?.ctx.fiber.dispose() }
      finally { vi.unstubAllGlobals() }
    }
  })

  it('prepares each description publication before resetting with the same initial flag, including for late subscribers', async () => {
    const bench = await mount()
    const order: string[] = []
    const late: string[] = []
    const connected = { version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }
    const connection = bench.ctx.get('connection') as ConnectionHandle
    const stopDescription = connection.hostDescription.subscribe(() => { order.push('description') })
    try {
      bench.ctx.on('connection/will-reset', (value) => {
        order.push(`will-reset:${String(value)}`)
        expect(connection.hostDescription.getSnapshot()).toBeUndefined()
      })
      bench.ctx.on('connection/reset', (value) => {
        order.push(`reset:${String(value)}`)
        expect(connection.hostDescription.getSnapshot()).toBe(connected)
      })
      bench.sinks?.onBeforeConnected?.(connected)
      expect(order).toEqual(['will-reset:true'])
      expect(bench.api.callsOf('workspace.list')).toHaveLength(0)
      expect(bench.api.callsOf('session.list')).toHaveLength(0)
      bench.publishDescription(connected)
      bench.sinks?.onConnected?.(connected)
      expect(order).toEqual(['will-reset:true', 'description', 'reset:true'])
      bench.ctx.on('connection/will-reset', (value) => { late.push(`will-reset:${String(value)}`) })
      bench.ctx.on('connection/reset', (value) => { late.push(`reset:${String(value)}`) })
      bench.publishDescription(undefined)
      order.length = 0
      bench.sinks?.onBeforeConnected?.(connected)
      expect(order).toEqual(['will-reset:false'])
      bench.publishDescription(connected)
      bench.sinks?.onConnected?.(connected)
      expect(order).toEqual(['will-reset:false', 'description', 'reset:false'])
      expect(late).toEqual(['will-reset:false', 'reset:false'])
    } finally { stopDescription(); await bench.ctx.fiber.dispose() }
  })

  it('withdraws prior connection state before preparing the saved history and fresh baselines', async () => {
    const storage = new Map([['dsh.sessions.current', JSON.stringify({ sessionId: 'saved' })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
    let bench: Bench | undefined
    const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    try {
      bench = await mount()
      const { api, ctx, sinks } = bench
      api.onList = () => list.promise
      api.onHistory = () => history.promise
      const sessions = ctx.get('sessions')!
      const readsAtReset: number[][] = []
      ctx.on('connection/reset', () => {
        readsAtReset.push(['workspace.list', 'session.list', 'session.history'].map(endpoint => api.callsOf(endpoint).length))
        sessions.beginNavigation()
      })
      sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
      expect(readsAtReset).toEqual([[0, 0, 0]])
      expect(api.callsOf('session.history')).toHaveLength(1)
      expect(api.lastHistorySignal?.aborted).toBe(false)
      expect(api.callsOf('session.historyIndex')).toHaveLength(0)
      expect(sessions.list.getSnapshot().current).toBeUndefined()
    } finally {
      list.resolve(ok({ items: [] }))
      history.resolve(ok({ events: [], hasMore: false }))
      try { await bench?.ctx.fiber.dispose() }
      finally { vi.unstubAllGlobals() }
    }
  })

  it('retries the shared Workspace baseline on a later connection after refusal', async () => {
    const bench = await mount()
    const id = 'recovered-archive' as never
    const key = clientSessionKey({ kind: 'personal' }, id)
    bench.api.onList = async () => ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: false }] })
    bench.api.onWorkspaceList = async () => err({ code: 'internal', message: 'refused', details: {} })
    try {
      const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
      const connected = { version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }
      bench.sinks?.onConnected?.(connected)
      await workspaces.refresh()
      expect(workspaces.list.getSnapshot().state).toBe('error')
      expect(bench.api.callsOf('workspace.list')).toHaveLength(1)
      bench.sinks?.onStateChange?.('reconnecting')
      bench.api.onWorkspaceList = async () => ok({ items: [], archivedSessionIds: [id], archiveRevision: 1 })
      bench.sinks?.onConnected?.(connected)
      await workspaces.refresh()
      expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([key])
      expect(bench.ctx.get('sessions')?.list.getSnapshot().archivedById[key]?.id).toBe(key)
      expect(bench.api.callsOf('workspace.list')).toHaveLength(2)
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('aborts pending Workspace baseline work on runtime disposal and ignores its late response', async () => {
    const bench = await mount()
    const baseline = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const list = vi.spyOn(bench.api.workspace, 'list')
    bench.api.onWorkspaceList = () => baseline.promise
    try {
      bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
      const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
      const pending = workspaces.refresh()
      const signal = list.mock.calls[0]?.[1]
      await bench.ctx.fiber.dispose()
      expect(signal?.aborted).toBe(true)
      baseline.resolve(ok({ items: [], archivedSessionIds: ['late' as never], archiveRevision: 1 }))
      await pending
      expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([])
      expect(bench.ctx.get('sessions')).toBeUndefined()
    } finally { baseline.resolve(ok({ items: [] })); await bench.ctx.fiber.dispose() }
  })

  it('keeps both consumers on the same merged legacy Workspace archive baseline', async () => {
    const bench = await mount()
    const baseline = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const ids = ['legacy-a', 'legacy-b'].map(id => id as never)
    bench.api.onWorkspaceList = () => baseline.promise
    bench.api.onList = async () => ok({ items: ids.map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false })) })
    try {
      bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
      bench.sinks?.onHostEnvelope?.({ rpcId: 'legacy-archive' as never, payload: {
        type: 'host/archived-sessions-changed', archivedSessionIds: [ids[1]!],
      } })
      baseline.resolve(ok({ items: [], archivedSessionIds: [ids[0]!] }))
      const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
      await workspaces.refresh()
      const expected = new Set(ids.map(id => clientSessionKey({ kind: 'personal' }, id)))
      expect(new Set(workspaces.list.getSnapshot().archivedSessionIds)).toEqual(expected)
      expect(new Set(Object.keys(bench.ctx.get('sessions')!.list.getSnapshot().archivedById))).toEqual(expected)
      expect(bench.api.callsOf('workspace.list')).toHaveLength(1)
    } finally { baseline.resolve(ok({ items: [] })); await bench.ctx.fiber.dispose() }
  })

  it('shares the connected Workspace baseline with the Session archive partition', async () => {
    const bench = await mount()
    const baseline = deferred<Awaited<ReturnType<FakeApiClient['onWorkspaceList']>>>()
    const id = 'baseline-archived' as never
    const key = clientSessionKey({ kind: 'personal' }, id)
    bench.api.onWorkspaceList = () => baseline.promise
    bench.api.onList = async () => ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: false }] })
    try {
      bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
      expect(bench.api.callsOf('workspace.list')).toHaveLength(1)
      baseline.resolve(ok({ items: [], archivedSessionIds: [id], archiveRevision: 1 }))
      const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
      await workspaces.refresh()
      await vi.waitFor(() => {
        expect(bench.ctx.get('sessions')?.list.getSnapshot().archivedById[key]?.id).toBe(key)
      })
      expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([key])
      expect(bench.api.callsOf('workspace.list')).toHaveLength(1)
    } finally {
      baseline.resolve(ok({ items: [] }))
      await bench.ctx.fiber.dispose()
    }
  })

  it('mounts slots, Sessions, and Workspaces and fans host frames into both managers', async () => {
    const bench = await mount()
    expect(bench.ctx.get('slots') !== undefined).toBe(true)
    // The built-in 'root' declaration ships with this package's SlotRegistry
    // (the SlotMap 'root' merge lives here).
    expect(bench.ctx.slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    const sessions = bench.ctx.get('sessions')
    const workspaces = bench.ctx.get('workspaces')
    expect(sessions !== undefined).toBe(true)
    expect(workspaces !== undefined).toBe(true)
    // The bound the wire schema enforces, not a per-connection negotiation.
    expect((sessions as SessionRuntime).searchResultLimit).toBe(SESSION_SEARCH_RESULT_LIMIT)
    if (workspaces === undefined) throw new Error('WorkspaceRuntime missing after runtime apply')
    expect(bench.sinks).toBeDefined()

    // Frame sinks reach the object layer: a host session-added lands in the list store.
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-new' } as never,
    })
    await Promise.resolve()
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain(clientSessionKey({ kind: 'personal' }, 's-new' as never))
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-workspace' as never,
      payload: {
        type: 'host/workspace-changed',
        workspace: {
          workspaceId: 'w-new', path: '/w/new', title: 'new', sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      } as never,
    })
    await Promise.resolve()
    expect(workspaces.list.getSnapshot().items[0]?.workspaceId).toBe('w-new')
    // Mux sink and onConnected route without throwing (manager semantics own the behavior).
    bench.sinks?.onMuxEnvelope?.({ rpcId: 'r2' as never, payload: { type: 'stream/error', message: 'x' } as never })
    bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
  })

  it('selects the recent Workspace once when the first baselines have no current session', async () => {
    const bench = await mount()
    bench.api.onWorkspaceList = () => Promise.resolve(ok({
      items: [{
        workspaceId: 'w-recent', path: '/w/recent', title: 'recent', sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never[],
    }))
    bench.api.onList = () => Promise.resolve(ok({ items: [] }))
    // A preallocated draft id is a request/response correlation key; the
    // real Host echoes it, so make the fake obey that wire invariant.
    bench.api.onCreate = payload => Promise.resolve(ok({
      sessionId: (payload as { sessionId: string }).sessionId as never,
    }))

    bench.sinks?.onConnected?.({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
    await flushMicrotasks()
    await new Promise(resolve => setTimeout(resolve, 0))

    const sessions = bench.ctx.get('sessions') as SessionRuntime
    const workspaces = bench.ctx.get('workspaces') as WorkspaceRuntime
    const create = bench.api.callsOf('session.create')[0]
    expect(create).toMatchObject({ workspaceId: 'w-recent' })
    expect(typeof (create as { draftId?: unknown })?.draftId).toBe('string')
    expect(typeof (create as { sessionId?: unknown })?.sessionId).toBe('string')
    expect(sessions.list.getSnapshot().current).toBe(clientSessionKey({ kind: 'personal' }, (create as { sessionId: never }).sessionId))

    sessions.clear()
    await workspaces.refresh()
    await flushMicrotasks()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(bench.api.callsOf('session.create')).toHaveLength(1)
  })

  it('wires registry changes into resident Sessions during the runtime apply pass', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-registry' as never,
      payload: { type: 'host/session-added', blank: true, sessionId: 's-registry' } as never,
    })
    await flushMicrotasks()
    sessions.open('s-registry' as never)
    expect(sessions.binding('s-registry' as never)).toBeDefined()
    const rebuild = vi.spyOn(Session.prototype, 'rebuildConversationRegistry')
    const definition: ConversationNodeDefinition<null> = {
      kind: 'registry-probe',
      target: 'chat',
      match: () => null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }

    bench.ctx.conversationEvents.register(definition)
    await flushMicrotasks()

    expect(rebuild).toHaveBeenCalledOnce()
    rebuild.mockRestore()
  })

  it('owns the permission catalog: attributed changes republish and generation boundaries clear', async () => {
    const bench = await mount()
    let catalog = { options: [{ value: 'one', name: 'One' }] }
    bench.onRpcCall = (_channel, endpoint) => Promise.resolve(
      endpoint === 'permissionPresets/catalog' ? { ok: true as const, value: catalog } : { ok: false as const, error: { code: 'unknown', message: 'no endpoint', details: {} } },
    )
    const directory = bench.ctx.get('permissionCatalog')
    if (directory === undefined) throw new Error('permissionCatalog missing after runtime apply')
    const face = directory.forSession(undefined)
    const seen: unknown[] = []
    face.subscribe(() => { seen.push(face.getSnapshot()) })
    await flushMicrotasks()
    expect(face.getSnapshot()).toBe(catalog)

    // The host's catalog-changed frame republishes the fresh option table on
    // the delivering connection's mirror only.
    catalog = { options: [{ value: 'two', name: 'Two' }] }
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r-catalog' as never,
      payload: { type: 'host/remote-event', event: 'permission-presets/catalog-changed', args: [] } as never,
    })
    await flushMicrotasks()
    expect(face.getSnapshot()).toBe(catalog)
    expect(seen).toHaveLength(2)

    // A new connection generation clears before repulling the next host's table.
    bench.publishDescription({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true })
    expect(seen).toHaveLength(3)
    await flushMicrotasks()
    expect(face.getSnapshot()).toBe(catalog)
  })

  it('stops the stream loop when the plugin fiber unloads', async () => {
    const bench = await mount()
    const fiber = [...bench.ctx.registry.values()].find(f => f.name?.includes('client'))
    // Dispose the whole tree: the ctx.effect teardown must call loop.stop exactly once.
    await bench.ctx.fiber.dispose()
    expect(bench.stopped).toBe(1)
    void fiber
  })
})

it('disposes every retained Client generation before reloading for a different confirmed account', async () => {
  const { createBrowserIdentityFence } = await import('@deepseek-ai/dsh-client-connection/src/client/identity-fence.ts')
  const reload = vi.fn()
  const fence = createBrowserIdentityFence(vi.fn<typeof fetch>(), 'https://gateway.example', reload)
  const b = await mount({ confirmPrincipal: fence.confirm, onPrincipalChange: fence.subscribe })
  const policy = b.ctx.projectUiPolicy
  const sessions = b.ctx.sessions
  try {
    policy.setVerifiedAccountId(7)
    b.sinks?.onHostEnvelope?.({ rpcId: 'owned-frame' as never,
      payload: { type: 'host/session-added', sessionId: 'same' as never, blank: true } })
    await flushMicrotasks()
    const key = clientSessionKey({ kind: 'personal' }, 'same' as never)
    const reference = sessions.retain(key, { source: 'controllerOperation' })
    await reference.ready
    policy.setVerifiedAccountId(undefined)
    expect(reference.binding.session.sessionId).toBe(key)
    expect(reload).not.toHaveBeenCalled()
    expect(() => { policy.setVerifiedAccountId(8) }).toThrow('Gateway account changed')
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(() => reference.binding).toThrow()
    expect(b.ctx.get('sessions')).toBeUndefined()
    expect(b.ctx.get('slots')).toBeUndefined()
    expect(b.stopped).toBe(1)
  } finally { fence.dispose(); await b.ctx.fiber.dispose() }
})
