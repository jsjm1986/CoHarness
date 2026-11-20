/** Real Gateway startup against a private PostgreSQL database with every business checkout held. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { PostgresComputerAccess } from '../src/computer-access.ts'
import { INSTANCE_PROFILE } from '../src/instances.ts'
import { computeLaunchStamps } from '../src/launch-stamp.ts'
import { nodeLeaseSchema, type NodeCredential } from '../src/node-access.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { loadPrincipalKeys, PRINCIPAL_HEADER } from '../src/principal.ts'
import { SESSION_COOKIE } from '../src/server.ts'
import type { StreamPrincipalRenewals } from '../src/stream-principal-leases.ts'
import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
import { testConfig, testEnvironment } from './test-config.ts'

const gateway = resolve(import.meta.dirname, '..')

interface PoolState {
  backendPids: number[]
  max: number
  total: number
  idle: number
  waiting: number
}

async function within<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_done, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 10_000)
    timer.unref()
  })
  try { return await Promise.race([operation, timeout]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

function startGateway(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--import',
    new URL('./fixtures/gateway-control-saturation-preload.mjs', import.meta.url).href, join(gateway, 'src/index.ts')],
  { cwd: gateway, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 55_000, killSignal: 'SIGKILL' })
  const closed = new AbortController()
  let diagnostics = '', sequence = 0
  child.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-30_000) })
  child.stdout!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-30_000) })
  child.once('error', error => closed.abort(error))
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    child.once('close', (code, signal) => {
      closed.abort(new Error(`Gateway fixture exited (${String(code)}, ${String(signal)})\n${diagnostics}`))
      done({ code, signal })
    })
  })
  const ready = once(child, 'message', { signal: AbortSignal.any([closed.signal, AbortSignal.timeout(20_000)]) })
    .then(([message]) => {
      if (message.kind !== 'gateway-listening' || !Number.isInteger(message.port)) throw new Error('Gateway listener was not observed')
      return `http://127.0.0.1:${message.port}`
    })
  async function call(action: 'hold' | 'release' | 'state'): Promise<PoolState> {
    const id = ++sequence
    const response = once(child, 'message', { signal: AbortSignal.any([closed.signal, AbortSignal.timeout(10_000)]) })
    child.send({ id, action })
    const [message] = await response
    if (message.id !== id || message.error) throw new Error(`Saturation fixture IPC ${action} failed: ${message.error ?? 'unexpected response'}\n${diagnostics}`)
    return message.value
  }
  return { child, ready, call, exit, diagnostics: () => diagnostics }
}

/**
 * Exercise the serving Gateway with its full business pool held throughout each control operation.
 * @param databaseUrl - validated disposable PostgreSQL URL with permission to create a private fixture database.
 * @returns the keyless serving, revocation, and recovery observation as JSONL.
 */
export async function gatewayControlSaturationTranscript(databaseUrl: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hgw-control-saturation-'))
  const database = 'hgw_control_' + randomUUID().replaceAll('-', '') + '_test'
  const adminPool = createPostgresPool(databaseUrl, { max: 1 })
  const runtime = createServer((_req, res) => { res.writeHead(404).end() })
  const upstream = new WebSocketServer({ noServer: true })
  runtime.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://runtime').pathname !== '/api/events.mux') { socket.destroy(); return }
    upstream.handleUpgrade(req, socket, head, connection => upstream.emit('connection', connection, req))
  })
  let streams = 0
  upstream.on('connection', () => { streams++ })
  const lifecycle = new AbortController()
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  let deployed: ReturnType<typeof startGateway> | undefined
  let browser: WebSocket | undefined
  try {
    await adminPool.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl)
    url.pathname = `/${database}`
    pool = createPostgresPool(url.href, { max: 3, application_name: 'hgw-test-observer' })
    expect((await pool.query('SELECT current_database() AS name')).rows[0]?.name).toBe(database)
    await runMigrations(pool, join(gateway, 'deploy/postgres/migrations'))
    const slug = 'saturation-' + randomUUID(), name = 'saturation-center'
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Control saturation') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2),($1,'lease-owner')", [organization, name])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, name)
    const remote = await resolvePostgresRuntimeContext(pool, slug, 'lease-owner')
    await enableFixtureTopology(context)
    const runtimeRoot = join(root, 'runtime-source')
    const policyPackage = 'plugins/dsh-model-governance'
    await mkdir(join(runtimeRoot, policyPackage), { recursive: true })
    await Promise.all(['package.json', 'cordis.patch.yml'].map(file =>
      copyFile(resolve(gateway, '..', policyPackage, file), join(runtimeRoot, policyPackage, file))))
    const env = testEnvironment(root, {
      PATH: process.env.PATH, HGW_DATABASE_URL: url.href, HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: name,
      HGW_LAUNCHER: 'local', HGW_STEWARD: 'off', HGW_RECONCILE: 'off', HGW_DSH_REPO_ROOT: runtimeRoot, HGW_GUARD_PATCH: 'off',
      HGW_PORT: '8899', HGW_INTAKE_PORT: '8900', HGW_DATABASE_MAX_CONNECTIONS: '2', HGW_DATABASE_MIN_CONNECTIONS: '0',
      HGW_DATABASE_CONNECTION_TIMEOUT_MS: '15000', HGW_READINESS_TIMEOUT_MS: '3000', HGW_NODE_HEARTBEAT_MS: '200',
      HGW_ACCESS_INVALIDATION_POLL_MS: '60000', HGW_NODE_AGENT_LEASE_MS: '60000',
      NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
    })
    const cfg = testConfig(root, env)
    const users = new PostgresUserService(context, cfg)
    const admin = await users.create({ username: 'operator', password: 'fixture-password', role: 'admin' })
    const member = await users.create({ username: 'reader', password: 'fixture-password' })
    await users.changeOwnPassword(admin.id, 'fixture-password')
    await users.changeOwnPassword(member.id, 'fixture-password')
    const auth = new PostgresAuthService(context, cfg)
    const login = await auth.login(member.username, 'fixture-password', '127.0.0.1', 'saturation-fixture')
    const adminLogin = await auth.login(admin.username, 'fixture-password', '127.0.0.1', 'saturation-fixture')
    if (typeof login === 'string' || typeof adminLogin === 'string') throw new Error('Fixture authentication failed')

    const catalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog)
    const selected = await catalog.resolveForOwner(member, { kind: 'personal', id: member.id })
    const target = { kind: 'user' as const, id: member.id, runtimeId: selected.id }
    runtime.listen(0, '127.0.0.1')
    await once(runtime, 'listening')
    const port = (runtime.address() as AddressInfo).port
    const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)

    const nodes = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
    const ticket = await nodes.issue(admin, { requestId: randomUUID(), nodeId: remote.nodeId })
    const credential = ('dsh_node_' + randomBytes(32).toString('base64url')) as NodeCredential
    await nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'x64', credential })

    deployed = startGateway({ ...env, HGW_TEST_STREAM_PORT: String(port) })
    const entry = await deployed.ready
    const fetchDeadline = (path: string, init?: RequestInit) => fetch(entry + path, {
      ...init, signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(8000)]),
    })
    const requestNode = (action: 'connect' | 'heartbeat', payload: unknown) => fetchDeadline(`/internal/nodes/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const connectionId = randomUUID()
    const connected = await requestNode('connect', { connectionId, executionReady: true })
    const connectedBody = await connected.json()
    expect(connected.status, JSON.stringify(connectedBody)).toBe(200)
    const initialLease = nodeLeaseSchema.parse(connectedBody)
    // Startup has applied the password changes before this Runtime generation starts.
    const principal = loadPrincipalKeys(cfg.principalKeyDir, slug, cfg.principalAssertionTtlMs)
    const stamp = computeLaunchStamps(cfg, principal.publicKeyPem, INSTANCE_PROFILE).stampFor({ admin: false, kind: 'user', steward: false })
    const runtimeToken = randomBytes(32).toString('base64url')
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(runtimeToken).digest(), 'explicit', undefined, true, stamp)
    await pool.query('UPDATE harness.instances SET port=$1 WHERE organization_id=$2 AND runtime_id=$3', [port, organization, target.runtimeId])
    await repository.markReady(target, generation)
    await new NodeResourceBudget(pool, organization, context.nodeId, cfg.resourceBudget).register({ organizationId: organization, target, generation })

    const streamPath = `/api/events.mux?dshRuntime=${target.runtimeId}&dshTarget=personal&dshNode=${context.nodeId}`
    const cookie = `${SESSION_COOKIE}=${login.token}`
    const upstreamConnection = once(upstream, 'connection', { signal: lifecycle.signal }) as Promise<[WebSocket, IncomingMessage]>
    browser = new WebSocket(entry.replace('http:', 'ws:') + streamPath, { headers: { cookie }, origin: cfg.publicOrigins[0], handshakeTimeout: 8000 })
    const browserOpen = once(browser, 'open', { signal: lifecycle.signal })
    const initialFrame = once(browser, 'message', { signal: lifecycle.signal })
    void initialFrame.catch(() => { /* the upstream assertion below can fail before the first frame is read */ })
    const [[runtimeSocket, forwarded]] = await within(Promise.all([upstreamConnection, browserOpen]), 'Gateway did not forward the browser event stream')
      .catch(async (cause: unknown) => {
        const state = await repository.snapshotOf(target)
        throw new Error(`Gateway did not admit the browser stream for Runtime generation ${state.generation} (${state.state})\n${deployed!.diagnostics()}`, { cause })
      })
    const assertion = forwarded.headers[PRINCIPAL_HEADER]
    if (typeof assertion !== 'string') throw new Error('Gateway did not sign the browser event stream')
    const originalClaims = principal.signer.verify(assertion)
    expect(originalClaims).toMatchObject({ user: { id: member.id }, runtime: { ...target, generation } })
    const browserClosed = once(browser, 'close').then(([code]) => ({ code, closedAt: Date.now() }))
    const upstreamClosed = once(runtimeSocket, 'close').then(([code]) => code)
    void Promise.allSettled([browserClosed, upstreamClosed])
    runtimeSocket.send('admitted')
    expect(String((await within(initialFrame, 'Admitted browser did not receive the upstream frame'))[0])).toBe('admitted')

    const held = await deployed.call('hold')
    expect(held).toMatchObject({ max: 2, total: 2, idle: 0 })
    expect(new Set(held.backendPids).size).toBe(held.max)
    const liveBusinessPids = async () => (await pool!.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='dsh-gateway' ORDER BY pid`)).rows.map(row => row.pid)
    expect(await liveBusinessPids()).toEqual(held.backendPids.toSorted((a, b) => a - b))
    const observerPids = async (applicationName: string) => (await pool!.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 ORDER BY pid`, [applicationName])).rows.map(row => row.pid)
    expect(await observerPids(`hgw-access:${name}`)).toHaveLength(1)

    let adminStatus: number | undefined
    const adminRequest = fetch(entry + '/account/api/context', {
      headers: { cookie: `${SESSION_COOKIE}=${adminLogin.token}` }, signal: lifecycle.signal,
    })
      .then(async value => { await value.text(); adminStatus = value.status; return value.status })
    void adminRequest.catch(() => { /* the assertion after release observes the original request */ })
    await expect.poll(async () => (await deployed!.call('state')).waiting).toBeGreaterThan(0)
    const serving = await requestNode('heartbeat', { connectionId, epoch: initialLease.epoch })
    const servingBody = await serving.json()
    expect(serving.status, JSON.stringify(servingBody)).toBe(200)
    const servingLease = nodeLeaseSchema.parse(servingBody)
    expect(servingLease).toMatchObject({ nodeId: remote.nodeId, connectionId, epoch: initialLease.epoch })

    const renewBrowser = (token: string) => fetchDeadline('/internal/runtime/stream-principals/renew', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, leaseIds: [originalClaims.nonce] }),
    })
    const foreignBrowser = await renewBrowser(randomUUID())
    expect(foreignBrowser.status).toBe(401)
    expect(await foreignBrowser.json()).toEqual({ error: 'invalid-runtime-token' })
    const browserRenewal = await renewBrowser(runtimeToken)
    const browserRenewalBody: StreamPrincipalRenewals = await browserRenewal.json()
    expect(browserRenewal.status).toBe(200)
    expect(browserRenewalBody).toMatchObject({ version: 1, leases: [{ leaseId: originalClaims.nonce, status: 'renewed' }] })
    const replacement = browserRenewalBody.leases[0]!
    if (replacement.status !== 'renewed') throw new Error('Runtime could not renew the admitted browser event stream')
    const renewedClaims = principal.signer.verify(replacement.assertion)
    expect(renewedClaims).toMatchObject({ user: originalClaims.user, runtime: originalClaims.runtime, scope: originalClaims.scope })
    expect(renewedClaims.nonce).not.toBe(originalClaims.nonce)
    expect(renewedClaims.expiresAt).toBeGreaterThan(originalClaims.expiresAt)

    const control = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    const maintenance = await control.enterMaintenance(null, 'Saturation fixture')
    await expect.poll(async () => (await pool!.query(`SELECT maintenance_applied_epoch::text AS epoch FROM harness.compute_nodes
      WHERE id=$1`, [context.nodeId])).rows[0]?.epoch, { timeout: 8000 }).toBe(String(maintenance.maintenanceEpoch))
    const maintenanceFrame = once(browser, 'message', { signal: lifecycle.signal })
    runtimeSocket.send('under-maintenance')
    expect(String((await within(maintenanceFrame, 'Browser event stream closed before permission withdrawal'))[0])).toBe('under-maintenance')
    const permission = new PostgresComputerAccess(context, cfg.runtimeCatalog)
    const grant = (await permission.page(admin, {}, member.id)).items.find(row => row.nodeId === context.nodeId)!
    const withdrawalStarted = Date.now()
    expect(await permission.set(admin, member.id, context.nodeId, { enabled: false, revision: grant.revision })).toMatchObject({ enabled: false })
    const browserClose = await within(browserClosed, 'Browser event stream stayed open after permission withdrawal')
    expect(browserClose.code).toBe(1006)
    expect(browserClose.closedAt).toBeGreaterThanOrEqual(withdrawalStarted)
    expect(browserClose.closedAt).toBeLessThan(renewedClaims.expiresAt)
    const closedBeforeRelease = await within(upstreamClosed, 'Upstream Runtime stream stayed open after permission withdrawal')
    expect(closedBeforeRelease).toBe(1006)
    await expect.poll(async () => (await deployed!.call('state')).waiting).toBeGreaterThan(1)
    // The first probe runs after revocation while the Runtime stop is waiting for business capacity.
    const readiness = await fetchDeadline('/healthz/ready')
    expect(await readiness.json()).toMatchObject({ ok: true })
    expect(readiness.status).toBe(200)
    const accessAckPending = (await pool.query(`SELECT n.access_applied_revision<o.access_revision AS pending
      FROM harness.compute_nodes n JOIN harness.organizations o ON o.id=n.organization_id WHERE n.id=$1`,
    [context.nodeId])).rows[0]?.pending
    expect(accessAckPending).toBe(true)

    const readDurableLease = async () => (await pool!.query<{ connection_id: string; connection_epoch: string; lease_expires_at: Date }>(`SELECT
      connection_id,connection_epoch::text,lease_expires_at FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2`, [organization, remote.nodeId])).rows[0]!
    const rejected = await requestNode('heartbeat', { connectionId, epoch: String(BigInt(initialLease.epoch) + 1n) })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ error: 'node-access/lease-lost' })
    expect(await readDurableLease()).toEqual({ connection_id: connectionId, connection_epoch: initialLease.epoch, lease_expires_at: new Date(servingLease.expiresAt) })
    const renewed = await requestNode('heartbeat', { connectionId, epoch: initialLease.epoch })
    const renewedBody = await renewed.json()
    expect(renewed.status, JSON.stringify(renewedBody)).toBe(200)
    const currentLease = nodeLeaseSchema.parse(renewedBody)
    expect(currentLease).toMatchObject({ nodeId: remote.nodeId, connectionId, epoch: initialLease.epoch })
    expect(Date.parse(currentLease.expiresAt)).toBeGreaterThan(Date.parse(servingLease.expiresAt))
    expect(await readDurableLease()).toEqual({ connection_id: connectionId, connection_epoch: initialLease.epoch, lease_expires_at: new Date(currentLease.expiresAt) })
    expect(await observerPids(`hgw-control:${name}`)).not.toHaveLength(0)
    expect(await deployed.call('state')).toMatchObject({ backendPids: held.backendPids, max: 2, total: 2, idle: 0 })
    expect(await liveBusinessPids()).toEqual(held.backendPids.toSorted((a, b) => a - b))
    expect(adminStatus).toBeUndefined()

    await deployed.call('release')
    expect(await within(adminRequest, 'Ordinary request did not finish after releasing the business pool')).toBe(200)
    await expect.poll(async () => (await pool!.query(`SELECT c.access_applied_revision=o.access_revision AND i.observed_state='stopped' AS settled
      FROM harness.compute_nodes c JOIN harness.organizations o ON o.id=c.organization_id
      JOIN harness.instances i ON i.organization_id=o.id WHERE c.id=$1 AND i.runtime_id=$2`, [context.nodeId, target.runtimeId])).rows[0]?.settled, { timeout: 8000 }).toBe(true)
    const denied = await fetchDeadline(streamPath, { headers: { cookie }, redirect: 'manual' })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'computer-access/forbidden' })
    expect(streams).toBe(1)
    deployed.child.kill('SIGTERM')
    expect(await within(deployed.exit, 'Gateway did not drain its PostgreSQL pools on shutdown')).toEqual({ code: 0, signal: null })
    await expect.poll(async () => Promise.all([
      liveBusinessPids(), observerPids(`hgw-control:${name}`), observerPids(`hgw-access:${name}`),
    ])).toEqual([[], [], []])
    const observation = {
      business: { held: held.backendPids.length, max: held.max, waiting: true, usedByControl: false, recovered: true },
      readinessDuringRuntimeCleanup: readiness.status,
      accessAckPending,
      admittedStream: { open: true, renewal: browserRenewal.status, wrongBearer: foreignBrowser.status, browserClose: browserClose.code, upstreamClose: closedBeforeRelease, resumed: false },
      lease: { staleStatus: rejected.status, servingStatus: serving.status, maintenanceStatus: renewed.status, sameEpoch: true },
      revokedScopeAfterRelease: denied.status,
      shutdownReleasedPools: true,
    }
    return JSON.stringify(observation) + '\n'
  } finally {
    lifecycle.abort()
    browser?.terminate()
    for (const socket of upstream.clients) socket.terminate()
    try {
      if (deployed !== undefined && deployed.child.exitCode === null && deployed.child.signalCode === null) {
        try { await deployed.call('release'); deployed.child.kill('SIGTERM') }
        catch { if (deployed.child.exitCode === null && deployed.child.signalCode === null) deployed.child.kill('SIGKILL') }
      }
      await deployed?.exit
    } finally {
      runtime.closeAllConnections()
      if (runtime.listening) await new Promise<void>(done => runtime.close(() => done()))
      await new Promise<void>(done => upstream.close(() => done()))
      try { await pool?.end() }
      finally {
        try { if (created) await adminPool.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
        finally { try { await adminPool.end() } finally { await rm(root, { recursive: true, force: true }) } }
      }
    }
  }
}
