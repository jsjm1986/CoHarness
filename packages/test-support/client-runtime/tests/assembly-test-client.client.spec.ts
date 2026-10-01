// @vitest-environment jsdom
/**
 * TestClient over the web profile's roster read from its bundles: production
 * `bootClient` over in-process modules, every Remote call answered by a
 * `RemoteMock` bound to that client's Connection instance, mount, HMR-style reload,
 * unload, and fail-loud teardown.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AssemblyPlan, ClientPluginModule, TestClientOptions } from '../src/assembly/index.ts'
import { ClientRoster, TestClient, remoteDefaultResponses, webApp } from '../src/assembly/index.ts'

/** The client-runtime row and its cone: Connection, Typert, Gateway, and the dropped api-remotes row. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-client-runtime'])
const MODULES = '@deepseek-ai/dsh-client-modules'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const PARALLEL_PROBE = '@deepseek-ai/dsh-client-test-parallel-probe'
/** Declared by ui-sidebar, whose SlotMap merge is outside this package's compilation face. */
const SIDEBAR_SETTINGS = 'sidebar.settings' as never
const BRAND = '@deepseek-ai/dsh-client-ui-brand-official'
const globals = globalThis as { EventSource?: unknown; ResizeObserver?: unknown }
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000

type RemoteFace = Record<string, Record<string, (...args: unknown[]) => unknown>>

async function started(plan: AssemblyPlan, options?: TestClientOptions): Promise<TestClient> {
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const client = await TestClient.start(plan, mock, options)
  onTestFinished(() => client.dispose())
  return client
}

describe('TestClient (jsdom)', () => {
  it('boots the whole web-app roster, connects, mounts, and disposes with nothing unmatched', async () => {
    // Exercise missing-API cleanup independently of the suite's browser defaults.
    vi.stubGlobal('ResizeObserver', undefined)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
    expect(client.connection.state.getSnapshot()).toBe('connected')
    expect(mock.log.streams('events.mux')).toHaveLength(1)
    const container = client.container!
    expect(document.body.contains(container)).toBe(true)
    expect(container.childElementCount).toBeGreaterThan(0)
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeDefined()
    expect(globals.ResizeObserver).toBeDefined()
    expect(document.fonts).toBeInstanceOf(EventTarget)
    await client.dispose()
    expect(document.body.contains(container)).toBe(false)
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeUndefined()
    expect(globals.ResizeObserver).toBeUndefined()
    expect(document.fonts).toBeUndefined()
    await client.dispose()
  }, COLD_BOOT_TIMEOUT_MS)

  it('leaves a pre-existing global alone and removes only the shims it installed', async () => {
    const existing = { existing: true }
    vi.stubGlobal('ResizeObserver', existing)
    const fonts = new EventTarget()
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    onTestFinished(() => {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(document, 'fonts')
    })
    const client = await started({ roster: API_ROSTER })
    expect(globals.ResizeObserver).toBe(existing)
    expect(globals.EventSource).toBeDefined()
    await client.dispose()
    expect(globals.ResizeObserver).toBe(existing)
    expect(globals.EventSource).toBeUndefined()
    expect(document.fonts).toBe(fonts)
  })

  it('restores an existing undefined fonts property after disposal', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'fonts')
    onTestFinished(() => {
      if (original === undefined) Reflect.deleteProperty(document, 'fonts')
      else Object.defineProperty(document, 'fonts', original)
    })
    const descriptor = { configurable: true, enumerable: true, writable: true, value: undefined }
    Object.defineProperty(document, 'fonts', descriptor)
    const client = await started({ roster: API_ROSTER })
    expect(document.fonts).toBeInstanceOf(EventTarget)
    await client.dispose()
    expect(Object.getOwnPropertyDescriptor(document, 'fonts')).toEqual(descriptor)
  })

  it('boots separate client instances against their own mocks and keeps shared shims until the last dispose', async () => {
    const mockA = RemoteMock.create().load(remoteDefaultResponses).unary('synthetic/echo', ok({ tag: 'a' }))
    const mockB = RemoteMock.create().load(remoteDefaultResponses).unary('synthetic/echo', ok({ tag: 'b' }))
    const [a, b] = await Promise.all([
      TestClient.start({ roster: API_ROSTER }, mockA),
      TestClient.start({ roster: API_ROSTER }, mockB),
    ])
    onTestFinished(() => a.dispose())
    onTestFinished(() => b.dispose())
    const echo = async (client: TestClient): Promise<unknown> =>
      (client.ctx as unknown as { remote: RemoteFace }).remote.synthetic!.echo!({ sessionId: 's' })
    await expect(echo(a)).resolves.toEqual({ ok: true, value: { tag: 'a' } })
    await expect(echo(b)).resolves.toEqual({ ok: true, value: { tag: 'b' } })
    expect(mockA.log.calls('synthetic/echo')).toHaveLength(1)
    expect(mockB.log.calls('synthetic/echo')).toHaveLength(1)
    await a.reload('@deepseek-ai/dsh-client-connection')
    await vi.waitFor(() => { expect(a.connection.state.getSnapshot()).toBe('connected') })
    await expect(echo(a)).resolves.toEqual({ ok: true, value: { tag: 'a' } })
    expect(mockA.log.calls('synthetic/echo')).toHaveLength(2)
    expect(mockB.log.calls('synthetic/echo')).toHaveLength(1)
    await a.dispose()
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeDefined()
    expect(document.fonts).toBeInstanceOf(EventTarget)
    await b.dispose()
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeUndefined()
    expect(document.fonts).toBeUndefined()
  })

  it('boots two plugin trees concurrently instead of serializing the worker', async () => {
    let arrivals = 0
    const gate = Promise.withResolvers<undefined>()
    const probe: ClientPluginModule = {
      async apply() {
        arrivals += 1
        await gate.promise
      },
    }
    const roster = ClientRoster.of([
      { name: MODULES, inject: [], immediately: true },
      { name: PARALLEL_PROBE, inject: [], immediately: false },
    ])
    const first = TestClient.start({ roster, provide: { [PARALLEL_PROBE]: probe } }, RemoteMock.create(), { awaitConnected: false })
    const second = TestClient.start({ roster, provide: { [PARALLEL_PROBE]: probe } }, RemoteMock.create(), { awaitConnected: false })
    const starts = Promise.allSettled([first, second])
    let overlapFailure: unknown
    try {
      await vi.waitFor(() => { expect(arrivals).toBe(2) }, { timeout: 5_000 })
    } catch (error) {
      overlapFailure = error
    } finally {
      gate.resolve(undefined)
    }
    const results = await starts
    for (const result of results) {
      if (result.status === 'fulfilled') onTestFinished(() => result.value.dispose())
    }
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') {
      const reason: unknown = rejected.reason
      throw reason
    }
    if (overlapFailure !== undefined) throw overlapFailure
  }, COLD_BOOT_TIMEOUT_MS)

  it('reloads the bootstrap modules row against its own Loader internal', async () => {
    const roster = ClientRoster.of([{ name: MODULES, inject: [], immediately: true }])
    const a = await TestClient.start({ roster }, RemoteMock.create(), { awaitConnected: false })
    onTestFinished(() => a.dispose())
    const b = await TestClient.start({ roster }, RemoteMock.create(), { awaitConnected: false })
    onTestFinished(() => b.dispose())
    const modulesA = a.ctx.get('modules')
    const modulesB = b.ctx.get('modules')
    expect(modulesA).not.toBe(modulesB)
    expect(modulesA).toBe(a.ctx.loader.internal)
    expect(modulesB).toBe(b.ctx.loader.internal)
    await a.reload(MODULES)
    expect(a.ctx.get('modules')).toBe(modulesA)
    expect(b.ctx.get('modules')).toBe(modulesB)
  })

  it('boots the api subset without a mount and exposes the Remote service', async () => {
    const client = await started({ roster: API_ROSTER })
    expect(client.container).toBeUndefined()
    expect(client.ctx.get('remote')).toBeDefined()
    expect(client.connection.state.getSnapshot()).toBe('connected')
  })

  it('refuses to mount a roster that provides no uiRenderer instead of returning an empty container', async () => {
    const before = document.body.childElementCount
    await expect(TestClient.start({ roster: API_ROSTER }, RemoteMock.create().load(remoteDefaultResponses), { mount: true }))
      .rejects.toThrow('mount requested, but the roster provides no `uiRenderer`')
    expect(document.body.childElementCount).toBe(before)
  })

  it('creates no mount element when the roster cannot be loaded', async () => {
    const roster = ClientRoster.of([{ name: '@deepseek-ai/dsh-client-test-runtime-missing', inject: [], immediately: true }])
    const before = document.body.childElementCount
    await expect(TestClient.start({ roster }, RemoteMock.create(), { mount: true })).rejects.toThrow()
    expect(document.body.childElementCount).toBe(before)
  })

  it('mounts into a caller-supplied element and leaves it in place on dispose', async () => {
    const host = document.createElement('main')
    document.body.appendChild(host)
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: host })
    expect(client.container).toBe(host)
    expect(host.childElementCount).toBeGreaterThan(0)
    await client.dispose()
    expect(document.body.contains(host)).toBe(true)
    host.remove()
  })

  it('boots with a provided row in place of the real plugin', async () => {
    const apply = vi.fn()
    const client = await started({ roster: webApp, provide: { [BRAND]: { apply } } }, { mount: true })
    expect(apply).toHaveBeenCalledOnce()
    expect([...client.ctx.loader.entries()].some(entry => entry.options.name === BRAND)).toBe(true)
  })

  it('reload rebuilds the declaring entry; unload collapses it', async () => {
    const client = await started({ roster: webApp }, { mount: true })
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(1)
    await client.reload(SIDEBAR)
    await client.flush()
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(1)
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    const sidebar = [...client.ctx.loader.entries()].find(entry => entry.options.name === SIDEBAR)!
    sidebar.fiber!.ctx.effect(() => async () => {
      cleanupStarted.resolve(undefined)
      await releaseCleanup.promise
    })
    let unloaded = false
    const unloading = client.unload(SIDEBAR).then(() => { unloaded = true })
    try {
      await cleanupStarted.promise
      await client.flush()
      expect(unloaded).toBe(false)
    } finally {
      releaseCleanup.resolve(undefined)
      await unloading
    }
    expect(unloaded).toBe(true)
    await client.flush()
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(0)
    await expect(client.reload(SIDEBAR)).rejects.toThrow(`no Loader entry named ${SIDEBAR}`)
  })

  it('fails loud by teardown at the latest when a boot-time endpoint has no fixture', async () => {
    const mock = RemoteMock.create()
    const run = TestClient.start({ roster: webApp }, mock, { mount: true }).then(client => client.dispose())
    await expect(run).rejects.toThrow(/session\.list|workspace\.list|settings\.describe|dynamicCordisRunner\/|\/list/)
  })

  it('waits through a carrier flap for the connection to become ready', async () => {
    let opens = 0
    const mock = RemoteMock.create().load(remoteDefaultResponses).stream('events.mux', (_args, stream) => {
      opens += 1
      // Fail the first generation's mux pump outright; the controller backs off and reopens it.
      if (opens === 1) stream.fail(new Error('flap'))
    })
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    onTestFinished(() => client.dispose())
    expect(client.connection.state.getSnapshot()).toBe('connected')
    expect(mock.log.streams('events.mux')).toHaveLength(2)
  })

  it('reports the log when the connection never becomes ready', async () => {
    // `host.describe` never resolves: the readiness handshake cannot finish, and
    // both event streams stay `open` for the timeout message to report.
    const mock = RemoteMock.create().load(remoteDefaultResponses)
      .unary('host.describe', () => new Promise(() => {}))
    await expect(TestClient.start({ roster: API_ROSTER }, mock, { connectTimeoutMs: 300 }))
      .rejects.toThrow(/connection state is \S+ after 300ms; unmatched: \[.*\]; streams: \[.*events\.(mux|host) \(open\).*\]/)
    expect(globals.EventSource).toBeUndefined()
  })
})
