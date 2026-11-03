import { createServer, type IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { httpFetch } from './api-fetch.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import open from 'open'
import WebSocket, { type RawData } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name, startInspector, InspectorStartupCleanupError } from '../src/index.ts'
import { isPlainObject } from '../src/shared/json.ts'
import { INSPECTOR_BOOTSTRAP_PATH } from '../src/shared/web.ts'
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { ResourceLease, ResourceRequest } from '@deepseek-ai/dsh-resource-budget'

vi.mock('open', () => ({ default: vi.fn(async () => undefined), apps: { chrome: 'chrome' } }))

interface CdpResponse {
  readonly id: number
  readonly result?: Record<string, unknown>
}

describe('experimental Inspector Host plugin', () => {
  let context: Context | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each([
    { change: 'replaced', failedCompletion: false }, { change: 'withdrawn', failedCompletion: false },
    { change: 'replaced', failedCompletion: true },
  ] as const)('refuses an Inspector provider $change while waiting with failed completion=$failedCompletion', async ({ change, failedCompletion }) => {
    context = new Context()
    const releaseRoute = vi.fn()
    const routes: Pick<WebServer, 'register' | 'registerUpgrade'> = {
      register: () => releaseRoute, registerUpgrade: () => releaseRoute,
    }
    context.provide('webServer', routes as WebServer)
    new HostConnectionService(context, [], {} as BrowserAuth)
    const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    if (failedCompletion) release.mockRejectedValueOnce(new Error('Original resource accountant unavailable'))
    const budget = { async acquire() {
      entered.resolve(undefined); await grant.promise
      return { signal: new AbortController().signal, release, uncertain }
    } }
    const replacement = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
    const withdraw = context.provide('resourceBudget', budget)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fiber = context.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    const observed = fiber.await().then(() => ({ ready: true }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      withdraw()
      if (change === 'replaced') context.provide('resourceBudget', { acquire: replacement })
      grant.resolve(undefined)
      const outcome = await observed
      if (failedCompletion) {
        if (!('error' in outcome) || !(outcome.error instanceof InspectorStartupCleanupError)) throw new Error('Startup cleanup was not retained')
        expect(outcome.error.cause).toMatchObject({ errors: [expect.objectContaining({ reason: 'unavailable' }), expect.any(Error)] })
      } else expect(outcome).toMatchObject({ error: { reason: 'unavailable' } })
      expect(context.get('inspector')).toBeUndefined()
      expect(release).toHaveBeenCalledTimes(failedCompletion ? 2 : 1)
      expect(uncertain).not.toHaveBeenCalled()
      expect(replacement).not.toHaveBeenCalled()
    } finally { grant.resolve(undefined); await observed; await fiber.dispose(); log.mockRestore() }
  })

  it('retains a live resource Service through unrelated plugin activity while startup is queued', async () => {
    context = new Context()
    const releaseRoute = vi.fn(), grant = Promise.withResolvers<ResourceLease>(), requested = Promise.withResolvers<ResourceRequest>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    context.provide('webServer', {
      register: () => releaseRoute, registerUpgrade: () => releaseRoute,
    } as Pick<WebServer, 'register' | 'registerUpgrade'> as WebServer)
    new HostConnectionService(context, [], {} as BrowserAuth)
    class Budget extends ResourceBudget {
      async acquire(request: ResourceRequest): Promise<ResourceLease> { requested.resolve(request); return grant.promise }
    }
    await context.plugin(Budget)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fiber = context.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    const startup = fiber.await()
    try {
      const request = await requested.promise
      const unrelated = context.plugin(() => {})
      await unrelated.await()
      await unrelated.dispose()
      expect(request.signal?.aborted).toBe(false)
      grant.resolve({ signal: new AbortController().signal, release, uncertain })
      await startup
      expect(context.get('inspector')).toBeDefined()
      expect(release).not.toHaveBeenCalled()
      await fiber.dispose()
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally {
      grant.resolve({ signal: new AbortController().signal, release, uncertain })
      await startup
      await fiber.dispose()
    }
  })

  it('cancels queued infrastructure admission before unloading its startup context', async ({ signal }) => {
    context = new Context()
    const releaseRoute = vi.fn()
    const routes: Pick<WebServer, 'register' | 'registerUpgrade'> = {
      register: () => releaseRoute, registerUpgrade: () => releaseRoute,
    }
    context.provide('webServer', routes as WebServer)
    new HostConnectionService(context, [], {} as BrowserAuth)
    const requested = Promise.withResolvers<ResourceRequest>(), grant = Promise.withResolvers<ResourceLease>()
    const canceled = () => { grant.reject(signal.reason) }
    signal.addEventListener('abort', canceled, { once: true })
    const acquire = vi.fn((request: ResourceRequest) => {
      requested.resolve(request)
      request.signal?.addEventListener('abort', () => { grant.reject(request.signal?.reason) }, { once: true })
      return grant.promise
    })
    context.provide('resourceBudgetRequired', true)
    new class extends ResourceBudget { acquire = acquire }(context)
    const fiber = context.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    const startup = fiber.await().catch((error: unknown) => error)
    let disposal: Promise<void> | undefined
    try {
      const request = await requested.promise
      expect(request).toMatchObject({ kind: 'process', origin: 'infrastructure' })
      disposal = fiber.dispose()
      await disposal
      expect(request.signal?.aborted).toBe(true)
      await startup
      expect(context.get('inspector')).toBeUndefined()
    } finally {
      signal.removeEventListener('abort', canceled)
      grant.reject(new Error('fixture startup cleanup'))
      await disposal
      await startup
    }
  })

  it('starts the Worker, provides ctx.inspector, injects Client bootstrap, and disposes', async () => {
    context = new Context()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const releaseRoute = vi.fn()
    const registerRoute = vi.fn(() => releaseRoute)
    const releaseUpgrade = vi.fn()
    const registerUpgrade = vi.fn<(_route: WebUpgradeRoute) => () => void>(() => releaseUpgrade)
    const routes: Pick<WebServer, 'register' | 'registerUpgrade'> = { register: registerRoute, registerUpgrade }
    let authenticated = false
    const auth: Pick<BrowserAuth, 'isAuthenticated' | 'operatorInteractions'> = {
      isAuthenticated: () => authenticated,
      operatorInteractions: () => undefined,
    }
    context.provide('webServer', routes as WebServer)
    const connection = new HostConnectionService(context, [], auth as BrowserAuth)
    const fiber = context.plugin(
      { name, inject: [...inject], Config, apply },
      { port: 0, captureFetch: false },
    )
    await fiber.await()

    const rows: IndexInjection[] = []
    context.emit('webserver/index-inject', rows)
    const bootstrap = rows.find(row => row.kind === 'global' && row.name === '__DSH_INSPECTOR__')
    expect(bootstrap).toMatchObject({ kind: 'global', name: '__DSH_INSPECTOR__' })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^dsh inspector: devtools:\/\//u))
    expect(context.inspector).toBeDefined()
    expect(registerRoute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prefix', path: '/inspector/devtools' }))
    expect(registerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ path: '/inspector/devtools/cdp' }))
    const upgrade = registerUpgrade.mock.calls[0]![0]
    for (const [origin, status] of [['http://127.0.0.1', 401], ['http://untrusted.invalid', 403]] as const) {
      const socket = new PassThrough()
      await upgrade.handler({ headers: { host: '127.0.0.1', origin } } as IncomingMessage, socket, Buffer.alloc(0))
      expect(String(socket.read())).toContain(`HTTP/1.1 ${status}`)
      socket.destroy()
    }
    authenticated = true
    for (const query of ['clientSourceId=', 'clientSourceId=a&clientSourceId=b',
      'sourceScope=client', 'sourceScope=host&sourceScope=host', 'sourceScope=host&clientSourceId=a']) {
      const socket = new PassThrough()
      await upgrade.handler({ url: `/inspector/devtools/cdp?${query}`, headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' } } as IncomingMessage, socket, Buffer.alloc(0))
      expect(String(socket.read())).toContain('HTTP/1.1 400')
      socket.destroy()
    }
    await vi.waitFor(async () => {
      const tree = await context!.inspector.cordis.getTree()
      expect(tree.host?.source.kind).toBe('host')
    })
    expect(() => { context!.inspector.publish('', {}) }).toThrow('topic must contain 1 to 128 characters')
    expect(() => { context!.inspector.publish('host/invalid-time', {}, Number.NaN) }).toThrow('monotonicMs must be finite')
    context.inspector.publish('host/plugin-probe', { ready: true })

    const value = bootstrap?.kind === 'global' ? bootstrap.value : undefined
    const fetched = await httpFetch(connection, new Request(`http://localhost${INSPECTOR_BOOTSTRAP_PATH}`))
    expect(fetched.headers.get('cache-control')).toBe('no-store')
    expect(await fetched.json()).toEqual(value)
    expect(open).not.toHaveBeenCalled()
    const endpoint = value as { endpoint: string; protocol: string }
    const authority = new URL(endpoint.endpoint)
    const targets: unknown = await fetch(`http://${authority.host}/json`).then(response => response.json())
    if (!Array.isArray(targets) || !isPlainObject(targets[0]) || typeof targets[0].webSocketDebuggerUrl !== 'string') {
      throw new Error('Inspector discovery did not return a target')
    }
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    const response = new Promise<CdpResponse>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(rawText(data)) as CdpResponse
        if (message.id === 1) resolve(message)
      })
    })
    socket.send(JSON.stringify({ id: 1, method: 'DSHInspector.getSources' }))
    await vi.waitFor(async () => {
      const sources = (await response).result?.sources as Array<{ topics: Record<string, number> }>
      expect(sources.some(source => source.topics['host/plugin-probe'] === 1)).toBe(true)
    })
    socket.close()
    await new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })

    await fiber.dispose()
    expect(releaseRoute).toHaveBeenCalledOnce()
    expect(releaseUpgrade).toHaveBeenCalledOnce()
    expect(rows).toHaveLength(1)
    const afterDispose: IndexInjection[] = []
    context.emit('webserver/index-inject', afterDispose)
    expect(afterDispose).toEqual([])
    expect((await httpFetch(connection, new Request(`http://localhost${INSPECTOR_BOOTSTRAP_PATH}`))).status).toBe(404)
  })

  it('closes the started Worker when a later plugin registration fails', async () => {
    const port = await availablePort()
    context = new Context()
    const routes: Pick<WebServer, 'register' | 'registerUpgrade'> = { register: () => () => {}, registerUpgrade: () => () => {} }
    context.provide('webServer', routes as WebServer)
    new HostConnectionService(context, [], {} as BrowserAuth)
    context.provide('inspector', {
      publish: () => undefined,
      cordis: { getTree: () => Promise.reject(new Error('unused test service')) },
    })

    const fiber = context.plugin(
      { name, inject: [...inject], Config, apply },
      { port, captureFetch: false },
    )
    await expect(fiber.await()).rejects.toThrow('service "inspector" has been registered')

    const replacement = await startInspector({ port, captureFetch: false })
    expect(new URL(replacement.endpoint.httpUrl).port).toBe(String(port))
    await replacement.close()
  })

  it('keeps inspection available when --inspect cannot open Chrome', async () => {
    context = new Context()
    const routes: Pick<WebServer, 'register' | 'registerUpgrade'> = { register: () => () => {}, registerUpgrade: () => () => {} }
    context.provide('webServer', routes as WebServer)
    context.provide('cmdlineArgs', { get: () => ['--inspect'] })
    const connection = new HostConnectionService(context, [], {} as BrowserAuth)
    vi.mocked(open).mockRejectedValueOnce(new Error('Chrome unavailable'))
    const fiber = context.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    await fiber.await()
    expect(context.get('inspector')).toBeDefined()
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^devtools:\/\//u), {
      app: { name: 'chrome' }, wait: false,
    })
    const response = await httpFetch(connection, new Request(`http://localhost${INSPECTOR_BOOTSTRAP_PATH}`))
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('endpoint', expect.stringContaining('/ingest'))
  })

  it('closes the Worker when fetch capture installation fails', async () => {
    const port = await availablePort()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
    const nativeFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => nativeFetch,
    })
    try {
      await expect(startInspector({ port })).rejects.toThrow('globalThis.fetch is an accessor')
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
      else Object.defineProperty(globalThis, 'fetch', descriptor)
    }

    const replacement = await startInspector({ port, captureFetch: false })
    expect(new URL(replacement.endpoint.httpUrl).port).toBe(String(port))
    await replacement.close()
  })
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return port
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
