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
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

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

async function mount(): Promise<Bench> {
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
    api,
    isLoopback: true,
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
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain('s-new')
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
    expect(sessions.list.getSnapshot().current).toBe((create as { sessionId?: unknown })?.sessionId)

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
