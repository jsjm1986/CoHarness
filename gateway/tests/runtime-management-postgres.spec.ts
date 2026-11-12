/** Personal Runtime allocation, shared limits and node-owned retirement through real PostgreSQL providers. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { InstanceManager, type RuntimeTarget } from '../src/instances.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { PostgresRuntimeManagement } from '../src/runtime-management.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { refreshModelGovernance, writeModelGovernanceFile } from '../src/apply-model-governance.ts'
import { applyGrantsToUser } from '../src/apply-grants.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { personalRuntimeLayout } from '../src/runtime-layout.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('personal Runtime management across computers', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-allocation-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const slug = `runtime-management-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Runtime management') RETURNING id`, [slug])).rows[0]!.id
    cleanups.push(() => removeFixtureOrganization(pool, organizationId))
    for (const name of ['computer-a', 'computer-b']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
    const a = await resolvePostgresRuntimeContext(pool, slug, 'computer-a'), b = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
    const cfgA = testConfig(join(root, 'a')), cfgB = testConfig(join(root, 'b'))
    const usersA = new PostgresUserService(a, cfgA), usersB = new PostgresUserService(b, cfgB)
    const admin = await usersA.create({ username: 'administrator', password: 'test-password', role: 'admin' })
    const user = await usersA.create({ username: 'executor', password: 'test-password' })
    await usersA.changeOwnPassword(admin.id, 'test-password')
    await usersA.changeOwnPassword(user.id, 'test-password')
    const userId = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, user.id])).rows[0]!.id
    const serviceA = new PostgresRuntimeManagement(a, cfgA), serviceB = new PostgresRuntimeManagement(b, cfgB)
    const repositoryA = new PostgresInstanceRepository(a, cfgA.instancePortBase), repositoryB = new PostgresInstanceRepository(b, cfgB.instancePortBase)
    const catalog = new PostgresRuntimeCatalog(a, cfgA.runtimeCatalog)
    const grantB = async () => { await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      VALUES($1,$2,$3,true) ON CONFLICT(organization_id,node_id,user_id) DO UPDATE SET enabled=true`, [organizationId, b.nodeId, userId]) }
    const targets = () => repositoryA.targetsForOwner({ kind: 'user', id: user.id })
    return { root, organizationId, a, b, cfgA, cfgB, usersA, usersB, admin, user, userId, serviceA, serviceB, repositoryA, repositoryB, catalog, grantB, targets }
  }

  it.each([true, false])('permits administrator lifecycle stop of the reserved project with qualification=%s', async (qualified) => {
    const f = await fixture(), path = join(f.root, 'steward')
    await mkdir(path)
    const project = await new PostgresProjectService(f.a, f.cfgA).ensureSteward({ name: 'Reserved maintenance', path })
    if (qualified) await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision)
      SELECT $1,$2,id,true,1 FROM harness.users WHERE organization_id=$1 AND public_id=$3`, [f.organizationId, f.a.nodeId, f.admin.id])
    const target = await f.repositoryA.resolveTarget({ kind: 'project', id: project.id })
    await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running' WHERE organization_id=$1 AND runtime_id=$2",
      [f.organizationId, target.runtimeId])
    const carrier = createServer((_req, res) => { res.end('owned runtime is live') })
    await new Promise<void>(done => { carrier.listen(0, '127.0.0.1', done) })
    let closed = false, stopCalls = 0
    const close = async () => {
      if (closed) return
      carrier.closeAllConnections()
      await new Promise<void>((done, reject) => { carrier.close(error => { if (error) reject(error); else done() }) })
      closed = true
    }
    cleanups.push(close)
    const budget = new NodeResourceBudget(pool, f.organizationId, f.a.nodeId, f.cfgA.resourceBudget)
    const processOwner = await GatewayModelBudget.open(budget, join(f.root, 'gateway-owners'))
    cleanups.push(() => processOwner.close())
    const manager = new InstanceManager(f.repositoryA, f.cfgA, {
      instancesOutliveGateway: false,
      start: async () => { throw new Error('Lifecycle stop cannot launch a Runtime') },
      attach: () => ({ hasExited: () => closed, terminate: async () => { stopCalls++; await close() } }),
    }, { principalPublicKey: '' }, budget, processOwner)
    cleanups.push(() => manager.stopAll())
    await expect(manager.withStopped(target, async () => {}, f.admin.id, 1)).rejects.toMatchObject({ code: qualified ? 'steward-reserved' : 'forbidden' })
    await expect(manager.withStopped(target, async () => {}, f.admin.id, 2, 'control')).rejects.toMatchObject({ code: 'INSTANCE_GENERATION_CHANGED' })
    expect({ closed, stopCalls }).toEqual({ closed: false, stopCalls: 0 })
    expect(await f.repositoryA.snapshotOf(target)).toMatchObject({ state: 'ready', generation: 1 })
    await manager.withStopped(target, async () => {}, f.admin.id, 1, 'control')
    expect({ closed, stopCalls }).toEqual({ closed: true, stopCalls: 1 })
    expect(await f.repositoryA.snapshotOf(target)).toMatchObject({ state: 'stopped', generation: 1 })
    expect((await pool.query('SELECT 1 FROM harness.runtime_destructive_operations WHERE organization_id=$1', [f.organizationId])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [f.organizationId, project.id])).rowCount).toBe(1)
  })

  it('seeds a separate resident steward project per node, each bound to its home node', async () => {
    const f = await fixture(), pathA = join(f.root, 'steward-a'), pathB = join(f.root, 'steward-b')
    await mkdir(pathA); await mkdir(pathB)
    const serviceA = new PostgresProjectService(f.a, f.cfgA), serviceB = new PostgresProjectService(f.b, f.cfgB)
    const seededA = await serviceA.ensureSteward({ name: 'Reserved maintenance', path: pathA })
    const seededB = await serviceB.ensureSteward({ name: 'Reserved maintenance', path: pathB })
    expect(seededB.id).not.toBe(seededA.id)
    const bound = await pool.query<{ steward_node_id: string; name: string }>(`SELECT p.steward_node_id::text,p.name::text
      FROM harness.projects p WHERE p.organization_id=$1 AND p.kind='steward' ORDER BY p.public_id`, [f.organizationId])
    expect(bound.rows.map(row => row.steward_node_id).sort()).toEqual([f.a.nodeId, f.b.nodeId].sort())
    const mounts = await pool.query<{ node_id: string; status: string }>(`SELECT pm.node_id,pm.status
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
      WHERE pm.organization_id=$1 AND p.kind='steward' ORDER BY pm.node_id`, [f.organizationId])
    expect(mounts.rows.map(row => row.node_id).sort()).toEqual([f.a.nodeId, f.b.nodeId].sort())
    expect(mounts.rows.map(row => row.status)).toEqual(['active', 'active'])
    expect(await serviceB.stewardProject()).toMatchObject({ id: seededB.id, path: await realpath(pathB) })
    const allocations = await pool.query<{ assigned_node_id: string }>(`SELECT i.assigned_node_id
      FROM harness.instances i JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND p.kind='steward'`, [f.organizationId])
    expect(allocations.rows.map(row => row.assigned_node_id).sort()).toEqual([f.a.nodeId, f.b.nodeId].sort())
    // A repeat seeding on node A stays idempotent against its own steward project.
    const again = await serviceA.ensureSteward({ name: 'Reserved maintenance', path: pathA })
    expect(again.id).toBe(seededA.id)
    expect((await pool.query('SELECT COUNT(*)::int count FROM harness.projects WHERE organization_id=$1 AND kind=$2',
      [f.organizationId, 'steward'])).rows[0]!.count).toBe(2)
  })

  it('recovers a bound steward row that lost its active mount instead of reporting a collision', async () => {
    const f = await fixture(), pathA = join(f.root, 'steward-a'), pathB = join(f.root, 'steward-b')
    await mkdir(pathA); await mkdir(pathB)
    const serviceA = new PostgresProjectService(f.a, f.cfgA), serviceB = new PostgresProjectService(f.b, f.cfgB)
    await serviceA.ensureSteward({ name: 'Reserved maintenance', path: pathA })
    const seededB = await serviceB.ensureSteward({ name: 'Reserved maintenance', path: pathB })
    // Strip node B's active mount: the bound row survives so the next seeding
    // collides on projects_steward_per_node and must recover, not throw.
    await pool.query(`UPDATE harness.project_mounts pm SET status='missing'
      FROM harness.projects p WHERE p.id=pm.project_id AND p.organization_id=pm.organization_id
        AND pm.organization_id=$1 AND p.kind='steward' AND pm.node_id=$2`, [f.organizationId, f.b.nodeId])
    const recovered = await serviceB.ensureSteward({ name: 'Reserved maintenance', path: pathB })
    expect(recovered.id).toBe(seededB.id)
    const mount = await pool.query<{ local_path: string; status: string }>(`SELECT pm.local_path,pm.status
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
      WHERE pm.organization_id=$1 AND p.kind='steward' AND pm.node_id=$2 AND pm.status='active'`, [f.organizationId, f.b.nodeId])
    expect(await Promise.all(mount.rows.map(row => realpath(row.local_path)))).toEqual([await realpath(pathB)])
    const allocation = await pool.query<{ assigned_node_id: string }>(`SELECT i.assigned_node_id
      FROM harness.instances i JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND p.kind='steward'`, [f.organizationId])
    expect(allocation.rows.map(row => row.assigned_node_id).sort()).toEqual([f.a.nodeId, f.b.nodeId].sort())
    expect((await pool.query('SELECT COUNT(*)::int count FROM harness.projects WHERE organization_id=$1 AND kind=$2',
      [f.organizationId, 'steward'])).rows[0]!.count).toBe(2)
  })

  it('reconverges the bound steward mount when the configured workspace path moves', async () => {
    const f = await fixture(), pathA = join(f.root, 'steward-a'), moved = join(f.root, 'steward-moved')
    await mkdir(pathA); await mkdir(moved)
    const serviceA = new PostgresProjectService(f.a, f.cfgA)
    const seeded = await serviceA.ensureSteward({ name: 'Reserved maintenance', path: pathA })
    // A workspace path that changed since seeding must update the live mount,
    // not leave the Runtime pointed at the retired directory.
    const converged = await serviceA.ensureSteward({ name: 'Reserved maintenance', path: moved })
    expect(converged.id).toBe(seeded.id)
    const mount = await pool.query<{ local_path: string; canonical_path: string }>(`SELECT pm.local_path,pm.canonical_path
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
      WHERE pm.organization_id=$1 AND p.kind='steward' AND pm.node_id=$2 AND pm.status='active'`, [f.organizationId, f.a.nodeId])
    expect(await Promise.all(mount.rows.map(row => realpath(row.local_path)))).toEqual([await realpath(moved)])
    expect(await Promise.all(mount.rows.map(row => realpath(row.canonical_path)))).toEqual([await realpath(moved)])
  })

  it('retains override revisions through inheritance and refuses stale editors and administrators', async () => {
    const f = await fixture()
    expect(await f.serviceA.policy(f.admin)).toMatchObject({ revision: '1', maxTotal: 8, maxPerNode: 4, source: 'organization' })
    expect(await f.serviceA.policy(f.admin, f.user.id)).toMatchObject({ revision: '0', source: 'organization' })
    const first = await f.serviceA.setPolicy(f.admin, { revision: '0', limits: { maxTotal: 3, maxPerNode: 2 } }, f.user.id)
    const inherited = await f.serviceA.setPolicy(f.admin, { revision: first.revision, limits: null }, f.user.id)
    expect(inherited).toMatchObject({ revision: '2', maxTotal: 8, source: 'organization' })
    await expect(f.serviceA.setPolicy(f.admin, { revision: '1', limits: { maxTotal: 1, maxPerNode: 1 } }, f.user.id))
      .rejects.toMatchObject({ status: 409, code: 'runtime-management/revision-conflict' })
    expect(await f.serviceA.setPolicy(f.admin, { revision: '2', limits: { maxTotal: 4, maxPerNode: 2 } }, f.user.id)).toMatchObject({ revision: '3', source: 'user' })
    await expect(f.serviceA.setPolicy(f.admin, { revision: '1', limits: null })).rejects.toMatchObject({ status: 400 })
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE public_id=$2 AND organization_id=$1)", [f.organizationId, f.admin.id])
    await expect(f.serviceA.policy(f.admin)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('reads one coherent local assignment and refuses foreign, missing and ambiguous selectors', async () => {
    const f = await fixture()
    await f.repositoryA.initialize()
    const target = await f.repositoryA.resolveTarget({ kind: 'user', id: f.user.id })
    const port = await f.repositoryA.portOf(target)
    expect(await f.repositoryA.snapshotOf(target)).toEqual({ target, port, state: 'stopped', generation: 1, launchStamp: null })
    const generation = await f.repositoryA.beginStart(target, Date.now(), randomBytes(32), 'explicit')
    expect(await f.repositoryA.snapshotOf({ kind: 'user', id: f.user.id })).toEqual({ target, port, state: 'starting', generation, launchStamp: null })
    await f.repositoryA.markReady(target, generation)
    expect(await f.repositoryA.snapshotOf(target)).toEqual({ target, port, state: 'ready', generation, launchStamp: null })
    await expect(f.repositoryB.snapshotOf(target)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await expect(f.repositoryA.snapshotOf({ ...target, id: f.admin.id })).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await expect(f.repositoryA.snapshotOf({ ...target, runtimeId: randomUUID() as typeof target.runtimeId })).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() })
    await expect(f.repositoryA.snapshotOf({ kind: 'user', id: f.user.id })).rejects.toMatchObject({ code: 'runtime-catalog/ambiguous-target' })
    expect(await f.repositoryA.snapshotOf(target)).toEqual({ target, port, state: 'ready', generation, launchStamp: null })
  })

  it('persists the launch stamp with the generation claim and clears it on the next unstamped claim', async () => {
    const f = await fixture()
    await f.repositoryA.initialize()
    const target = await f.repositoryA.resolveTarget({ kind: 'user', id: f.user.id })
    const generation = await f.repositoryA.beginStart(target, Date.now(), randomBytes(32), 'explicit', undefined, false, 'stamp-a')
    await f.repositoryA.markReady(target, generation)
    expect(await f.repositoryA.launchStampOf(target, generation)).toBe('stamp-a')
    expect(await f.repositoryA.snapshotOf(target)).toMatchObject({ launchStamp: 'stamp-a' })
    await f.repositoryA.markStopping(target, generation, 'shutdown')
    await f.repositoryA.markStopped(target, generation)
    const replacement = await f.repositoryA.beginStart(target, Date.now(), randomBytes(32), 'explicit')
    expect(await f.repositoryA.launchStampOf(target, replacement)).toBeNull()
    expect(await f.repositoryA.snapshotOf(target)).toMatchObject({ state: 'starting', generation: replacement, launchStamp: null })
  })

  it('admits only the current ready assignment without touching refused owner, node or generation targets', async () => {
    const f = await fixture()
    await f.repositoryA.initialize()
    const target = await f.repositoryA.resolveTarget({ kind: 'user', id: f.user.id })
    const other = await f.repositoryA.resolveTarget({ kind: 'user', id: f.admin.id })
    const generation = await f.repositoryA.beginStart(target, Date.now(), randomBytes(32), 'explicit')
    const activity = async () => (await pool.query<{ value: string }>(`SELECT last_activity_at::text value
      FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2`, [f.organizationId, target.runtimeId])).rows[0]!.value
    const refuses = async (repository = f.repositoryA, selected = target, expected = generation) => {
      const before = await activity()
      expect(await repository.admitLease(selected, Date.now() + 1_000, expected)).toBe(false)
      expect(await activity()).toBe(before)
    }
    await refuses()
    await f.repositoryA.markReady(target, generation)
    expect(await f.repositoryA.admitLease(target, Date.now(), generation)).toBe(true)
    expect(await f.repositoryA.admitLease(target, Date.now())).toBe(true)
    expect(await f.repositoryA.admitLease({ kind: 'user', id: f.user.id }, Date.now(), generation)).toBe(true)
    await refuses(f.repositoryA, target, generation + 1)
    await refuses(f.repositoryA, { ...target, id: f.admin.id })
    await refuses(f.repositoryA, { ...target, runtimeId: other.runtimeId! })
    await refuses(f.repositoryB)
    await pool.query("UPDATE harness.users SET status='disabled' WHERE organization_id=$1 AND id=$2", [f.organizationId, f.userId])
    await refuses()
    await pool.query("UPDATE harness.users SET status='active' WHERE organization_id=$1 AND id=$2", [f.organizationId, f.userId])
    await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.userId])
    await refuses()
    await pool.query("UPDATE harness.memberships SET status='active' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.userId])
    await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,false)
      ON CONFLICT(organization_id,node_id,user_id) DO UPDATE SET enabled=false`, [f.organizationId, f.a.nodeId, f.userId])
    await refuses()
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
      [f.organizationId, f.a.nodeId, f.userId])
    await f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() })
    await refuses(f.repositoryA, { kind: 'user', id: f.user.id })
    expect(await f.repositoryA.admitLease(target, Date.now(), generation)).toBe(true)
  })

  it('counts assignments across computers, reserves shared quotas and recovers the exact request identity', async () => {
    const f = await fixture(), requestId = randomUUID()
    await expect(f.serviceB.allocate(f.admin, f.user.id, { requestId })).rejects.toMatchObject({ status: 403 })
    await f.serviceA.setPolicy(f.admin, { revision: '0', limits: { maxTotal: 3, maxPerNode: 2 } }, f.user.id)
    const local = await f.serviceA.allocate(f.admin, f.user.id, { requestId })
    expect(local).toMatchObject({ requestId, userId: f.user.id, nodeId: f.a.nodeId, status: 'allocated' })
    expect(await f.serviceA.allocate(f.admin, f.user.id, { requestId })).toEqual(local)
    await expect(f.serviceA.allocate(f.admin, f.admin.id, { requestId })).rejects.toMatchObject({ status: 409 })
    await expect(f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'runtime-management/quota-exceeded' })
    await f.grantB()
    const remote = await f.serviceB.allocate(f.admin, f.user.id, { requestId: randomUUID() })
    expect(remote.runtimeId).not.toBe(local.runtimeId)
    await expect(f.serviceB.allocate(f.admin, f.user.id, { requestId })).rejects.toMatchObject({ code: 'runtime-management/request-conflict' })
    await expect(f.serviceB.allocate(f.admin, f.user.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'runtime-management/quota-exceeded' })
    expect(await f.usersA.getListedById(f.user.id)).toMatchObject({ runtimeCount: 2, port: null, instanceState: 'multiple' })
    expect(await f.usersB.getListedById(f.user.id)).toMatchObject({ runtimeCount: 1, instanceState: 'stopped', homePath: join(f.cfgB.usersRoot, f.user.username, 'home') })
    expect((await f.usersA.list()).filter(row => row.id === f.user.id)).toHaveLength(1)
    expect((await f.usersB.list()).find(row => row.id === f.admin.id)).toMatchObject({ runtimeCount: 0, port: null, instanceState: 'unassigned' })
    await expect(f.catalog.resolveForOwner(f.user, { kind: 'personal', id: f.user.id })).rejects.toMatchObject({ status: 409 })
    expect((await f.catalog.pageForAccount(f.user, {})).items).toHaveLength(3)
    await expect(f.repositoryA.resolveTarget({ kind: 'user', id: f.user.id })).rejects.toMatchObject({ status: 409 })
    const exact: RuntimeTarget = { kind: 'user', id: f.user.id, runtimeId: local.runtimeId }
    expect(await f.repositoryA.resolveTarget(exact)).toEqual(exact)
  })

  it('retains preparing allocations after local disk failure and resumes without taking a second quota slot', async () => {
    const f = await fixture(), requestId = randomUUID()
    await f.grantB()
    const parent = join(f.cfgB.usersRoot, f.user.username), alias = join(parent, 'runtimes')
    await mkdir(parent, { recursive: true }); await symlink(f.root, alias)
    await expect(f.serviceB.allocate(f.admin, f.user.id, { requestId })).rejects.toMatchObject({ status: 503, code: 'runtime-management/provisioning-pending' })
    await expect(f.serviceA.allocationReceipt(f.admin, requestId)).rejects.toMatchObject({ status: 404 })
    const receipt = await f.serviceB.allocationReceipt(f.admin, requestId)
    expect(receipt.status).toBe('preparing')
    const exact: RuntimeTarget = { kind: 'user', id: f.user.id, runtimeId: receipt.runtimeId }
    const instances = new InstanceManager(f.repositoryB, f.cfgB)
    cleanups.push(() => instances.stopAll())
    const projections = { cfg: f.cfgB, users: f.usersB, projects: new PostgresProjectService(f.b, f.cfgB), instances,
      governance: new PostgresModelGovernanceService(f.b, new OrganizationModelCredentialCipher(Buffer.alloc(32, 12))),
      audit: new PostgresAuditService(f.b) }
    await refreshModelGovernance(projections)
    expect(await applyGrantsToUser(projections, f.user.id, f.admin.id)).toBe('written')
    await expect(readFile(join(f.root, receipt.runtimeId, 'dsh', 'model-governance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.repositoryB.beginStart(exact, Date.now(), randomBytes(32), 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await expect(pool.query("UPDATE harness.instances SET observed_state='starting',desired_state='running' WHERE runtime_id=$1", [receipt.runtimeId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'runtime_provisioning' })
    await unlink(alias)
    expect(await f.serviceB.allocate(f.admin, f.user.id, { requestId })).toEqual({ ...receipt, status: 'allocated' })
    await refreshModelGovernance(projections)
    expect(JSON.parse(await readFile(join(parent, 'runtimes', receipt.runtimeId, 'dsh', 'model-governance.json'), 'utf8'))).toHaveProperty('intakeToken')
    expect((await f.repositoryB.targetsForOwner(exact)).map(target => target.runtimeId)).toEqual([receipt.runtimeId])
    const inventory = await readFile(join(parent, 'runtimes', receipt.runtimeId, 'dsh', 'managed-data.jsonl'), 'utf8')
    expect(inventory).toContain(join(parent, 'home', 'documents'))
    expect(inventory).not.toContain(f.cfgA.usersRoot)
  })

  it('serializes concurrent node allocations against one account-wide quota', async () => {
    const f = await fixture()
    await f.grantB()
    await f.serviceA.setPolicy(f.admin, { revision: '0', limits: { maxTotal: 2, maxPerNode: 2 } }, f.user.id)
    const results = await Promise.allSettled([f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() }),
      f.serviceB.allocate(f.admin, f.user.id, { requestId: randomUUID() })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ code: 'runtime-management/quota-exceeded' })
    expect((await f.catalog.pageForAccount(f.user, {})).items).toHaveLength(2)
  })

  it('keeps Runtime reporting credentials independent while usage remains billed to one account', async () => {
    const f = await fixture(), primary = (await f.targets())[0]!
    const local = await f.serviceA.allocate(f.admin, f.user.id, { requestId: randomUUID() })
    await f.grantB()
    const remote = await f.serviceB.allocate(f.admin, f.user.id, { requestId: randomUUID() })
    const cipher = new OrganizationModelCredentialCipher(Buffer.alloc(32, 12))
    const a = new PostgresModelGovernanceService(f.a, cipher), b = new PostgresModelGovernanceService(f.b, cipher)
    const servers = [createUsageIntakeServer(a), createUsageIntakeServer(b)]
    for (const server of servers) {
      cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    }
    const choices = [
      { service: a, cfg: f.cfgA, runtimeId: primary.runtimeId!, storageLayout: 'legacy' as const, server: servers[0]! },
      { service: a, cfg: f.cfgA, runtimeId: local.runtimeId, storageLayout: 'isolated' as const, server: servers[0]! },
      { service: b, cfg: f.cfgB, runtimeId: remote.runtimeId, storageLayout: 'isolated' as const, server: servers[1]! },
    ]
    const tokens: string[] = []
    for (const choice of choices) {
      const owner = { ...f.user, runtimeId: choice.runtimeId, storageLayout: choice.storageLayout }
      const path = await writeModelGovernanceFile(choice.cfg, choice.service, owner)
      const policy = JSON.parse(await readFile(path, 'utf8')) as { intakeToken: string }
      expect(path).toBe(join(personalRuntimeLayout(choice.cfg, owner).dshHome, 'model-governance.json'))
      tokens.push(policy.intakeToken)
    }
    expect(new Set(tokens).size).toBe(3)
    for (const [index, choice] of choices.entries()) {
      expect(await choice.service.subjectForIntakeToken(tokens[index]!)).toEqual({ kind: 'user', id: f.user.id, runtimeId: choice.runtimeId })
      const path = await writeModelGovernanceFile(choice.cfg, choice.service, { ...f.user, runtimeId: choice.runtimeId, storageLayout: choice.storageLayout })
      expect((JSON.parse(await readFile(path, 'utf8')) as { intakeToken: string }).intakeToken).toBe(tokens[index])
      const response = await fetch(`http://127.0.0.1:${(choice.server.address() as AddressInfo).port}/usage`, { method: 'POST',
        headers: { authorization: `Bearer ${tokens[index]!}`, 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: randomUUID(), occurredAt: Date.now(), provider: 'fixture', model: 'reply', purpose: 'chat',
          sessionId: `reporting-${index}`, credentialSource: 'organization', credentialClass: 'company', status: 'succeeded', usage: { inputTokens: 1, outputTokens: 2 } }) })
      expect(response.status, await response.text()).toBe(200)
    }
    expect(await a.subjectForIntakeToken(tokens[2]!)).toBeNull()
    expect(await b.subjectForIntakeToken(tokens[0]!)).toBeNull()
    expect((await pool.query<{ user_id: string; calls: number; tokens: number }>(`SELECT user_id,count(*)::integer calls,
      sum(input_tokens+output_tokens)::integer tokens FROM harness.model_usage WHERE organization_id=$1 GROUP BY user_id`, [f.organizationId])).rows)
      .toEqual([{ user_id: f.userId, calls: 3, tokens: 9 }])
    await f.usersA.remove(f.user.id, f.admin.id)
    for (const [index, choice] of choices.entries()) expect(await choice.service.subjectForIntakeToken(tokens[index]!)).toBeNull()
  })

  it('retires only a confirmed exact assignment and retains its data, receipt and storage history', async () => {
    const f = await fixture(), requestId = randomUUID()
    const allocated = await f.serviceA.allocate(f.admin, f.user.id, { requestId })
    const exact: RuntimeTarget = { kind: 'user', id: f.user.id, runtimeId: allocated.runtimeId }
    const budget = new NodeResourceBudget(pool, f.organizationId, f.a.nodeId, f.cfgA.resourceBudget)
    const owner = await GatewayModelBudget.open(budget, join(f.root, 'gateway-owners'))
    cleanups.push(() => owner.close())
    const manager = new InstanceManager(f.repositoryA, f.cfgA, { instancesOutliveGateway: false,
      start: async () => { throw new Error('Stopped allocation fixture cannot launch') } }, undefined, budget, owner)
    cleanups.push(() => manager.stopAll())
    const marker = join(f.cfgA.usersRoot, f.user.username, 'runtimes', allocated.runtimeId, 'dsh', 'retained.txt')
    await writeFile(marker, 'retained Runtime data')
    const operation = vi.fn(async () => undefined)
    await expect(manager.withStopped(exact, operation, f.admin.id, 2)).rejects.toMatchObject({ code: 'INSTANCE_GENERATION_CHANGED' })
    expect(operation).not.toHaveBeenCalled()
    await manager.withStopped(exact, async lease => {
      expect((await pool.query<{ confirmed: boolean }>('SELECT quiescent_at IS NOT NULL confirmed FROM harness.runtime_destructive_operations WHERE runtime_id=$1', [allocated.runtimeId])).rows)
        .toEqual([{ confirmed: true }])
      await f.serviceA.retire(f.admin, f.user.id, lease!)
    }, f.admin.id, 1)
    expect(await readFile(marker, 'utf8')).toBe('retained Runtime data')
    expect(await f.serviceA.allocationReceipt(f.admin, requestId)).toEqual({ ...allocated, status: 'retired' })
    expect(await f.serviceA.allocate(f.admin, f.user.id, { requestId })).toEqual({ ...allocated, status: 'retired' })
    expect((await pool.query<{ storage_layout: string; retired: boolean }>('SELECT storage_layout,retired_at IS NOT NULL retired FROM harness.runtime_environments WHERE id=$1', [allocated.runtimeId])).rows)
      .toEqual([{ storage_layout: 'isolated', retired: true }])
    await f.repositoryA.initialize()
    expect((await f.targets()).map(target => target.runtimeId)).not.toContain(allocated.runtimeId)
    expect(await f.targets()).toHaveLength(1)
  })

  it('rechecks administrator authority after allocation waits for an organization mutation', async () => {
    const f = await fixture(), applicationName = `allocation-wait-${randomUUID()}`
    const contender = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    cleanups.push(() => contender.end())
    const service = new PostgresRuntimeManagement({ ...f.a, pool: contender }, f.cfgA)
    const blocker = await pool.connect(), requestId = randomUUID()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${f.organizationId}`])
      pending = service.allocate(f.admin, f.user.id, { requestId }).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName])).rowCount).toBe(1)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.organizationId, f.admin.id])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect(await f.targets()).toHaveLength(1)
      expect((await pool.query('SELECT request_id FROM harness.runtime_allocation_receipts WHERE organization_id=$1', [f.organizationId])).rows).toEqual([])
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending }
  })
})
