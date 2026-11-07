/**
 * Node half of the HMR plugin: bundle watches follow the graph, stat changes
 * report through clientModuleHost.rebuilt, and everything dies with the fiber.
 */
import { EventEmitter } from 'node:events'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientArtifactBaseline, ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, EVENTS_ENDPOINT, inject } from '../src/index.ts'

const POLL_MS = 20

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * Controllable clientModuleHost fake over a mutable id → bundle-path table.
 * Structural (Pick+cast): the plugin only touches the read/notify surface;
 * the service class carries private scan state a literal need not reproduce.
 */
type FakeHost = ClientModuleRegistry & { rebuiltCalls: string[]; fireGraphChanged(): void }
interface FakeHostOptions {
  beforeGraphRead?: () => void
  rebuilt?: (id: string) => string | undefined
}

function artifactBaseline(path: string): ClientArtifactBaseline {
  const bundle = statSync(path)
  return { path, mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size }
}

function fakeClientModuleHost(rows: Map<string, string>, options: FakeHostOptions = {}): FakeHost {
  const graphListeners = new Set<() => void>()
  const rebuiltCalls: string[] = []
  const baselines = new Map([...rows].map(([id, path]) => [id, artifactBaseline(path)]))
  const fake: Pick<FakeHost, 'graph' | 'artifactBaseline' | 'rebuilt' | 'onRebuilt' | 'onGraphChanged' | 'rebuiltCalls' | 'fireGraphChanged'> = {
    rebuiltCalls,
    fireGraphChanged: () => { for (const l of graphListeners) l() },
    graph: (): WebBootGraph => {
      options.beforeGraphRead?.()
      return {
        rev: 'r',
        entries: [...rows.keys()].map(id => ({ id, url: `/plugins/combo.js??${id}/client.js&rev=r`, rev: 'r' })),
        batches: [],
      }
    },
    artifactBaseline: (id) => {
      const path = rows.get(id)
      if (path === undefined) return undefined
      let baseline = baselines.get(id)
      if (baseline?.path !== path) {
        baseline = artifactBaseline(path)
        baselines.set(id, baseline)
      }
      return { ...baseline }
    },
    rebuilt: (id) => {
      rebuiltCalls.push(id)
      return options.rebuilt?.(id) ?? 'r2'
    },
    onRebuilt: () => () => {},
    onGraphChanged: (listener) => {
      graphListeners.add(listener)
      return () => { graphListeners.delete(listener) }
    },
  }
  return fake as FakeHost
}

// Structural fake: the plugin only touches register(); the service class
// carries private state a literal cannot (and need not) reproduce.
function fakeHttpServer(routes: WebRoute[]): WebServer {
  const fake: Pick<WebServer, 'register' | 'tapIndex' | 'port'> = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
  return fake as WebServer
}

async function mount(clientModuleHost: FakeHost, webServer: WebServer, watchArtifacts = true) {
  const ctx = new Context()
  ctx.provide('clientModules', clientModuleHost)
  ctx.provide('webServer', webServer)
  const fiber = ctx.plugin(
    { inject: [...inject], Config, apply },
    { pollIntervalMs: POLL_MS, watchArtifacts },
  )
  await fiber.await()
  return fiber
}

/** Socket-like response whose destroy operation reaches the observable close edge. */
function fakeResponse(lines: string[]) {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, closed: false, writableEnded: false, writableNeedDrain: false,
    writeHead: vi.fn(),
    write: vi.fn((line: string) => { lines.push(line); return true }),
    destroy: vi.fn(() => {
      response.destroyed = true
      if (!response.closed) response.emit('close')
    }),
    end: vi.fn(),
  })
  response.on('close', () => { response.closed = true; response.destroyed = true })
  return response
}

describe('hmr node half', () => {
  it('delivers graph changes without acquiring artifact watches or polling in production', async () => {
    const rows = new Map<string, string>()
    const host = fakeClientModuleHost(rows)
    const baseline = vi.spyOn(host, 'artifactBaseline')
    const timer = vi.spyOn(globalThis, 'setInterval')
    const routes: WebRoute[] = []
    const fiber = await mount(host, fakeHttpServer(routes), false)
    const lines: string[] = []
    const response = fakeResponse(lines)
    try {
      expect(timer).not.toHaveBeenCalled()
      await routes[0]!.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
      rows.set('new-plugin', join(dir, 'unbuilt.js'))
      host.fireGraphChanged()
      expect(lines).toHaveLength(3)
      expect((JSON.parse(lines[2]!.slice(6)) as { graph: WebBootGraph }).graph.entries.map(row => row.id)).toEqual(['new-plugin'])
      expect(baseline).not.toHaveBeenCalled()
      expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15_000)
      expect(host.rebuiltCalls).toEqual([])
      await fiber.dispose()
      host.fireGraphChanged()
      expect(lines).toHaveLength(3)
      expect(response.destroy).toHaveBeenCalledOnce()
      expect(routes).toHaveLength(0)
    } finally {
      await fiber.dispose()
      timer.mockRestore()
      baseline.mockRestore()
    }
  })

  it('validates the graph-stream keepalive timer range before activation', () => {
    expect(Config({}).keepAliveIntervalMs).toBe(15_000)
    for (const keepAliveIntervalMs of [1, 2_147_483_647]) {
      expect(Config({ keepAliveIntervalMs }).keepAliveIntervalMs).toBe(keepAliveIntervalMs)
    }
    for (const keepAliveIntervalMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => Config({ keepAliveIntervalMs })).toThrow()
    }
  })

  it('writes idle comments with one unref timer until the last graph stream closes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const timer = vi.spyOn(globalThis, 'setInterval')
    const routes: WebRoute[] = []
    const host = fakeClientModuleHost(new Map())
    const fiber = await mount(host, fakeHttpServer(routes), false)
    const first: string[] = []
    const second: string[] = []
    const a = fakeResponse(first)
    const b = fakeResponse(second)
    try {
      expect(vi.getTimerCount()).toBe(0)
      await routes[0]!.handler({ method: 'GET' } as IncomingMessage, a as unknown as ServerResponse)
      await routes[0]!.handler({ method: 'GET' } as IncomingMessage, b as unknown as ServerResponse)
      expect(timer).toHaveBeenCalledOnce()
      expect((timer.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false)
      vi.advanceTimersByTime(15_000)
      expect(first).toEqual([': connected\n\n', expect.stringContaining('"type":"graph"'), ': keep-alive\n\n'])
      expect(second).toEqual(first)
      a.emit('close')
      vi.advanceTimersByTime(15_000)
      expect(first).toHaveLength(3)
      expect(second).toHaveLength(4)
      b.emit('close')
      expect(vi.getTimerCount()).toBe(0)
      expect(a.listenerCount('error')).toBe(0)
      expect(b.listenerCount('error')).toBe(0)
    } finally {
      await fiber.dispose()
      timer.mockRestore()
      vi.useRealTimers()
    }
  })

  it('skips backpressured comments and contains a heartbeat write failure', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const routes: WebRoute[] = []
    const fiber = await mount(fakeClientModuleHost(new Map()), fakeHttpServer(routes), false)
    const warn = vi.spyOn(fiber.ctx.logger, 'warn').mockImplementation(() => {})
    const lines: string[] = []
    const response = fakeResponse(lines)
    try {
      await routes[0]!.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
      response.writableNeedDrain = true
      vi.advanceTimersByTime(45_000)
      expect(lines).toHaveLength(2)
      response.writableNeedDrain = false
      vi.advanceTimersByTime(15_000)
      expect(lines.at(-1)).toBe(': keep-alive\n\n')
      response.write.mockImplementationOnce(() => { throw new Error('fixture write failure') })
      expect(() => vi.advanceTimersByTime(15_000)).not.toThrow()
      expect(warn).toHaveBeenCalledOnce()
      expect(response.destroy).toHaveBeenCalledOnce()
      expect(response.listenerCount('error')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await fiber.dispose()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('contains asynchronous response errors and retires their graph-stream timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const routes: WebRoute[] = []
    const fiber = await mount(fakeClientModuleHost(new Map()), fakeHttpServer(routes), false)
    const warn = vi.spyOn(fiber.ctx.logger, 'warn').mockImplementation(() => {})
    const response = fakeResponse([])
    try {
      await routes[0]!.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
      expect(() => response.emit('error', new Error('fixture socket failure'))).not.toThrow()
      expect(response.destroy).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await fiber.dispose()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([false, true])('joins delayed response closure and rejects later admissions when a write fails: %s', async (failedWrite) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const host = fakeClientModuleHost(new Map())
    const routes: WebRoute[] = []
    const fiber = await mount(host, fakeHttpServer(routes), false)
    const warn = vi.spyOn(fiber.ctx.logger, 'warn').mockImplementation(() => {})
    const route = routes[0]!
    const lines: string[] = []
    const response = fakeResponse(lines)
    let destroyed!: () => void
    const destroying = new Promise<void>((resolve) => { destroyed = resolve })
    response.destroy.mockImplementation(() => {
      response.destroyed = true
      if (response.destroy.mock.calls.length === (failedWrite ? 2 : 1)) destroyed()
    })
    let disposing: Promise<void> | undefined
    try {
      await route.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
      if (failedWrite) {
        response.write.mockImplementationOnce(() => { throw new Error('fixture delayed write failure') })
        vi.advanceTimersByTime(15_000)
      }
      let settled = false
      disposing = fiber.dispose().then(() => { settled = true })
      await destroying
      expect(settled).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      host.fireGraphChanged()
      vi.advanceTimersByTime(30_000)
      expect(lines).toHaveLength(2)
      response.emit('close')
      await disposing
      const late = fakeResponse([])
      await route.handler({ method: 'GET' } as IncomingMessage, late as unknown as ServerResponse)
      expect(late.destroy).toHaveBeenCalledOnce()
      expect(late.writeHead).not.toHaveBeenCalled()
      expect(routes).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      response.emit('close')
      await disposing
      await fiber.dispose()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('watches graph bundles, ignores map-only changes, and unwatches on dispose', async () => {
    const bundle = join(dir, 'a.js')
    writeFileSync(bundle, 'v1')
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const routes: WebRoute[] = []
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes))

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: EVENTS_ENDPOINT })
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    // Nudge mtime past stat granularity so the poller sees a content signal.
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(`${bundle}.map`, '{"version":3}')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    writeFileSync(bundle, 'v3-even-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    await fiber.dispose()
    expect(routes).toHaveLength(0)
    // Watcher gone: further file changes report nothing.
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(bundle, 'v4-after-dispose')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 4))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
  })

  it('follows graph changes: rows added after activation get watched', async () => {
    const early = join(dir, 'early.js')
    const late = join(dir, 'late.js')
    writeFileSync(early, 'v1')
    const rows = new Map([['pkg-early', early]])
    const clientModuleHost = fakeClientModuleHost(rows)
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    writeFileSync(late, 'v1')
    rows.set('pkg-late', late)
    clientModuleHost.fireGraphChanged()
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(late, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-late') }, { timeout: 3_000 })

    rows.delete('pkg-late')
    clientModuleHost.fireGraphChanged()
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(late, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('publishes only a row changed between its startup snapshot and watch installation', async () => {
    const bundle = join(dir, 'construction.js')
    writeFileSync(bundle, 'v1')
    let rewrite = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!rewrite) return
        rewrite = false
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('publishes a ctime change when a rewrite preserves mtime and size', async () => {
    const bundle = join(dir, 'preserved-mtime.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    try {
      await expect.poll(() => Date.now()).toBeGreaterThan(Math.ceil(baseline.ctimeMs))
      writeFileSync(bundle, 'next')
      utimesSync(bundle, fixedTime, fixedTime)
      expect(statSync(bundle)).toMatchObject({ mtimeMs: baseline.mtimeMs, size: baseline.size })
      await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    } finally {
      await fiber.dispose()
    }
  })

  it('publishes a reappearing bundle with restored mtime and size', async () => {
    const bundle = join(dir, 'replace.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    unlinkSync(bundle)
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'x'.repeat(baseline.size))
    utimesSync(bundle, fixedTime, fixedTime)
    const restored = statSync(bundle)
    expect({ mtimeMs: restored.mtimeMs, size: restored.size }).toEqual({
      mtimeMs: baseline.mtimeMs,
      size: baseline.size,
    })
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  it('retains a dirty baseline when catch-up publication races a rename', async () => {
    const bundle = join(dir, 'rename.js')
    writeFileSync(bundle, 'v1')
    let first = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!first) return
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
      rebuilt: () => {
        if (!first) return 'r2'
        first = false
        throw Object.assign(new Error('bundle renamed'), { code: 'ENOENT' })
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a', 'pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })
})


it('broadcasts the desired graph without waiting for Host activation or cleanup', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const bundle = join(dir, 'a.js')
  writeFileSync(bundle, 'a')
  const rows = new Map([['a', bundle]])
  const host = fakeClientModuleHost(rows)
  const routes: WebRoute[] = []
  ctx.provide('clientModules', host)
  ctx.provide('webServer', fakeHttpServer(routes))
  let release!: () => void
  let cleaned!: () => void
  let started!: () => void
  const starting = new Promise<void>((resolve) => { started = resolve })
  const activation = new Promise<void>((resolve) => { release = resolve })
  const cleanup = new Promise<void>((resolve) => { cleaned = resolve })
  let disposed = false
  ctx.loader.internal = { version: 'client', import: async () => ({
    apply: async (pluginCtx: Context) => {
      pluginCtx.effect(() => async () => { await cleanup; disposed = true })
      started()
      await activation
    },
  }) } as never
  const entryId = await ctx.loader.create({ name: 'owned' })
  await starting
  const fiber = ctx.plugin({ inject, Config, apply }, { pollIntervalMs: POLL_MS })
  await fiber.await()
  const route = routes[0]!
  const connect = async () => {
    const lines: string[] = []
    const response = fakeResponse(lines)
    await route.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
    return { lines, response }
  }
  try {
    const first = await connect()
    expect(first.lines).toHaveLength(2)
    const frame = JSON.parse(first.lines[1]!.slice(6)) as { graph: WebBootGraph }
    expect(frame.graph.entries.map(row => row.id)).toEqual(['a'])
    const second = await connect()
    expect(second.lines[1]).toBe(first.lines[1])
    expect(first.lines).toHaveLength(2)
    release()
    const owned = ctx.loader.resolve(entryId).fiber!
    await owned.await()
    const child = owned.ctx.plugin({ apply() {} })
    await child.await()
    expect(child.entry).toBe(owned.entry)
    await child.dispose()
    await child.await()
    await ctx.loader.await()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(second.lines).toHaveLength(2)
    first.response.emit('close')
    ctx.loader.remove(entryId)
    rows.clear()
    host.fireGraphChanged()
    expect(second.lines).toHaveLength(3)
    expect(disposed).toBe(false)
    expect((JSON.parse(second.lines[2]!.slice(6)) as { graph: WebBootGraph }).graph.entries).toEqual([])
    const third = await connect()
    expect(third.lines[1]).toBe(second.lines[2])
    expect(second.lines).toHaveLength(3)
    cleaned()
    while (owned.inertia !== undefined) await owned.inertia
    expect(disposed).toBe(true)
    expect(second.lines).toHaveLength(3)
    await fiber.dispose()
    host.fireGraphChanged()
    expect(second.lines).toHaveLength(3)
    expect(second.response.destroy).toHaveBeenCalledOnce()
    expect(third.response.destroy).toHaveBeenCalledOnce()
  } finally {
    release()
    cleaned()
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
