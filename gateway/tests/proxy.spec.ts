import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'
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
  if (req.url === '/api/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: open\\n\\n')
    const timer = setTimeout(() => { res.write('data: tick\\n\\n'); res.end() }, 250)
    req.on('close', () => clearTimeout(timer))
    return
  }
  if (req.url === '/api/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:' + process.argv[1] + '/landing' }); res.end(); return }
  if (req.url === '/api/external-redirect') { res.writeHead(302, { location: 'https://127.0.0.1.evil/landing' }); res.end(); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ host: req.headers.host, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null })) })
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], String(server.address().port))
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

/** Hold the assigned Gateway endpoint while each real child binds its own ephemeral port. */
async function runtimeRelay(portFile: string): Promise<number> {
  const sockets = new Set<Socket>()
  const relay = createServer((downstream) => {
    sockets.add(downstream)
    downstream.on('close', () => sockets.delete(downstream))
    // The manager retries signed readiness while the child publishes its listener.
    let port: number
    try { port = Number(readFileSync(portFile, 'utf8')) } catch (error) {
      downstream.destroy()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      downstream.destroy()
      throw new Error('fixture child published an invalid listener')
    }
    const upstream = connect(port, '127.0.0.1')
    sockets.add(upstream)
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.on('close', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    downstream.pipe(upstream).pipe(downstream)
  })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (relay.listening) await new Promise<void>((resolve, reject) => {
      relay.close(error => error ? reject(error) : resolve())
    })
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  return (relay.address() as AddressInfo).port
}

async function setup(withPrincipal = false, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'g.sqlite'))
  cleanup.push(() => { db.close() })
  const portFile = join(root, 'child-port')
  const port = await runtimeRelay(portFile)
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_READINESS_TIMEOUT_MS: '10000', HGW_INSTANCE_PORT_BASE: String(port), ...env })
  cfg.dshCommand = [process.execPath, '-e', ECHO_DSH, '{port}', portFile]
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
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
  return { deps, base, cookie, root, signer, handlers, alice }
}

describe('proxy handlers', () => {
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
    const audited = await deps.audit.query({ action: 'api' })
    expect(audited[0]?.methodPath).toBe('POST /api/echo')
    const grantsFile = join(root, 'users', 'alice', 'dsh', 'directory-grants.json')
    expect(existsSync(grantsFile)).toBe(true)
    expect(JSON.parse(readFileSync(grantsFile, 'utf8'))).toEqual(await deps.projects.effectiveGrants(1))
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
