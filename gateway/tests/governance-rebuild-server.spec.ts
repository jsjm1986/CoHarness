/** Real HTTP and upgrade admission for the normal Gateway's restricted recovery entry. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import type { GatewayForwardClaims } from '../src/forwarded-principal.ts'
import { InstanceManager } from '../src/instances.ts'
import { NODE_CHANNEL_PATH } from '../src/node-channel-protocol.ts'
import { NODE_SERVICE_IDENTITY_PATH, NODE_SERVICE_STREAM_PATH, NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import { ProjectService } from '../src/projects.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { createGatewayServer, type GatewayDeps, type GatewayHandlers } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { testConfig } from './test-config.ts'

const RECOVERY = '/admin/api/governance-recovery'
const PAGE = '/admin/governance-recovery'
const LOCAL_PAGE = `${PAGE}/local`
const PASSWORD = 'fixture-password-123'

async function fixture(restricted = true) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-governance-entry-'))
  const cfg = testConfig(root)
  const db = openDb(join(root, 'gateway.sqlite'))
  let server: ReturnType<typeof createGatewayServer> | undefined
  onTestFinished(async () => {
    const running = server
    if (running !== undefined) {
      running.closeAllConnections()
      if (running.listening) await new Promise<void>((resolve, reject) => running.close(error => error ? reject(error) : resolve()))
    }
    try { db.close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const auth = new AuthService(db, cfg), users = new UserService(db, cfg)
  const admin = await users.create({ username: 'bootstrap', password: PASSWORD, role: 'admin' })
  const other = await users.create({ username: 'other-admin', password: PASSWORD, role: 'admin' })
  await users.changeOwnPassword(admin.id, PASSWORD)
  await users.changeOwnPassword(other.id, PASSWORD)
  const initialAdmin = await auth.login('bootstrap', PASSWORD, '', '')
  const initialOther = await auth.login('other-admin', PASSWORD, '', '')
  if (typeof initialAdmin === 'string' || typeof initialOther === 'string') throw new Error('fixture account login failed')
  const snapshot = { operationId: randomUUID(), bootstrapUserId: admin.id, state: 'review' as 'review' | 'released' }
  const admission = vi.fn(async () => snapshot)
  const verifyAdministration = vi.fn(async () => {})
  const ordinary = vi.fn<NonNullable<GatewayHandlers['admin']>>(async (_req, res) => { res.writeHead(200).end('ordinary-admin'); return true })
  const recovery = vi.fn<NonNullable<GatewayHandlers['governanceRecovery']>['admin']>(async (_req, res, actor, ingress) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ actor, directLocal: ingress.directLocal }))
    return true
  })
  const internal = vi.fn<NonNullable<GatewayHandlers['peerBackups']>['internal']>(async (_req, res) => { res.end('unexpected-peer'); return true })
  const proxy = vi.fn<NonNullable<GatewayDeps['nodeServiceProxy']>['http']>(async () => false)
  const upgrade = vi.fn<NonNullable<GatewayHandlers['upgrade']>>(async (_req, socket) => { socket.end() })
  const channel = vi.fn<NonNullable<GatewayDeps['nodeChannels']>['accept']>(async (_req, socket) => { socket.end() })
  const serviceStream = vi.fn<NonNullable<GatewayDeps['nodeServices']>['accept']>(async (_req, socket) => { socket.end() })
  const deps: GatewayDeps = {
    cfg, auth, users, audit: new AuditService(db), projects: new ProjectService(db, cfg), instances: new InstanceManager(db, cfg),
    ...(restricted ? { governanceRecovery: { admission, verifyAdministration } } : {}),
    nodeServiceProxy: { http: proxy, upgrade: vi.fn(async () => false) },
    nodeChannels: { accept: channel, probe: vi.fn(), revoke: vi.fn() },
    nodeServices: { accept: serviceStream, revoke: vi.fn() },
  }
  const start = vi.spyOn(deps.instances, 'ensureRunning')
  const adminRoot = join(root, 'admin')
  await mkdir(join(adminRoot, 'assets'), { recursive: true })
  await writeFile(join(adminRoot, 'index.html'), '<!doctype html><title>Recovery entry</title>')
  await writeFile(join(adminRoot, 'assets', 'recovery.js'), '/* recovery fixture asset */')
  const running = server = createGatewayServer(deps, { admin: ordinary, governanceRecovery: { admin: recovery }, upgrade,
    peerBackups: { internal, admin: vi.fn(async () => false) }, adminRoot })
  await new Promise<void>(resolve => running.listen(0, '127.0.0.1', resolve))
  const port = (running.address() as AddressInfo).port, base = `http://127.0.0.1:${port}`
  cfg.publicOrigins.push(base)
  const cookie = `hgw_session=${initialAdmin.token}`, otherCookie = `hgw_session=${initialOther.token}`
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init, redirect: 'manual', headers: { cookie, origin: base, ...init.headers },
  })
  return { deps, snapshot, admission, verifyAdministration, ordinary, recovery, internal, proxy, upgrade, channel, serviceStream, start,
    request, base, port, cookie, otherCookie, token: initialAdmin.token, admin: initialAdmin.user }
}

function upgradeRequest(port: number, path: string, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    socket.setTimeout(5000, () => { socket.destroy(new Error('fixture upgrade timeout')) })
    socket.on('error', reject)
    socket.on('data', chunk => { chunks.push(chunk) })
    socket.on('close', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Z292ZXJuYW5jZS10ZXN0IQ==\r\nCookie: ${cookie}\r\n\r\n`))
  })
}

it('blocks business, ordinary Admin, internal and maintenance-exempt routes before their handlers', async () => {
  const f = await fixture()
  const maintenance = vi.fn(async () => 'open' as const)
  f.deps.maintenanceGate = maintenance
  const paths = ['/api/sessions', '/account/api/workbench/context', '/admin/users', '/admin/api/users',
    '/admin/api/deployment/topology', '/admin/api/backups', '/internal/runtime/authorize', '/internal/peer-backups/repositories',
    '/internal/nodes/enroll', '/internal/nodes/connect', NODE_SERVICE_IDENTITY_PATH, '/webhook/1', '/plugins/events']
  for (const path of paths) {
    const response = await f.request(path, { method: path.startsWith('/internal/') || path.includes('/backups') || path.startsWith('/webhook/') ? 'POST' : 'GET' })
    expect(response.status, path).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'governance-recovery-required' })
  }
  expect((await f.request('/healthz/live')).status).toBe(200)
  expect((await f.request('/healthz/ready')).status).toBe(200)
  for (const spy of [maintenance, f.ordinary, f.internal, f.proxy, f.start]) expect(spy).not.toHaveBeenCalled()
})

it('admits only the bootstrap administrator and preserves password, CSRF, logout and static recovery entry handling', async () => {
  const f = await fixture()
  const revoke = vi.spyOn(f.deps.auth, 'revoke')
  const login = (username: string) => f.request('/login?returnTo=%2Fadmin%2Fusers', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: PASSWORD, returnTo: '/' }) })
  const refused = await login('other-admin')
  expect(refused.status).toBe(401)
  expect(refused.headers.get('set-cookie')).toBeNull()
  expect(revoke).toHaveBeenCalledOnce()
  const admitted = await login('bootstrap')
  expect(admitted.status).toBe(302)
  expect(admitted.headers.get('location')).toBe(PAGE)
  expect(admitted.headers.get('set-cookie')).toContain('hgw_session=')
  expect((await f.request(RECOVERY, { headers: { cookie: f.otherCookie } })).status).toBe(403)
  expect((await f.request(PAGE, { headers: { cookie: '' } })).status).toBe(401)
  for (const path of ['/', '/admin']) expect((await f.request(path)).headers.get('location')).toBe(PAGE)
  expect(await (await f.request(PAGE)).text()).toContain('Recovery entry')
  expect(await (await f.request('/admin/assets/recovery.js')).text()).toContain('fixture asset')
  expect((await f.request(PAGE, { method: 'POST' })).status).toBe(503)
  expect((await f.request(RECOVERY, { method: 'POST', headers: { origin: 'https://wrong.invalid' }, body: '{}' })).status).toBe(403)
  expect(f.recovery).not.toHaveBeenCalled()
  const validate = vi.spyOn(f.deps.auth, 'validate')
  validate.mockResolvedValueOnce({ ...f.admin, mustChangePassword: true })
  expect((await f.request(RECOVERY)).status).toBe(403)
  validate.mockResolvedValueOnce({ ...f.admin, mustChangePassword: true })
  expect((await f.request('/account/password')).status).toBe(200)
  const password = await f.request('/account/password', { method: 'POST', body: new URLSearchParams({ password: PASSWORD, returnTo: '/api/sessions' }) })
  expect(password.status).toBe(302)
  expect(password.headers.get('location')).toBe(PAGE)
  expect((await f.request('/logout', { method: 'POST' })).headers.get('location')).toBe('/login')
  expect(f.ordinary).not.toHaveBeenCalled()
  expect(f.proxy).not.toHaveBeenCalled()
})

it('dispatches recovery API before selected targets and allows its own transactions while maintenance stays closed', async () => {
  const f = await fixture()
  const maintenance = vi.fn(async () => 'maintenance' as const)
  f.deps.maintenanceGate = maintenance
  const result = await f.request(RECOVERY, { method: 'POST', headers: { cookie: `${f.cookie}; hgw_scope=project:42`, referer: `${f.base}/?dshRuntime=${randomUUID()}` }, body: '{}' })
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ actor: f.admin.id, directLocal: true })
  expect(maintenance).not.toHaveBeenCalled()
  for (const selector of ['dshNode', 'dshRuntime', 'dshTarget']) {
    expect((await f.request(`${RECOVERY}?${selector}=foreign`)).status).toBe(409)
    expect((await f.request(`${PAGE}?${selector}=foreign`)).status).toBe(409)
  }
  expect(f.recovery).toHaveBeenCalledOnce()
  expect(f.proxy).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  f.snapshot.state = 'released'
  const released = await f.request(RECOVERY, { method: 'POST', body: '{}' })
  expect(released.status).toBe(503)
  expect(await released.json()).toEqual({ error: 'maintenance' })
  expect(maintenance).toHaveBeenCalledOnce()
  expect(f.recovery).toHaveBeenCalledOnce()
})

it('derives direct-local inspection from verified forwarding facts, never from a browser header', async () => {
  const f = await fixture()
  const node = randomUUID() as RuntimeNodeId
  f.deps.nodeServiceIdentity = { nodeId: node, organizationId: randomUUID(), authorize: vi.fn() }
  const claims: GatewayForwardClaims = {
    version: 1, issuer: 'harness-gateway', audience: 'dsh-node', issuerNode: randomUUID() as RuntimeNodeId,
    audienceNode: node, organization: f.deps.nodeServiceIdentity.organizationId, user: f.admin,
    issuedAt: 1, expiresAt: 2, nonce: 'fixture-verified-forward',
    request: { method: 'GET', path: RECOVERY, sessionHash: createHash('sha256').update(f.token).digest('hex') },
  }
  const verify = vi.fn<NonNullable<GatewayDeps['forwardedPrincipal']>>(async assertion => assertion === 'verified' ? claims : null)
  f.deps.forwardedPrincipal = verify
  const forwarded = await f.request(RECOVERY, { headers: { [NODE_SERVICE_TARGET_HEADER]: node, 'x-dsh-gateway-forward': 'verified' } })
  expect(await forwarded.json()).toEqual({ actor: f.admin.id, directLocal: false })
  const spoofed = await f.request(RECOVERY, { headers: { [NODE_SERVICE_TARGET_HEADER]: node, 'x-dsh-gateway-forward': 'browser-unverified' } })
  expect(await spoofed.json()).toEqual({ actor: f.admin.id, directLocal: true })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(f.proxy).not.toHaveBeenCalled()
})

it('rejects browser and node-channel upgrades before any socket owner can adopt them', async () => {
  const f = await fixture()
  for (const path of ['/api/events', NODE_CHANNEL_PATH, `${NODE_SERVICE_STREAM_PATH}${randomUUID()}`]) {
    const response = await upgradeRequest(f.port, path, f.cookie)
    expect(response).toContain('HTTP/1.1 503 Service Unavailable')
    expect(response).toContain('governance-recovery-required')
  }
  for (const spy of [f.upgrade, f.channel, f.serviceStream, f.proxy, f.start]) expect(spy).not.toHaveBeenCalled()
})

it('returns normal routing after release and leaves untouched organizations without a recovery admission dependency', async () => {
  const f = await fixture()
  f.snapshot.state = 'released'
  expect(await (await f.request(PAGE)).text()).toContain('Recovery entry')
  expect(f.proxy).not.toHaveBeenCalled()
  expect(await (await f.request('/admin/api/users')).text()).toBe('ordinary-admin')
  expect(f.ordinary).toHaveBeenCalledOnce()
  expect(f.verifyAdministration).not.toHaveBeenCalled()
  const normal = await fixture(false)
  expect(await (await normal.request('/admin/api/users')).text()).toBe('ordinary-admin')
  expect(normal.admission).not.toHaveBeenCalled()
})

it('rechecks the database generation for recovery administration after ordinary admission is released', async () => {
  const f = await fixture()
  f.snapshot.state = 'released'
  f.verifyAdministration.mockRejectedValue(new Error('replaced-database'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => log.mockRestore())
  expect((await f.request(RECOVERY)).status).toBe(503)
  expect(f.verifyAdministration).toHaveBeenCalledOnce()
  expect(f.recovery).not.toHaveBeenCalled()
})

it('serves the local recovery page only to a directly connected administrator after release', async () => {
  const f = await fixture()
  expect((await f.request(LOCAL_PAGE)).status).toBe(503)
  f.snapshot.state = 'released'
  expect(await (await f.request(LOCAL_PAGE)).text()).toContain('Recovery entry')
  for (const selector of ['dshNode', 'dshRuntime', 'dshTarget']) {
    expect((await f.request(`${LOCAL_PAGE}?${selector}=foreign`)).status).toBe(409)
  }
  const validate = vi.spyOn(f.deps.auth, 'validate')
  validate.mockResolvedValueOnce({ ...f.admin, role: 'user' })
  expect((await f.request(LOCAL_PAGE)).status).toBe(403)
  const node = randomUUID() as RuntimeNodeId
  f.deps.nodeServiceIdentity = { nodeId: node, organizationId: randomUUID(), authorize: vi.fn() }
  f.deps.forwardedPrincipal = async () => ({
    version: 1, issuer: 'harness-gateway', audience: 'dsh-node', issuerNode: randomUUID() as RuntimeNodeId,
    audienceNode: node, organization: f.deps.nodeServiceIdentity!.organizationId, user: f.admin,
    issuedAt: 1, expiresAt: 2, nonce: 'fixture-local-page-forward',
    request: { method: 'GET', path: LOCAL_PAGE, sessionHash: createHash('sha256').update(f.token).digest('hex') },
  })
  expect((await f.request(LOCAL_PAGE, { headers: { [NODE_SERVICE_TARGET_HEADER]: node, 'x-dsh-gateway-forward': 'verified' } })).status).toBe(409)
  expect(f.ordinary).not.toHaveBeenCalled()
  expect(f.proxy).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  const normal = await fixture(false)
  expect((await normal.request(LOCAL_PAGE)).status).toBe(404)
})

it('fails closed on an unreadable recovery epoch without returning database diagnostics', async () => {
  const f = await fixture()
  f.admission.mockRejectedValue(new Error('fixture-private-database-diagnostic'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => log.mockRestore())
  const response = await f.request(RECOVERY)
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ error: 'peer-backup/governance-admission-unavailable' })
  const upgrade = await upgradeRequest(f.port, NODE_CHANNEL_PATH, f.cookie)
  expect(upgrade).toContain('HTTP/1.1 503 Service Unavailable')
  expect(upgrade).not.toContain('fixture-private-database-diagnostic')
  expect(log).toHaveBeenCalledTimes(2)
  for (const spy of [f.recovery, f.ordinary, f.channel, f.start]) expect(spy).not.toHaveBeenCalled()
})
