import { once } from 'node:events'
import { createServer, get, type IncomingMessage } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import type { Launcher, LaunchRuntime } from '../src/launcher.ts'
import { RUNTIME_READINESS_NONCE_HEADER, RUNTIME_READINESS_PATH, runtimeReadinessResponseProof } from '../src/runtime-readiness.ts'
import { ProjectService } from '../src/projects.ts'
import { createProxyHandlers, projectRuntimeGrants } from '../src/proxy.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { RUNTIME_PORT_PUBLISHER, runtimeRelay } from './runtime-relay.ts'
import { barrier } from './barrier.ts'

// Resolve from a real cwd path (not import.meta.url, which is a virtual URL
// under vitest) so the absolute ws path stays requireable by the plain-node child.
const WS_MODULE = createRequire(join(process.cwd(), 'noop.js')).resolve('ws')
const ECHO_DSH = `
const fs = require('fs')
const crypto = require('crypto')
const http = require('http')
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const credential = JSON.parse(fs.readFileSync(3, 'utf8'))
const material = (kind, nonce) => 'dsh-gateway-readiness-v1\\0' + kind + '\\0' + nonce + '\\0' + credential.runtime.kind + '\\0' + String(credential.runtime.id) + '\\0' + String(credential.runtime.generation)
const proof = (kind, nonce) => crypto.createHmac('sha256', credential.token).update(material(kind, nonce)).digest('base64url')
const server = http.createServer((req, res) => {
  if (req.url === '/exit') { res.end('bye'); process.exit(0); return }
  if (req.url === '/api/internal/gateway/readiness') {
    const nonce = req.headers['x-dsh-gateway-readiness-nonce']
    const request = req.headers['x-dsh-gateway-readiness-request']
    if (typeof nonce !== 'string' || request !== proof('request', nonce)) { res.writeHead(403); res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: 1, runtime: credential.runtime, proof: proof('response', nonce) }))
    return
  }
  if (req.url === '/api/hold') { res.writeHead(200); res.write('authorized-prefix'); return }
  if (req.url === '/api/hang-headers') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"partial":'); return }
  if (req.url === '/api/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: open\\n\\n')
    const timer = setTimeout(() => { res.write('data: tick\\n\\n'); res.end() }, 250)
    req.on('close', () => clearTimeout(timer))
    return
  }
  if (req.url === '/api/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:' + process.argv[1] + '/landing' }); res.end(); return }
  if (req.url === '/api/external-redirect') { res.writeHead(302, { location: 'https://127.0.0.1.evil/landing' }); res.end(); return }
  if (req.url === '/api/refused') { res.writeHead(403); res.end('refused'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ host: req.headers.host, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null })) })
server.listen(0, '127.0.0.1', () => {
  ${RUNTIME_PORT_PUBLISHER}(process.argv[2], server.address().port)
})
`

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (error) { failures.push(error) }
  }
  cleanup = []
  if (failures.length) throw new AggregateError(failures, 'proxy fixture cleanup failed')
})


async function setup(withPrincipal = false, env: Record<string, string> = {}, launcher?: Launcher, runtimeRouter?: GatewayDeps['runtimeRouter']) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'g.sqlite'))
  cleanup.push(() => { db.close() })
  const portFile = join(root, 'child-port')
  const port = await runtimeRelay(portFile, dispose => { cleanup.push(dispose) })
  const cfg = testConfig(root, { HGW_USERS_ROOT: join(root, 'users'), HGW_READINESS_TIMEOUT_MS: '10000', HGW_INSTANCE_PORT_BASE: String(port), ...env })
  cfg.dshCommand = [process.execPath, '-e', ECHO_DSH, '{port}', portFile]
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg, launcher),
    ...(runtimeRouter === undefined ? {} : { runtimeRouter }),
  }
  cleanup.push(() => deps.instances.stopAll())
  const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
  const signer = withPrincipal
    ? new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'default', 30_000)
    : undefined
  const handlers = createProxyHandlers(deps, signer)
  const server = createGatewayServer(deps, handlers)
  const connections = new Set<Socket>()
  server.on('connection', socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })
  cleanup.push(async () => {
    // Upgraded WebSockets are not included in closeAllConnections().
    for (const socket of connections) socket.destroy()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  })
  cleanup.push(() => handlers.close())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'alice', password: 'pw-12345678' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { deps, base, cookie, root, signer, handlers, alice, db }
}

describe('proxy handlers', () => {
  it('reports unavailable supervision without restarting or releasing the live Runtime', async () => {
    const { deps, base, cookie, alice } = await setup()
    await deps.instances.ensureRunning(alice)
    const directory = join(deps.cfg.stateRoot, 'local-runtime-supervisors')
    const name = readdirSync(directory).find(name => name.endsWith('.json'))!
    const path = join(directory, name), original = readFileSync(path, 'utf8')
    const record = JSON.parse(original) as { url: string }
    const starts = vi.spyOn(deps.instances, 'startRequest')
    const prior = deps.instances.capacitySnapshot?.().resident
    expect(prior).toBe(1)
    writeFileSync(path, JSON.stringify({ ...record, url: 'http://127.0.0.1:0/' }))
    try {
      const response = await fetch(`${base}/api/echo`, { headers: { cookie } })
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'INSTANCE_UNAVAILABLE' } })
      expect(starts).not.toHaveBeenCalled()
      expect(deps.instances.capacitySnapshot?.().resident).toBe(prior)
    } finally { writeFileSync(path, original) }
    const recovered = await fetch(`${base}/api/echo`, { headers: { cookie } })
    expect(recovered.status).toBe(200)
    await recovered.arrayBuffer()
  })
  it('reports a full cold-start queue through real HTTP admission and recovers without waiting for readiness', async () => {
    const starts: number[] = []
    const states = new Map<number, {
      entered: ReturnType<typeof barrier>
      proceed: ReturnType<typeof barrier>
      runtime?: LaunchRuntime
      alive: boolean
    }>()
    const launcher: Launcher = {
      instancesOutliveGateway: false,
      async start(runtime) {
        const state = states.get(runtime.ownerId)!
        starts.push(runtime.ownerId)
        state.runtime = runtime
        state.entered.resolve()
        await state.proceed.promise
        state.alive = true
        return { hasExited: () => !state.alive, terminate: async () => { state.alive = false } }
      },
    }
    const { deps, base, cookie, alice, db } = await setup(false, {
      HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_QUEUED: '1',
    }, launcher)
    const bob = await deps.users.create({ username: 'queued-bob', password: 'pw-12345678' })
    const cara = await deps.users.create({ username: 'refused-cara', password: 'pw-12345678' })
    const cookies = new Map([[alice.id, cookie]])
    for (const user of [alice, bob, cara]) {
      const state = { entered: barrier(), proceed: barrier(), alive: false, runtime: undefined as LaunchRuntime | undefined }
      states.set(user.id, state)
      const runtime = createServer((req, res) => {
        if (!state.alive || state.runtime === undefined) { res.writeHead(503).end(); return }
        if (req.url === RUNTIME_READINESS_PATH) {
          const credential = JSON.parse(state.runtime.gatewayCredential) as { token: string; runtime: { kind: 'user'; id: number; generation: number } }
          const nonce = req.headers[RUNTIME_READINESS_NONCE_HEADER]
          if (typeof nonce !== 'string') { res.writeHead(403).end(); return }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ version: 1, runtime: credential.runtime, proof: runtimeReadinessResponseProof(credential.token, nonce, credential.runtime) }))
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ runtimeUser: user.id }))
      })
      cleanup.push(async () => {
        if (!runtime.listening) return
        const closed = new Promise<void>((resolve, reject) => runtime.close(error => error ? reject(error) : resolve()))
        runtime.closeAllConnections()
        await closed
      })
      await new Promise<void>(resolve => runtime.listen(0, '127.0.0.1', resolve))
      db.prepare('UPDATE instances SET port=? WHERE user_id=?').run((runtime.address() as AddressInfo).port, user.id)
      if (user.id !== alice.id) {
        await deps.users.changeOwnPassword(user.id, 'pw-12345678')
        const login = await fetch(base + '/login', {
          method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: user.username, password: 'pw-12345678' }),
        })
        await login.body?.cancel()
        cookies.set(user.id, (login.headers.get('set-cookie') ?? '').split(';')[0]!)
      }
    }
    cleanup.push(async () => {
      for (const state of states.values()) state.proceed.resolve()
      await deps.instances.stopAll()
    })
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    cleanup.push(() => { process.off('unhandledRejection', onUnhandled) })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => log.mockRestore())
    const firstWaiting = await fetch(base + '/', { headers: { cookie: `${cookie}; hgw_lang=en`, accept: 'text/html' } })
    expect(firstWaiting.status).toBe(200)
    const firstWaitingPage = await firstWaiting.text()
    expect(firstWaitingPage).toContain('aria-busy="true"')
    expect(firstWaitingPage).toContain('<html lang="en">')
    expect(firstWaitingPage).toContain('Starting your workbench…')
    await expect(`${firstWaitingPage}\n`).toMatchFileSnapshot(fileURLToPath(new URL('./snapshots/runtime-gates/starting-en.expected.html', import.meta.url)))
    await states.get(alice.id)!.entered.promise
    expect(states.get(alice.id)!.alive).toBe(false)
    const first = deps.instances.startRequest(alice)
    expect(deps.instances.ensureRunning(alice)).toBe(first.completion)

    const queuedWaiting = await fetch(base + '/api/echo', { headers: { cookie: cookies.get(bob.id)! } })
    expect(queuedWaiting.status).toBe(503)
    expect(await queuedWaiting.json()).toMatchObject({ error: { code: 'INSTANCE_STARTING' } })
    const queued = deps.instances.startRequest(bob)
    expect(deps.instances.startRequest(bob)).toBe(queued)
    await expect(queued.admission).resolves.toBeUndefined()
    expect(starts).toEqual([alice.id])
    expect(deps.instances.capacitySnapshot?.().queued).toBe(1)
    const refusedHeaders: Record<string, string>[] = [{ cookie: cookies.get(cara.id)! }, { cookie: cookies.get(cara.id)!, accept: 'text/html' }]
    for (const headers of refusedHeaders) {
      const refused = await fetch(base + '/api/echo', { headers })
      expect(refused.status).toBe(503)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(await refused.json()).toMatchObject({ error: { code: 'INSTANCE_CAPACITY' } })
    }
    expect(starts).toEqual([alice.id])
    const cancelled = expect(first.completion).rejects.toMatchObject({ code: 'INSTANCE_CAPACITY', reason: 'cancelled' })
    const stopping = deps.instances.stop(alice.id)
    states.get(alice.id)!.proceed.resolve()
    await stopping
    await cancelled
    await states.get(bob.id)!.entered.promise
    states.get(bob.id)!.proceed.resolve()
    await queued.completion
    const warmBob = await fetch(base + '/api/echo', { headers: { cookie: cookies.get(bob.id)! } })
    expect(await warmBob.json()).toEqual({ runtimeUser: bob.id })

    const recovering = await fetch(base + '/api/echo', { headers: { cookie: cookies.get(cara.id)! } })
    expect(await recovering.json()).toMatchObject({ error: { code: 'INSTANCE_STARTING' } })
    const recovered = deps.instances.startRequest(cara)
    await deps.instances.stop(bob.id)
    await states.get(cara.id)!.entered.promise
    states.get(cara.id)!.proceed.resolve()
    await recovered.completion
    const warmCara = await fetch(base + '/api/echo', { headers: { cookie: cookies.get(cara.id)! } })
    expect(await warmCara.json()).toEqual({ runtimeUser: cara.id })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(unhandled).toEqual([])
    expect(deps.instances.capacitySnapshot?.()).toMatchObject({ resident: 1, starting: 0, queued: 0, rejected: 2 })
  })

  it('rewrites host and origin to the instance loopback authority and writes grants', async () => {
    const { deps, base, cookie, root } = await setup()
    // Deterministic startup (the manager's beforeStart writes the grants file).
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(200)
    const echoed = await response.json() as { host: string; origin: string }
    const port = await deps.instances.portOf(1)
    expect(echoed.host).toBe(`127.0.0.1:${port}`)
    expect(echoed.origin).toBe(`http://127.0.0.1:${port}`)
    expect(await deps.audit.query({ action: 'api' })).toEqual([])
    const grantsFile = join(root, 'users', 'alice', 'dsh', 'directory-grants.json')
    expect(existsSync(grantsFile)).toBe(true)
    expect(JSON.parse(readFileSync(grantsFile, 'utf8'))).toEqual(await deps.projects.effectiveGrants(1))
  })

  it('records the selected environment and actual generation when a routed API refuses work', async () => {
    const environment = {
      id: '00000000-0000-4000-8000-000000000091' as RuntimeId,
      nodeId: '00000000-0000-4000-8000-000000000092' as RuntimeNodeId,
    }
    const { deps, base, cookie } = await setup(false, {}, undefined, {
      async placement() { return { target: 'personal', local: true, resetScope: false } },
      async landing() { return { target: 'personal', local: true, resetScope: false } },
      async resolve(user) {
        return { context: { user, scope: { kind: 'personal' }, runtime: user, environment }, resetScope: false }
      },
    })
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/refused`, { headers: { cookie } })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('refused')
    const rows = await deps.audit.query({ action: 'api' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: 1, methodPath: 'GET /api/refused', status: 403 })
    expect(JSON.parse(rows[0]!.detail!)).toEqual({ runtimeId: environment.id, nodeId: environment.nodeId, generation: 1 })
  })

  it('does not create one audit row for every resumable upload data request', async () => {
    const { deps, base, cookie } = await setup()
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const uploadPath = '/api/documents/uploads/00000000-0000-4000-8000-000000000000'
    const chunk = await fetch(`${base}${uploadPath}/chunks/0`, {
      method: 'PUT',
      headers: {
        cookie,
        origin: base,
        'content-range': 'bytes 0-0/1',
        'content-length': '1',
      },
      body: 'x',
    })
    expect(chunk.status).toBe(200)
    const status = await fetch(`${base}${uploadPath}`, { headers: { cookie, origin: base } })
    expect(status.status).toBe(200)
    expect(await deps.audit.query({ action: 'api' })).toEqual([])
  })

  it('does not expose an upstream loopback redirect to the browser', async () => {
    const { deps, base, cookie } = await setup()
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/redirect`, {
      headers: { cookie, origin: base },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/landing')
    expect(response.headers.get('location')).not.toContain('127.0.0.1')

    const external = await fetch(`${base}/api/external-redirect`, {
      headers: { cookie, origin: base },
      redirect: 'manual',
    })
    expect(external.headers.get('location')).toBe('https://127.0.0.1.evil/landing')
  })

  it('keeps a manual stop through passive requests and starts only after the authorized form action', async () => {
    const { deps, base, cookie, alice } = await setup()
    await deps.instances.ensureRunning(alice)
    await deps.instances.stop(alice.id)
    const stopped = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } })
    expect(stopped.status).toBe(200)
    const page = await stopped.text()
    expect(page).toContain('启动并打开')
    expect(page).not.toContain('http-equiv="refresh"')
    const englishStopped = await fetch(`${base}/`, { headers: { cookie: `${cookie}; hgw_lang=en`, accept: 'text/html' } })
    const englishPage = await englishStopped.text()
    expect(englishPage).toContain('<html lang="en">')
    expect(englishPage).toContain('Start and open')
    await expect(`${englishPage}\n`).toMatchFileSnapshot(fileURLToPath(new URL('./snapshots/runtime-gates/stopped-en.expected.html', import.meta.url)))
    const englishApi = await fetch(`${base}/api/echo`, { headers: { cookie: `${cookie}; hgw_lang=en` } })
    expect(await englishApi.json()).toMatchObject({ error: { code: 'INSTANCE_STOPPED', message: expect.stringContaining('The workbench was stopped manually') } })
    const passive = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(passive.status).toBe(409)
    expect(await passive.json()).toMatchObject({ error: { code: 'INSTANCE_STOPPED' } })
    expect(await deps.instances.isLive(alice.id)).toBe(false)
    const request = { method: 'POST', redirect: 'manual' as const,
      headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'personal' }) }
    const forged = await fetch(`${base}/account/runtime/start`, { ...request, headers: { ...request.headers, origin: 'https://unrelated.invalid' } })
    expect(forged.status).toBe(403)
    deps.maintenanceGate = async () => 'maintenance'
    expect((await fetch(`${base}/account/runtime/start`, request)).status).toBe(503)
    expect(await deps.instances.stopReasonOf(alice.id)).toBe('manual')
    deps.maintenanceGate = async () => 'open'
    const start = await fetch(`${base}/account/runtime/start`, request)
    expect(start.status).toBe(302)
    expect(start.headers.get('location')).toBe('/')
    expect(await deps.instances.isLive(alice.id)).toBe(true)
    expect(await deps.instances.stopReasonOf(alice.id)).toBeNull()
  })

  it('shows the waiting page and respawns when a ready child has exited', async () => {
    const { deps, base, cookie } = await setup()
    const alice = (await deps.users.getByUsername('alice'))!
    await deps.instances.ensureRunning(alice)
    const port = await deps.instances.portOf(alice.id)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await new Promise(r => setTimeout(r, 50))
    expect(await deps.instances.isLive(alice.id)).toBe(false)
    const apiWaiting = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(apiWaiting.status).toBe(503)
    expect(apiWaiting.headers.get('retry-after')).toBe('2')
    expect(await apiWaiting.json()).toEqual({
      error: { code: 'INSTANCE_STARTING', message: 'The runtime is starting. Retry shortly.' },
    })
    const waiting = await fetch(base + '/', { headers: { cookie, accept: 'text/html' }, redirect: 'manual' })
    expect(waiting.status).toBe(200)
    expect(waiting.headers.get('cache-control')).toBe('no-store')
    expect(waiting.headers.get('retry-after')).toBe('2')
    const waitingHtml = await waiting.text()
    expect(waitingHtml).toContain('正在启动您的工作台')
    expect(waitingHtml).toContain('aria-busy="true"')
    expect(waitingHtml).toContain('startup-progress')
    expect(waitingHtml.indexOf('<meta http-equiv="refresh"')).toBeLessThan(waitingHtml.indexOf('</head>'))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !await deps.instances.isLive(alice.id)) {
      await new Promise(r => setTimeout(r, 100))
    }
    expect(await deps.instances.isLive(alice.id)).toBe(true)
    const proxied = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(proxied.status).toBe(200)
  })

  it('closes an admitted WebSocket on logout and requires new authentication', async () => {
    const { deps, base, cookie } = await setup(true)
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    cleanup.push(() => ws.terminate())
    await once(ws, 'message', { signal: AbortSignal.timeout(5000) })
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) })
    const response = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base } })
    expect(response.status).toBe(302)
    await closed
    expect((await fetch(`${base}/api/echo`, { headers: { cookie } })).status).toBe(401)
  })

  it('rechecks a login revoked while runtime admission is waiting', async () => {
    const { deps, base, cookie, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const admitted = barrier()
    const release = barrier()
    const original = deps.instances.operationRef!.bind(deps.instances)
    deps.instances.operationRef = async (target, delta, generation) => {
      await original(target, delta, generation)
      if (delta === 1) {
        admitted.resolve()
        await release.promise
      }
    }
    const response = fetch(`${base}/api/echo`, { headers: { cookie } })
    try {
      await admitted.promise
      await deps.auth.revoke(cookie.slice('hgw_session='.length))
      release.resolve()
      expect((await response).status).toBe(403)
    } finally {
      release.resolve()
      await response
    }
  })

  it('invalidates only matching targets and terminates in-flight HTTP bodies', async () => {
    const { deps, base, cookie, handlers, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.host`, { headers: { cookie, origin: base } })
    cleanup.push(() => ws.terminate())
    await once(ws, 'message', { signal: AbortSignal.timeout(5000) })
    handlers.invalidateAccess({ projectId: 999 })
    handlers.invalidateAccess({ userId: alice.id + 100 })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    const response = await fetch(`${base}/api/hold`, { headers: { cookie } })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) })
    const reading = reader.read()
    const ended = reading.then(
      next => { expect(next).toEqual({ done: true, value: undefined }) },
      (error: unknown) => { expect(error).toBeInstanceOf(Error) },
    )
    handlers.invalidateAccess({ userId: alice.id })
    await Promise.all([closed, ended])
    reader.releaseLock()
  })

  it('does not abort an event stream that idles past the upstream timeout', async () => {
    const { deps, base, cookie } = await setup(false, { HGW_UPSTREAM_TIMEOUT_MS: '100' })
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/sse`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toBe('data: open\n\ndata: tick\n\n')
  })

  it('aborts incomplete responses when the upstream resets', async () => {
    const { deps, base, cookie, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => spy.mockRestore())
    const port = await deps.instances.portOf(alice.id)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(`${base}/api/hang-headers`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }, resolve)
      const closed = new Promise<void>(done => request.once('close', done))
      cleanup.push(async () => { request.destroy(); await closed })
      request.once('error', reject)
    })
    expect(response.statusCode).toBe(200)
    const closed = new Promise<void>(resolve => response.once('close', resolve))
    const body = new Promise<Error | undefined>(resolve => {
      response.once('error', resolve)
      response.once('end', () => resolve(undefined))
      response.resume()
    })
    await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(5000) })
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('proxy response stream error'))
    }, { timeout: 5000 })
    expect(await body).toMatchObject({ code: 'ECONNRESET' })
    await closed
    expect(response.complete).toBe(false)
    // An unauthenticated request never reaches instance admission, so a fast
    // 401 proves the gateway itself is still serving after the upstream reset.
    const probe = await fetch(`${base}/api/echo`, { signal: AbortSignal.timeout(5000) })
    expect(probe.status).toBe(401)
  })

  it('absorbs a reset on an upgraded WebSocket connection', async () => {
    const { deps, base, cookie, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => spy.mockRestore())
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    cleanup.push(() => ws.terminate())
    await once(ws, 'message', { signal: AbortSignal.timeout(5000) })
    // A TCP reset on the client surface raises 'error' on the gateway-side
    // socket, which http-proxy-3 forwards as an unconditional server-level
    // 'error' event — unhandled, it used to crash the gateway process.
    const socket = (ws as WebSocket & { _socket?: Socket })._socket
    socket?.resetAndDestroy()
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('proxy upstream error'))
    }, { timeout: 5000 })
    const probe = await fetch(`${base}/api/echo`, { signal: AbortSignal.timeout(5000) })
    expect(probe.status).toBe(401)
  })

  it('logs the request path when a client disconnects before the response completes', async () => {
    const { deps, base, cookie, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cleanup.push(() => spy.mockRestore())
    const controller = new AbortController()
    const pending = fetch(`${base}/api/hold`, { headers: { cookie }, signal: controller.signal })
    await pending.then(response => expect(response.status).toBe(200))
    controller.abort()
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('client disconnected mid-response: GET /api/hold'))
    }, { timeout: 5000 })
  })

  it('proxies websocket upgrades with rewritten host', async () => {
    const { deps, base, cookie } = await setup()
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ws message in 5s')), 5000)
      ws.once('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.once('error', err => { clearTimeout(timer); reject(err) })
    })
    ws.close()
    const port = await deps.instances.portOf(1)
    expect(JSON.parse(first)).toEqual({ host: `127.0.0.1:${port}`, principal: null })
  })

  it('caps the first event grant at the existing login deadline and closes it without renewal', async () => {
    const { deps, base, cookie, signer, handlers, alice, db } = await setup(true)
    await deps.instances.ensureRunning(alice)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const deadline = Date.now() + 5000
    db.prepare('UPDATE auth_sessions SET expires_at=?,absolute_expires_at=?').run(deadline, deadline)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    cleanup.push(() => ws.terminate())
    try {
      const [message] = await once(ws, 'message', { signal: AbortSignal.timeout(5000) })
      const grant = signer!.verify((JSON.parse(String(message)) as { principal: string }).principal)
      expect(grant.expiresAt).toBe(deadline)
      expect(handlers.streamPrincipals?.size).toBe(1)
      const http = await fetch(`${base}/api/echo`, { headers: { cookie } })
      const httpGrant = signer!.verify(((await http.json()) as { principal: string }).principal)
      expect(httpGrant.expiresAt).toBeGreaterThan(deadline)
      const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) })
      await vi.advanceTimersByTimeAsync(5001)
      await closed
      expect(handlers.streamPrincipals?.size).toBe(0)
    } finally { ws.terminate(); vi.useRealTimers() }
  })

  it('refuses an event upgrade whose login loses eligibility after ordinary validation', async () => {
    const { deps, base, cookie, handlers, alice } = await setup(true)
    await deps.instances.ensureRunning(alice)
    const qualification = vi.spyOn(deps.auth, 'qualifyForStream').mockResolvedValueOnce(null)
    cleanup.push(() => qualification.mockRestore())
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.host`, { headers: { cookie, origin: base } })
    cleanup.push(() => ws.terminate())
    await once(ws, 'error', { signal: AbortSignal.timeout(5000) })
    expect(qualification).toHaveBeenCalledOnce()
    expect(handlers.streamPrincipals?.size).toBe(0)
  })

  it('replaces forged principal headers on HTTP and WebSocket requests', async () => {
    const { deps, base, cookie, signer } = await setup(true)
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'content-type': 'application/json',
        [PRINCIPAL_HEADER]: 'forged',
      },
      body: '{}',
    })
    const echoed = await response.json() as { principal: string }
    expect(echoed.principal).not.toBe('forged')
    expect(signer?.verify(echoed.principal).user.username).toBe('alice')

    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, {
      headers: { cookie, origin: base, [PRINCIPAL_HEADER]: 'forged' },
    })
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ws message in 5s')), 5000)
      ws.once('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.once('error', error => { clearTimeout(timer); reject(error) })
    })
    ws.close()
    const websocket = JSON.parse(first) as { principal: string }
    expect(websocket.principal).not.toBe('forged')
    expect(signer?.verify(websocket.principal).runtime).toEqual({ kind: 'user', id: 1, generation: 1 })
  })
})

describe('projectRuntimeGrants', () => {
  const steward = { kind: 'project' as const, id: 7, name: 'Steward', path: '/srv/steward/workspace', steward: true }
  const standard = { kind: 'project' as const, id: 8, name: 'Standard', path: '/srv/standard' }

  it('grants only the workspace read-write to a standard project', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-grants-'))
    try {
      const cfg = testConfig(root)
      expect(projectRuntimeGrants(cfg, standard)).toEqual([
        { path: '/srv/standard', mode: 'rw', label: 'Standard' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds the deployment collection and declared roots read-only for the steward', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-grants-'))
    try {
      const base = testConfig(root, {
        HGW_STEWARD: 'on',
        HGW_STEWARD_ROOT: join(root, 'steward'),
        HGW_STEWARD_READ_ROOTS: '["/srv/logs","/srv/more"]',
      })
      const cfg = { ...base, releaseRoot: '/srv/releases/coharness-abc' }
      expect(projectRuntimeGrants(cfg, steward)).toEqual([
        { path: '/srv/steward/workspace', mode: 'rw', label: 'Steward' },
        { path: '/srv/releases', mode: 'ro', label: '/srv/releases' },
        { path: '/srv/logs', mode: 'ro', label: '/srv/logs' },
        { path: '/srv/more', mode: 'ro', label: '/srv/more' },
      ])
      // Without a managed release layout the repository root is the deployment tree.
      expect(projectRuntimeGrants({ ...cfg, releaseRoot: undefined }, steward)[1])
        .toMatchObject({ path: base.dshRepoRoot, mode: 'ro' })
      expect(projectRuntimeGrants(cfg, standard)).toEqual([
        { path: '/srv/standard', mode: 'rw', label: 'Standard' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never projects gateway state or credential locations into steward grants', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-grants-'))
    try {
      const base = testConfig(root, { HGW_STEWARD: 'on', HGW_STEWARD_ROOT: join(root, 'steward') })
      const cfg = { ...base, releaseRoot: '/srv/releases/coharness-abc' }
      const sensitive = [
        base.stateRoot, base.principalKeyDir, base.runtimeCredentialDir,
        base.organizationModelCredentialKeyFile, base.webhookSecretKeyFile, base.databaseUrlFile,
      ].filter((path): path is string => path !== undefined)
      const paths = projectRuntimeGrants(cfg, steward).map(grant => grant.path)
      for (const secret of sensitive) {
        expect(paths.some(granted => secret.startsWith(`${granted}/`) || secret === granted)).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
