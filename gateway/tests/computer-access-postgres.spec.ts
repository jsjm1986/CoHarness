import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
/** Real organization permissions, remote project membership and runtime admission. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PostgresComputerAccess } from '../src/computer-access.ts'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'
import { createGatewayServer } from '../src/server.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { InstanceManager } from '../src/instances.ts'
import { ResourceAccess } from '../src/resource-access.ts'
import { PostgresWorkspaceCatalog } from '../src/workspace-catalog.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { testConfig } from './test-config.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('organization computer use', () => {
  let pool: Pool
  const releases: Array<() => Promise<unknown>> = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const failures = []
    for (const release of releases.splice(0).reverse()) { try { await release() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Computer permission cleanup failed')
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-computer-use-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `computers-${randomUUID()}`
    const organization = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Computer permissions') RETURNING id", [slug])).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, organization))
    for (const name of ['computer-a', 'computer-b']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, name])
    const a = await resolvePostgresRuntimeContext(pool, slug, 'computer-a'), b = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
    await enableFixtureTopology(a)
    const cfg = testConfig(root), users = new PostgresUserService(a, cfg), remoteUsers = new PostgresUserService(b, cfg)
    const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'pw-12345678' })
    const remote = await remoteUsers.create({ username: 'remote', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    await users.changeOwnPassword(member.id, 'pw-12345678')
    await remoteUsers.changeOwnPassword(remote.id, 'pw-12345678')
    const access = new PostgresComputerAccess(a, cfg.runtimeCatalog), remoteAccess = new PostgresComputerAccess(b, cfg.runtimeCatalog)
    const projects = new PostgresProjectService(b, cfg)
    const project = await projects.createManaged({ name: 'Remote project', ownerUserId: remote.id })
    return { root, cfg, organization, a, b, users, remoteUsers, admin, member, remote, access, remoteAccess, projects, project }
  }

  it('preserves only the original personal-space host and requires computer use in addition to project membership', async () => {
    const f = await fixture()
    expect((await f.access.page(f.member, {})).items.map(item => item.nodeId)).toEqual([f.a.nodeId])
    await f.projects.setMember(f.project.id, f.member.id, 'rw', f.admin.id)
    const catalog = new PostgresRuntimeCatalog(f.a, f.cfg.runtimeCatalog), collaboration = new PostgresCollaborationService(f.b)
    expect((await catalog.pageForAccount(f.member, {})).items.some(item => item.owner.kind === 'project')).toBe(false)
    expect(await collaboration.projectForUser(f.project.id, f.member.id)).toBeNull()
    await expect(f.remoteAccess.authorize(f.member.id)).rejects.toMatchObject({ status: 403 })
    const permission = await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    expect(permission).toMatchObject({ nodeId: f.b.nodeId, enabled: true, revision: '1' })
    expect(await collaboration.projectForUser(f.project.id, f.member.id)).toMatchObject({ projectId: f.project.id, mode: 'rw' })
    expect((await catalog.pageForAccount(f.member, {})).items.some(item => item.owner.kind === 'project')).toBe(true)
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '1' })
    expect(await collaboration.projectForUser(f.project.id, f.member.id)).toBeNull()
    await expect(f.access.authorize(f.member.id)).resolves.toBeUndefined()
    expect(await f.projects.getById(f.project.id)).not.toBeNull()
  })

  it('lists authorized empty projects across the primary entry while direct access and execution remain computer-scoped', async () => {
    const f = await fixture()
    const local = await new PostgresProjectService(f.a, f.cfg).createManaged({ name: 'Local project', ownerUserId: f.member.id })
    await f.projects.setMember(f.project.id, f.member.id, 'rw', f.admin.id)
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,attachment_state)
      VALUES($1,$2,$3,'managed')`, [f.organization, f.b.nodeId, createHash('sha256').update(randomBytes(32)).digest()])
    const primary = new PostgresCollaborationService(f.a, f.a.nodeId as RuntimeNodeId)
    const secondary = new PostgresCollaborationService(f.b, f.b.nodeId as RuntimeNodeId)
    const states = async () => (await pool.query(`SELECT runtime_id,generation::text,observed_state FROM harness.instances
      WHERE organization_id=$1 ORDER BY runtime_id`, [f.organization])).rows
    const before = await states()
    expect((await primary.projectsForUser(f.member.id)).map(item => item.projectId)).toEqual([local.id])
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    expect(await primary.projectsForUser(f.member.id)).toMatchObject([
      { projectId: local.id, nodeId: f.a.nodeId, nodeName: 'computer-a' },
      { projectId: f.project.id, nodeId: f.b.nodeId, nodeName: 'computer-b' },
    ])
    expect((await secondary.projectsForUser(f.member.id)).map(item => item.projectId)).toEqual([f.project.id])
    expect(await primary.projectForUser(f.project.id, f.member.id)).toBeNull()
    expect(await secondary.projectForUser(f.project.id, f.member.id)).toMatchObject({ projectId: f.project.id })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '1' })
    expect((await primary.projectsForUser(f.member.id)).map(item => item.projectId)).toEqual([local.id])
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '2' })
    await new PostgresNodeAccessService(f.a, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
      .mutate(f.admin, f.b.nodeId, { action: 'detach', revision: 1 })
    await pool.query('UPDATE harness.deployment_topology SET enabled=false WHERE organization_id=$1', [f.organization])
    expect((await primary.projectsForUser(f.member.id)).map(item => item.projectId)).toEqual([local.id])
    expect(await states()).toEqual(before)
  })

  it('rechecks current administrator authority and revisions without granting project membership or allocating a runtime', async () => {
    const f = await fixture()
    await expect(f.access.set(f.member, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })).rejects.toMatchObject({ status: 403 })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    await expect(f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '0' })).rejects.toMatchObject({ status: 409 })
    expect(await new PostgresCollaborationService(f.b).projectForUser(f.project.id, f.member.id)).toBeNull()
    expect(await new PostgresInstanceRepository(f.b, f.cfg.instancePortBase).owner({ kind: 'user', id: f.member.id })).toBeNull()
    await f.users.setRole(f.admin.id, 'user')
    await expect(f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '1' })).rejects.toMatchObject({ status: 403 })
    expect((await f.remoteAccess.page(f.member, {})).items).toHaveLength(2)
  })

  it('requires the project computer at issuance and acceptance without requiring a personal runtime there', async () => {
    const f = await fixture(), invitation = { projectId: f.project.id, inviterUserId: f.remote.id,
      inviteeUserId: f.member.id, mode: 'rw' as const }
    const centerProjects = new PostgresProjectService(f.a, f.cfg)
    await expect(centerProjects.createInvitation(invitation)).rejects.toMatchObject({ code: 'invitation-computer-required' })
    expect(await f.projects.listInvitations(f.member.id)).toEqual([])
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    const pending = await centerProjects.createInvitation(invitation)
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '1' })
    await expect(centerProjects.acceptInvitation(pending.id, f.member.id))
      .rejects.toMatchObject({ code: 'invitation-computer-required' })
    expect(await f.projects.listInvitations(f.member.id)).toMatchObject([{ status: 'pending' }])
    expect(await new PostgresCollaborationService(f.b).projectForUser(f.project.id, f.member.id)).toBeNull()
    await expect(f.access.authorize(f.member.id)).resolves.toBeUndefined()
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '2' })
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    await centerProjects.acceptInvitation(pending.id, f.member.id)
    expect(await new PostgresCollaborationService(f.b).projectForUser(f.project.id, f.member.id))
      .toMatchObject({ projectId: f.project.id, mode: 'rw' })
    expect(await new PostgresInstanceRepository(f.b, f.cfg.instancePortBase).owner({ kind: 'user', id: f.member.id })).toBeNull()
    expect((await pool.query('SELECT assigned_node_id FROM harness.instances WHERE project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)',
      [f.organization, f.project.id])).rows).toEqual([{ assigned_node_id: f.b.nodeId }])
  })

  it('requires the selected computer before allocating a user-owned project', async () => {
    const f = await fixture(), input = { name: 'Member project on B', ownerUserId: f.member.id, actorUserId: f.member.id }
    await expect(f.projects.createManaged(input)).rejects.toMatchObject({ code: 'forbidden' })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    const project = await f.projects.createManaged(input)
    expect(await new PostgresCollaborationService(f.b).projectForUser(project.id, f.member.id)).toMatchObject({ mode: 'rw' })
    expect((await pool.query('SELECT assigned_node_id FROM harness.instances WHERE project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)',
      [f.organization, project.id])).rows).toEqual([{ assigned_node_id: f.b.nodeId }])
  })

  it('lists only eligible nonmembers on the project computer and rechecks management authority', async () => {
    const f = await fixture()
    expect((await f.projects.listInvitableUsers(f.project.id, f.remote.id)).items).toEqual([])
    await expect(f.projects.listInvitableUsers(f.project.id, f.member.id)).rejects.toMatchObject({ code: 'forbidden' })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    expect((await f.projects.listInvitableUsers(f.project.id, f.remote.id)).items).toEqual([
      { id: f.member.id, username: f.member.username, displayName: f.member.displayName },
    ])
    await f.projects.setMember(f.project.id, f.member.id, 'rw', f.admin.id)
    expect((await f.projects.listInvitableUsers(f.project.id, f.remote.id)).items).toEqual([])
    await expect(f.projects.listInvitableUsers(f.project.id, f.remote.id, -1)).rejects.toThrow('invalid-user-cursor')
  })

  it('keeps offline Workspace metadata private to its assigned account and ignores superseded publications', async () => {
    const f = await fixture(), catalog = new PostgresWorkspaceCatalog(f.a)
    const instance = (await pool.query<{ runtime_id: string; generation: string }>(`SELECT i.runtime_id,i.generation::text
      FROM harness.instances i JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND u.public_id=$2`, [f.organization, f.member.id])).rows[0]!
    const subject = { organizationId: f.organization, target: { kind: 'user' as const, id: f.member.id, runtimeId: instance.runtime_id as never },
      generation: Number(instance.generation) }
    const entry = { workspaceId: 'metadata-only', path: '/private/work', title: 'Private Workspace', sessionIds: [],
      createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' }
    expect((await catalog.personal(f.member))[0]?.syncedAt).toBeNull()
    await catalog.publish(subject, { revision: 2, items: [entry] })
    await catalog.publish(subject, { revision: 1, items: [] })
    expect((await catalog.personal(f.member))[0]?.items).toEqual([entry])
    expect((await catalog.personal(f.admin)).flatMap(item => item.items)).toEqual([])
    await expect(catalog.publish({ ...subject, generation: subject.generation + 1 }, { revision: 3, items: [] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(catalog.publish(subject, { revision: 3, items: [{ ...entry, sessionIds: [123] }] })).rejects.toThrow()
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    expect(await catalog.personal(f.member)).toEqual([])
    expect((await pool.query('SELECT items FROM harness.runtime_workspace_catalog WHERE organization_id=$1', [f.organization])).rows)
      .toEqual([{ items: [entry] }])
  })

  it.each(['create', 'accept'] as const)('rechecks the recipient computer after waiting to %s an invitation', async operation => {
    const f = await fixture()
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    const input = { projectId: f.project.id, inviterUserId: f.remote.id, inviteeUserId: f.member.id, mode: 'rw' as const }
    const invitation = operation === 'accept' ? await f.projects.createInvitation(input) : undefined
    const applicationName = `computer-invitation-${randomUUID()}`
    const writingPool = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    releases.push(() => writingPool.end())
    const projects = new PostgresProjectService({ ...f.b, pool: writingPool }, f.cfg), blocker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.organization, f.project.id])
      pending = (invitation === undefined ? projects.createInvitation(input) : projects.acceptInvitation(invitation.id, f.member.id))
        .catch((error: unknown) => error)
      await vi.waitFor(async () => {
        expect((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,
          [applicationName])).rowCount).toBe(1)
      }, { timeout: 10_000 })
      await pool.query(`UPDATE harness.computer_use_permissions SET enabled=false,revision=revision+1
        WHERE organization_id=$1 AND node_id=$2 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)`,
      [f.organization, f.b.nodeId, f.member.id])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'invitation-computer-required' })
      expect(await f.projects.listInvitations(f.member.id)).toMatchObject(invitation === undefined ? [] : [{ status: 'pending' }])
      expect(await new PostgresCollaborationService(f.b).projectForUser(f.project.id, f.member.id)).toBeNull()
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending
    }
  })

  it('keeps each capability qualification and revision on its configured computer', async () => {
    const f = await fixture(), owner = { kind: 'user' as const, id: f.admin.id }
    for (const lane of ['desktop', 'terminal', 'ssh', 'plugin', 'steward', 'memory'] as const) {
      const local = new ResourceAccess(f.a, lane), remote = new ResourceAccess(f.b, lane)
      expect(await local.set(owner, true, '0')).toMatchObject({ enabled: true, revision: '1' })
      expect(await remote.get(owner)).toMatchObject({ enabled: false, revision: '0' })
      expect(await remote.set(owner, false, '0')).toMatchObject({ enabled: false, revision: '1' })
      expect(await local.get(owner)).toMatchObject({ enabled: true, revision: '1' })
      await expect(local.set({ kind: 'project', id: f.project.id }, true, '0')).rejects.toMatchObject({ status: 404 })
    }
  })

  it('bounds permission metadata and rejects invalid decisions or another organization computer', async () => {
    const f = await fixture(), foreign = await fixture()
    for (const query of [{ limit: '0' }, { limit: '99999' }, { cursor: 'wrong' }]) {
      await expect(f.access.page(f.admin, query, f.member.id)).rejects.toMatchObject({ status: 400 })
    }
    const first = await f.access.page(f.admin, { limit: '1' }, f.member.id)
    expect(first.items).toHaveLength(1)
    const second = await f.access.page(f.admin, { limit: '1', cursor: first.nextCursor! }, f.member.id)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.nodeId).not.toBe(first.items[0]!.nodeId)
    expect(second.nextCursor).toBeNull()
    await expect(new PostgresComputerAccess(f.a, { pageSize: 1, maxBytes: 1 }).page(f.member, {})).rejects.toMatchObject({ status: 413 })
    await expect(f.access.set(f.admin, f.member.id, foreign.a.nodeId, { enabled: true, revision: '0' })).rejects.toMatchObject({ status: 404 })
    for (const value of [{ enabled: 'yes', revision: '0' }, { enabled: true, revision: 0 }, { enabled: true, revision: '0', nodeId: f.a.nodeId }]) {
      await expect(f.access.set(f.admin, f.member.id, f.b.nodeId, value)).rejects.toMatchObject({ status: 400 })
    }
  })

  it('rechecks administrator authority after a queued permission write', async () => {
    const f = await fixture(), blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${f.organization}`])
    const pending = f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: error as unknown }))
    const qualification = new ResourceAccess(f.b, 'desktop').set({ kind: 'user', id: f.member.id }, true, '0', f.admin.id)
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: error as unknown }))
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query='SELECT pg_advisory_xact_lock(hashtext($1))'`)
        expect(waiting.rowCount).toBe(2)
      })
      await pool.query(`UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=(
        SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)`, [f.organization, f.admin.id])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ ok: false, error: { status: 403 } })
      expect(await qualification).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(await new ResourceAccess(f.b, 'desktop').get({ kind: 'user', id: f.member.id })).toMatchObject({ enabled: false, revision: '0' })
      const permissions = await f.access.page(f.remote, {}, f.member.id)
      expect(permissions.items.find(item => item.nodeId === f.b.nodeId)).toMatchObject({ enabled: false, revision: '0' })
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled([pending, qualification]) }
  })

  it('blocks personal startup and new runtime credentials after revocation while keeping cleanup authentication', async () => {
    const f = await fixture(), repository = new PostgresInstanceRepository(f.a, f.cfg.instancePortBase)
    expect(await repository.personalPolicy(f.member.id)).not.toBeNull()
    const token = 'private-fixture-runtime'
    await repository.beginStart({ kind: 'user', id: f.member.id }, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    expect(await repository.personalPolicy(f.member.id)).toBeNull()
    expect(await repository.startEligibility({ kind: 'user', id: f.member.id })).toBeNull()
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    expect(await repository.authenticateRuntimeCleanupToken(token)).not.toBeNull()
    const runtime = (await new PostgresRuntimeCatalog(f.a, f.cfg.runtimeCatalog).pageForAdministrator(f.admin, {})).items.find(item => item.owner.id === f.member.id && item.owner.kind === 'personal')!
    await expect(new PostgresRuntimeCatalog(f.a, f.cfg.runtimeCatalog).resolveForAccount(f.member, runtime.id)).rejects.toMatchObject({ status: 404 })
  })

  it('memoizes runtime token verdicts until invalidation or a local fencing write', async () => {
    const f = await fixture()
    let witnessQueries = 0
    const countingPool = new Proxy(pool, { get(actual, key) {
      if (key === 'query') return async (sql: string, values?: readonly unknown[]) => {
        if (typeof sql === 'string' && sql.includes('i.runtime_token_hash=$3')) witnessQueries++
        return actual.query(sql, values === undefined ? undefined : [...values])
      }
      const value: unknown = Reflect.get(actual, key, actual)
      return typeof value === 'function' ? value.bind(actual) : value
    } })
    const repository = new PostgresInstanceRepository({ ...f.a, pool: countingPool }, f.cfg.instancePortBase,
      undefined, undefined, 60_000)
    const target = { kind: 'user' as const, id: f.member.id }
    const token = 'private-fixture-runtime'
    const started = await repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    expect(witnessQueries).toBe(1)
    // The durable verdict still answers until the subscription wake clears it.
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    repository.invalidateRuntimeTokenCache()
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    // A local fencing write clears the same process without waiting for the channel.
    // The revoked runtime has meanwhile drained to stopped, as the node agent settles it.
    expect(await repository.markStopped(target, started)).toBe(true)
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: true, revision: '2' })
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    expect(await repository.markStopped(target, generation)).toBe(true)
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
  })

  it('binds a runtime generation to its live node connection without releasing cleanup or another computer', async () => {
    const f = await fixture(), nodes = new PostgresNodeAccessService(f.a, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const ticket = await nodes.issue(f.admin, { name: 'computer-c', requestId: randomUUID() })
    await pool.query("UPDATE harness.compute_nodes SET status='active' WHERE id=$1", [ticket.nodeId])
    const c = await resolvePostgresRuntimeContext(pool, f.a.organizationSlug, 'computer-c')
    const owner = await new PostgresUserService(c, f.cfg).create({ username: 'node-owner', password: 'pw-12345678' })
    const repository = new PostgresInstanceRepository(c, f.cfg.instancePortBase), target = { kind: 'user' as const, id: owner.id }
    const token = randomUUID(), tokenHash = createHash('sha256').update(token).digest()
    const initialGeneration = await repository.generationOf(target)
    const independentGeneration = await repository.beginStart(target, Date.now(), tokenHash, 'explicit')
    expect(independentGeneration).toBeGreaterThan(initialGeneration)
    await repository.markStopped(target, independentGeneration)
    const credential = `dsh_node_${randomBytes(32).toString('base64url')}`
    await nodes.enroll(ticket.token, { protocolVersion: 1, credential, platform: 'linux', architecture: 'x64' })
    const connectionId = randomUUID(), lease = await nodes.connect(credential, { connectionId })
    const generation = await repository.beginStart(target, Date.now(), tokenHash, 'explicit')
    await repository.markReady(target, generation)
    expect(await repository.authenticateRuntimeToken(token)).toMatchObject({ generation, target })
    expect((await pool.query('SELECT node_connection_id,node_connection_epoch::text FROM harness.instances WHERE assigned_node_id=$1', [c.nodeId])).rows)
      .toEqual([{ node_connection_id: connectionId, node_connection_epoch: lease.epoch }])
    await nodes.heartbeat(credential, { connectionId, epoch: lease.epoch })
    expect(await repository.authenticateRuntimeToken(token)).not.toBeNull()
    await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", [c.nodeId])
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    expect(await repository.authenticateRuntimeCleanupToken(token)).toMatchObject({ generation, target })
    const successor = await nodes.connect(credential, { connectionId })
    expect(successor.epoch).not.toBe(lease.epoch)
    expect(await repository.authenticateRuntimeToken(token)).toBeNull()
    expect(await repository.startEligibility(target)).toBeNull()
    expect(await repository.stateOf(target)).toBe('ready')
    expect(await new PostgresInstanceRepository(f.a, f.cfg.instancePortBase).startEligibility({ kind: 'user', id: f.member.id })).not.toBeNull()
    // A stopped report represents the fixture supervisor's confirmed termination.
    await repository.markStopped(target, generation)
    const renewedToken = randomUUID(), nextGeneration = await repository.beginStart(target, Date.now(), createHash('sha256').update(renewedToken).digest(), 'explicit')
    await repository.markReady(target, nextGeneration)
    expect(await repository.authenticateRuntimeToken(renewedToken)).toMatchObject({ generation: nextGeneration })
    await nodes.mutate(f.admin, c.nodeId, { action: 'revoke', revision: 1 })
    expect(await repository.authenticateRuntimeToken(renewedToken)).toBeNull()
    expect(await repository.authenticateRuntimeCleanupToken(renewedToken)).not.toBeNull()
    expect(await repository.stateOf(target)).toBe('ready')
  })

  it('delivers revocation for the specific computer and retains independent node subjects', async () => {
    const f = await fixture(), monitor = new PostgresAccessMonitor(f.a, 60_000)
    releases.push(() => monitor.close())
    await monitor.synchronize()
    const changes: unknown[] = []
    monitor.subscribe(subject => { changes.push(subject) })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: true, revision: '0' })
    await f.access.set(f.admin, f.member.id, f.b.nodeId, { enabled: false, revision: '1' })
    await f.access.set(f.admin, f.member.id, f.a.nodeId, { enabled: false, revision: '1' })
    await monitor.synchronize()
    expect(changes).toContainEqual({ nodeId: f.b.nodeId as RuntimeNodeId, userId: f.member.id, restartRuntime: true })
    expect(changes).toContainEqual({ nodeId: f.a.nodeId as RuntimeNodeId, userId: f.member.id, restartRuntime: true })
  })

  it('manages an offline computer through the center API without forwarding or starting its runtime', async () => {
    const f = await fixture(), auth = new PostgresAuthService(f.a, f.cfg)
    await f.users.changeOwnPassword(f.admin.id, 'pw-12345678')
    await f.users.changeOwnPassword(f.member.id, 'pw-12345678')
    await f.projects.setMember(f.project.id, f.member.id, 'rw', f.admin.id)
    const session = await auth.login('admin', 'pw-12345678', '127.0.0.1', 'fixture')
    expect(typeof session).toBe('object')
    if (typeof session !== 'object') throw new Error('Fixture login failed')
    const instances = new InstanceManager(new PostgresInstanceRepository(f.a, f.cfg.instancePortBase), f.cfg)
    releases.push(() => instances.stopAll())
    const server = createGatewayServer({ cfg: f.cfg, auth, users: f.users, projects: new PostgresProjectService(f.a, f.cfg),
      audit: new PostgresAuditService(f.a), instances, computerAccess: f.access,
      runtimeCatalog: new PostgresRuntimeCatalog(f.a, f.cfg.runtimeCatalog) })
    releases.push(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    f.cfg.publicOrigins.push(base)
    const memberSession = await auth.login('member', 'pw-12345678', '127.0.0.1', 'fixture')
    if (typeof memberSession !== 'object') throw new Error('Fixture member login failed')
    const catalog = async () => {
      const response = await fetch(`${base}/account/api/runtimes`, { headers: { cookie: `hgw_session=${memberSession.token}` } })
      expect(response.status).toBe(200)
      return await response.json() as { items: Array<{ owner: { kind: string } }> }
    }
    const transcript = []
    expect((await catalog()).items.map(item => item.owner.kind)).toEqual(['personal'])
    transcript.push('Existing personal-space access stays on its original computer; project membership alone does not grant another computer.')
    await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.b.nodeId])
    const response = await fetch(`${base}/admin/api/users/${f.member.id}/computers/${f.b.nodeId}?dshNode=${f.b.nodeId}`, {
      method: 'PUT', headers: { cookie: `hgw_session=${session.token}`, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, revision: '0' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ nodeId: f.b.nodeId, enabled: true, status: 'offline' })
    transcript.push('The center grants an offline computer without forwarding or creating a personal Runtime.')
    expect((await catalog()).items.map(item => item.owner.kind).sort()).toEqual(['personal', 'project'])
    transcript.push('Project access requires both current membership and the hosting computer permission.')
    const page = await fetch(`${base}/admin/api/users/${f.member.id}/computers?limit=1`, { headers: { cookie: `hgw_session=${session.token}` } })
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect((await page.json() as { items: unknown[] }).items).toHaveLength(1)
    const revoked = await fetch(`${base}/admin/api/users/${f.member.id}/computers/${f.b.nodeId}`, {
      method: 'PUT', headers: { cookie: `hgw_session=${session.token}`, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, revision: '1' }),
    })
    expect(revoked.status).toBe(200); await revoked.arrayBuffer()
    expect((await catalog()).items.map(item => item.owner.kind)).toEqual(['personal'])
    transcript.push('Revoking computer B hides its project while the same login retains computer A.')
    expect(`${transcript.join('\n')}\n`).toBe(await readFile(new URL('./expected/computer-access.txt', import.meta.url), 'utf8'))
  })
})
