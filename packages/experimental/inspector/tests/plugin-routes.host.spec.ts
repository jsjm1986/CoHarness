/** Host DevTools frontend and CDP upgrade routes registered by the Inspector plugin. */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import type { IndexInjection, WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import ExecutionAuthority from '@deepseek-ai/dsh-execution-authority'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name, InspectorStartupCleanupError } from '../src/index.ts'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { InspectorClientFixture } from './fixtures/client-source.host.ts'
import { httpFetch } from './api-fetch.ts'

type AssetMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void

const assets = vi.hoisted(() => ({
  options: undefined as { setHeaders?: (res: ServerResponse) => void } | undefined,
  middleware: vi.fn<AssetMiddleware>(),
}))

vi.mock('serve-static', () => ({
  default: (_root: string, options: { setHeaders?: (res: ServerResponse) => void }) => {
    assets.options = options
    return assets.middleware
  },
}))

vi.mock('../src/host/bridge/controller.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/bridge/controller.ts')>()
  return { ...actual, startInspector: vi.fn(actual.startInspector) }
})

interface RecordedResponse {
  status?: number
  headers: Record<string, string>
  ended: boolean
  destroyed: boolean
}

describe('experimental Inspector Host DevTools routes', () => {
  let context: Context | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    assets.middleware.mockReset()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  async function mount(options: { indexAllowed?: () => boolean; isolate?: boolean; before?: (ctx: Context, realm: Context) => void } = {}) {
    context = new Context()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const webServer: Pick<WebServer, 'register' | 'registerUpgrade'> = {
      register: (route) => { routes.push(route); return () => {} },
      registerUpgrade: (route) => { upgrades.push(route); return () => {} },
    }
    context.provide('webServer', webServer as WebServer)
    const auth: Pick<BrowserAuth, 'isAuthenticated' | 'operatorInteractions' | 'authorizeIndex'> = {
      isAuthenticated: () => true,
      operatorInteractions: () => undefined,
      authorizeIndex: (_request, response) => {
        if (options.indexAllowed?.() !== false) return true
        response.writeHead(401)
        response.end()
        return false
      },
    }
    new HostConnectionService(context, [], auth as BrowserAuth)
    const messages: Message[] = []
    context.logger.exporter({ levels: { default: 3 }, export: (message) => { messages.push(message) } })
    const realm = options.isolate ? context.isolate('executionAuthority').isolate('executionAuthorityRequired') : context
    options.before?.(context, realm)
    const fiber = realm.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    return { fiber, routes, upgrades, messages }
  }

  it.each(['required', 'provider'] as const)('refuses Host debugging before allocation with %s execution authority', async (control) => {
    const { fiber, routes, upgrades } = await mount({ before: (ctx) => {
      if (control === 'required') ctx.provide('executionAuthorityRequired', true)
      else new FixtureAuthority(ctx)
    } })
    const outcome = await fiber.await().then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(outcome).toContain('Inspector requires an independent local runtime')
    expect(startInspector).not.toHaveBeenCalled()
    expect(context!.get('inspector')).toBeUndefined()
    expect(routes).toEqual([])
    expect(upgrades).toEqual([])
  })

  it.each(['required', 'provider'] as const)('cannot hide root %s authority in an isolated Inspector realm', async (control) => {
    const { fiber } = await mount({ isolate: true, before: (ctx) => {
      if (control === 'required') ctx.provide('executionAuthorityRequired', true)
      else new FixtureAuthority(ctx)
    } })
    const outcome = await fiber.await().then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(outcome).toContain('Inspector requires an independent local runtime')
    expect(startInspector).not.toHaveBeenCalled()
  })

  it.each(['required', 'provider'] as const)('refuses %s authority confined to its own Inspector realm', async (control) => {
    const { fiber } = await mount({ isolate: true, before: (_ctx, realm) => {
      if (control === 'required') realm.provide('executionAuthorityRequired', true)
      else new FixtureAuthority(realm)
    } })
    const outcome = await fiber.await().then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(outcome).toContain('Inspector requires an independent local runtime')
    expect(startInspector).not.toHaveBeenCalled()
  })

  it.each([
    { control: 'required', isolated: false }, { control: 'provider', isolated: false },
    { control: 'required', isolated: true }, { control: 'provider', isolated: true },
  ])('returns an unused startup grant when $control authority appears while queued with isolation=$isolated', async ({ control, isolated }) => {
    const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    const { fiber } = await mount({ isolate: isolated, before: (ctx) => {
      ctx.provide('resourceBudget', { async acquire() {
        entered.resolve(undefined); await grant.promise
        return { signal: new AbortController().signal, release, uncertain }
      } })
    } })
    const ready = fiber.await()
    void ready.catch(() => {})
    try {
      await entered.promise
      if (control === 'required') context!.provide('executionAuthorityRequired', true)
      else new FixtureAuthority(context!)
      grant.resolve(undefined)
      const outcome = await ready.then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error))
      expect(outcome).toContain('Inspector requires an independent local runtime')
      expect(context!.get('inspector')).toBeUndefined()
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally { grant.resolve(undefined); await ready.catch(() => {}) }
  })

  it.each([
    { control: 'required', isolated: false }, { control: 'provider', isolated: false },
    { control: 'required', isolated: true }, { control: 'provider', isolated: true },
  ])('closes existing debugging and refuses a retained relay after $control authority appears with isolation=$isolated', async ({ control, isolated }) => {
    const { fiber, routes, upgrades } = await mount({ isolate: isolated })
    await fiber.await()
    const optional = context!.provide('executionAuthorityRequired', false)
    expect(context!.get('inspector')).toBeDefined()
    optional()
    const upgrade = upgrades.find(row => row.path === '/inspector/devtools/cdp')!
    const pair = await socketPair()
    const reply = readUpgrade(pair.client)
    await upgrade.handler(upgradeRequest(undefined, {}), pair.server,
      clientTextFrame(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '21*2' } })))
    expect((await reply).message).toHaveProperty('result.result.value', 42)
    if (control === 'required') context!.provide('executionAuthorityRequired', true)
    else new FixtureAuthority(context!)
    if (control === 'required') new FixtureAuthority(context!)
    else context!.provide('executionAuthorityRequired', true)
    const injected: IndexInjection[] = []
    context!.emit('webserver/index-inject', injected)
    expect(injected).toEqual([])
    let status: number | undefined
    const response = { writeHead(code: number) { status = code; return this }, end() { return this } }
    await routes.find(row => row.path === '/inspector/devtools')!.handler(
      upgradeRequest('/inspector/devtools/', {}), response as ServerResponse,
    )
    expect(status).toBe(403)
    await pair.closed
    await vi.waitFor(() => { expect(context!.get('inspector')).toBeUndefined() })
    const refused = await socketPair()
    await upgrade.handler(upgradeRequest(undefined, {}), refused.server, Buffer.alloc(0))
    await refused.closed
    expect(refused.received().toString()).toMatch(/^HTTP\/1\.1 403 /u)
  })

  it('retries unused-grant completion after authority cancels queued startup', async () => {
    const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Unused completion unavailable'))
    const uncertain = vi.fn(async () => {})
    const { fiber } = await mount({ before: (ctx) => {
      ctx.provide('resourceBudget', { async acquire() {
        entered.resolve(undefined); await grant.promise
        return { signal: new AbortController().signal, release, uncertain }
      } })
    } })
    const pending = fiber.await().then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      context!.provide('executionAuthorityRequired', true)
      grant.resolve(undefined)
      expect(await pending).toBeInstanceOf(InspectorStartupCleanupError)
      expect(release).toHaveBeenCalledTimes(2)
      expect(uncertain).not.toHaveBeenCalled()
      expect(context!.get('inspector')).toBeUndefined()
    } finally { grant.resolve(undefined); await pending }
  })

  it('rejects a ready Worker returned after the authority changed and closes its unpublished endpoint', async () => {
    const close = vi.fn(async () => {})
    vi.mocked(startInspector).mockImplementationOnce(async (options, admission) => {
      const actual = await vi.importActual<typeof import('../src/host/bridge/controller.ts')>('../src/host/bridge/controller.ts')
      const handle = await actual.startInspector(options, admission)
      close.mockImplementation(() => handle.close())
      context!.provide('executionAuthorityRequired', true)
      return { endpoint: handle.endpoint, source: handle.source, close }
    })
    const { fiber } = await mount()
    const outcome = await fiber.await().then(() => 'ready', (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(outcome).toContain('Inspector requires an independent local runtime')
    expect(context!.get('inspector')).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('blocks bootstrap during managed cleanup and retries failed accounting', async () => {
    const release = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Resource completion unavailable'))
    const { fiber, messages } = await mount({ before: (ctx) => {
      ctx.provide('resourceBudget', { async acquire() {
        return { signal: new AbortController().signal, release, uncertain: async () => {} }
      } })
    } })
    await fiber.await()
    context!.provide('executionAuthorityRequired', true)
    const response = await httpFetch(context!.get('connection') as HostConnectionService,
      new Request('http://localhost/api/experimental-inspector/bootstrap'))
    expect(response.status).toBe(403)
    await vi.waitFor(() => {
      expect(messages.some(message => message.args[0] === 'experimental-inspector: managed debugging cleanup failed')).toBe(true)
    })
    expect(release).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('answers frontend requests by method, index authorization, redirect, and asset outcome', async () => {
    let indexAllowed = true
    const { fiber, routes, messages } = await mount({ indexAllowed: () => indexAllowed })
    await fiber.await()
    const route = routes.find(row => row.path === '/inspector/devtools')
    if (route === undefined) throw new Error('DevTools route was not registered')
    const call = async (method: string | undefined, url: string | undefined, headersSent = false) => {
      const recorded: RecordedResponse = { headers: {}, ended: false, destroyed: false }
      const res = {
        get headersSent() { return headersSent },
        setHeader(key: string, value: string) { recorded.headers[key.toLowerCase()] = value },
        writeHead(status: number, headers: Record<string, string> = {}) {
          recorded.status = status
          for (const [key, value] of Object.entries(headers)) recorded.headers[key.toLowerCase()] = value
          return this
        },
        end() { recorded.ended = true; return this },
        destroy() { recorded.destroyed = true; return this },
      }
      const req = { method, url, headers: { host: '127.0.0.1' } }
      await route.handler(req as IncomingMessage, res as ServerResponse)
      return { recorded, req }
    }

    expect((await call('POST', '/inspector/devtools/devtools_app.html')).recorded).toMatchObject({ status: 405, headers: { allow: 'GET, HEAD' }, ended: true })
    indexAllowed = false
    expect((await call('GET', '/inspector/devtools/devtools_app.html')).recorded.status).toBe(401)
    indexAllowed = true
    expect(assets.middleware).not.toHaveBeenCalled()
    expect((await call('GET', '/inspector/devtools?panel=console')).recorded).toMatchObject({
      status: 302, headers: { location: 'devtools/devtools_app.html?panel=console' },
    })
    expect((await call('HEAD', '/inspector/devtools/')).recorded).toMatchObject({ status: 302, headers: { location: 'devtools_app.html' } })

    assets.middleware.mockImplementationOnce((_req, res) => {
      assets.options?.setHeaders?.(res)
      res.writeHead(200).end()
    })
    const served = await call('GET', '/inspector/devtools/devtools_app.html?ws=1')
    expect(served.req.url).toBe('/devtools_app.html?ws=1')
    expect(served.recorded).toMatchObject({ status: 200, headers: { 'x-content-type-options': 'nosniff' } })

    assets.middleware.mockImplementationOnce((_req, _res, next) => { next() })
    const missing = await call('GET', undefined)
    expect(missing.req.url).toBe('')
    expect(missing.recorded).toMatchObject({ status: 404, ended: true })

    const failure = new Error('fixture asset read failed')
    assets.middleware.mockImplementation((_req, _res, next) => { next(failure) })
    expect((await call(undefined, '/inspector/devtools/main.js')).recorded).toMatchObject({ status: 405 })
    expect((await call('GET', '/inspector/devtools/main.js')).recorded).toMatchObject({ status: 500, ended: true, destroyed: false })
    const streaming = (await call('GET', '/inspector/devtools/main.js', true)).recorded
    expect(streaming.status).toBeUndefined()
    expect(streaming.destroyed).toBe(true)
    expect(messages.filter(message => message.args[0] === 'experimental-inspector: frontend asset request failed')
      .map((message): unknown => message.args[1])).toEqual([failure, failure])
  })

  it('proxies authenticated CDP upgrades with their WebSocket headers and early bytes to the Worker', async () => {
    const { fiber, upgrades } = await mount()
    await fiber.await()
    const upgrade = upgrades.find(row => row.path === '/inspector/devtools/cdp')
    if (upgrade === undefined) throw new Error('CDP upgrade route was not registered')

    const selected = await socketPair()
    const reply = readUpgrade(selected.client)
    await upgrade.handler(upgradeRequest('/inspector/devtools/cdp?clientSourceId=client-fixture', {
      'sec-websocket-protocol': ['dsh-fixture', 'dsh-other'],
      'sec-websocket-extensions': undefined,
      'user-agent': 'fixture',
    }), selected.server, clientTextFrame(JSON.stringify({ id: 1, method: 'DSHInspector.getSources' })))
    const answered = await reply
    expect(answered.status).toMatch(/^HTTP\/1\.1 101 /u)
    expect(answered.headers.toLowerCase()).toContain('sec-websocket-protocol: dsh-fixture')
    expect(answered.message.id).toBe(1)
    expect(answered.message.result).toHaveProperty('sources')

    const unselected = await socketPair()
    const later = readUpgrade(unselected.client)
    await upgrade.handler(upgradeRequest(undefined, {}), unselected.server, Buffer.alloc(0))
    await vi.waitFor(() => { expect(unselected.received().toString('latin1')).toMatch(/^HTTP\/1\.1 101 /u) })
    unselected.client.write(clientTextFrame(JSON.stringify({ id: 1, method: 'DSHInspector.getSources' })))
    expect((await later).message).toMatchObject({ id: 1 })

    const reset = await socketPair()
    await upgrade.handler(upgradeRequest(undefined, {}), reset.server, Buffer.alloc(0))
    reset.server.destroy(new Error('fixture browser reset'))
    await reset.closed

    // Disposal releases every still-proxied socket before the Worker closes.
    await fiber.dispose()
    await Promise.all([selected.closed, unselected.closed])
  })

  it('closes the browser socket when the Worker endpoint refuses the proxied connection', async () => {
    const refused = await closedPort()
    vi.mocked(startInspector).mockImplementationOnce(async (options) => {
      const actual = await vi.importActual<typeof import('../src/host/bridge/controller.ts')>('../src/host/bridge/controller.ts')
      const handle = await actual.startInspector(options)
      return redirectedHandle(handle, `ws://127.0.0.1:${String(refused)}/devtools/page/refused`)
    })
    const { fiber, upgrades } = await mount()
    await fiber.await()
    const upgrade = upgrades.find(row => row.path === '/inspector/devtools/cdp')
    if (upgrade === undefined) throw new Error('CDP upgrade route was not registered')
    const pair = await socketPair()
    await upgrade.handler(upgradeRequest(undefined, {}), pair.server, Buffer.alloc(0))
    await pair.closed
    expect(pair.received().length).toBe(0)
  })

  it('preserves a Host-only scope through the authenticated relay while another Client is present', async () => {
    const { fiber, upgrades } = await mount()
    await fiber.await()
    const handle = await (vi.mocked(startInspector).mock.results[0]!.value as ReturnType<typeof startInspector>)
    const client = await InspectorClientFixture.start(handle.endpoint.client)
    try {
      await vi.waitFor(async () => { expect((await context!.inspector.cordis.getTree()).clients).toHaveLength(1) })
      const upgrade = upgrades.find(row => row.path === '/inspector/devtools/cdp')!
      const pair = await socketPair()
      const reply = readUpgrade(pair.client)
      await upgrade.handler(upgradeRequest('/inspector/devtools/cdp?sourceScope=host', {}), pair.server,
        clientTextFrame(JSON.stringify({ id: 1, method: 'DSHInspector.getSources' })))
      const answered = await reply
      const sources = answered.message.result as { sources: Array<{ kind: string }> }
      expect(answered.status).toMatch(/^HTTP\/1\.1 101 /u)
      expect(sources.sources.map(source => source.kind)).toEqual(['host'])
      await fiber.dispose()
      await pair.closed
    } finally { await client.close() }
  })

  it('logs a rollback failure and still rejects initialization with the registration error', async () => {
    const closeFailure = new Error('fixture Worker close failed')
    vi.mocked(startInspector).mockImplementationOnce(async (options) => {
      const actual = await vi.importActual<typeof import('../src/host/bridge/controller.ts')>('../src/host/bridge/controller.ts')
      const handle = await actual.startInspector(options)
      return { endpoint: handle.endpoint, source: handle.source, close: async () => { await handle.close(); throw closeFailure } }
    })
    const { fiber, messages } = await mount({
      before: (ctx) => {
        ctx.provide('inspector', {
          publish: () => undefined,
          cordis: { getTree: () => Promise.reject(new Error('unused test service')) },
        })
      },
    })
    await expect(fiber.await()).rejects.toThrow('service "inspector" has been registered')
    const rollback = messages.find(message => message.args[0] === 'experimental-inspector: initialization rollback failed')
    expect(rollback?.type).toBe('error')
    expect(rollback?.args[1]).toMatchObject({ errors: [closeFailure] })
  })
})

/** A mounted authority whose guarded runtime must never invoke debugging on its behalf. */
class FixtureAuthority extends ExecutionAuthority {
  stamp(): never { throw new Error('Fixture does not stamp messages') }
  answer(): never { throw new Error('Fixture does not answer questions') }
  runCaptured(): never { throw new Error('Fixture does not run captured work') }
  runRequest(): never { throw new Error('Fixture does not run requests') }
  capture(): never { throw new Error('Fixture does not capture execution') }
  current(): undefined { return undefined }
  captureSession(): never { throw new Error('Fixture does not capture Sessions') }
  inherit(): never { throw new Error('Fixture does not inherit execution') }
  relay(): never { throw new Error('Fixture does not relay execution') }
  authorize(): never { throw new Error('Fixture does not authorize debugging') }
  authorizeSelection(): never { throw new Error('Fixture does not select presets') }
}

function upgradeRequest(url: string | undefined, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return {
    url,
    headers: {
      host: '127.0.0.1', origin: 'http://127.0.0.1', connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13', ...headers,
    },
  } as IncomingMessage
}

/** Encode one masked client-to-server WebSocket text frame. */
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  if (payload.length >= 126) throw new Error('fixture frame must stay below 126 bytes')
  const mask = randomBytes(4)
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((byte, index) => byte ^ mask[index % 4]!)])
}

/** Read the upgrade response and the first server text frame that answers request id 1. */
async function readUpgrade(socket: Socket): Promise<{ status: string; headers: string; message: Record<string, unknown> }> {
  let buffer = Buffer.alloc(0)
  return new Promise((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.subarray(0, end).toString('latin1')
      let offset = end + 4
      while (offset + 2 <= buffer.length) {
        const short = buffer[offset + 1]! & 0x7f
        const lengthBytes = short === 126 ? 2 : short === 127 ? 8 : 0
        if (offset + 2 + lengthBytes > buffer.length) return
        const length = short === 126 ? buffer.readUInt16BE(offset + 2) : short === 127 ? Number(buffer.readBigUInt64BE(offset + 2)) : short
        const start = offset + 2 + lengthBytes
        if (start + length > buffer.length) return
        const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as Record<string, unknown>
        if (message.id === 1) {
          const [status = '', ...headers] = head.split('\r\n')
          resolve({ status, headers: headers.join('\n'), message })
          return
        }
        offset = start + length
      }
    })
    socket.once('close', () => { reject(new Error(`socket closed before a CDP reply: ${buffer.toString('latin1')}`)) })
  })
}

/** Open one connected TCP pair: `server` stands for the browser socket the Web server hands to the upgrade route. */
async function socketPair(): Promise<{ client: Socket; server: Socket; closed: Promise<void>; received: () => Buffer }> {
  const listener = createServer()
  await new Promise<void>((resolve) => { listener.listen(0, '127.0.0.1', resolve) })
  const accepted = new Promise<Socket>((resolve) => { listener.once('connection', resolve) })
  const client = createConnection((listener.address() as AddressInfo).port, '127.0.0.1')
  const server = await accepted
  listener.close()
  let received = Buffer.alloc(0)
  client.on('data', (chunk: Buffer) => { received = Buffer.concat([received, chunk]) })
  client.on('error', (error: unknown) => { void error /* The proxied peer may reset the fixture connection; `closed` observes the outcome. */ })
  const closed = new Promise<void>((resolve) => { client.once('close', () => { resolve() }) })
  return { client, server, closed, received: () => received }
}

async function closedPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolve) => { listener.listen(0, '127.0.0.1', resolve) })
  const { port } = listener.address() as AddressInfo
  await new Promise<void>((resolve) => { listener.close(() => { resolve() }) })
  return port
}

function redirectedHandle(handle: InspectorHandle, webSocketDebuggerUrl: string): InspectorHandle {
  return { endpoint: { ...handle.endpoint, webSocketDebuggerUrl }, source: handle.source, close: () => handle.close() }
}
