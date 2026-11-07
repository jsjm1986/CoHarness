/** Organization mode and managed-to-local execution transitions over real PostgreSQL. @module */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PostgresDeploymentTopology } from '../src/deployment-topology.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresComputerAccess } from '../src/computer-access.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { NodeCredential } from '../src/node-access.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { testConfig } from './test-config.ts'
import { GatewayNodeConnection, configuredNodeAgent } from '../src/node-connection.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const pg = url === undefined ? describe.skip : describe
pg('deployment topology', () => {
  let pool: Pool
  const releases: Array<() => Promise<unknown>> = []
  beforeAll(async () => {
    pool = createPostgresPool(url!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const failures: unknown[] = []
    for (const release of releases.splice(0).reverse()) { try { await release() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Topology fixture cleanup failed')
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-topology-'))
    releases.push(() => rm(root, { force: true, recursive: true }))
    const slug = `topology-${randomUUID()}`
    const id = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Topology') RETURNING id", [slug])).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, id))
    for (const name of ['primary', 'worker']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [id, name])
    const a = await resolvePostgresRuntimeContext(pool, slug, 'primary'), b = await resolvePostgresRuntimeContext(pool, slug, 'worker')
    const cfg = testConfig(root)
    const users = new PostgresUserService(a, cfg), remoteUsers = new PostgresUserService(b, cfg)
    const admin = await users.create({ username: 'admin', password: 'test-password', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'test-password' })
    const worker = await remoteUsers.create({ username: 'worker', password: 'test-password' })
    await users.changeOwnPassword(admin.id, 'test-password')
    await users.changeOwnPassword(member.id, 'test-password')
    await remoteUsers.changeOwnPassword(worker.id, 'test-password')
    const options = { legacyForwarding: false, refreshAfterMs: 30000, pageSize: 10, maxBytes: 65536, allowedOrigins: ['https://primary.example.test'] }
    const topology = new PostgresDeploymentTopology(a, options), local = new PostgresDeploymentTopology(b, options)
    const nodes = new PostgresNodeAccessService(a, cfg.nodeAccess, cfg.runtimeCatalog)
    const enable = async () => topology.save(admin, { revision: (await topology.read()).revision, enabled: true, primaryOrigin: 'https://primary.example.test' })
    const connect = async () => {
      const ticket = await nodes.issue(admin, { requestId: randomUUID(), nodeId: b.nodeId })
      const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential
      await nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'arm64', credential })
      const lease = await nodes.connect(credential, { connectionId: randomUUID() })
      return { ticket, credential, lease }
    }
    return { a, b, cfg, admin, member, worker, topology, local, nodes, enable, connect, id }
  }
  it('defaults to local entry scope and retains current administrator and revision checks', async () => {
    const f = await fixture()
    expect(await f.topology.read()).toMatchObject({ mode: 'single', scope: 'local', primary: null, revision: '0' })
    await expect(f.enable()).resolves.toMatchObject({ mode: 'multi', role: 'primary', scope: 'organization' })
    expect(await f.local.read()).toMatchObject({ mode: 'multi', scope: 'local' })
    await expect(f.local.save(f.admin, { revision: '1', enabled: false })).rejects.toMatchObject({ status: 403 })
    await expect(f.topology.save(f.member, { revision: '1', enabled: false })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.topology.save(f.admin, { revision: '0', enabled: false })).rejects.toMatchObject({ code: 'deployment/revision-conflict' })
  })
  it('issuing a code preserves local authorization, and activation refuses an existing Runtime', async () => {
    const f = await fixture(); await f.enable()
    const ticket = await f.nodes.issue(f.admin, { requestId: randomUUID(), nodeId: f.b.nodeId })
    expect((await pool.query('SELECT harness.node_execution_available($1,$2) allowed', [f.id, f.b.nodeId])).rows[0].allowed).toBe(true)
    await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running' WHERE organization_id=$1 AND assigned_node_id=$2", [f.id, f.b.nodeId])
    const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential
    await f.nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'x64', credential })
    await expect(f.nodes.connect(credential, { connectionId: randomUUID() })).rejects.toMatchObject({ code: 'node-access/computer-busy' })
    expect((await pool.query('SELECT attachment_state FROM harness.node_agents WHERE node_id=$1', [f.b.nodeId])).rows[0].attachment_state).toBe('pending')
  })
  it('requires explicit initialization on the original legacy ingress while retaining existing managed leases', async () => {
    const f = await fixture()
    const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential
    const connectionId = randomUUID()
    await pool.query('UPDATE harness.deployment_topology SET legacy_initialization_required=true WHERE organization_id=$1', [f.id])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,attachment_state,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'managed',$4,5,clock_timestamp()+interval '30 seconds')`,
    [f.id, f.b.nodeId, createHash('sha256').update(credential).digest(), connectionId])
    await pool.query("UPDATE harness.instances SET observed_state='starting',desired_state='running',generation=generation+1 WHERE organization_id=$1 AND assigned_node_id=$2", [f.id, f.b.nodeId])
    expect(await f.topology.read()).toMatchObject({ mode: 'single', scope: 'local', legacyMigrationRequired: true })
    await expect(f.enable()).rejects.toMatchObject({ code: 'deployment/legacy-primary-required' })
    await expect(f.nodes.heartbeat(credential, { connectionId, epoch: '5' })).resolves.toMatchObject({ nodeId: f.b.nodeId })
    const options = { legacyForwarding: true, refreshAfterMs: 30000, pageSize: 10, maxBytes: 65536, allowedOrigins: ['https://primary.example.test'] }
    await expect(new PostgresDeploymentTopology(f.b, options).save(f.admin,
      { revision: '0', enabled: true, primaryOrigin: 'https://primary.example.test' })).rejects.toMatchObject({ code: 'deployment/current-computer-attached' })
    await expect(new PostgresDeploymentTopology(f.a, options).save(f.admin,
      { revision: '0', enabled: true, primaryOrigin: 'https://primary.example.test' })).resolves.toMatchObject({
      mode: 'multi', role: 'primary', legacyMigrationRequired: false,
    })
    expect((await pool.query('SELECT observed_state,node_connection_id FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2',
      [f.id, f.b.nodeId])).rows[0]).toMatchObject({ observed_state: 'starting', node_connection_id: connectionId })
  })
  it('requires a configured HTTPS or loopback origin and leaves the revision unchanged after a refusal', async () => {
    const f = await fixture()
    await expect(f.topology.save(f.admin, { revision: '0', enabled: true, primaryOrigin: 'http://primary.example.test' })).rejects.toMatchObject({ code: 'deployment/invalid-origin' })
    await expect(f.topology.save(f.admin, { revision: '0', enabled: true, primaryOrigin: 'https://unconfigured.example.test' })).rejects.toMatchObject({ code: 'deployment/origin-not-configured' })
    expect(await f.topology.read()).toMatchObject({ mode: 'single', revision: '0' })
  })
  it('detaches only a stopped Runtime, refuses old leases, and starts a new independent generation without a center lease', async () => {
    const f = await fixture(); await f.enable()
    const { ticket, credential, lease } = await f.connect()
    await pool.query("UPDATE harness.instances SET observed_state='starting',desired_state='running',generation=generation+1 WHERE organization_id=$1 AND assigned_node_id=$2", [f.id, f.b.nodeId])
    const before = (await pool.query('SELECT runtime_id,generation,node_connection_id FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2', [f.id, f.b.nodeId])).rows[0]
    expect(before.node_connection_id).toBe(lease.connectionId)
    await expect(f.nodes.mutate(f.admin, f.b.nodeId, { action: 'detach', revision: ticket.revision })).rejects.toMatchObject({ code: 'node-access/computer-busy' })
    await pool.query("UPDATE harness.instances SET observed_state='stopped',desired_state='stopped' WHERE organization_id=$1 AND assigned_node_id=$2", [f.id, f.b.nodeId])
    await f.nodes.mutate(f.admin, f.b.nodeId, { action: 'detach', revision: ticket.revision })
    await expect(f.nodes.heartbeat(credential, { connectionId: lease.connectionId, epoch: lease.epoch })).rejects.toMatchObject({ code: 'node-access/detached' })
    expect((await pool.query('SELECT harness.runtime_node_execution_allowed($1,$2,$3,$4) allowed', [f.id, f.b.nodeId, lease.connectionId, lease.epoch])).rows[0].allowed).toBe(false)
    await f.topology.save(f.admin, { revision: (await f.topology.read()).revision, enabled: false })
    await pool.query("UPDATE harness.instances SET observed_state='starting',desired_state='running',generation=generation+1 WHERE organization_id=$1 AND assigned_node_id=$2", [f.id, f.b.nodeId])
    const after = (await pool.query('SELECT runtime_id,generation,node_connection_id FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2', [f.id, f.b.nodeId])).rows[0]
    expect(after.runtime_id).toBe(before.runtime_id)
    expect(Number(after.generation)).toBeGreaterThan(Number(before.generation))
    expect(after.node_connection_id).toBeNull()
  })
  it('keeps foreign metadata outside local entries and blocks disabling until every attachment has exited', async () => {
    const f = await fixture()
    const access = new PostgresComputerAccess(f.a, f.cfg.runtimeCatalog)
    await access.set(f.admin, f.admin.id, f.b.nodeId, { enabled: true, revision: '0' })
    const catalog = new PostgresRuntimeCatalog(f.a, f.cfg.runtimeCatalog, f.a.nodeId as RuntimeNodeId)
    expect((await catalog.pageForAdministrator(f.admin, {})).items.every(item => item.node.id === f.a.nodeId)).toBe(true)
    await f.enable(); await f.connect()
    expect((await catalog.pageForAdministrator(f.admin, {})).items.some(item => item.node.id === f.b.nodeId)).toBe(true)
    await expect(f.topology.assertNode(f.b.nodeId)).resolves.toBeUndefined()
    await expect(f.local.assertNode(f.a.nodeId)).rejects.toMatchObject({ code: 'deployment/remote-target-unavailable' })
    expect(await f.topology.preflight(f.admin)).toMatchObject({ canDisable: false, blockingCount: 1 })
    await expect(f.topology.save(f.admin, { revision: (await f.topology.read()).revision, enabled: false })).rejects.toMatchObject({ code: 'deployment/computers-still-attached' })
  })
  it('keeps invitations on their fixed project computer and requires its grant independently of entry visibility', async () => {
    const f = await fixture()
    const localProjects = new PostgresProjectService(f.a, f.cfg, f.a.nodeId)
    const workerProjects = new PostgresProjectService(f.b, f.cfg, f.b.nodeId)
    const project = await workerProjects.createManaged({ name: 'Fixed computer collaboration', ownerUserId: f.worker.id, actorUserId: f.worker.id })
    const input = { projectId: project.id, inviteeUserId: f.member.id, inviterUserId: f.worker.id, mode: 'rw' as const }
    await expect(workerProjects.createInvitation(input)).rejects.toMatchObject({ code: 'invitation-computer-required' })
    await new PostgresComputerAccess(f.a, f.cfg.runtimeCatalog).set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    const invitation = await workerProjects.createInvitation(input)
    expect(await localProjects.listInvitations(f.member.id)).toEqual([])
    expect(await localProjects.countPendingInvitations(f.member.id)).toBe(0)
    await expect(localProjects.acceptInvitation(invitation.id, f.member.id)).rejects.toMatchObject({ code: 'invitation-computer-required' })
    await f.enable(); await f.connect()
    expect(await localProjects.countPendingInvitations(f.member.id)).toBe(1)
    expect(await localProjects.listInvitations(f.member.id)).toMatchObject([{ id: invitation.id, projectId: project.id }])
    await localProjects.acceptInvitation(invitation.id, f.member.id)
    expect((await pool.query('SELECT assigned_node_id FROM harness.instances WHERE organization_id=$1 AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)',
      [f.id, project.id])).rows[0].assigned_node_id).toBe(f.b.nodeId)
  })
  it('serializes enrollment and disabling so a successful disable cannot leave an attached computer', async () => {
    const f = await fixture(); await f.enable()
    const revision = (await f.topology.read()).revision
    const results = await Promise.allSettled([
      f.topology.save(f.admin, { revision, enabled: false }),
      f.nodes.issue(f.admin, { requestId: randomUUID(), nodeId: f.b.nodeId }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const state = await f.topology.read()
    if (state.mode === 'single') expect((await pool.query('SELECT 1 FROM harness.node_agents WHERE organization_id=$1', [f.id])).rows).toEqual([])
    else expect((await f.topology.preflight(f.admin)).canDisable).toBe(false)
  })
  it('rejects raw topology disable and primary changes while preserving a stopped attachment', async () => {
    const f = await fixture(); await f.enable(); await f.connect()
    await expect(pool.query('UPDATE harness.deployment_topology SET enabled=false WHERE organization_id=$1', [f.id])).rejects.toMatchObject({ constraint: 'deployment_computers_attached' })
    await expect(pool.query('UPDATE harness.deployment_topology SET primary_node_id=$2 WHERE organization_id=$1', [f.id, f.b.nodeId])).rejects.toMatchObject({ constraint: 'deployment_primary_immutable' })
  })
  it('keeps one-time setup private, reuses the existing computer identity and clears the consumed code', async () => {
    const f = await fixture(); await f.enable()
    const ticket = await f.nodes.issue(f.admin, { requestId: randomUUID(), nodeId: f.b.nodeId })
    f.cfg.publicOrigins.push('https://primary.example.test')
    const environment = { HGW_STATE_ROOT: f.cfg.stateRoot, HGW_NODE_CONNECTION_FILE: f.cfg.nodeConnectionFile }
    const serialPool = createPostgresPool(url!, { max: 1 }); releases.push(() => serialPool.end())
    const local = { ...f.b, pool: serialPool }
    const setup = new GatewayNodeConnection(local, f.cfg, environment, nodeConfigurationAuthority(local), f.local)
    const saved = await setup.save(f.admin, { revision: 0, centerUrl: 'https://primary.example.test', enrollmentToken: ticket.token })
    expect(saved).toMatchObject({ nodeId: f.b.nodeId, configured: true, enrollmentPending: true, originReady: true })
    expect(JSON.stringify(saved)).not.toContain(ticket.token)
    expect((await stat(f.cfg.nodeConnectionFile)).mode & 0o777).toBe(0o600)
    const agent = await configuredNodeAgent(environment)
    expect(agent.config.expectedIdentity).toEqual({ organizationId: f.id, nodeId: f.b.nodeId })
    expect(agent.config.enrollmentToken).toBe(ticket.token)
    await agent.clearCode()
    expect(await readFile(f.cfg.nodeConnectionFile, 'utf8')).not.toContain(ticket.token)
    expect(await setup.view(f.admin)).toMatchObject({ revision: 1, enrollmentPending: false })
    await expect(setup.save(f.admin, { revision: 0, centerUrl: 'https://primary.example.test', enrollmentToken: ticket.token })).rejects.toMatchObject({ message: 'node-connection-revision-conflict' })
    await expect(setup.view(f.member)).rejects.toMatchObject({ code: 'forbidden' })
    const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential
    await f.nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'arm64', credential })
    await f.nodes.connect(credential, { connectionId: randomUUID() })
    expect(await setup.view(f.admin)).toMatchObject({ connectionState: 'connected' })
    await expect(setup.start(f.admin)).rejects.toMatchObject({ message: 'node-connection-already-connected' })
  })
})
