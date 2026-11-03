import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
/** Real PostgreSQL and authenticated Gateway node enrollment, leases and outbound processes. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as adminClient from '../admin-ui/src/api.ts'
import { NodeAgentError, runNodeAgent } from '../src/node-agent.ts'
import type { NodeEnrollmentId } from '../src/node-access.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { InstanceManager, type RuntimeStopOperationId } from '../src/instances.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import type { NodeAgentEvent } from '../src/node-agent.ts'
import type { NodeAccessPage, NodeCredential, NodeEnrollment } from '../src/node-access.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

function credential(): NodeCredential { return `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential }
function enrollment(credential: NodeCredential) { return { protocolVersion: 1, platform: 'linux', architecture: 'x64', credential } }

describePg('PostgreSQL outbound node access', () => {
  let pool: Pool
  const releases: Array<() => Promise<void>> = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const errors: unknown[] = []
    for (const release of releases.splice(0).reverse()) {
      try { await release() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Node access fixture cleanup failed')
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-node-access-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `nodes-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node access') RETURNING id", [slug],
    )).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, organizationId))
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'center')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'center')
    await enableFixtureTopology(context)
    const cfg = testConfig(root, { HGW_NODE_AGENT_LEASE_MS: '30000', HGW_NODE_AGENT_HEARTBEAT_MS: '100' })
    const users = new PostgresUserService(context, cfg)
    const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'pw-12345678' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    await users.changeOwnPassword(member.id, 'pw-12345678')
    const nodes = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
    const issue = (name = 'worker') => nodes.issue(admin, { name, requestId: randomUUID() })
    return { root, organizationId, context, cfg, users, admin, member, nodes, issue }
  }

  async function httpFixture() {
    const f = await fixture()
    await expect(f.nodes.authorizeAdministratorNode(f.admin, f.context.nodeId)).resolves.toBe(f.context.nodeId)
    await expect(f.nodes.authorizeAdministratorNode(f.member, f.context.nodeId)).rejects.toMatchObject({ status: 403 })
    let starts = 0
    const repository = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    const instances = new InstanceManager(repository, f.cfg, {
      instancesOutliveGateway: false, start: async () => { starts++; throw new Error('Node access cannot launch runtimes') },
    })
    const deps: GatewayDeps = { cfg: f.cfg, auth: new PostgresAuthService(f.context, f.cfg),
      users: f.users, projects: new PostgresProjectService(f.context, f.cfg), instances,
      audit: new PostgresAuditService(f.context), nodeAccess: f.nodes,
      runtimeCatalog: new PostgresRuntimeCatalog(f.context, f.cfg.runtimeCatalog) }
    const server = createGatewayServer(deps, {
      admin: createAdminApiHandler(deps),
      runtimeAuthorize: async req => {
        const value = req.headers.authorization
        return value?.startsWith('Bearer ') === true && await repository.authenticateRuntimeToken(value.slice(7)) !== null
      },
    })
    releases.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) })
      await instances.stopAll()
    })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    f.cfg.publicOrigins.push(base)
    const login = async (username: string) => {
      const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
        body: new URLSearchParams({ username, password: 'pw-12345678' }) })
      await response.arrayBuffer()
      expect(response.status).toBe(302)
      return response.headers.get('set-cookie')!.split(';')[0]!
    }
    const cookie = await login('admin')
    const adminRequest = (path: string, body?: unknown, actorCookie = cookie) => fetch(`${base}/admin/api/deployment/nodes/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie: actorCookie, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const nodeRequest = (path: string, token: string, body: unknown) => fetch(`${base}/internal/nodes/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { ...f, deps, base, server, login, adminRequest, nodeRequest, starts: () => starts }
  }

  it('reserves offline nodes and stores only token digests; enrollment retries bind to the same credential', async () => {
    const f = await fixture(), requestId = randomUUID()
    const ticket = await f.nodes.issue(f.admin, { name: 'worker', requestId })
    await expect(f.nodes.issue(f.admin, { name: 'worker-again', requestId })).rejects.toMatchObject({ code: 'node-access/enrollment-already-issued' })
    const secret = credential()
    const identity = await f.nodes.enroll(ticket.token, enrollment(secret))
    expect(await f.nodes.enroll(ticket.token, enrollment(secret))).toEqual(identity)
    await expect(f.nodes.enroll(ticket.token, enrollment(credential()))).rejects.toMatchObject({ code: 'node-access/unauthorized' })
    const state = await pool.query<{ status: string; last_heartbeat_at: Date | null; credential_hash: Buffer; token_hash: Buffer }>(`SELECT n.status,n.last_heartbeat_at,a.credential_hash,e.token_hash
      FROM harness.compute_nodes n JOIN harness.node_agents a ON a.node_id=n.id
      JOIN harness.node_agent_enrollments e ON e.node_id=n.id WHERE n.id=$1`, [ticket.nodeId])
    expect(state.rows[0]).toMatchObject({ status: 'offline', last_heartbeat_at: null })
    expect(state.rows[0]!.credential_hash).toHaveLength(32)
    expect(state.rows[0]!.token_hash).toHaveLength(32)
    expect(JSON.stringify(state.rows).includes(secret)).toBe(false)
    expect(JSON.stringify(state.rows).includes(ticket.token)).toBe(false)
    expect(identity).toMatchObject({ nodeId: ticket.nodeId, organizationId: f.organizationId, executionReady: false })
  })

  it('rechecks administrator and organization authority and rejects credentials from another organization', async () => {
    const f = await fixture(), other = await fixture()
    await expect(f.nodes.issue(f.member, { name: 'denied', requestId: randomUUID() })).rejects.toMatchObject({ status: 403 })
    const ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    await expect(other.nodes.connect(secret, { connectionId: randomUUID() })).rejects.toMatchObject({ status: 401 })
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1", [f.organizationId])
    await expect(f.nodes.list(f.admin, {})).rejects.toMatchObject({ status: 403 })
    await expect(f.nodes.mutate(f.admin, ticket.nodeId, { action: 'revoke', revision: 1 })).rejects.toMatchObject({ status: 403 })
    await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
    await expect(f.nodes.connect(secret, { connectionId: randomUUID() })).rejects.toMatchObject({ status: 401 })
  })

  it('expires tickets, rejects unsupported protocols and platforms, and never adopts an existing Gateway node', async () => {
    const f = await fixture(), ticket = await f.issue()
    await expect(f.nodes.issue(f.admin, { name: 'center', requestId: randomUUID() })).rejects.toMatchObject({ code: 'node-access/name-conflict' })
    await expect(f.nodes.mutate(f.admin, f.context.nodeId, { action: 'revoke', revision: 1 })).rejects.toMatchObject({ status: 404 })
    await expect(f.nodes.enroll(ticket.token, { ...enrollment(credential()), protocolVersion: 2 })).rejects.toMatchObject({ code: 'node-access/unsupported-protocol' })
    await expect(f.nodes.enroll(ticket.token, { ...enrollment(credential()), platform: 'win32' })).rejects.toMatchObject({ code: 'node-access/unsupported-platform' })
    await pool.query("UPDATE harness.node_agent_enrollments SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [ticket.enrollmentId])
    await expect(f.nodes.enroll(ticket.token, enrollment(credential()))).rejects.toMatchObject({ status: 401 })
  })

  it('rejects malformed wire selectors and prevents node credentials from selecting another node', async () => {
    const f = await httpFixture(), ticket = await f.issue(), secret = credential()
    await expect(f.nodes.enroll(ticket.token, { ...enrollment(secret), nodeId: f.context.nodeId })).rejects.toMatchObject({ status: 400 })
    await f.nodes.enroll(ticket.token, enrollment(secret))
    await expect(f.nodes.connect(secret, { connectionId: randomUUID(), organizationId: f.organizationId })).rejects.toMatchObject({ status: 400 })
    await expect(f.nodes.heartbeat(secret, { connectionId: randomUUID(), epoch: '-1' })).rejects.toMatchObject({ status: 400 })
    const method = await fetch(`${f.base}/internal/nodes/connect`)
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('POST')
    await method.arrayBuffer()
    const missing = await f.nodeRequest('unknown', secret, {})
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
    const oversized = await f.nodeRequest('connect', secret, { extra: 'x'.repeat(4096) })
    expect(oversized.status).toBe(413)
    await oversized.arrayBuffer()
    const malformed = await f.nodeRequest('connect', 'wrong-token', { connectionId: randomUUID() })
    expect(malformed.status).toBe(401)
    await malformed.arrayBuffer()
  })

  it('grants one concurrent connection and fences delayed heartbeats and disconnects by epoch', async () => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const ids = [randomUUID(), randomUUID()]
    const acquisitions = await Promise.allSettled(ids.map(connectionId => f.nodes.connect(secret, { connectionId })))
    const success = acquisitions.find(result => result.status === 'fulfilled')
    const failure = acquisitions.find(result => result.status === 'rejected')
    expect(success?.status).toBe('fulfilled')
    expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({ code: 'node-access/already-connected' })
    if (success?.status !== 'fulfilled') throw new Error('No connection was acquired')
    const first = success.value
    expect((await f.nodes.connect(secret, { connectionId: first.connectionId })).epoch).toBe(first.epoch)
    await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", [ticket.nodeId])
    await expect(f.nodes.heartbeat(secret, { connectionId: first.connectionId, epoch: first.epoch })).rejects.toMatchObject({ code: 'node-access/lease-lost' })
    const second = await f.nodes.connect(secret, { connectionId: randomUUID() })
    expect(BigInt(second.epoch)).toBe(BigInt(first.epoch) + 1n)
    await expect(f.nodes.disconnect(secret, { connectionId: first.connectionId, epoch: first.epoch })).rejects.toMatchObject({ code: 'node-access/lease-lost' })
    await f.nodes.disconnect(secret, { connectionId: second.connectionId, epoch: second.epoch })
    await f.nodes.disconnect(secret, { connectionId: second.connectionId, epoch: second.epoch })
    expect((await f.nodes.connect(secret, { connectionId: second.connectionId })).epoch).not.toBe(second.epoch)
  })

  it('claims only the expired Runtime connection and preserves old credential rejection across fresh startup', async () => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const first = await f.nodes.connect(secret, { connectionId: randomUUID() })
    await pool.query("UPDATE harness.compute_nodes SET status='active' WHERE organization_id=$1 AND id=$2", [f.organizationId, ticket.nodeId])
    const worker = await resolvePostgresRuntimeContext(pool, f.context.organizationSlug, 'worker')
    const users = new PostgresUserService(worker, f.cfg)
    const owner = await users.create({ username: 'worker-owner', password: 'pw-12345678', role: 'admin' })
    const repository = new PostgresInstanceRepository(worker, f.cfg.instancePortBase)
    await repository.initialize()
    const target = await repository.resolveTarget({ kind: 'user', id: owner.id })
    const token = randomBytes(32).toString('base64url')
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    await repository.markReady(target, generation)
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    expect(await repository.markExpiredConnectionStopping(target, generation)).toBe(false)
    await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", [ticket.nodeId])
    const second = await f.nodes.connect(secret, { connectionId: first.connectionId })
    expect(BigInt(second.epoch)).toBeGreaterThan(BigInt(first.epoch))
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    expect(await repository.markExpiredConnectionStopping(target, generation + 1)).toBe(false)
    expect(await repository.markExpiredConnectionStopping({ ...target, id: f.admin.id }, generation)).toBe(false)
    const foreign = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    expect(await foreign.markExpiredConnectionStopping(target, generation)).toBe(false)
    await expect(repository.markExpiredConnectionStopping(target, generation, f.member.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await repository.stateOf(target)).toBe('ready')
    const resources = new NodeResourceBudget(pool, worker.organizationId, worker.nodeId, f.cfg.resourceBudget)
    await resources.configure()
    const budget = await GatewayModelBudget.open(resources, join(f.root, 'recovery-owner'))
    releases.push(() => budget.close())
    await budget.withOwnership(async process => {
      const operationId = randomUUID() as RuntimeStopOperationId
      await repository.acquireStopLease(target, operationId, process, f.admin.id, generation)
      try { expect(await repository.markExpiredConnectionStopping(target, generation)).toBe(false) }
      finally { await repository.releaseStopLease(operationId, process) }
    })
    expect(await repository.markExpiredConnectionStopping(target, generation, f.admin.id)).toBe(true)
    expect(await repository.stateOf(target)).toBe('stopping')
    expect(await repository.admitLease(target, Date.now(), generation)).toBe(false)
    await repository.markStopped(target, generation)
    const renewedToken = randomBytes(32).toString('base64url')
    const renewed = await repository.beginStart(target, Date.now(), createHash('sha256').update(renewedToken).digest(), 'explicit')
    await repository.markReady(target, renewed)
    expect(renewed).toBeGreaterThan(generation)
    expect(await repository.resolveTarget({ kind: 'user', id: owner.id })).toEqual(target)
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    expect(await repository.authenticateRuntimeToken(renewedToken)).not.toBeNull()
    expect(await repository.markExpiredConnectionStopping(target, generation)).toBe(false)
    expect(await repository.markExpiredConnectionStopping(target, renewed)).toBe(false)
  })

  it('reissues with a stable node identity and invalidates both old tickets and connected credentials', async () => {
    const f = await fixture(), first = await f.issue(), secret = credential()
    await f.nodes.enroll(first.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    await expect(f.nodes.mutate(f.admin, first.nodeId, { action: 'issue-enrollment', revision: 1, requestId: first.enrollmentId }))
      .rejects.toMatchObject({ code: 'node-access/enrollment-already-issued' })
    expect((await f.nodes.heartbeat(secret, { connectionId: lease.connectionId, epoch: lease.epoch })).epoch).toBe(lease.epoch)
    const second = await f.nodes.mutate(f.admin, first.nodeId, { action: 'issue-enrollment', revision: 1, requestId: randomUUID() })
    if (!('token' in second)) throw new Error('No replacement ticket was issued')
    expect(second.nodeId).toBe(first.nodeId)
    await expect(f.nodes.heartbeat(secret, { connectionId: lease.connectionId, epoch: lease.epoch })).rejects.toMatchObject({ status: 401 })
    await expect(f.nodes.enroll(first.token, enrollment(secret))).rejects.toMatchObject({ status: 401 })
    await expect(f.nodes.mutate(f.admin, first.nodeId, { action: 'revoke', revision: 1 })).rejects.toMatchObject({ code: 'node-access/revision-conflict' })
    const next = credential()
    await f.nodes.enroll(second.token, enrollment(next))
    await f.nodes.mutate(f.admin, first.nodeId, { action: 'revoke', revision: second.revision })
    await expect(f.nodes.connect(next, { connectionId: randomUUID() })).rejects.toMatchObject({ status: 401 })
    expect((await f.nodes.list(f.admin, {})).items[0]?.status).toBe('revoked')
  })

  it('admits concurrent channel reads while another reader retains the node', async () => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    const reader = createPostgresPool(databaseUrl!, { max: 2, lock_timeout: 1000 })
    const nodes = new PostgresNodeAccessService({ ...f.context, pool: reader }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const held = await pool.connect()
    try {
      await held.query('BEGIN')
      await held.query('SELECT node_id FROM harness.node_agents WHERE node_id=$1 FOR SHARE', [ticket.nodeId])
      const reads = await Promise.all([1, 2].map(() => nodes.authorizeChannel(secret, {
        connectionId: lease.connectionId, epoch: lease.epoch,
      })))
      expect(reads).toEqual([lease, lease])
    } finally {
      try { await held.query('ROLLBACK') } finally { held.release() }
      await reader.end()
    }
  })

  it('authorizes one current channel with three database round trips', async () => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    const reader = createPostgresPool(databaseUrl!, { max: 1 })
    const queries: Array<MockInstance<PoolClient['query']>> = []
    reader.on('connect', client => {
      queries.push(vi.spyOn(client, 'query'))
    })
    try {
      const nodes = new PostgresNodeAccessService({ ...f.context, pool: reader }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
      await expect(nodes.authorizeChannel(secret, { connectionId: lease.connectionId, epoch: lease.epoch })).resolves.toEqual(lease)
      const statements = queries.flatMap(query => query.mock.calls.map(([statement]) => statement))
      expect(statements).toHaveLength(3)
      expect(statements[0]).toBe('BEGIN')
      expect(statements.at(-1)).toBe('COMMIT')
    } finally {
      await reader.end()
      for (const query of queries) query.mockRestore()
    }
  })

  it.each([
    { change: 'revoked', statement: 'UPDATE harness.node_agents SET revoked_at=clock_timestamp() WHERE node_id=$1', code: 'node-access/unauthorized' },
    { change: 'expired', statement: "UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", code: 'node-access/lease-lost' },
    { change: 'credential-replaced', statement: "UPDATE harness.node_agents SET credential_hash=decode(repeat('00',32),'hex') WHERE node_id=$1", code: 'node-access/unauthorized' },
    { change: 'detached', statement: "UPDATE harness.node_agents SET attachment_state='detached',credential_hash=NULL WHERE node_id=$1", code: 'node-access/detached' },
    { change: 'epoch-replaced', statement: 'UPDATE harness.node_agents SET connection_epoch=connection_epoch+1 WHERE node_id=$1', code: 'node-access/lease-lost' },
    { change: 'organization-disabled', statement: "UPDATE harness.organizations SET status='disabled' WHERE id=(SELECT organization_id FROM harness.node_agents WHERE node_id=$1)", code: 'node-access/unauthorized' },
  ])('rechecks a $change channel after waiting for an authority mutation', async ({ statement, code }) => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    const name = `node-read-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name, lock_timeout: 15000 })
    const nodes = new PostgresNodeAccessService({ ...f.context, pool: reader }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const held = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN')
      await held.query(statement, [ticket.nodeId])
      pending = nodes.authorizeChannel(secret, { connectionId: lease.connectionId, epoch: lease.epoch })
        .catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting`, [name])).rows[0]!.waiting).toBe(true)
      await held.query('COMMIT')
      expect(await pending).toMatchObject({ code })
    } finally {
      try { await held.query('ROLLBACK') } finally { held.release() }
      await pending
      await reader.end()
    }
  })

  it('checks lease time after an unchanged node lock is released', async () => {
    const f = await fixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()+interval '5 seconds' WHERE node_id=$1", [ticket.nodeId])
    const name = `node-clock-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name, lock_timeout: 15000 })
    const nodes = new PostgresNodeAccessService({ ...f.context, pool: reader }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const held = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN')
      await held.query('SELECT node_id FROM harness.node_agents WHERE node_id=$1 FOR UPDATE', [ticket.nodeId])
      pending = nodes.authorizeChannel(secret, { connectionId: lease.connectionId, epoch: lease.epoch }).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting`, [name])).rows[0]!.waiting).toBe(true)
      const live = async () => (await pool.query<{ live: boolean }>(
        'SELECT lease_expires_at>clock_timestamp() live FROM harness.node_agents WHERE node_id=$1', [ticket.nodeId])).rows[0]!.live
      expect(await live()).toBe(true)
      await expect.poll(live, { timeout: 10000 }).toBe(false)
      await held.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'node-access/lease-lost' })
    } finally {
      try { await held.query('ROLLBACK') } finally { held.release() }
      await pending
      await reader.end()
    }
  })

  it('bounds cached node pages by rows and complete UTF-8 bytes', async () => {
    const f = await fixture()
    await f.issue('电脑甲')
    await f.issue('电脑乙')
    const page = await f.nodes.list(f.admin, { limit: '1' })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    const next = await f.nodes.list(f.admin, { cursor: page.nextCursor! })
    expect(next.items).toHaveLength(1)
    expect(next.items[0]!.nodeId).not.toBe(page.items[0]!.nodeId)
    const bytes = Buffer.byteLength(JSON.stringify(page))
    const exact = new PostgresNodeAccessService(f.context, f.cfg.nodeAccess, { pageSize: 50, maxBytes: bytes })
    expect(Buffer.byteLength(JSON.stringify(await exact.list(f.admin, {})))).toBe(bytes)
    await expect(new PostgresNodeAccessService(f.context, f.cfg.nodeAccess, { pageSize: 50, maxBytes: bytes - 1 }).list(f.admin, {}))
      .rejects.toMatchObject({ status: 413 })
    await expect(f.nodes.list(f.admin, { limit: '0' })).rejects.toMatchObject({ status: 400 })
    await expect(f.nodes.list(f.admin, { cursor: 'broken' })).rejects.toMatchObject({ status: 400 })
  })

  it('bounds concurrent control requests while cached directories remain available', async () => {
    const f = await httpFixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    const lease = await f.nodes.connect(secret, { connectionId: randomUUID() })
    f.cfg.nodeAccess.maxInFlight = 1
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done })
    const gate = new Promise<void>(done => { release = done })
    const heartbeat = f.nodes.heartbeat.bind(f.nodes)
    f.nodes.heartbeat = async (token, input) => { entered(); await gate; return heartbeat(token, input) }
    const pending = f.nodeRequest('heartbeat', secret, { connectionId: lease.connectionId, epoch: lease.epoch })
    releases.push(async () => { release(); const response = await pending; if (!response.bodyUsed) await response.arrayBuffer() })
    await waiting
    try {
      const busy = await f.nodeRequest('connect', secret, { connectionId: randomUUID() })
      expect(busy.status).toBe(503)
      expect(await busy.json()).toEqual({ error: 'node-access/busy' })
      const directory = await f.adminRequest('access')
      expect(directory.status).toBe(200)
      await directory.arrayBuffer()
      const live = await fetch(`${f.base}/healthz/live`)
      expect(live.status).toBe(200)
      await live.arrayBuffer()
    } finally { release() }
    const resumed = await pending
    expect(resumed.status).toBe(200)
    await resumed.arrayBuffer()
    const acquired = await f.nodeRequest('connect', secret, { connectionId: lease.connectionId })
    expect(acquired.status).toBe(200)
    await acquired.arrayBuffer()
  })

  it('fences node metadata writes during maintenance and after a restore while keeping directory reads open', async () => {
    const f = await httpFixture(), ticket = await f.issue(), secret = credential()
    await f.nodes.enroll(ticket.token, enrollment(secret))
    let activeWriters = 0
    f.deps.writerSpan = () => { activeWriters += 1; return () => { activeWriters -= 1 } }
    f.deps.maintenanceGate = async () => 'maintenance'
    const refused = await f.nodeRequest('connect', secret, { connectionId: randomUUID() })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'maintenance' })
    const issuance = await f.adminRequest('enrollments', { name: 'paused', requestId: randomUUID() })
    expect(issuance.status).toBe(503)
    await issuance.arrayBuffer()
    const page = await f.adminRequest('access')
    expect(page.status).toBe(200)
    expect((await page.json() as NodeAccessPage).items[0]?.status).toBe('pending')
    f.deps.maintenanceGate = async () => 'stale-epoch'
    const stale = await f.adminRequest(`access/${ticket.nodeId}`, { action: 'revoke', revision: 1 })
    expect(stale.status).toBe(503)
    expect(await stale.json()).toEqual({ error: 'stale-epoch' })
    expect(activeWriters).toBe(0)
    expect((await f.nodes.list(f.admin, {})).items[0]?.revision).toBe(1)
  })

  it('records a keyless authenticated Gateway transcript without launching or authorizing a runtime', async () => {
    const f = await httpFixture()
    const anonymous = await fetch(`${f.base}/internal/nodes/connect`, { method: 'POST', body: '{}' })
    const forbidden = await f.adminRequest('enrollments', { name: 'denied', requestId: randomUUID() }, await f.login('member'))
    const issued = await f.adminRequest('enrollments', { name: 'worker', requestId: randomUUID() })
    const ticket = await issued.json() as NodeEnrollment, secret = credential(), connectionId = randomUUID()
    const enrolled = await f.nodeRequest('enroll', ticket.token, enrollment(secret))
    expect(await enrolled.json()).toMatchObject({ nodeId: ticket.nodeId, executionReady: false })
    const acquired = await f.nodeRequest('connect', secret, { connectionId })
    const lease = await acquired.json() as { epoch: string }
    const stale = await f.nodeRequest('heartbeat', secret, { connectionId, epoch: '999' })
    const runtime = await fetch(`${f.base}/internal/runtime/unknown`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: '{}' })
    const directory = await f.adminRequest('access')
    const page = await directory.json() as NodeAccessPage
    const revoked = await f.adminRequest(`access/${ticket.nodeId}`, { action: 'revoke', revision: 1 })
    const denied = await f.nodeRequest('heartbeat', secret, { connectionId, epoch: lease.epoch })
    const audit = await pool.query<{ detail: string | null }>('SELECT detail FROM harness.audit_events WHERE organization_id=$1', [f.organizationId])
    expect(JSON.stringify(audit.rows).includes(secret) || JSON.stringify(audit.rows).includes(ticket.token)).toBe(false)
    const transcript = { anonymous: anonymous.status, member: forbidden.status, issued: issued.status, enrolled: enrolled.status,
      connected: acquired.status, stale: { status: stale.status, body: await stale.json() }, runtime: runtime.status,
      directory: { status: directory.status, cache: directory.headers.get('cache-control'), nodes: page.items.map(item => ({ status: item.status, executionReady: item.executionReady })) },
      revoked: revoked.status, denied: { status: denied.status, body: await denied.json() }, runtimeStarts: f.starts() }
    for (const response of [anonymous, forbidden, runtime, revoked]) await response.arrayBuffer()
    await expect(JSON.stringify(transcript, null, 2) + '\n').toMatchFileSnapshot(fileURLToPath(new URL('./expected/node-access.json', import.meta.url)))
  })

  it.skipIf(process.platform === 'win32')('replays the Admin client onboarding flow against the real Gateway and node agent', async () => {
    const f = await httpFixture(), nativeFetch = globalThis.fetch
    const login = await nativeFetch(`${f.base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: f.base },
      body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }) })
    await login.arrayBuffer()
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const writes: string[] = []
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (typeof input !== 'string' || !input.startsWith('/admin/api/deployment/nodes/')) return nativeFetch(input, init)
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie); headers.set('origin', f.base)
      if (init?.method === 'POST') writes.push(input.includes('/enrollments') ? 'issue' : String(JSON.parse(String(init.body)).action))
      return nativeFetch(new URL(input, f.base), { ...init, headers })
    })
    releases.push(async () => { browserFetch.mockRestore() })

    async function agent(ticket: NodeEnrollment, file: string) {
      const controller = new AbortController()
      let connected = false, ready!: () => void, refused!: (error: unknown) => void
      const readiness = new Promise<void>((done, reject) => { ready = done; refused = reject })
      const completion = runNodeAgent({ centerUrl: f.base, stateFile: join(f.root, file), enrollmentToken: ticket.token,
        requestTimeoutMs: 10_000, retryMs: 100 }, controller.signal, event => {
        if (event.status === 'connected') { connected = true; ready() }
      }).then(() => { if (!connected) refused(new Error('Node agent stopped before readiness')); return null }, error => { refused(error); return error as unknown })
      releases.push(async () => {
        controller.abort()
        const error = await completion
        if (error !== null && !(error instanceof NodeAgentError && error.code === 'node-access/unauthorized')) throw error
      })
      await readiness
      return { completion }
    }

    const first = await adminClient.issueNodeEnrollment('Admin client computer', randomUUID() as NodeEnrollmentId)
    const pending = (await adminClient.listNodeAccess()).items[0]!
    const firstAgent = await agent(first, 'client-node-first.json')
    const connected = (await adminClient.listNodeAccess()).items[0]!
    const second = await adminClient.reissueNodeEnrollment(connected, randomUUID() as NodeEnrollmentId)
    expect(await firstAgent.completion).toMatchObject({ code: 'node-access/unauthorized' })
    let staleStatus: number | undefined
    try { await adminClient.revokeNodeAccess(connected) }
    catch (error) { if (!(error instanceof adminClient.AdminRequestError)) throw error; staleStatus = error.status }
    const secondAgent = await agent(second, 'client-node-second.json')
    const renewed = (await adminClient.listNodeAccess()).items[0]!
    const revoked = await adminClient.revokeNodeAccess(renewed)
    expect(await secondAgent.completion).toMatchObject({ code: 'node-access/unauthorized' })
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)",
      [f.organizationId, f.admin.id])
    let deniedStatus: number | undefined
    try { await adminClient.listNodeAccess() }
    catch (error) { if (!(error instanceof adminClient.AdminRequestError)) throw error; deniedStatus = error.status }
    const transcript = { pending: pending.status, connected: connected.status, executionReady: connected.executionReady,
      sameIdentityOnReissue: first.nodeId === second.nodeId, revisions: [first.revision, second.revision, revoked.revision],
      staleStatus, reconnected: renewed.status, revoked: revoked.status, deniedStatus, writes, runtimeStarts: f.starts() }
    await expect(JSON.stringify(transcript, null, 2) + '\n').toMatchFileSnapshot(fileURLToPath(new URL('./expected/admin-node-onboarding.json', import.meta.url)))
  })

  async function processAgent(f: Awaited<ReturnType<typeof httpFixture>>, name: string, options: {
    centerUrl?: string; onEvent?: (event: NodeAgentEvent) => void; onHeaders?: () => void; disableChannel?: boolean
  } = {}) {
    const ticket = await f.issue(name)
    const built = process.env.HGW_TEST_NODE_AGENT_BUILT === '1'
    const args = built ? [process.env.HGW_TEST_NODE_AGENT_BUILT_ENTRY ?? resolve(import.meta.dirname, '../lib/node-agent-main.js')]
      : ['--import', import.meta.resolve('tsx/esm'), resolve(import.meta.dirname, '../src/node-agent-main.ts')]
    if (options.onHeaders !== undefined) args.unshift('--import', resolve(import.meta.dirname, 'fixtures/node-agent-http-observer.mjs'))
    const child = spawn(process.execPath, args, { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HGW_NODE_CENTER_URL: options.centerUrl ?? f.base,
        HGW_NODE_AGENT_STATE_FILE: join(f.root, name, 'access.json'), HGW_NODE_ENROLLMENT_TOKEN: ticket.token,
        HGW_NODE_AGENT_REQUEST_TIMEOUT_MS: '10000', HGW_NODE_AGENT_RETRY_MS: '100',
        ...(!built ? { TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') } : {}),
        ...(options.disableChannel ? { HGW_NODE_AGENT_CHANNEL_ENABLED: '0' } : {}) } })
    const events: NodeAgentEvent[] = []
    let stdout = '', stderr = '', stopped = false
    let connected!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((done, reject) => { connected = done; rejectReady = reject })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', error => { rejectReady(error); reject(error) })
      child.once('close', (code, signal) => { stopped = true; rejectReady(new Error('Node process closed before readiness: ' + stderr)); done({ code, signal }) })
    })
    const stop = async () => {
      if (!stopped) child.kill('SIGTERM')
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15000)
      try { const result = await closed; if (timedOut) throw new Error('Node process did not stop before its deadline'); return result }
      finally { clearTimeout(timer) }
    }
    releases.push(async () => { await stop() })
    if (child.stdout === null || child.stderr === null) throw new Error('Node process fixture requires diagnostic pipes')
    child.on('message', value => {
      if (value !== null && typeof value === 'object' && 'type' in value && value.type === 'node-control-headers-received') options.onHeaders?.()
    })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); if (stderr.length > 65536) child.kill('SIGTERM') })
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline === -1) break
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1)
        try {
          const event = JSON.parse(line) as NodeAgentEvent
          events.push(event)
          options.onEvent?.(event)
          if (event.status === 'connected') connected()
        } catch (error) { rejectReady(error as Error); child.kill('SIGTERM') }
      }
    })
    await ready
    return { ticket, events, stop, closed, stderr: () => stderr }
  }

  it.skipIf(process.platform === 'win32').each(['enroll', 'connect', 'heartbeat'])(
    'recovers an interrupted %s body in the same independent node process', async phase => {
      const f = await httpFixture(), fixtureErrors: unknown[] = []
      const calls: Array<{ phase: string; credentialHash: string; connectionId?: string }> = []
      const leases: Array<{ connectionId: string; epoch: string }> = []
      const pending = new Set<Promise<void>>()
      let held: ServerResponse | undefined, headersReceived = false, degraded = false, faultRequestIndex = -1
      let recover!: () => void
      const recovered = new Promise<void>(done => { recover = done })
      const relay = createServer((req, res) => {
        const work = (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const input = JSON.parse(body.toString('utf8')) as { credential?: string; connectionId?: string }
          const operation = req.url!.slice('/internal/nodes/'.length)
          calls.push({ phase: operation, connectionId: input.connectionId,
            credentialHash: createHash('sha256').update(input.credential ?? req.headers.authorization!.slice(7)).digest('hex') })
          const response = await fetch(f.base + req.url!, { method: req.method,
            headers: { authorization: req.headers.authorization!, 'content-type': 'application/json' },
            body, signal: AbortSignal.timeout(10_000) })
          const bytes = Buffer.from(await response.arrayBuffer())
          if (response.ok && operation !== 'enroll' && operation !== 'disconnect') {
            leases.push(JSON.parse(bytes.toString('utf8')) as { connectionId: string; epoch: string })
          }
          if (operation === phase && held === undefined) {
            if (response.status !== 200 || bytes.length < 3) throw new Error('Control fault requires a committed successful Gateway reply')
            held = res
            faultRequestIndex = calls.length - 1
            res.writeHead(response.status, { 'content-type': 'application/json', 'content-length': bytes.length,
              'x-hgw-test-partial-control-body': '1' })
            res.write(bytes.subarray(0, 2))
          } else {
            res.writeHead(response.status, { 'content-type': 'application/json', 'content-length': bytes.length })
            res.end(bytes)
          }
        })().catch(error => { fixtureErrors.push(error); res.destroy(error as Error) })
        pending.add(work)
        void work.then(() => { pending.delete(work) })
      })
      releases.push(async () => {
        relay.closeAllConnections()
        await new Promise<void>((done, reject) => { relay.close(error => { if (error) reject(error); else done() }) })
        await Promise.all(pending)
      })
      await new Promise<void>((done, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', done) })
      const base = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`
      const agent = await processAgent(f, 'partial-' + phase, { centerUrl: base, disableChannel: true,
        onHeaders: () => {
          headersReceived = true
          if (held === undefined) fixtureErrors.push(new Error('Node observed headers before the relay held a reply'))
          held?.destroy()
        },
        onEvent: event => {
          if (event.status === 'degraded') degraded = true
          if (event.status === 'connected' && degraded) recover()
        } })
      await Promise.race([recovered, agent.closed.then(() => { throw new Error('Node exited instead of recovering: ' + agent.stderr()) })])
      const row = (await pool.query<{ connection_id: string; connection_epoch: string; live: boolean }>(
        'SELECT connection_id,connection_epoch,lease_expires_at > clock_timestamp() AS live FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2',
        [f.organizationId, agent.ticket.nodeId])).rows[0]!
      expect(row.live).toBe(true)
      expect(leases.every(lease => lease.connectionId === row.connection_id && lease.epoch === row.connection_epoch)).toBe(true)
      expect((await f.nodes.list(f.admin, {})).items.find(item => item.nodeId === agent.ticket.nodeId)?.status).toBe('connected')
      expect(await agent.stop()).toEqual({ code: 0, signal: null })
      expect(fixtureErrors).toEqual([])
      expect(agent.stderr()).toBe('')
      expect(agent.events.filter(event => event.status === 'degraded').map(event => ({ status: event.status, reason: event.reason })))
        .toEqual([{ status: 'degraded', reason: 'node-agent/transport-unavailable' }])
      const state = JSON.parse(await readFile(join(f.root, 'partial-' + phase, 'access.json'), 'utf8')) as { enrollmentToken: null; identity: { nodeId: string } }
      const remoteInstances = await pool.query<{ count: string }>('SELECT count(*)::text FROM harness.instances WHERE assigned_node_id=$1', [agent.ticket.nodeId])
      const transcript = { phase, successfulHeadersBeforeCut: headersReceived,
        faultOperationRetried: calls[faultRequestIndex + 1]?.phase === phase,
        sameCredential: new Set(calls.map(call => call.credentialHash)).size === 1,
        sameConnection: new Set(calls.filter(call => call.phase !== 'enroll').map(call => call.connectionId)).size === 1,
        sameLeaseEpoch: new Set(leases.map(lease => lease.epoch)).size === 1,
        connectedEvents: agent.events.filter(event => event.status === 'connected').length,
        finalStatus: agent.events.at(-1)?.status, enrollmentCodeCleared: state.enrollmentToken === null,
        savedNodeMatches: state.identity.nodeId === agent.ticket.nodeId,
        runtimeStarts: f.starts(), runtimeAssignments: Number(remoteInstances.rows[0]!.count) }
      await expect(JSON.stringify(transcript, null, 2) + '\n').toMatchFileSnapshot(
        fileURLToPath(new URL('./expected/node-control-response-recovery-' + phase + '.json', import.meta.url)))
    }, 30_000)

  it.skipIf(process.platform === 'win32')('runs independent outbound node processes and releases one without blocking the other', async () => {
    const f = await httpFixture()
    const first = await processAgent(f, 'computer-a'), second = await processAgent(f, 'computer-b')
    expect((await f.nodes.list(f.admin, {})).items.map(item => item.status)).toEqual(['connected', 'connected'])
    expect(await first.stop()).toEqual({ code: 0, signal: null })
    const page = await f.nodes.list(f.admin, {})
    expect(page.items.find(item => item.nodeId === first.ticket.nodeId)?.status).toBe('disconnected')
    expect(page.items.find(item => item.nodeId === second.ticket.nodeId)?.status).toBe('connected')
    await f.nodes.mutate(f.admin, second.ticket.nodeId, { action: 'revoke', revision: 1 })
    expect(await second.closed).toEqual({ code: 1, signal: null })
    expect(second.stderr()).toContain('node-access/unauthorized')
    expect(first.events.at(-1)).toEqual({ status: 'stopped' })
    expect(f.starts()).toBe(0)
    const state = JSON.parse(await readFile(join(f.root, 'computer-a', 'access.json'), 'utf8')) as { enrollmentToken: null; identity: { nodeId: string } }
    expect(state.enrollmentToken).toBeNull()
    expect(state.identity.nodeId).toBe(first.ticket.nodeId)
    const remoteInstances = await pool.query<{ count: string }>('SELECT count(*)::text FROM harness.instances WHERE assigned_node_id=ANY($1::uuid[])',
      [[first.ticket.nodeId, second.ticket.nodeId]])
    expect(remoteInstances.rows[0]?.count).toBe('0')
  })
})
