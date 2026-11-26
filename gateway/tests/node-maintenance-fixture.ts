/** Isolated PostgreSQL and real HTTP assembly for maintenance control-lease scenarios. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { InstanceManager } from '../src/instances.ts'
import { NodeAccessError } from '../src/node-access.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { testConfig } from './test-config.ts'

/** Create an independently owned organization and bound loopback Gateway. @param pool - disposable test database. @returns fixture with awaited disposal. */
export async function nodeMaintenanceFixture(pool: Pool) {
  const releases: Array<() => Promise<void>> = []
  async function close() {
    const errors: unknown[] = []
    for (const release of releases.splice(0).reverse()) {
      try { await release() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Node maintenance fixture cleanup failed')
  }
  try {
    const root = await mkdtemp(join(tmpdir(), 'node-maintenance-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `maintenance-${randomUUID()}`
    const org = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Maintenance lease') RETURNING id", [slug])).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, org))
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'center')", [org])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [org])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'center')
    await enableFixtureTopology(context)
    const cfg = testConfig(root, { HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'center' })
    const users = new PostgresUserService(context, cfg)
    const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    const nodes = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
    const maintenance = new PostgresMaintenanceService(context, 60_000)
    const baseline = await maintenance.currentWriteEpoch()
    const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
    let starts = 0, writes = 0, writerAdmissions = 0, shutdown = false
    const instances = new InstanceManager(repository, cfg, { instancesOutliveGateway: false,
      start: async () => { starts++; throw new Error('This fixture never starts a Runtime') } })
    releases.push(() => instances.stopAll())
    const deps: GatewayDeps = { cfg, users, instances, nodeAccess: nodes, maintenance,
      auth: new PostgresAuthService(context, cfg), projects: new PostgresProjectService(context, cfg), audit: new PostgresAuditService(context),
      maintenanceGate: async () => shutdown ? 'maintenance' : (await maintenance.writeGate(baseline)).verdict,
      maintainNodeConnection: (operation, token, input) => {
        if (shutdown) throw new NodeAccessError(503, 'node-access/unavailable')
        return nodes.maintainConnection(operation, token, input, baseline)
      },
      writerSpan: () => { writes++; writerAdmissions++; return () => { writes-- } },
    }
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), runtimeAuthorize: async request => {
      const bearer = request.headers.authorization
      return bearer?.startsWith('Bearer ') === true && await repository.authenticateRuntimeToken(bearer.slice(7)) !== null
    } })
    releases.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      if (!server.listening) { done(); return }
      server.close(error => error ? reject(error) : done())
    }))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cfg.publicOrigins.push(base)
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
      body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }) })
    await login.arrayBuffer(); expect(login.status).toBe(302)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    async function request(path: string, input: unknown, token?: string) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin: base, cookie,
        'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(input) })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    async function node(name: string, managed = true) {
      const ticket = await nodes.issue(admin, { name, requestId: randomUUID() })
      const token = `dsh_node_${randomBytes(32).toString('base64url')}`
      await nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'x64', credential: token })
      const connectionId = randomUUID()
      const lease = managed ? await nodes.connect(token, { connectionId, executionReady: true }) : undefined
      return { ticket, token, connectionId, lease }
    }
    async function enter() {
      const state = await maintenance.enterMaintenance(admin.id)
      await maintenance.heartbeat(BigInt(state.maintenanceEpoch), writes)
      return state
    }
    return { pool, context, cfg, org, admin, nodes, maintenance, repository, baseline, deps, request, node, enter,
      starts: () => starts, writes: () => writes, writerAdmissions: () => writerAdmissions,
      shutdown: () => { shutdown = true }, [Symbol.asyncDispose]: close }
  } catch (error) { await close(); throw error }
}

/** Exercise real HTTP maintenance leases and business refusals. @param pool - disposable database with migrations applied. @returns deterministic assembled transcript. */
export async function nodeMaintenanceTranscript(pool: Pool): Promise<string> {
  await using f = await nodeMaintenanceFixture(pool)
  const node = await f.node('managed'), pending = await f.node('pending', false)
  await f.enter()
  const topology = (await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows
  const instanceRows = (await pool.query('SELECT * FROM harness.instances WHERE organization_id=$1 ORDER BY id', [f.org])).rows
  const lines = ['# Managed node control during maintenance', '']
  const initialWriters = f.writerAdmissions()
  for (let i = 0; i < 3; i++) {
    const renewed = await f.request('/internal/nodes/heartbeat', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)
    expect(renewed.status).toBe(200)
    expect(renewed.body).toMatchObject({ nodeId: node.ticket.nodeId, epoch: node.lease!.epoch, executionReady: true })
    await f.maintenance.heartbeat(1n, f.writes())
    expect((await f.maintenance.state()).writersQuiesced).toBe(true)
  }
  expect(f.writerAdmissions()).toBe(initialWriters)
  lines.push('Three authenticated heartbeats: HTTP 200; same node and connection epoch; no business writer admitted; writers quiesced.')
  const disconnected = await f.request('/internal/nodes/disconnect', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)
  expect(disconnected.status).toBe(204)
  const connectionId = randomUUID()
  const connected = await f.request('/internal/nodes/connect', { connectionId, executionReady: true }, node.token)
  expect(connected.status).toBe(200)
  expect(BigInt(connected.body.epoch)).toBe(BigInt(node.lease!.epoch) + 1n)
  expect((await f.request('/internal/nodes/connect', { connectionId }, node.token)).body.epoch).toBe(connected.body.epoch)
  expect((await f.request('/internal/nodes/heartbeat', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)).status).toBe(409)
  expect((await f.request('/internal/nodes/disconnect', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)).status).toBe(409)
  lines.push('Release and reconnect: HTTP 204 then 200; exactly one successor epoch; lost-response retry retains it; old heartbeat and release return 409.')
  expect((await f.request('/internal/nodes/connect', { connectionId: randomUUID() }, pending.token)).status).toBe(503)
  expect((await f.request('/internal/nodes/enroll', { protocolVersion: 1, platform: 'linux', architecture: 'x64', credential: pending.token }, pending.ticket.token)).status).toBe(503)
  lines.push('Pending attachment and enrollment: HTTP 503; attachment and topology unchanged.')
  expect((await f.request('/account/api/scope', { kind: 'personal' })).status).toBe(503)
  expect((await f.request('/api', { text: 'must not execute' })).status).toBe(503)
  expect(f.starts()).toBe(0)
  expect((await pool.query('SELECT * FROM harness.instances WHERE organization_id=$1 ORDER BY id', [f.org])).rows).toEqual(instanceRows)
  expect((await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows).toEqual(topology)
  lines.push('New personal Runtime and message submission: HTTP 503; zero launches; Runtime records unchanged.')
  await pool.query("UPDATE harness.cluster_control SET mode='restoring' WHERE organization_id=$1", [f.org])
  expect((await f.request('/internal/nodes/heartbeat', { connectionId, epoch: connected.body.epoch }, node.token)).status).toBe(503)
  lines.push('Restore in progress: HTTP 503; control lease cannot bypass the restore fence.')
  return lines.join('\n') + '\n'
}
