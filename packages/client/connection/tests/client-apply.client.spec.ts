/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, installConnection, type ConnectionHandle } from '../src/client/index.ts'
import type { RpcMessage, SessionId } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'
import { ConnectionController, type ConnectionFailure } from '../src/client/connection.ts'
import { deferred } from './fake-api.client.ts'

type Win = { location?: { hostname: string; search: string; origin?: string } }
type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket
const sockets: FakeWebSocket[] = []

class FakeWebSocket extends EventTarget {
  static autoOpen = true
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  holdClose = false
  closeCalls = 0

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
    queueMicrotask(() => {
      if (!FakeWebSocket.autoOpen || this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    this.closeCalls++
    if (this.readyState === FakeWebSocket.CLOSED) return
    if (this.holdClose) { this.readyState = FakeWebSocket.CLOSING; return }
    this.remoteClose(1000, true)
  }

  remoteClose(code: number, wasClean: boolean, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(Object.assign(new Event('close'), { code, wasClean, reason }))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

const mountedContexts: Context[] = []
afterEach(async () => {
  for (const ctx of mountedContexts.splice(0).reverse()) await ctx.fiber.dispose()
  delete (globalThis as Win).location
  sockets.length = 0
  FakeWebSocket.autoOpen = true
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

describe('connection termination diagnostics', () => {
  const privateText = 'private-session/private?token=do-not-record'
  const config = { backoffBaseMs: 10_000, backoffMaxMs: 10_000 }

  function response(init?: RequestInit): Response {
    const request = JSON.parse(init?.body as string) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {
      version: 'test', cwd: '/private', home: '/private', attachedSessions: 0, canOpenPath: false,
    } } })
  }

  it.each([
    { source: 'mux', code: 1012, wasClean: true },
    { source: 'host', code: 1006, wasClean: false },
  ] as const)('reports only the first $source close and excludes the companion abort', async ({ source, code, wasClean }) => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 100
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { clock = Math.max(clock, 120); return response(init) })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const connected = deferred<undefined>()
    const nextConnected = deferred<undefined>()
    let connections = 0
    const reconnecting = deferred<undefined>()
    const failure = vi.fn<(value: ConnectionFailure) => void>()
    const controller = new ConnectionController(new WebApiClient(), {
      onConnected: () => { if (++connections === 1) connected.resolve(undefined); else nextConnected.resolve(undefined) },
      onStateChange: (state) => { if (state === 'reconnecting') reconnecting.resolve(undefined) },
      onFailure: failure,
    }, config)
    controller.start()
    try {
      await connected.promise
      const first = sockets.find(socket => new URL(socket.url).pathname === `/api/events.${source}`)!
      const companion = sockets.find(socket => socket !== first)!
      companion.holdClose = true
      clock = 165
      first.remoteClose(code, wasClean, privateText)
      await reconnecting.promise
      expect(failure).toHaveBeenCalledOnce()
      expect(failure.mock.calls[0]![0]).toMatchObject({ kind: 'transport', diagnostic: {
        clientGeneration: 1, source, cause: 'stream-eof', phase: 'connected',
        elapsedMs: 65, connectedForMs: 45, closeCode: code, wasClean,
      } })
      expect(companion.readyState).toBe(FakeWebSocket.CLOSING)
      expect(companion.closeCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(10_000)
      await nextConnected.promise
      companion.remoteClose(1000, true, privateText)
      controller.stop()
      await vi.runAllTimersAsync()
      expect(failure).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledOnce()
      const text = warning.mock.calls.flat().join('\n')
      expect(text).toContain(`"source":"${source}"`)
      expect(text).toContain(`"closeCode":${String(code)}`)
      expect(text).not.toContain(privateText)
      expect(text).not.toContain('localhost')
      expect(text).not.toContain('/private')
      expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual(failure.mock.calls[0]![0].diagnostic)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.stop()
      for (const socket of sockets) if (socket.readyState !== FakeWebSocket.CLOSED) socket.remoteClose(1000, true)
      await vi.runAllTimersAsync()
      warning.mockRestore(); fetch.mockRestore(); now.mockRestore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('attributes a rejected describe to opening and preserves its error without logging its text', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.autoOpen = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const error = new TypeError(privateText)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(error)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reconnecting = deferred<undefined>()
    const failure = vi.fn<(value: ConnectionFailure) => void>()
    const controller = new ConnectionController(new WebApiClient(), {
      onFailure: failure,
      onStateChange: (state) => { if (state === 'reconnecting') reconnecting.resolve(undefined) },
    }, config)
    controller.start()
    try {
      await reconnecting.promise
      controller.stop()
      await vi.runAllTimersAsync()
      expect(failure).toHaveBeenCalledOnce()
      expect(failure.mock.calls[0]![0].error).toBe(error)
      expect(failure.mock.calls[0]![0].diagnostic).toMatchObject({
        clientGeneration: 1, source: 'describe', cause: 'transport-rejection', phase: 'opening',
      })
      expect(failure.mock.calls[0]![0].diagnostic).not.toHaveProperty('connectedForMs')
      expect(failure.mock.calls[0]![0].diagnostic).not.toHaveProperty('closeCode')
      expect(sockets).toHaveLength(2)
      expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
      expect(warning).toHaveBeenCalledOnce()
      expect(warning.mock.calls.flat().join('\n')).not.toContain(privateText)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.stop()
      await vi.runAllTimersAsync()
      warning.mockRestore(); fetch.mockRestore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it.each([false, true])('treats stop as client cancellation without a failure or retry (ready=%s)', async (ready) => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'http://localhost:3080' }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reply = deferred<Response>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => ready ? response(init) : reply.promise)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const connected = deferred<undefined>()
    const failure = vi.fn()
    const controller = new ConnectionController(new WebApiClient(), {
      onFailure: failure, onConnected: () => { connected.resolve(undefined) },
    }, config)
    controller.start()
    try {
      if (ready) await connected.promise
      else await Promise.resolve()
      expect(sockets).toHaveLength(2)
      controller.stop()
      reply.resolve(Response.json({}))
      await vi.runAllTimersAsync()
      expect(failure).not.toHaveBeenCalled()
      expect(warning).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledOnce()
      expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.stop(); reply.resolve(Response.json({}))
      await vi.runAllTimersAsync()
      warning.mockRestore(); fetch.mockRestore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  mountedContexts.push(ctx)
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('rejects malformed browser document input before replacing fetch or providing a connection', () => {
    const ctx = new Context()
    mountedContexts.push(ctx)
    const original = globalThis.fetch
    expect(() => {
      installConnection(ctx, {
        location: { hostname: 'harness.example', origin: 'https://harness.example' },
        documentIdentity: { version: 2 },
      })
    }).toThrow(/Connection document identity/)
    expect(globalThis.fetch).toBe(original)
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('leaves document identity to an explicit carrier', () => {
    const ctx = new Context()
    mountedContexts.push(ctx)
    const api = new FixtureApiClient()
    const original = globalThis.fetch
    installConnection(ctx, {
      location: { hostname: 'harness.example', origin: 'https://harness.example' },
      documentIdentity: { version: 2 },
      transport: { createApiClient: () => api },
    })
    expect((ctx.get('connection') as ConnectionHandle).api).toBe(api)
    expect(globalThis.fetch).toBe(original)
  })

  it.each(['account', 'runtime'] as const)('retires early sockets when the first response changes the document %s', async (changed) => {
    const reloaded = deferred<undefined>()
    vi.stubGlobal('location', {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
      reload: () => { reloaded.resolve(undefined) },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('__DSH_DOCUMENT_IDENTITY__', { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: 42 } })
    const held = deferred<Response>()
    const requested = deferred<RequestInit | undefined>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requested.resolve(init)
      return held.promise
    })
    let loop: ReturnType<ConnectionHandle['start']> | undefined
    try {
      const handle = await mount()
      expect(handle.documentIdentity).toEqual({ principalId: 7, runtimeTarget: { kind: 'project', projectId: 42 } })
      expect(handle.forTarget?.({ kind: 'personal' }).documentIdentity).toBe(handle.documentIdentity)
      const connected = vi.fn()
      loop = handle.start({ onConnected: connected })
      const init = await requested.promise
      await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
      held.resolve(Response.json({
        type: 'server-response', rpcId: (JSON.parse(init?.body as string) as { rpcId: string }).rpcId,
        result: { ok: true, value: {
          version: 'test', cwd: '/fixture', home: '/fixture', attachedSessions: 0, canOpenPath: false,
          executionAuthorityRequired: true, runtimeTarget: { kind: 'project', projectId: changed === 'runtime' ? 43 : 42 },
        } },
      }, { headers: { 'x-dsh-principal-id': changed === 'account' ? '8' : '7' } }))
      await reloaded.promise
      expect(connected).not.toHaveBeenCalled()
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
    } finally {
      loop?.stop()
      held.resolve(new Response('{}'))
      await mountedContexts.at(-1)?.fiber.dispose()
      fetch.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('ignores document input for a fixture carrier', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', search: '?fixture', origin: 'http://localhost:3080' })
    vi.stubGlobal('__DSH_DOCUMENT_IDENTITY__', { version: 'invalid-for-HTTP' })
    try {
      expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    } finally {
      await mountedContexts.at(-1)?.fiber.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { kind: 'personal' as const },
    { kind: 'project' as const, projectId: 42 },
  ])('opens pinned startup sockets before describe without publishing early for $kind', async (runtimeTarget) => {
    vi.stubGlobal('location', { hostname: 'harness.example', search: '', origin: 'https://harness.example' })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('__DSH_DOCUMENT_IDENTITY__', { version: 1, principalId: 7, runtimeTarget })
    FakeWebSocket.autoOpen = false
    const held = deferred<Response>()
    const requested = deferred<RequestInit | undefined>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requested.resolve(init)
      return held.promise
    })
    let loop: ReturnType<ConnectionHandle['start']> | undefined
    try {
      const handle = await mount()
      const order: string[] = []
      const connected = deferred<undefined>()
      loop = handle.start({
        onConnected: () => { order.push('connected'); connected.resolve(undefined) },
        onHostEnvelope: () => { order.push('host-frame') },
      })
      const init = await requested.promise
      await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
      const pinned = runtimeTarget.kind === 'personal' ? 'personal' : 'project:42'
      for (const socket of sockets) {
        const url = new URL(socket.url)
        expect(url.searchParams.get('dshTarget')).toBe(pinned)
        expect(url.searchParams.get('dshPrincipal')).toBe('7')
        socket.readyState = FakeWebSocket.OPEN
        socket.dispatchEvent(new Event('open'))
      }
      expect(new Headers(init?.headers).get('x-dsh-expected-principal-id')).toBe('7')
      const input = fetch.mock.calls[0]![0]
      const descriptionUrl = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      expect(descriptionUrl.searchParams.get('dshTarget')).toBe(pinned)
      sockets.find(socket => new URL(socket.url).pathname.endsWith('events.host'))!.receive(JSON.stringify({
        type: 'server-request', rpcId: 'early-host', method: 'host/remote-event',
        payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
      }))
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(order).toEqual([])
      held.resolve(Response.json({
        type: 'server-response', rpcId: (JSON.parse(init?.body as string) as { rpcId: string }).rpcId,
        result: { ok: true, value: {
          version: 'test', cwd: '/fixture', home: '/fixture', attachedSessions: 0, canOpenPath: false,
          executionAuthorityRequired: true, runtimeTarget,
        } },
      }, { headers: { 'x-dsh-principal-id': '7' } }))
      await connected.promise
      await vi.waitFor(() => { expect(order).toEqual(['connected', 'host-frame']) })
    } finally {
      loop?.stop()
      held.resolve(new Response('{}'))
      await mountedContexts.at(-1)?.fiber.dispose()
      fetch.mockRestore()
      vi.unstubAllGlobals()
    }
  })
  it('advertises document identity cleanup only when the browser account fence owns the connection', async () => {
    ;(globalThis as Win).location = { hostname: 'gateway.example', search: '', origin: 'https://gateway.example' }
    expect((await mount()).onPrincipalChange).toBeTypeOf('function')
    ;(globalThis as Win).location = { hostname: 'gateway.example', search: '?fixture', origin: 'https://gateway.example' }
    expect((await mount()).onPrincipalChange).toBeUndefined()
  })

  it('rejects an invalid browser unary deadline before creating its API carrier', () => {
    const ctx = new Context()
    mountedContexts.push(ctx)
    expect(() => { installConnection(ctx, { rpcTimeoutMs: 0 }) }).toThrow('rpcTimeoutMs')
  })

  it.each([false, true])('applies a configured unary deadline to the browser carrier (pooled: %s)', async (pooled) => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => {
        const reason: unknown = requestSignal?.reason
        reject(reason instanceof Error ? reason : new Error('request aborted', { cause: reason }))
      }, { once: true })
    }))
    const ctx = new Context()
    mountedContexts.push(ctx)
    try {
      installConnection(ctx, { rpcTimeoutMs: 120_000 })
      const handle = ctx.get('connection') as ConnectionHandle
      const selected = pooled ? handle.forTarget!({ kind: 'project', projectId: 7 }) : handle
      const pending = selected.api.host.describe({}).then(
        () => ({ kind: 'resolved' }), (error: unknown) => ({ kind: 'rejected', error }),
      )
      await vi.advanceTimersByTimeAsync(31_000)
      expect(requestSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(89_000)
      expect(requestSignal?.aborted).toBe(true)
      expect(await pending).toMatchObject({ kind: 'rejected', error: { name: 'TimeoutError' } })
    } finally {
      fetch.mockRestore()
      vi.useRealTimers()
    }
  })

  it('mounts ctx.connection with the real client when no ?fixture switch is present', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('selects the fixture client under ?fixture (and with no location at all stays real)', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    delete (globalThis as Win).location
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the streams', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const descriptions: Array<boolean | undefined> = []
    const stopThrowing = handle.hostDescription.subscribe(() => { throw new Error('subscriber bug') })
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    // config omitted: the `config ?? {}` default arm is part of the surface.
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(descriptions).toEqual([true, undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopDescription()
    errorSpy.mockRestore()
  })

  it('does not announce a generation synchronously stopped by a description subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawDescription = false
    const stopDescription = handle.hostDescription.subscribe(() => {
      if (handle.hostDescription.getSnapshot() === undefined) return
      sawDescription = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawDescription).toBe(true) })
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopDescription()
      loop.stop()
    }
  })

  it('retracts the host description while reconnecting and republishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const descriptions: Array<boolean | undefined> = []
    const reconnectSnapshots: Array<boolean | undefined> = []
    const preparationSnapshots: unknown[] = []
    const order: string[] = []
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
      order.push(`description:${String(handle.hostDescription.getSnapshot()?.canOpenPath)}`)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onBeforeConnected: () => {
        preparationSnapshots.push([handle.state.getSnapshot(), handle.hostDescription.getSnapshot()])
        order.push('before-connected')
      },
      onConnected: () => { order.push('connected') },
      onStateChange: (state) => {
        order.push(`state:${state}`)
        if (state === 'reconnecting') {
          reconnectSnapshots.push(handle.hostDescription.getSnapshot()?.canOpenPath)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, streamOpenTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      })
      const timing = (globalThis as Record<string, unknown>).__fxTiming as
        | { breakStreams(): void }
        | undefined
      if (timing === undefined) throw new Error('fixture timing hooks missing')
      timing.breakStreams()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(descriptions).toEqual([true, undefined, true]) })
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      expect(preparationSnapshots).toEqual([[undefined, undefined], ['reconnecting', undefined]])
      expect(order).toEqual([
        'before-connected', 'state:connected', 'description:true', 'connected',
        'description:undefined', 'state:reconnecting',
        'before-connected', 'state:connected', 'description:true', 'connected',
      ])
    } finally {
      stopDescription()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('WebApiClient keeps unary calls and respond on globalThis.fetch', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => undefined)
      await handle.api.respond({
        type: 'client-response',
        rpcId: RpcId('response-over-http'),
        result: { ok: true, value: {} },
      }).catch(() => undefined)
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/host.describe'))).toBe(true)
    expect(seen.some(u => u.includes('/api/respond'))).toBe(true)
  })

  it('creates a target transport that carries the selected project on HTTP and WebSocket requests', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const handle = await mount()
    handle.confirmPrincipal?.(7)
    handle.setBaseTarget?.({ kind: 'personal' })
    const target = handle.forTarget?.({ kind: 'project', projectId: 42 })
    expect(target).toBeDefined()
    const seen: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      await target!.api.host.describe({}).catch(() => undefined)
      const abort = new AbortController()
      const iterator = target!.api.events.mux({}, abort.signal)[Symbol.asyncIterator]()
      const pending = iterator.next()
      await vi.waitFor(() => { expect(sockets.at(-1)?.url).toContain('dshTarget=project%3A42') })
      abort.abort()
      await pending
    } finally {
      globalThis.fetch = original
    }
    expect(seen[0]).toContain('dshTarget=project%3A42')
  })

  it('opens one WebSocket per downlink, parses frames, and aborts both without using fetch', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch')
    const handle = await mount()
    handle.confirmPrincipal?.(7)
    handle.setBaseTarget?.({ kind: 'personal' })
    const client = handle.api as WebApiClient
    const envelopes: RpcMessage[][] = []
    client.subscribeEnvelopes((batch) => { envelopes.push([...batch]) })
    const opened: string[] = []
    const muxAbort = new AbortController()
    const hostAbort = new AbortController()
    const mux = client.events.mux({}, muxAbort.signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
    const host = client.events.host({}, hostAbort.signal, () => { opened.push('host') })[Symbol.asyncIterator]()
    const muxFrame = mux.next()
    const hostFrame = host.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    expect(sockets.map(socket => socket.url)).toEqual([
      'ws://localhost:3080/api/events.mux?interactions=answer&dshTarget=personal&dshPrincipal=7',
      'ws://localhost:3080/api/events.host?interactions=answer&dshTarget=personal&dshPrincipal=7',
    ])
    await vi.waitFor(() => { expect(opened).toEqual(['mux', 'host']) })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    sockets[0]!.receive(new Uint8Array([1, 2, 3]))
    sockets[1]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'bad', method: 'host/session-status', payload: {} }))
    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-browser',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-browser', lastSeq: 8 },
    }))
    sockets[1]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'host-browser',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    }))
    expect(await muxFrame).toMatchObject({
      value: { rpcId: 'mux-browser', payload: { type: 'session/subscribed', lastSeq: 8 } },
    })
    expect(await hostFrame).toMatchObject({
      value: { rpcId: 'host-browser', payload: { type: 'host/remote-event', event: 'commands/change' } },
    })
    expect(errors).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => { expect(envelopes.flat()).toHaveLength(2) })
    expect(fetch).not.toHaveBeenCalled()

    const muxEnd = mux.next()
    const hostEnd = host.next()
    muxAbort.abort()
    hostAbort.abort()
    await expect(muxEnd).resolves.toMatchObject({ done: true })
    await expect(hostEnd).resolves.toMatchObject({ done: true })
    expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
    errors.mockRestore()
    fetch.mockRestore()
  })

  it('closes a stalled downlink when its retained burst exceeds the queue budget', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api as WebApiClient
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(sockets[0]?.readyState).toBe(FakeWebSocket.OPEN) })
    const frame = JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-burst',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'stalled', lastSeq: 0 },
    })
    sockets[0]!.receive(frame)
    await expect(first).resolves.toMatchObject({ value: { payload: { type: 'session/subscribed' } } })
    for (let index = 0; index < 1_100; index += 1) sockets[0]!.receive(frame)
    await expect(iterator.next()).rejects.toMatchObject({ kind: 'queue-overflow' })
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('downlink queue exceeded'))
    abort.abort()
    errors.mockRestore()
  })

  it('maps an HTTPS page origin to a secure WebSocket URL', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const handle = await mount()
    handle.confirmPrincipal?.(7)
    handle.setBaseTarget?.({ kind: 'personal' })
    const client = handle.api
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets[0]?.url).toBe('wss://harness.example/api/events.mux?interactions=answer&dshTarget=personal&dshPrincipal=7') })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('does not allocate a WebSocket when its signal was already aborted', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api
    const abort = new AbortController()
    abort.abort()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(sockets).toHaveLength(0)
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://dsh.internal/api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        new URL('https://harness.example/api/goals/create'),
        expect.objectContaining({ signal: abort.signal }),
      )

      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', {
        status: 200,
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow(/API response exceeds/u)

      ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/api/goals/create'))
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal')
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('carries Goal Remotes over the same state as the client-only fixture API', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const created = await handle.rpc.call('/api', 'goals/create', {
      args: { agentId: 'fx-alpha', request: { objective: 'fixture remote' } },
    })
    expect(created).toMatchObject({ ok: true, value: { ref: { revision: 1 } } })
    if (!created.ok) throw new Error('fixture Goal create failed')
    const ref = (created.value as { ref: { id: string; revision: number } }).ref
    const edited = await handle.rpc.call('/api', 'goals/edit', {
      args: { agentId: 'fx-alpha', ref, request: { objective: 'edited fixture remote' } },
    })
    expect(edited).toMatchObject({ ok: true, value: { objective: 'edited fixture remote', revision: 2 } })
    const editedRef = { id: ref.id, revision: 2 }
    const paused = await handle.rpc.call('/api', 'goals/pause', {
      args: { agentId: 'fx-alpha', ref: editedRef },
    })
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', activation: 'disarmed', revision: 3 } })
    const resumed = await handle.rpc.call('/api', 'goals/resume', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 3 } },
    })
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active', activation: 'armed', revision: 4 } })
    const completed = await handle.rpc.call('/api', 'goals/complete', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 4 } },
    })
    expect(completed).toMatchObject({ ok: true, value: { phase: 'complete', activation: 'disarmed', revision: 5 } })
    await expect(handle.rpc.call('/api', 'goals/clear', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 5 } },
    })).resolves.toEqual({ ok: true, value: { id: ref.id, revision: 6 } })
    await expect(handle.rpc.call('/other', 'goals/create', {})).rejects.toThrow(/channel.*unavailable/)
    await expect(handle.rpc.call('/api', 'unknown/read', { args: { agentId: 'fx-alpha' } }))
      .rejects.toThrow(/endpoint.*unavailable/)
  })

  it('keeps the target handle across view closure and isolates the next stream owner', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const handle = await mount()
    const remoteSession = vi.fn(() => 's1' as SessionId)
    const release = handle.registerSessionTargetResolver!(id => id === 's1'
      ? { kind: 'project', projectId: 7 }
      : undefined, remoteSession)
    try {
      const pooled = handle.forTarget!({ kind: 'project', projectId: 7 })
      expect(handle.forSession!('s1' as SessionId)).toBe(pooled)
      expect(handle.forSession!('s1' as SessionId)).toBe(pooled)
      // Unowned sessions and the personal target resolve to the base connection.
      expect(handle.forSession!('other' as SessionId)).toBe(handle)
      expect(handle.forTarget!({ kind: 'personal' })).toBe(handle)
      // A derived handle resolves sessions through the shared resolver.
      expect(pooled.forSession!('s1' as SessionId)).toBe(pooled)
      expect(pooled.forSession!('other' as SessionId)).toBe(handle)
      expect(pooled.sessionForRemote!('feedback/record', { request: { sessionId: 's1' } })).toBe('s1')
      expect(remoteSession).toHaveBeenCalledWith('feedback/record', { request: { sessionId: 's1' } })

      const original = globalThis.fetch
      globalThis.fetch = (input: URL | RequestInfo, init?: RequestInit) => {
        void input
        const request = JSON.parse(init?.body as string) as { rpcId: string }
        return Promise.resolve(Response.json({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value: {
            version: '0.0.0-test', cwd: '/tmp', attachedSessions: 0, home: '/tmp', canOpenPath: false,
          } },
        }))
      }
      try {
        const loop = pooled.start({})
        await vi.waitFor(() => { expect(pooled.state.getSnapshot()).toBe('connected') })
        expect(pooled.hostDescription.getSnapshot()?.version).toBe('0.0.0-test')
        // The session-addressed lookup keeps returning the live started handle.
        expect(handle.forSession!('s1' as SessionId)).toBe(pooled)
        loop.stop()
        expect(pooled.state.getSnapshot()).toBeUndefined()
        expect(pooled.hostDescription.getSnapshot()).toBeUndefined()
        expect(handle.forSession!('s1' as SessionId)).toBe(pooled)
        expect(handle.forSession!('s1' as SessionId).state.getSnapshot()).toBeUndefined()
        const next = pooled.start({})
        try {
          await vi.waitFor(() => { expect(pooled.state.getSnapshot()).toBe('connected') })
          loop.stop()
          expect(pooled.state.getSnapshot()).toBe('connected')
          expect(handle.forSession!('s1' as SessionId)).toBe(pooled)
        } finally { next.stop() }
      } finally {
        globalThis.fetch = original
      }
    } finally {
      release()
    }
  })
})

it('opens an explicit personal carrier when the bootstrap connection belongs to a project', async () => {
  ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
  const handle = await mount()
  handle.setBaseTarget!({ kind: 'project', projectId: 7 })
  expect(handle.forTarget!({ kind: 'project', projectId: 7 })).toBe(handle)
  const personal = handle.forTarget!({ kind: 'personal' })
  expect(personal).not.toBe(handle)
  expect(handle.forTarget!({ kind: 'personal' })).toBe(personal)
  expect(personal.forTarget!({ kind: 'project', projectId: 7 })).toBe(handle)
  const oldFetch = globalThis.fetch
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {
      version: '0', cwd: '/personal', home: '/home', attachedSessions: 0, canOpenPath: false, runtimeTarget: { kind: 'personal' },
    } } })
  })
  globalThis.fetch = fetcher
  try {
    await personal.api.host.describe({})
    const input = fetcher.mock.calls[0]?.[0]
    if (input === undefined) throw new Error('Personal runtime was not requested')
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.searchParams.get('dshTarget')).toBe('personal')
  } finally { globalThis.fetch = oldFetch }
})
