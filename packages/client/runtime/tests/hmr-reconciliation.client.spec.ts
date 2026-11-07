// @vitest-environment jsdom
/** A repeated Host graph retains the actual runtime; changed and failed entries still reconcile. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  apply as provideModules,
  createClientModuleSystem,
  type ClientBundleRegistration,
  type ClientModuleLoaderTarget,
  type WebBootEntry,
  type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as RuntimeClient from '../src/client/index.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

const MODULES = '@deepseek-ai/dsh-client-modules'
const RUNTIME = '@deepseek-ai/dsh-client-runtime'

function graph(runtimeRev = 'r0', featureRev = 'r0', failed = false): WebBootGraph {
  const entries = [
    { id: MODULES, rev: 'r0' },
    { id: RUNTIME, rev: runtimeRev },
    { id: 'fixture-feature', rev: featureRev },
    ...(failed ? [{ id: 'fixture-failed', rev: 'r0' }] : []),
  ].map(({ id, rev }): WebBootEntry => ({ id, rev, url: `/plugins/combo.js??${id}/client.js&rev=${rev}` }))
  return {
    rev: JSON.stringify(entries), entries,
    batches: [{ phase: 'application', rev: 'boot', url: 'boot', entries: entries.map(row => row.id) }],
  }
}

it('keeps the connected Runtime mounted for the same graph, applies changed code and retries a failed entry at the same revision', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.restoreAllMocks() })
  const api = new FakeApiClient()
  const calls: string[] = []
  const lifetime = { mounted: 0, disposed: 0, started: 0, stopped: 0, resets: 0 }
  const feature = { mounted: 0, disposed: 0 }
  let failed = true
  let attempts = 0
  const description = { version: 'fixture', cwd: '/fixture', attachedSessions: 0, home: '/fixture', canOpenPath: false }
  const connection: ConnectionHandle = {
    api, interactions: 'none', isLoopback: true,
    metadataTiming: { requestTimeoutMs: 15000, retryAfterMs: 10000 },
    hostDescription: { getSnapshot: () => description, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: async (channel, endpoint) => {
      calls.push(`${channel}/${endpoint}`)
      if (endpoint !== 'permissionPresets/catalog') throw new Error(`unexpected fixture RPC: ${endpoint}`)
      return { ok: true, value: { options: [] } }
    } },
    reconnect: () => { throw new Error('same-graph fixture must not reconnect') },
    start: (sinks) => {
      lifetime.started++
      sinks.onConnected?.(description)
      return { stop: () => { lifetime.stopped++ } }
    },
  }
  await ctx.plugin(TypertRegistry).await()
  ctx.provide('connection', connection)
  const remotes = fakeRemote(api)
  ctx.reflect.provide('remote', { $on: () => () => {} })
  ctx.reflect.provide('remote.commands', remotes.commands)
  ctx.reflect.provide('remote.subagents', remotes.subagents)
  ctx.on('connection/reset', () => { lifetime.resets++ })
  const factories: Record<string, ClientBundleRegistration['factory']> = {
    [RUNTIME]: () => ({ ...RuntimeClient, apply(context: Context) {
      lifetime.mounted++
      context.effect(() => () => { lifetime.disposed++ })
      RuntimeClient.apply(context)
    } }),
    'fixture-feature': () => ({ apply(context: Context) {
      feature.mounted++
      context.effect(() => () => { feature.disposed++ })
    } }),
    'fixture-failed': () => ({ apply() {
      attempts++
      if (failed) throw new Error('fixture entry unavailable')
    } }),
  }
  const fetched: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: MODULES, exports: { inject: ['loader'], apply: provideModules } }, options),
  }
  const initial = graph()
  const modules = target.create({ boot: initial, staticModules: {}, loadBundle: async (url) => {
    fetched.push(url)
    const ids = url === 'boot'
      ? initial.entries.filter(row => row.id !== MODULES).map(row => row.id)
      : [url.split('??')[1]!.split('/client.js')[0]!]
    for (const id of ids) target.load({ id, factory: factories[id]! })
  } })
  await ctx.plugin(Loader).await()
  ctx.loader.internal = modules as unknown as NonNullable<typeof ctx.loader.internal>
  await modules.entries.start(ctx.loader, modules.manifest)
  await vi.waitFor(() => { expect(ctx.sessions.list.getSnapshot().phase).toBe('ready') })
  await ctx.permissionCatalog.forSession(undefined).read()
  expect(lifetime).toEqual({ mounted: 1, disposed: 0, started: 1, stopped: 0, resets: 1 })
  expect(api.callsOf('session.list')).toHaveLength(1)
  expect(api.callsOf('workspace.list')).toHaveLength(1)
  expect(calls).toEqual(['/api/permissionPresets/catalog'])
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces
  const baseline = { api: [...api.calls], rpc: [...calls], fetched: [...fetched] }

  await modules.entries.sync(graph())
  await modules.entries.sync(graph())
  expect(ctx.sessions).toBe(sessions)
  expect(ctx.workspaces).toBe(workspaces)
  expect(lifetime).toEqual({ mounted: 1, disposed: 0, started: 1, stopped: 0, resets: 1 })
  expect({ api: api.calls, rpc: calls, fetched }).toEqual(baseline)

  await modules.entries.sync(graph('r0', 'r1'))
  expect(feature).toEqual({ mounted: 2, disposed: 1 })
  expect(ctx.sessions).toBe(sessions)
  expect(lifetime.started).toBe(1)
  await modules.entries.sync(graph('r1', 'r1'))
  await vi.waitFor(() => { expect(ctx.sessions.list.getSnapshot().phase).toBe('ready') })
  await ctx.permissionCatalog.forSession(undefined).read()
  expect(ctx.sessions).not.toBe(sessions)
  expect(lifetime).toEqual({ mounted: 2, disposed: 1, started: 2, stopped: 1, resets: 2 })
  expect(api.callsOf('session.list')).toHaveLength(2)
  expect(api.callsOf('workspace.list')).toHaveLength(2)
  expect(calls).toHaveLength(2)

  const recovering = graph('r1', 'r1', true)
  await modules.entries.sync(recovering)
  const failures = modules.entries.state.getSnapshot().failures
  expect(failures).toHaveLength(1)
  expect(failures[0]?.id).toBe('fixture-failed')
  expect(failures[0]?.message).toContain('fixture entry unavailable')
  expect(attempts).toBe(1)
  failed = false
  await modules.entries.sync(graph('r1', 'r1', true))
  expect(attempts).toBe(2)
  expect(modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
  expect(lifetime).toEqual({ mounted: 2, disposed: 1, started: 2, stopped: 1, resets: 2 })
  await ctx.fiber.dispose()
  expect(lifetime).toEqual({ mounted: 2, disposed: 2, started: 2, stopped: 2, resets: 2 })
  expect(feature).toEqual({ mounted: 2, disposed: 2 })
})
