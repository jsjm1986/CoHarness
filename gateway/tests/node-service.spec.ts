/** Existing Gateway authentication and APIs over real outbound HTTP/WebSocket node connections. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientRequest, createServer, type Server } from 'node:http'
import { PassThrough, Readable, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { AuthService } from '../src/auth.ts'
import { AuditService } from '../src/audit.ts'
import { UserService } from '../src/users.ts'
import { ProjectService } from '../src/projects.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { createGatewayServer, scopeCookie, type GatewayDeps } from '../src/server.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { RuntimeCatalogError, type RuntimeCatalogEntry, type RuntimeId, type RuntimeNodeId } from '../src/runtime-catalog.ts'
import { NodeAccessError, type NodeCredential, type NodeLease } from '../src/node-access.ts'
import { GatewayNodeChannels } from '../src/node-channel.ts'
import { runNodeChannel } from '../src/node-channel-client.ts'
import { NodeDialer, type NodeDialReason } from '../src/node-dialer.ts'
import { loadNodeChannelClientLimits, NODE_CHANNEL_PROTOCOL } from '../src/node-channel-protocol.ts'
import { GatewayNodeServices, loadNodeServiceConfig } from '../src/node-service.ts'
import { GatewayNodeServiceProxy } from '../src/node-service-proxy.ts'
import { NodeServiceHttpPool } from '../src/node-service-http-pool.ts'
import { NODE_SERVICE_TARGET_HEADER, nodeServiceLocalOrigin, NodeServiceError } from '../src/node-service-stream.ts'
import { testConfig } from './test-config.ts'

const releases: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const release of releases.splice(0).reverse()) {
    try { await release() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Node service cleanup failed')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) })
}

/** A closed loopback port: the first dial candidate answers ECONNREFUSED. */
async function deadPort(): Promise<string> {
  const probe = createServer()
  const url = await listen(probe)
  await close(probe)
  return url
}

async function fixture(overrides: NodeJS.ProcessEnv = {}, resolveOwners = false, ambiguousPersonal = false, dialFallback = false) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-service-'))
  releases.push(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'accounts.sqlite'))
  releases.push(async () => { db.close() })
  const centerConfig = testConfig(join(root, 'center'), { HGW_NODE_SERVICE_FORWARDING: 'on', ...overrides })
  const remoteConfig = testConfig(join(root, 'remote'))
  const users = new UserService(db, centerConfig)
  const admin = await users.create({ username: 'owner', password: 'pw-12345678', role: 'admin' })
  await users.changeOwnPassword(admin.id, 'pw-12345678')
  const other = await users.create({ username: 'other', password: 'pw-12345678' })
  await users.changeOwnPassword(other.id, 'pw-12345678')
  const nodeId = randomUUID() as RuntimeNodeId, localNodeId = randomUUID() as RuntimeNodeId
  const lease: NodeLease = { protocolVersion: 1, organizationId: randomUUID() as NodeLease['organizationId'], nodeId,
    connectionId: randomUUID() as NodeLease['connectionId'], epoch: '1' as NodeLease['epoch'], executionReady: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), heartbeatMs: 1000 }
  const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential
  let live = true
  const authorizeChannel = async (token: string, input: unknown) => {
    const value = input as { connectionId: string; epoch: string }
    if (!live || token !== credential) throw new NodeAccessError(401, 'node-access/unauthorized')
    if (value.connectionId !== lease.connectionId || value.epoch !== lease.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
    return lease
  }
  const authorizeAdministratorNode = async (actor: typeof admin, id: string) => {
    const current = users.getById(actor.id)
    if (current?.role !== 'admin' || current.status !== 'active') throw new NodeAccessError(403, 'node-access/forbidden')
    if (id !== nodeId) throw new NodeAccessError(404, 'node-access/not-found')
    return nodeId
  }
  const environment: RuntimeCatalogEntry = { id: randomUUID() as RuntimeId,
    owner: { kind: 'personal', id: admin.id, name: admin.displayName },
    node: { id: nodeId, name: 'Computer B', status: 'active', lastHeartbeatAt: null },
    generation: 1, observedState: 'ready', routing: 'unavailable' }
  const resolveForAccount = async (actor: typeof admin, id: string) => {
    const current = users.getById(actor.id)
    if (id !== environment.id || actor.id !== admin.id || current?.status !== 'active') throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return environment
  }
  const resolveForAdministrator = async (actor: typeof admin, id: string) => {
    await authorizeAdministratorNode(actor, nodeId)
    if (id !== environment.id) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return environment
  }
  const catalog = { resolveForAccount, resolveForLanding: async (actor: typeof admin) => resolveForAccount(actor, environment.id),
    resolveForOwner: async (actor: typeof admin, owner: { kind: 'personal' | 'project'; id: number }) => {
      if (ambiguousPersonal) throw new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target')
      if (owner.kind !== environment.owner.kind || owner.id !== environment.owner.id) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      return resolveForAccount(actor, environment.id)
    }, pageForAccount: async () => ({ items: [environment], nextCursor: null }),
    pageForAdministrator: async () => ({ items: [environment], nextCursor: null }) }
  const channels = new GatewayNodeChannels({ authorizeChannel, authorizeAdministratorNode }, centerConfig.nodeChannel)
  const services = new GatewayNodeServices({ authorizeChannel }, channels, centerConfig.nodeService, null)
  const proxy = new GatewayNodeServiceProxy({ localNodeId, resolveForAccount, resolveForAdministrator, authorizeAdministratorNode,
    authorizeAccountNode: async (actor, selected) => {
      if (actor.id !== admin.id || selected !== nodeId || users.getById(actor.id)?.status !== 'active') {
        throw new NodeAccessError(403, 'node-access/forbidden')
      }
    },
    ...(resolveOwners ? { resolvePlacement: (actor, selection) => centerRouter.placement(actor, selection), resetScopeCookie: () => scopeCookie('personal', centerConfig) } : {}),
  }, services, 5000, centerConfig.nodeService)
  const makeDeps = (cfg: typeof centerConfig, id: RuntimeNodeId): GatewayDeps => ({
    cfg, auth: new AuthService(db, cfg), users, projects: new ProjectService(db, cfg), audit: new AuditService(db),
    instances: new InstanceManager(db, cfg), runtimeCatalog: catalog,
    nodeServiceIdentity: { nodeId: id, organizationId: lease.organizationId, authorize: authorizeChannel },
  })
  const remoteDeps = makeDeps(remoteConfig, nodeId), centerDeps = makeDeps(centerConfig, localNodeId)
  const centerRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(centerDeps), { localNodeId, catalog })
  if (resolveOwners) centerDeps.runtimeRouter = centerRouter
  remoteDeps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(remoteDeps), { localNodeId: nodeId, catalog })
  const remoteStarts: number[] = [], localStarts: number[] = []
  if (resolveOwners) {
    remoteDeps.instances.ensureRunning = async subject => { remoteStarts.push(subject.id); return { port: 40000, generation: 1 } }
    centerDeps.instances.ensureRunning = async subject => { localStarts.push(subject.id); throw new Error('A remote scope cannot start locally') }
  }
  centerDeps.nodeChannels = channels; centerDeps.nodeServices = services; centerDeps.nodeServiceProxy = proxy
  const events = new WebSocketServer({ noServer: true })
  events.on('headers', values => { values.push(`${NODE_SERVICE_TARGET_HEADER}: ${nodeId}`) })
  const slow = deferred<void>(), slowResponse = deferred<void>()
  let localCalls = 0, remoteCalls = 0
  const remoteHttpSockets = new Set<import('node:net').Socket>()
  const remote = createGatewayServer(remoteDeps, {
    admin: createAdminApiHandler(remoteDeps),
    proxy: async (req, res, context) => {
      remoteCalls++
      if (!remoteHttpSockets.has(req.socket)) {
        remoteHttpSockets.add(req.socket)
        req.socket.once('close', () => { remoteHttpSockets.delete(req.socket) })
      }
      if (req.url?.startsWith('/api/final-buffer')) {
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
        res.end('buffered-response'.repeat(128))
        return
      }
      if (req.url?.startsWith('/api/export')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="records.json"' })
        const chunk = Buffer.alloc(256 * 1024, 'a')
        await pipeline(Readable.from((function* () {
          yield '"'
          for (let index = 0; index < 24; index++) yield chunk
          yield '"'
        })()), res)
        return
      }
      if (req.url?.startsWith('/api/slow')) {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first'); slowResponse.resolve()
        await slow.promise
        if (!res.destroyed) res.end('last')
        return
      }
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part))
      if (req.url?.startsWith('/api/reset-after-post')) { res.destroy(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ node: nodeId, user: context.user.id, runtime: context.environment?.id,
        bytes: Buffer.concat(parts).toString('base64'), path: req.url }))
    },
    upgrade: async (req, socket, head) => { events.handleUpgrade(req, socket, head, ws => { ws.on('message', bytes => { ws.send(bytes) }) }) },
  })
  const center = createGatewayServer(centerDeps, {
    admin: createAdminApiHandler(centerDeps),
    proxy: async (_req, res) => { localCalls++; res.end('center') },
    upgrade: async (_req, socket) => { localCalls++; socket.destroy() },
  })
  const agentStop = new AbortController(), ready = deferred<void>()
  let agent: Promise<void> | undefined
  releases.push(async () => {
    slow.resolve(); agentStop.abort()
    await Promise.allSettled([proxy.close(), services.close(), channels.close(), agent])
    for (const client of events.clients) client.terminate()
    await new Promise<void>((done, reject) => { events.close(error => { if (error) reject(error); else done() }) })
    await Promise.all([close(center), close(remote), centerDeps.instances.stopAll(), remoteDeps.instances.stopAll()])
  })
  const remoteBase = await listen(remote), base = await listen(center)
  centerConfig.publicOrigins.push(base); remoteConfig.publicOrigins.push(base, remoteBase)
  const dialEvents: Array<{ origin: string; reason: NodeDialReason }> = []
  const dialUrls = dialFallback ? [await deadPort(), base] : [base]
  agent = runNodeChannel({ dialer: new NodeDialer(dialUrls, 60_000, (origin, reason) => { dialEvents.push({ origin, reason }) }),
    credential, lease,
    limits: loadNodeChannelClientLimits({})!, requestTimeoutMs: 5000, retryMs: dialFallback ? 5 : 60_000,
    localGatewayUrl: remoteBase, maxServices: centerConfig.nodeService.maxPerNode }, agentStop.signal,
  event => { if (event.status === 'channel-ready') ready.resolve() },
  async () => ({ platform: 'linux', architecture: 'x64', uptimeSeconds: 1, executionReady: false }))
  await ready.promise
  const login = async (username: string) => {
    const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
      body: new URLSearchParams({ username, password: 'pw-12345678' }) })
    expect(response.status).toBe(302); await response.arrayBuffer()
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const cookie = await login('owner')
  return { base, remoteBase, nodeId, localNodeId, environment, cookie, login, admin, users, channels, services, proxy, lease, credential, centerDeps,
    remoteStarts, localStarts, dialEvents,
    slow, slowResponse, counters: () => ({ localCalls, remoteCalls }), remoteHttpConnections: () => remoteHttpSockets.size,
    disableForwarding: () => { centerDeps.nodeServiceProxy = undefined },
    misbind: () => { remoteDeps.nodeServiceIdentity!.nodeId = localNodeId },
    expire: () => { live = false },
    replaceChannel: async () => {
      Object.assign(lease, { connectionId: randomUUID(), epoch: String(BigInt(lease.epoch) + 1n) })
      const stop = new AbortController(), replacementReady = deferred<void>()
      const replacement = runNodeChannel({ dialer: new NodeDialer([base], 60_000, () => {}), credential, lease: { ...lease },
        limits: loadNodeChannelClientLimits({})!, requestTimeoutMs: 5000, retryMs: 60_000,
        localGatewayUrl: remoteBase, maxServices: centerConfig.nodeService.maxPerNode }, stop.signal,
      event => { if (event.status === 'channel-ready') replacementReady.resolve() },
      async () => ({ platform: 'linux', architecture: 'x64', uptimeSeconds: 1, executionReady: false }))
      releases.push(async () => { stop.abort(); await replacement })
      await replacementReady.promise
    },
    revoke: () => { live = false; channels.revoke(nodeId); services.revoke(nodeId) } }
}

it('validates fixed local origins and service capacity before network acquisition', () => {
  expect(nodeServiceLocalOrigin('http://127.0.0.1:3010')).toBe('http://127.0.0.1:3010')
  for (const value of ['https://127.0.0.1', 'http://localhost:3010', 'http://192.168.1.2', 'http://127.0.0.1/a', 'http://u:p@127.0.0.1']) {
    expect(() => nodeServiceLocalOrigin(value)).toThrow()
  }
  for (const value of ['0', '-1', '1.5', '2147483648']) expect(() => loadNodeServiceConfig({ HGW_NODE_SERVICE_MAX_CONNECTIONS: value })).toThrow()
  expect(() => loadNodeServiceConfig({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '1', HGW_NODE_SERVICE_MAX_PER_NODE: '2' })).toThrow()
  expect(loadNodeServiceConfig({}).forwarding).toBe(false)
  expect(loadNodeServiceConfig({ HGW_NODE_SERVICE_FORWARDING: 'on' }).forwarding).toBe(true)
  expect(() => loadNodeServiceConfig({ HGW_NODE_SERVICE_FORWARDING: 'true' })).toThrow()
  for (const key of ['HGW_NODE_SERVICE_HTTP_IDLE_TIMEOUT_MS', 'HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS', 'HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE',
    'HGW_NODE_SERVICE_HTTP_MAX_PENDING_REQUESTS', 'HGW_NODE_SERVICE_HTTP_QUEUE_TIMEOUT_MS']) {
    expect(() => loadNodeServiceConfig({ [key]: '0' })).toThrow()
  }
  expect(() => loadNodeServiceConfig({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '2', HGW_NODE_SERVICE_MAX_PER_NODE: '1',
    HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS: '3' })).toThrow()
  expect(() => loadNodeServiceConfig({ HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS: '1', HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE: '2' })).toThrow()
})

it('keeps the idle outbound control socket active independently of authority renewal', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server, perMessageDeflate: false })
  const stop = new AbortController(), ping = deferred<void>(), closed = deferred<void>()
  const lease: NodeLease = { protocolVersion: 1, organizationId: randomUUID() as NodeLease['organizationId'],
    nodeId: randomUUID() as RuntimeNodeId, connectionId: randomUUID() as NodeLease['connectionId'],
    epoch: '1' as NodeLease['epoch'], executionReady: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), heartbeatMs: 50 }
  let channel = Promise.resolve()
  releases.push(async () => {
    stop.abort(); await channel
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((done, reject) => { sockets.close(error => { if (error) reject(error); else done() }) })
    await close(server)
  })
  sockets.on('connection', socket => {
    expect(socket.protocol).toBe(NODE_CHANNEL_PROTOCOL)
    socket.once('ping', () => { ping.resolve() })
    socket.once('close', () => { closed.resolve() })
    socket.send(JSON.stringify({ ...lease, kind: 'ready', channelVersion: 1 }))
  })
  const origin = await listen(server)
  channel = runNodeChannel({ dialer: new NodeDialer([origin], 60_000, () => {}),
    credential: `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential,
    lease, limits: loadNodeChannelClientLimits({})!, requestTimeoutMs: 5000, retryMs: 60_000 }, stop.signal, () => {})
  await ping.promise
  stop.abort()
  await channel
  await closed.promise
  expect(sockets.clients.size).toBe(0)
})

it('dials the channel and its service streams through the next candidate after a refusal', async () => {
  const f = await fixture({}, false, false, true)
  expect(f.dialEvents).toEqual([{ origin: f.base, reason: 'node-dial/transport-failure' }])
  const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, {
    method: 'POST', headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/octet-stream' }, body: 'x',
  })
  expect(response.status).toBe(200)
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 1 })
})

it('forwards an exact remote environment with the existing login and streams binary request chunks', async () => {
  const f = await fixture()
  const body = randomBytes(256 * 1024 + 3)
  const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, {
    method: 'POST', headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/octet-stream' }, body,
  })
  expect(response.status).toBe(200)
  const value = await response.json() as { node: string; runtime: string; bytes: string }
  expect(value.node).toBe(f.nodeId); expect(value.runtime).toBe(f.environment.id)
  expect(Buffer.from(value.bytes, 'base64')).toEqual(body)
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 1 })
  const local = await fetch(`${f.base}/api/local`, { headers: { cookie: f.cookie } })
  expect(await local.text()).toBe('center')
})

it('flushes buffered node output after a clean local HTTP close', async () => {
  const f = await fixture()
  const held = deferred<void>(), release = deferred<void>()
  const localEnded = deferred<void>(), localSockets = new Set<Socket>()
  const emit = Socket.prototype.emit
  const observeEnd = vi.spyOn(Socket.prototype, 'emit').mockImplementation(function (this: Socket, event: string | symbol, ...args: unknown[]) {
    if (event === 'connect' && this.remotePort === Number(new URL(f.remoteBase).port)) localSockets.add(this)
    if (event === 'end' && localSockets.has(this)) localEnded.resolve()
    return Reflect.apply(emit, this, [event, ...args])
  })
  const send = WebSocket.prototype.send
  let captured = false
  const delayed = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, options, callback) {
    if (!captured && this.url?.includes('/internal/nodes/streams/') && Buffer.isBuffer(data) && data.subarray(0, 12).toString().startsWith('HTTP/1.1 200')) {
      captured = true
      held.resolve()
      void release.promise.then(() => { send.call(this, data, options, callback) })
      return
    }
    send.call(this, data, options, callback)
  })
  const response = fetch(`${f.base}/api/final-buffer?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
    .then(async reply => ({ status: reply.status, body: await reply.text() }))
  releases.push(async () => { release.resolve(); delayed.mockRestore(); observeEnd.mockRestore(); await response.catch(() => {}) })
  try {
    await held.promise
    await localEnded.promise
    // Let automatic half-close and close callbacks run while the final frame is held.
    await new Promise<void>(done => { setImmediate(done) })
    await new Promise<void>(done => { setImmediate(done) })
    release.resolve()
    expect(await response).toEqual({ status: 200, body: 'buffered-response'.repeat(128) })
  } finally { release.resolve(); delayed.mockRestore(); observeEnd.mockRestore() }
})

it('resolves existing personal, root and asset requests to the owning computer and pins the exact RuntimeId upstream', async () => {
  const f = await fixture({}, true)
  for (const path of ['/api/echo?dshTarget=personal', '/', '/assets/plugin-client.js']) {
    const response = await fetch(`${f.base}${path}`, { headers: { cookie: f.cookie } })
    expect(response.status).toBe(200)
    const value = await response.json() as { node: string; runtime: string; path: string }
    expect(value.node).toBe(f.nodeId); expect(value.runtime).toBe(f.environment.id)
    expect(new URL(value.path, f.base).searchParams.get('dshRuntime')).toBe(f.environment.id)
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 3 })
  const repaired = await fetch(`${f.base}/api/echo`, { headers: { cookie: `${f.cookie}; hgw_scope=project:999` } })
  expect(repaired.status).toBe(200); await repaired.arrayBuffer()
  expect(repaired.headers.get('set-cookie')).toContain('hgw_scope=personal')
  f.expire()
  const unavailable = await fetch(`${f.base}/api/echo?dshTarget=personal`, { headers: { cookie: f.cookie } })
  expect(unavailable.status).toBe(503); await unavailable.arrayBuffer()
  expect(f.localStarts).toEqual([])
})

it('keeps account metadata independent of an ambiguous personal Runtime selection', async () => {
  const f = await fixture({}, true, true)
  for (const [path, method, status] of [
    ['/account/api/preferences', 'GET', 501],
    ['/account/api/preferences', 'PATCH', 501],
    ['/account/api/projects', 'GET', 200],
    ['/account/api/push-devices', 'POST', 503],
    [`/account/api/push-devices/${randomUUID()}`, 'DELETE', 503],
  ] as const) {
    const response = await fetch(`${f.base}${path}`, { method, headers: { cookie: f.cookie, origin: f.base } })
    expect(response.status).toBe(status)
    await response.arrayBuffer()
  }
  const selected = await fetch(`${f.base}/account/api/context`, { headers: { cookie: f.cookie } })
  expect(selected.status).toBe(409)
  expect(await selected.json()).toEqual({ error: 'runtime-catalog/ambiguous-target' })
  const landing = await fetch(`${f.base}/`, { headers: { cookie: f.cookie }, redirect: 'manual' })
  expect(landing.status).toBe(302)
  expect(landing.headers.get('location')).toBe(`/?dshRuntime=${f.environment.id}`)
  await landing.arrayBuffer()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
  expect(f.remoteStarts).toEqual([])
  expect(f.localStarts).toEqual([])
})

it('serves the selected remote workbench from metadata without opening or starting a Runtime', async () => {
  const f = await fixture({}, true)
  f.centerDeps.collaboration = {
    projectsForUser: async () => [], projectForUser: async () => null, listAccountConversations: async () => [],
    access: () => { throw new Error('not implemented in metadata test') }, listConversations: () => [],
    readableSessionIds: () => [], setVisibility: () => { throw new Error('not implemented in metadata test') },
    claimInteraction: () => false, listActivity: async () => ({ items: [] }),
  }
  const storage = vi.spyOn(f.centerDeps.instances, 'storageOf')
  for (const disconnect of [false, true]) {
    if (disconnect) f.revoke()
    const response = await fetch(`${f.base}/account/api/workbench/catalog?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      environment: { id: f.environment.id, nodeId: f.nodeId, nodeName: 'Computer B' },
      activeRuntime: { kind: 'personal', runtimeId: f.environment.id, nodeId: f.nodeId },
      items: [], personalComplete: false,
    })
  }
  expect(storage).not.toHaveBeenCalled()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
  expect(f.localStarts).toEqual([])
  expect(f.remoteStarts).toEqual([])
})

it('pins the browser SVG icon to its referring tab when several personal Runtimes exist', async () => {
  const f = await fixture({}, true, true)
  const response = await fetch(`${f.base}/favicon.svg`, { headers: {
    cookie: f.cookie, referer: `${f.base}/?dshRuntime=${f.environment.id}`,
  } })
  expect(response.status).toBe(200)
  expect(response.url).toBe(`${f.base}/favicon.svg?dshRuntime=${f.environment.id}`)
  expect(await response.json()).toMatchObject({ node: f.nodeId, runtime: f.environment.id, path: `/favicon.svg?dshRuntime=${f.environment.id}` })
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 1 })
})

it('forwards content-addressed browser assets to the referring Runtime without redirecting', async () => {
  const f = await fixture({}, true)
  const referer = `${f.base}/?dshRuntime=${f.environment.id}`
  const forwarded = [
    '/assets/index-ABc12345.js',
    '/plugins/combo.js??@deepseek-ai/dsh-client-modules/client.js&rev=abcdef123456',
    '/plugins/@deepseek-ai/dsh-client-modules/client.lazy.js?rev=abcdef123456',
    '/plugins/@deepseek-ai/dsh-client-modules/client.lazy.js.map?rev=abcdef123456',
  ]
  for (const path of forwarded) {
    const response = await fetch(`${f.base}${path}`, { headers: { cookie: f.cookie, referer }, redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(response.url).toBe(`${f.base}${path}`)
    const value = await response.json() as { node: string, runtime: string, path: string }
    expect(value.node).toBe(f.nodeId)
    expect(value.runtime).toBe(f.environment.id)
    expect(value.path).toBe(`${path}${path.includes('?') ? '&' : '?'}dshRuntime=${f.environment.id}`)
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: forwarded.length })
})

it('keeps pinning runtime-specific and unrevisioned browser resource URLs', async () => {
  const f = await fixture({}, true)
  const referer = `${f.base}/?dshRuntime=${f.environment.id}`
  for (const path of [
    '/plugins/events',
    '/plugins/combo.js',
    '/plugins/@deepseek-ai/dsh-client-modules/client.js',
    '/plugins/@deepseek-ai/dsh-client-modules/client.lazy.js',
    '/assets/plugin-client.js',
  ]) {
    const response = await fetch(`${f.base}${path}`, { headers: { cookie: f.cookie, referer }, redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${path}?dshRuntime=${f.environment.id}`)
    await response.arrayBuffer()
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('rejects an unauthenticated content-addressed asset before any forwarding', async () => {
  const f = await fixture({}, true)
  const response = await fetch(`${f.base}/plugins/combo.js??@deepseek-ai/dsh-client-modules/client.js&rev=abcdef123456`, {
    headers: { referer: `${f.base}/?dshRuntime=${f.environment.id}` }, redirect: 'manual',
  })
  expect(response.status).toBe(401)
  await response.arrayBuffer()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('delivers parsed scope changes to the existing owning service and rejects selector conflicts before starting', async () => {
  const f = await fixture({}, true)
  const changed = await fetch(`${f.base}/account/api/scope`, { method: 'POST',
    headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'personal' }) })
  expect(changed.status).toBe(204); await changed.arrayBuffer()
  expect(changed.headers.get('set-cookie')).toBeNull()
  expect(f.remoteStarts).toEqual([f.admin.id]); expect(f.localStarts).toEqual([])
  const mismatch = await fetch(`${f.base}/account/api/scope?dshTarget=project:9`, { method: 'POST',
    headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'personal' }) })
  expect(mismatch.status).toBe(400); await mismatch.arrayBuffer()
  expect(f.remoteStarts).toEqual([f.admin.id]); expect(f.localStarts).toEqual([])
})

it('reuses existing remote Admin APIs while refusing a non-administrator node selector', async () => {
  const f = await fixture()
  const response = await fetch(`${f.base}/admin/api/users?dshNode=${f.nodeId}`, { headers: { cookie: f.cookie } })
  expect(response.status).toBe(200)
  expect(response.headers.get(NODE_SERVICE_TARGET_HEADER)).toBe(f.nodeId)
  expect(await response.json()).toMatchObject([{ username: 'owner' }, { username: 'other' }])
  const denied = await fetch(`${f.base}/admin/api/users?dshNode=${f.nodeId}`, { headers: { cookie: await f.login('other') } })
  expect(denied.status).toBe(403); await denied.arrayBuffer()
})

it('creates a collaborative project on the chosen computer without starting a personal Runtime', async () => {
  const f = await fixture({}, true)
  const request = { method: 'POST', headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Selected computer project' }) }
  const response = await fetch(`${f.base}/account/api/projects?dshNode=${f.nodeId}`, request)
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ name: 'Selected computer project', origin: 'user', owner: { id: f.admin.id } })
  expect(f.localStarts).toEqual([])
  expect(f.remoteStarts).toEqual([])
  expect(response.headers.get('set-cookie')).toBeNull()
  const denied = await fetch(`${f.base}/account/api/projects?dshNode=${f.nodeId}`, {
    ...request, headers: { ...request.headers, cookie: await f.login('other') },
  })
  expect(denied.status).toBe(403)
  await denied.arrayBuffer()
})

it('routes administrator Runtime selection without requiring personal access to its owner', async () => {
  const f = await fixture(), other = f.users.getByUsername('other')!
  f.users.setRole(other.id, 'admin')
  const cookie = await f.login('other')
  const response = await fetch(`${f.base}/admin/api/users?dshRuntime=${f.environment.id}`, { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(response.headers.get(NODE_SERVICE_TARGET_HEADER)).toBe(f.nodeId)
  await response.arrayBuffer()
  const mismatch = await fetch(`${f.base}/admin/api/users?dshRuntime=${f.environment.id}&dshNode=${f.localNodeId}`, { headers: { cookie } })
  expect(mismatch.status).toBe(400); await mismatch.arrayBuffer()
  f.users.setRole(other.id, 'user')
  const revoked = await fetch(`${f.base}/admin/api/users?dshRuntime=${f.environment.id}`, { headers: { cookie } })
  expect(revoked.status).toBe(403); await revoked.arrayBuffer()
})

it('streams a large JSON attachment without applying a metadata response limit to the download', async () => {
  const f = await fixture()
  const response = await fetch(`${f.base}/api/export?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="records.json"')
  const reader = response.body!.getReader()
  const received = createHash('sha256')
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      received.update(chunk.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  expect(bytes).toBe(24 * 256 * 1024 + 2)
  const expected = createHash('sha256').update('"')
  for (let index = 0; index < 24; index++) expected.update(Buffer.alloc(256 * 1024, 'a'))
  expect(received.digest('hex')).toBe(expected.update('"').digest('hex'))
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 1 })
})

it('reports the actual center identity and refuses a selected remote computer when forwarding is disabled', async () => {
  const f = await fixture()
  const context = await fetch(`${f.base}/admin/api/deployment/current-node`, { headers: { cookie: f.cookie } })
  expect(context.headers.get('cache-control')).toBe('no-store')
  expect(await context.json()).toMatchObject({ nodeId: f.localNodeId, forwardingEnabled: true })
  f.disableForwarding()
  const denied = await fetch(`${f.base}/admin/api/users?dshNode=${f.nodeId}`, { headers: { cookie: f.cookie } })
  expect(denied.status).toBe(503)
  expect(await denied.json()).toEqual({ error: 'node-service/unavailable' })
  const invalid = await fetch(`${f.base}/admin/api/users?dshNode=wrong`, { headers: { cookie: f.cookie } })
  expect(invalid.status).toBe(400); await invalid.arrayBuffer()
  const local = await fetch(`${f.base}/admin/api/users?dshNode=${f.localNodeId}`, { headers: { cookie: f.cookie } })
  expect(local.status).toBe(200); await local.arrayBuffer()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('delivers a response prefix before a slow node completes and preserves another connection', async () => {
  const f = await fixture()
  const response = await fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
  const other = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(other.status).toBe(200); await other.arrayBuffer()
  f.slow.resolve()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('last')
  expect((await reader.read()).done).toBe(true)
})

it('refuses detachment with an active stream and holds new admission until an idle pause is released', async () => {
  const f = await fixture()
  const paused = f.services.pauseIdle(f.nodeId)
  const blocked = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toEqual({ error: 'node-service/cancelled' })
  expect(f.counters().remoteCalls).toBe(0)
  paused()
  const response = await fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
  expect(() => f.services.pauseIdle(f.nodeId)).toThrow('node-service/busy')
  f.slow.resolve()
  while (!(await reader.read()).done) { /* Drain the owned response before checking transport admission. */ }
  reader.releaseLock()
  await f.proxy.closeIdle(f.nodeId)
  await expect.poll(() => {
    try { const resume = f.services.pauseIdle(f.nodeId); resume(); return true }
    catch (error) { if (error instanceof NodeServiceError && error.code === 'node-service/busy') return false; throw error }
  }).toBe(true)
})

it('forwards the existing browser WebSocket upgrade and byte stream to the selected computer', async () => {
  const f = await fixture()
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/events?dshRuntime=${f.environment.id}`,
    { headers: { cookie: f.cookie, origin: f.base } })
  const closed = new Promise<void>(resolve => { ws.once('close', () => { resolve() }) })
  releases.push(async () => { ws.terminate(); await closed })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const reply = new Promise<Buffer>((resolve, reject) => { ws.once('message', value => { resolve(Buffer.from(value as Buffer)) }); ws.once('error', reject) })
  ws.send('remote-event')
  expect((await reply).toString()).toBe('remote-event')
  expect(f.counters().localCalls).toBe(0)
})

it('keeps a live browser WebSocket when its computer has no spare service capacity', async () => {
  const f = await fixture({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '1', HGW_NODE_SERVICE_MAX_PER_NODE: '1' })
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/events?dshRuntime=${f.environment.id}`,
    { headers: { cookie: f.cookie, origin: f.base } })
  const closed = new Promise<void>(resolve => { ws.once('close', () => { resolve() }) })
  releases.push(async () => { ws.terminate(); await closed })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const refused = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(refused.status).toBe(503); await refused.arrayBuffer()
  const reply = new Promise<Buffer>((resolve, reject) => { ws.once('message', value => { resolve(Buffer.from(value as Buffer)) }); ws.once('error', reject) })
  ws.send('still connected')
  expect((await reply).toString()).toBe('still connected')
})

it.each(['scope', 'upgrade'] as const)('contains late transport errors after a failed %s request', async mode => {
  const f = await fixture({}, true)
  const captured = deferred<ClientRequest>()
  const original = ClientRequest.prototype.end
  const interception = vi.spyOn(ClientRequest.prototype, 'end').mockImplementation(function (this: ClientRequest, ...args) {
    if (this.host === 'node.gateway.invalid') captured.resolve(this)
    return Reflect.apply(original, this, args) as ClientRequest
  })
  releases.push(async () => { interception.mockRestore() })
  let browser: Promise<void>
  if (mode === 'scope') {
    browser = fetch(`${f.base}/account/api/scope`, { method: 'POST',
      headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'personal' }),
    }).then(async response => { expect(response.status).toBe(503); await response.arrayBuffer() })
  } else {
    const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/events?dshRuntime=${f.environment.id}`,
      { headers: { cookie: f.cookie, origin: f.base } })
    const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
    releases.push(async () => { socket.terminate(); await closed })
    browser = new Promise<void>((resolve, reject) => {
      socket.once('error', () => { resolve() })
      socket.once('open', () => { reject(new Error('The failed upgrade must not open')) })
    })
  }
  const outgoing = await captured.promise
  interception.mockRestore()
  outgoing.destroy(new NodeServiceError(503, 'node-service/unavailable'))
  await browser
  expect(() => outgoing.emit('error', Object.assign(new Error('Transport aborted during disposal'), { code: 'ABORT_ERR' }))).not.toThrow()
  const account = await fetch(`${f.base}/account/api/runtimes`, { headers: { cookie: f.cookie } })
  expect(account.status).toBe(200); await account.arrayBuffer()
})

it('refuses inaccessible environments and mismatched targets without a local fallback', async () => {
  const f = await fixture(), other = await f.login('other')
  for (const [query, cookie, status] of [
    [`dshRuntime=${f.environment.id}`, other, 404],
    [`dshRuntime=${f.environment.id}&dshTarget=project:1`, f.cookie, 400],
    [`dshRuntime=${f.environment.id}&dshNode=${f.localNodeId}`, f.cookie, 400],
  ] as const) {
    const response = await fetch(`${f.base}/api/echo?${query}`, { headers: { cookie } })
    expect(response.status).toBe(status); await response.arrayBuffer()
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('checks the selected computer before each versioned operation on the primary and directly on the owner', async () => {
  const f = await fixture({}, true)
  const services = ['/api/prepare/v1/session.create', '/api/prepare/v1/session.history',
    '/api/admit/v1/session.prompt', '/api/admit/v1/session.status']
  const send = async (base: string, path: string, selector: string, forwardedTo?: string) => {
    const response = await fetch(`${base}${path}?dshRuntime=${f.environment.id}&dshTarget=personal${selector}`, {
      method: 'POST', headers: { cookie: f.cookie, origin: base,
        ...(forwardedTo ? { [NODE_SERVICE_TARGET_HEADER]: forwardedTo } : {}) },
      ...(path === '/account/api/scope' ? { body: JSON.stringify({ kind: 'personal' }) } : {}),
    })
    await response.arrayBuffer()
    return response.status
  }
  for (const path of [...services, '/account/api/scope']) {
    // The first hop already chose this Gateway. A move cannot turn the receiver into a second forwarder.
    expect(await send(f.base, path, '', f.localNodeId)).toBe(409)
    for (const base of [f.base, f.remoteBase]) {
      expect(await send(base, path, '&dshNode=' + f.localNodeId)).toBe(400)
      expect(await send(base, path, `&dshNode=${f.nodeId}&dshNode=${f.localNodeId}`)).toBe(400)
    }
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
  expect(f.remoteStarts).toEqual([])
  for (const path of services) {
    expect(await send(f.base, path, '&dshNode=' + f.nodeId)).toBe(200)
    expect(await send(f.base, path, '')).toBe(200)
  }
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 8 })
  expect(await send(f.base, '/account/api/scope', '&dshNode=' + f.nodeId)).toBe(204)
  expect(f.remoteStarts).toEqual([f.admin.id])
})

it.each([true, false])('rechecks a placement moved after the outgoing service stream opens (original node pin %s)', async pinned => {
  const f = await fixture({}, true)
  const open = f.services.open.bind(f.services)
  const moved = vi.spyOn(f.services, 'open').mockImplementationOnce(async (node, signal) => {
    const stream = await open(node, signal)
    f.environment.node = { ...f.environment.node, id: f.localNodeId }
    return stream
  })
  const selectors = new URLSearchParams({ dshRuntime: f.environment.id, dshTarget: 'personal' })
  if (pinned) selectors.set('dshNode', f.nodeId)
  const response = await fetch(`${f.base}/api/admit/v1/session.prompt?${selectors}`, {
    method: 'POST', headers: { cookie: f.cookie, origin: f.base }, body: '{}',
  })
  expect(moved).toHaveBeenCalledOnce()
  expect(response.status).toBe(pinned ? 400 : 409)
  expect(await response.json()).toEqual({ error: pinned ? 'node-service/invalid-target' : 'node-service/mismatch' })
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
  expect(f.remoteStarts).toEqual([])
})

it('keeps control probes available at the service limit and closes admitted streams on revocation', async () => {
  const f = await fixture({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '1', HGW_NODE_SERVICE_MAX_PER_NODE: '1' })
  const response = await fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  const reader = response.body!.getReader(); await reader.read()
  const waiting = fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect((await f.channels.probe(f.admin, f.nodeId, new AbortController().signal)).nodeId).toBe(f.nodeId)
  f.revoke()
  await expect(reader.read()).rejects.toThrow()
  const refused = await waiting
  expect(refused.status).toBe(503); await refused.arrayBuffer()
  const disconnected = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(disconnected.status).toBe(503); await disconnected.arrayBuffer()
  expect(f.counters().localCalls).toBe(0)
})

it.each([1, 4, 16])('reuses a node service capacity of %s across completed HTTP requests', async capacity => {
  const f = await fixture({ HGW_NODE_SERVICE_MAX_CONNECTIONS: String(capacity), HGW_NODE_SERVICE_MAX_PER_NODE: String(capacity) })
  const results: number[] = []
  for (let index = 0; index < capacity * 2 + 1; index++) {
    const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
    results.push(response.status)
    await response.arrayBuffer()
  }
  expect(results).toEqual(Array.from({ length: capacity * 2 + 1 }, () => 200))
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: capacity * 2 + 1 })
})

it('reuses one HTTP service stream while rechecking the node credential for every request', async () => {
  const f = await fixture(), open = vi.spyOn(f.services, 'open'), revalidate = vi.spyOn(f.services, 'revalidate')
  for (let index = 0; index < 20; index++) {
    const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ node: f.nodeId, runtime: f.environment.id, user: f.admin.id })
  }
  expect(open).toHaveBeenCalledTimes(1)
  expect(revalidate).toHaveBeenCalledTimes(19)
  expect(f.remoteHttpConnections()).toBe(1)
  await f.proxy.closeIdle(f.nodeId)
  const cold = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(cold.status).toBe(200); await cold.arrayBuffer()
  expect(open).toHaveBeenCalledTimes(2)
  f.expire()
  const refused = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(refused.status).toBe(503); await refused.arrayBuffer()
  expect(f.counters().remoteCalls).toBe(21)
})

it('expires idle HTTP transports and drains them before the detachment fence', async () => {
  const f = await fixture({ HGW_NODE_SERVICE_HTTP_IDLE_TIMEOUT_MS: '60' }), open = vi.spyOn(f.services, 'open')
  const first = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(first.status).toBe(200); await first.arrayBuffer()
  await expect.poll(() => f.remoteHttpConnections()).toBe(0)
  const next = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(next.status).toBe(200); await next.arrayBuffer()
  expect(open).toHaveBeenCalledTimes(2)
  await f.proxy.closeIdle(f.nodeId)
  const resume = f.services.pauseIdle(f.nodeId)
  resume()
})

it('keeps concurrent requests independent when one response is cancelled', async () => {
  const f = await fixture(), open = vi.spyOn(f.services, 'open'), stop = new AbortController()
  const slow = await fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie }, signal: stop.signal })
  const reader = slow.body!.getReader(); await reader.read()
  const other = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(other.status).toBe(200); await other.arrayBuffer()
  stop.abort(); await expect(reader.read()).rejects.toThrow(); reader.releaseLock()
  const reused = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(reused.status).toBe(200); await reused.arrayBuffer()
  expect(open).toHaveBeenCalledTimes(2)
})

it('bounds retained idle transports after a concurrent HTTP burst', async () => {
  const f = await fixture({ HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE: '1' }), open = vi.spyOn(f.services, 'open')
  const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`,
    { headers: { cookie: f.cookie } })))
  expect(f.remoteHttpConnections()).toBe(3)
  f.slow.resolve()
  await Promise.all(responses.map(response => response.arrayBuffer()))
  await expect.poll(() => f.remoteHttpConnections()).toBe(1)
  const reused = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(reused.status).toBe(200); await reused.arrayBuffer()
  expect(open).toHaveBeenCalledTimes(3)
})

it('withdraws an old idle transport when the node connection epoch changes', async () => {
  const f = await fixture(), open = vi.spyOn(f.services, 'open')
  const first = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(first.status).toBe(200); await first.arrayBuffer()
  await f.replaceChannel()
  const next = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(next.status).toBe(200); await next.arrayBuffer()
  expect(open).toHaveBeenCalledTimes(2)
})

it('does not replay a POST after a reused connection loses its response', async () => {
  const f = await fixture(), open = vi.spyOn(f.services, 'open')
  const first = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(first.status).toBe(200); await first.arrayBuffer()
  const failed = await fetch(`${f.base}/api/reset-after-post?dshRuntime=${f.environment.id}`, { method: 'POST',
    headers: { cookie: f.cookie, origin: f.base }, body: 'one mutation' })
  expect(failed.status).toBe(503); await failed.arrayBuffer()
  expect(f.counters().remoteCalls).toBe(2)
  expect(open).toHaveBeenCalledTimes(1)
})

function capacityPoolFixture(maximum: number, perNode: number, reserved?: RuntimeNodeId, held?: RuntimeNodeId, overrides: NodeJS.ProcessEnv = {}) {
  const connections = new Map<Duplex, RuntimeNodeId>(), acknowledgements = new WeakMap<Duplex, Promise<void>>()
  const opened: RuntimeNodeId[] = [], streams: Duplex[] = [], destroyed = deferred<void>(), physicalRelease = deferred<void>()
  const capacity = (nodeId: RuntimeNodeId): 'available' | 'node' | 'global' => {
    if ([...connections.values()].filter(id => id === nodeId).length + Number(nodeId === reserved) >= perNode) return 'node'
    return connections.size + Number(reserved !== undefined) >= maximum ? 'global' : 'available'
  }
  const pool = new NodeServiceHttpPool({ capacity,
    open: async (nodeId, signal) => {
      signal.throwIfAborted()
      if (capacity(nodeId) !== 'available') throw new NodeServiceError(503, 'node-service/busy')
      const stream = new PassThrough(), released = deferred<void>()
      opened.push(nodeId); streams.push(stream); connections.set(stream, nodeId); acknowledgements.set(stream, released.promise)
      const abort = () => { stream.destroy() }
      signal.addEventListener('abort', abort, { once: true })
      stream.once('close', () => {
        signal.removeEventListener('abort', abort); destroyed.resolve()
        void (nodeId === held ? physicalRelease.promise : Promise.resolve()).then(() => {
          connections.delete(stream); released.resolve()
        })
      })
      return stream
    },
    revalidate: async () => {},
    released: stream => acknowledgements.get(stream)!,
  }, loadNodeServiceConfig({ HGW_NODE_SERVICE_MAX_CONNECTIONS: String(maximum), HGW_NODE_SERVICE_MAX_PER_NODE: String(perNode), ...overrides }))
  releases.push(async () => { physicalRelease.resolve(); await pool.close() })
  return { pool, opened, streams, destroyed, physicalRelease, capacity }
}

it('hands a completed HTTP connection to a waiting POST without replaying it', async () => {
  const f = await fixture({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '1', HGW_NODE_SERVICE_MAX_PER_NODE: '1' })
  const entered = deferred<void>(), original = f.services.open.bind(f.services)
  let attempts = 0
  vi.spyOn(f.services, 'open').mockImplementation((node, signal) => {
    if (++attempts === 2) entered.resolve()
    return original(node, signal)
  })
  const first = await fetch(`${f.base}/api/slow?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  const second = fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, {
    method: 'POST', headers: { cookie: f.cookie, origin: f.base }, body: 'queued-once',
  })
  await entered.promise
  f.slow.resolve()
  expect(await first.text()).toBe('firstlast')
  const result = await second
  expect(result.status).toBe(200)
  expect((await result.json()).bytes).toBe(Buffer.from('queued-once').toString('base64'))
  expect(f.counters().remoteCalls).toBe(2)
})

it('cancels a waiting borrower without destroying the active HTTP owner', async () => {
  const node = randomUUID() as RuntimeNodeId, f = capacityPoolFixture(1, 1)
  const active = await f.pool.acquire(node, new AbortController().signal)
  const cancelled = new AbortController()
  const waiting = f.pool.acquire(node, cancelled.signal)
  const outcome = waiting.catch(error => error)
  await new Promise<void>(resolve => setImmediate(resolve))
  cancelled.abort()
  expect(await outcome).toMatchObject({ code: 'node-service/cancelled' })
  expect(f.streams[0]!.destroyed).toBe(false)
  active.release()
  const successor = await f.pool.acquire(node, new AbortController().signal)
  expect(successor.agent).toBe(active.agent)
  successor.release()
})

it('bounds waiting HTTP requests and expires their original queue deadline', async () => {
  const node = randomUUID() as RuntimeNodeId
  const f = capacityPoolFixture(1, 1, undefined, undefined, {
    HGW_NODE_SERVICE_HTTP_MAX_PENDING_REQUESTS: '1', HGW_NODE_SERVICE_HTTP_QUEUE_TIMEOUT_MS: '20',
  })
  const active = await f.pool.acquire(node, new AbortController().signal)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const waiting = f.pool.acquire(node, new AbortController().signal).catch(error => error)
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(f.pool.acquire(node, new AbortController().signal)).rejects.toMatchObject({ code: 'node-service/busy' })
    await vi.advanceTimersByTimeAsync(21)
    expect(await waiting).toMatchObject({ code: 'node-service/timeout' })
    expect(f.streams[0]!.destroyed).toBe(false)
  } finally { await f.pool.close(); vi.useRealTimers() }
  active.release()
})

it('closes pending HTTP acquisition without allowing a late borrower to start', async () => {
  const node = randomUUID() as RuntimeNodeId, f = capacityPoolFixture(1, 1)
  const active = await f.pool.acquire(node, new AbortController().signal)
  const waiting = f.pool.acquire(node, new AbortController().signal).catch(error => error)
  await new Promise<void>(resolve => setImmediate(resolve))
  await f.pool.close()
  expect(await waiting).toMatchObject({ code: 'node-service/closed' })
  active.release()
  expect(f.opened).toEqual([node])
})

it('admits another computer while the target computer waits for its own busy HTTP connection', async () => {
  const a = randomUUID() as RuntimeNodeId, b = randomUUID() as RuntimeNodeId, f = capacityPoolFixture(2, 1)
  const first = await f.pool.acquire(a, new AbortController().signal)
  const waiting = f.pool.acquire(a, new AbortController().signal)
  const other = await f.pool.acquire(b, new AbortController().signal)
  first.release()
  const next = await waiting
  expect(next.agent).toBe(first.agent)
  expect(f.opened).toEqual([a, b])
  next.release(); other.release()
})

it('keeps a reused HTTP response alive when its released predecessor is destroyed late', async () => {
  const entered = deferred<void>(), finish = deferred<void>()
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/first') { res.end('first'); return }
    res.writeHead(200); res.write('second-started'); entered.resolve()
    void finish.promise.then(() => { res.end('second-finished') })
  })
  releases.push(() => close(server))
  const port = Number(new URL(await listen(server)).port)
  const closed = new WeakMap<Duplex, Promise<void>>()
  let opened = 0
  const pool = new NodeServiceHttpPool({
    capacity: () => 'available',
    open: async (_node, signal) => {
      const socket = new Socket()
      opened++
      const abort = () => { socket.destroy() }
      signal.addEventListener('abort', abort, { once: true })
      closed.set(socket, new Promise<void>((resolve) => {
        socket.once('close', () => { signal.removeEventListener('abort', abort); resolve() })
      }))
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.connect(port, '127.0.0.1', () => { socket.removeListener('error', reject); resolve() })
      })
      return socket
    },
    revalidate: async () => {},
    released: stream => closed.get(stream)!,
  }, loadNodeServiceConfig({}))
  const requests: Array<Promise<{ body?: string; error?: string }>> = []
  releases.push(async () => {
    finish.resolve(); await pool.close(); await Promise.allSettled(requests)
  })
  const call = (agent: import('node:http').Agent, path: string) => {
    const result = new Promise<{ body?: string; error?: string }>((resolve) => {
      const request = new ClientRequest({ hostname: 'node.gateway.invalid', path, agent }, (response) => {
        let body = ''
        response.on('data', chunk => { body += String(chunk) })
        response.once('end', () => { resolve({ body }) })
        response.once('error', error => { resolve({ error: error.message }) })
      })
      request.once('error', error => { resolve({ error: error.message }) }); request.end()
    })
    requests.push(result)
    return result
  }
  const node = randomUUID() as RuntimeNodeId, signal = new AbortController().signal
  const first = await pool.acquire(node, signal)
  expect(await call(first.agent, '/first')).toEqual({ body: 'first' })
  first.release()
  const second = await pool.acquire(node, signal)
  expect(second.agent).toBe(first.agent)
  const response = call(second.agent, '/second')
  await entered.promise
  first.destroy(); first.destroy(); first.release()
  finish.resolve()
  expect(await response).toEqual({ body: 'second-startedsecond-finished' })
  expect(opened).toBe(1)
  second.release()
})

it('evicts another computer idle transport and waits for physical credit before opening a new computer', async () => {
  const a = randomUUID() as RuntimeNodeId, b = randomUUID() as RuntimeNodeId
  const f = capacityPoolFixture(1, 1, undefined, a), signal = new AbortController().signal
  const first = await f.pool.acquire(a, signal); first.release()
  let acquired = false
  const second = f.pool.acquire(b, signal).then(lease => { acquired = true; return lease })
  await f.destroyed.promise
  expect(f.opened).toEqual([a])
  expect(acquired).toBe(false)
  expect(f.capacity(b)).toBe('global')
  f.physicalRelease.resolve()
  const lease = await second; lease.release()
  expect(f.opened).toEqual([a, b])
  expect(f.streams[0]!.destroyed).toBe(true)
})

it('retains other computers idle transports when active target connections exhaust its per-computer limit', async () => {
  const a = randomUUID() as RuntimeNodeId, b = randomUUID() as RuntimeNodeId
  const f = capacityPoolFixture(2, 1, b), signal = new AbortController().signal
  const first = await f.pool.acquire(a, signal); first.release()
  await expect(f.pool.acquire(b, signal)).rejects.toMatchObject({ code: 'node-service/busy' })
  expect(f.opened).toEqual([a])
  expect(f.streams[0]!.destroyed).toBe(false)
})

it.each([false, true])('waits for cancelled node bridge cleanup and honors successor cancellation=%s', async cancelSuccessor => {
  const f = await fixture({ HGW_NODE_SERVICE_MAX_CONNECTIONS: '1', HGW_NODE_SERVICE_MAX_PER_NODE: '1' })
  const localClosed = deferred<void>(), release = deferred<void>(), successorSeen = deferred<void>(), successorCancelled = deferred<void>()
  const emit = WebSocket.prototype.emit, send = WebSocket.prototype.send
  let held = false, commands = 0, successorId: string | undefined
  const delayed = vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
    if (!held && event === 'close' && this.url?.includes('/internal/nodes/streams/')) {
      held = true
      localClosed.resolve()
      void release.promise.then(() => { Reflect.apply(emit, this, [event, ...args]) })
      return true
    }
    return Reflect.apply(emit, this, [event, ...args])
  })
  const observe = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, options, callback) {
    if (typeof data === 'string' && data.startsWith('{"kind":"service"')) {
      commands++
      if (commands === 2) { successorId = (JSON.parse(data) as { id: string }).id; successorSeen.resolve() }
    }
    if (typeof data === 'string' && data.startsWith('{"kind":"cancel"') && (JSON.parse(data) as { id: string }).id === successorId) successorCancelled.resolve()
    send.call(this, data, options, callback)
  })
  const requests: Array<Promise<{ status: number; body: string }>> = []
  releases.push(async () => {
    release.resolve()
    await Promise.allSettled(requests)
    observe.mockRestore(); delayed.mockRestore()
  })
  const first = await fetch(`${f.base}/api/final-buffer?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(first.status).toBe(200); await first.arrayBuffer()
  await localClosed.promise
  await expect.poll(() => {
    try { const resume = f.services.pauseIdle(f.nodeId); resume(); return true }
    catch (error) { if (error instanceof NodeServiceError && error.code === 'node-service/busy') return false; throw error }
  }).toBe(true)
  const controller = new AbortController()
  const next = fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie }, signal: controller.signal })
    .then(async response => ({ status: response.status, body: await response.text() }))
    .catch((error: unknown) => { if (!controller.signal.aborted) throw error; return { status: 0, body: 'cancelled' } })
  requests.push(next)
  await successorSeen.promise
  await f.channels.probe(f.admin, f.nodeId, new AbortController().signal)
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 1 })
  if (cancelSuccessor) {
    controller.abort()
    await successorCancelled.promise
    await f.channels.probe(f.admin, f.nodeId, new AbortController().signal)
  }
  release.resolve()
  expect((await next).status).toBe(cancelSuccessor ? 0 : 200)
  await f.channels.probe(f.admin, f.nodeId, new AbortController().signal)
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: cancelSuccessor ? 1 : 2 })
})

it('refuses a local Gateway bound to another computer before forwarding an operation', async () => {
  const f = await fixture()
  f.misbind()
  const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(response.status).toBe(503); await response.arrayBuffer()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('checks the target-computer fence before an existing Admin mutation', async () => {
  const f = await fixture(), before = f.users.count()
  const response = await fetch(`${f.remoteBase}/admin/api/users`, { method: 'POST',
    headers: { cookie: f.cookie, origin: f.base, 'content-type': 'application/json', [NODE_SERVICE_TARGET_HEADER]: f.localNodeId },
    body: JSON.stringify({ username: 'wrong-node', password: 'pw-12345678' }),
  })
  expect(response.status).toBe(409); await response.arrayBuffer()
  expect(f.users.count()).toBe(before)
})

it('reports a lost node credential as service unavailability without invalidating the browser login', async () => {
  const f = await fixture()
  f.expire()
  const response = await fetch(`${f.base}/api/echo?dshRuntime=${f.environment.id}`, { headers: { cookie: f.cookie } })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'node-service/unavailable' })
  const account = await fetch(`${f.base}/account/api/runtimes`, { headers: { cookie: f.cookie } })
  expect(account.status).toBe(200); await account.arrayBuffer()
  expect(f.counters()).toEqual({ localCalls: 0, remoteCalls: 0 })
})

it('reports a fenced control lease as a disconnected node while retaining administrator authority', async () => {
  const f = await fixture()
  f.expire()
  await expect(f.channels.probe(f.admin, f.nodeId, new AbortController().signal))
    .rejects.toMatchObject({ status: 503, code: 'node-channel/disconnected' })
  const account = await fetch(`${f.base}/account/api/runtimes`, { headers: { cookie: f.cookie } })
  expect(account.status).toBe(200); await account.arrayBuffer()
})

it('awaits cancelled connection preparation and disposes its late control request', async () => {
  const prepared = deferred<void>(), released = deferred<void>()
  const lease: NodeLease = { protocolVersion: 1, organizationId: randomUUID() as NodeLease['organizationId'], nodeId: randomUUID() as RuntimeNodeId,
    connectionId: randomUUID() as NodeLease['connectionId'], epoch: '1' as NodeLease['epoch'], executionReady: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), heartbeatMs: 1000 }
  let disposed = 0, closed = false
  const service = new GatewayNodeServices({ authorizeChannel: async () => lease }, {
    requestService: async () => { prepared.resolve(); await released.promise; return { lease, dispose: () => { disposed++ } } },
  }, loadNodeServiceConfig({}), null)
  releases.push(async () => { released.resolve(); await service.close() })
  const controller = new AbortController(), opening = service.open(lease.nodeId, controller.signal)
  const refused = expect(opening).rejects.toMatchObject({ code: 'node-service/cancelled' })
  await prepared.promise
  controller.abort(); await refused
  const closing = service.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  released.resolve(); await closing
  expect(disposed).toBe(1)
})
