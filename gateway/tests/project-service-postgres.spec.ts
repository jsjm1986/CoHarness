import type { RuntimeId } from '../src/runtime-catalog.ts'
/** Real project transactions, directory ownership, and bounded connection use. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { InstanceManager } from '../src/instances.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import type { Launcher } from '../src/launcher.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { ConversationRepository, PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import { connectFromPool, createPostgresPool, runMigrations, type Queryable } from '../src/postgres/database.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { lockProjectManagement } from '../src/postgres/project-management-authority.ts'
import { lockAdministrator } from '../src/postgres/administrator-authority.ts'
import { PostgresModelGovernanceService, projectProviderCredentialRef } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import { StewardAccess } from '../src/steward-access.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { testConfig } from './test-config.ts'

import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

/** These transaction fixtures create durable assignments without allocating host processes. */
function syntheticRuntimeLauncher(): Launcher {
  return {
    instancesOutliveGateway: false,
    start: async () => { throw new Error('This fixture must not allocate a host process') },
    attach: () => {
      let closed = false
      return { hasExited: () => closed, isAlive: async () => !closed, terminate: async () => { closed = true } }
    },
  }
}


async function fixtureProjectRuntime(f: { context: PostgresRuntimeContext; cfg: ReturnType<typeof testConfig> }, projectId: number): Promise<RuntimeId> {
  return (await new PostgresInstanceRepository(f.context, f.cfg.instancePortBase).resolveTarget({ kind: 'project', id: projectId })).runtimeId!
}

describePg('PostgreSQL project creation and mutations', () => {
  let pool: Pool
  const roots: string[] = []
  const scopedPools: Pool[] = []
  const processOwners: GatewayModelBudget[] = []

  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(processOwners.splice(0).map(owner => owner.close()))
    await Promise.all(scopedPools.splice(0).map(scoped => scoped.end()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-project-transactions-'))
    roots.push(root)
    const slug = `projects-${randomUUID()}`
    const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Project transactions') RETURNING id`, [slug])
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'test-node')`, [organization.rows[0]!.id])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'test-node')
    const people: number[] = []
    for (const username of ['creator', 'member']) {
      const user = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
        organization_id,username,display_name,home_path
      ) VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id::text`, [context.organizationId, username, join(root, 'users', username, 'home')])
      await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')`,
        [context.organizationId, user.rows[0]!.id])
      await pool.query('INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,false)',
        [user.rows[0]!.id, 'fixture-password-hash'])
      await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
        VALUES($1,$2,$3,true)`, [context.organizationId, context.nodeId, user.rows[0]!.id])
      people.push(Number(user.rows[0]!.public_id))
    }
    const imports = join(root, 'imports')
    await mkdir(imports)
    const cfg = testConfig(root, { HGW_PROJECT_PATH_ROOTS: imports })
    return { root, imports, cfg, context, creator: people[0]!, member: people[1]!, service: new PostgresProjectService(context, cfg) }
  }

  function isolated(context: Awaited<ReturnType<typeof fixture>>['context'], label: string) {
    const applicationName = `project-${label}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const scoped = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName, lock_timeout: 15_000 })
    scopedPools.push(scoped)
    return { applicationName, context: { ...context, pool: scoped } }
  }

  async function waiting(applicationName: string, prefix: string | null = null): Promise<boolean> {
    return (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND ($2::text IS NULL OR starts_with(query,$2))) waiting`,
    [applicationName, prefix])).rows[0]!.waiting
  }

  it.each(['administrator', 'owner', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization'] as const)(
    'requires current administrator authority for removal (%s)', async state => {
      const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
      const project = await f.service.createManaged({ name: 'Removal authority', ownerUserId: f.creator })
      await writeFile(join(project.path, 'retained.txt'), 'retained project bytes')
      if (state === 'owner') await users.setRole(f.creator, 'user')
      else if (state === 'disabled-account') await users.setStatus(f.creator, 'disabled')
      else if (state === 'deleted-account') await users.remove(f.creator)
      else if (state === 'disabled-membership' || state === 'missing-membership') await pool.query(state === 'missing-membership'
        ? 'DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)'
        : "UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.context.organizationId, f.creator])
      else if (state === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      const writing = isolated(f.context, 'authorized-removal'), service = new PostgresProjectService(writing.context, f.cfg)
      const result = service.remove(project.id, f.creator)
      if (state === 'administrator') await expect(result).resolves.toEqual([f.creator])
      else {
        await expect(result).rejects.toMatchObject({ code: 'forbidden' })
        expect(await service.getById(project.id)).not.toBeNull()
      }
      expect(await readFile(join(project.path, 'retained.txt'), 'utf8')).toBe('retained project bytes')
    },
  )

  it.each(['role', 'organization'] as const)('orders queued destructive stop admission with %s revocation', async state => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Queued destructive admission', ownerUserId: f.creator })
    const writing = isolated(f.context, 'stop-admission'), revoking = isolated(f.context, 'stop-revocation')
    const repository = new PostgresInstanceRepository(writing.context, f.cfg.instancePortBase)
    const generation = await repository.generationOf({ kind: 'project', id: project.id })
    const blocker = await connectFromPool(pool)
    let stopped: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, committed = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      stopped = repository.markStopping({ kind: 'project', id: project.id }, generation, 'manual', f.creator).catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName, 'SELECT id,owner_user_id'), { timeout: 10_000 }).toBe(true)
      if (state === 'role') {
        revoked = new PostgresUserService(revoking.context, f.cfg).setRole(f.creator, 'user').catch((error: unknown) => error)
        await expect.poll(() => waiting(revoking.applicationName), { timeout: 10_000 }).toBe(true)
      } else await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      await blocker.query('COMMIT'); committed = true
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release(); await Promise.all([stopped, revoked])
    }
    if (state === 'role') {
      expect(await stopped).toBe(true); expect(await revoked).toBeUndefined()
      expect(await repository.stateOf({ kind: 'project', id: project.id })).toBe('stopping')
      await expect(f.service.remove(project.id, f.creator)).rejects.toMatchObject({ code: 'forbidden' })
    } else {
      expect(await stopped).toMatchObject({ code: 'forbidden' })
      expect(await repository.stateOf({ kind: 'project', id: project.id })).toBe('stopped')
    }
    expect(await f.service.getById(project.id)).not.toBeNull()
  })

  it.each((['managed', 'import'] as const).flatMap(operation =>
    (['active', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization'] as const)
      .map(state => ({ operation, state })),
  ))('requires current administrator authority to provision $operation ($state)', async ({ operation, state }) => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    const imported = join(f.imports, 'eligible-project')
    await mkdir(imported)
    await mkdir(f.cfg.projectsRoot, { recursive: true })
    const before = await readdir(f.cfg.projectsRoot)
    if (state === 'role') await users.setRole(f.creator, 'user')
    else if (state === 'disabled-account') await users.setStatus(f.creator, 'disabled')
    else if (state === 'deleted-account') await users.remove(f.creator)
    else if (state === 'disabled-membership' || state === 'missing-membership') await pool.query(state === 'missing-membership'
      ? 'DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)'
      : "UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.context.organizationId, f.creator])
    else if (state === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    const writing = isolated(f.context, 'administrator-provisioning')
    const service = new PostgresProjectService(writing.context, f.cfg)
    const result = service.create({ name: 'Administrator admission', ...(operation === 'import' ? { path: imported } : {}),
      createdBy: f.creator, actorUserId: f.creator })
    if (state === 'active') {
      await expect(result).resolves.toMatchObject({ origin: 'admin', owner: null, createdBy: { id: f.creator } })
    } else {
      await expect(result).rejects.toMatchObject({ code: 'forbidden' })
      expect(await service.list()).toEqual([])
      expect(await readdir(f.cfg.projectsRoot)).toEqual(before)
    }
  })

  it('refuses a foreign administrator creator before allocating its directory', async () => {
    const f = await fixture()
    await mkdir(f.cfg.projectsRoot, { recursive: true })
    await expect(f.service.create({ name: 'Foreign provisioning', createdBy: f.member, actorUserId: f.creator }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await readdir(f.cfg.projectsRoot)).toEqual([])
  })

  it.each(['role', 'organization'] as const)('orders administrator provisioning with queued %s revocation', async state => {
    const f = await fixture(), writing = isolated(f.context, 'provisioning-write'), revoking = isolated(f.context, 'provisioning-revoke')
    const service = new PostgresProjectService(writing.context, f.cfg), blocker = await connectFromPool(pool)
    await mkdir(f.cfg.projectsRoot, { recursive: true })
    let created: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, committed = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${f.context.nodeId}`])
      created = service.create({ name: 'Queued administrator provisioning', createdBy: f.creator, actorUserId: f.creator })
        .catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName, 'SELECT pg_advisory_xact_lock'), { timeout: 10_000 }).toBe(true)
      expect(await readdir(f.cfg.projectsRoot)).toEqual([])
      if (state === 'role') {
        // Advisory-first ordering: the create holds no user rows while it
        // waits on the port lock, so the revocation commits during the wait;
        // the queued create then observes the demotion and is refused.
        revoked = new PostgresUserService(revoking.context, f.cfg).setRole(f.creator, 'user').catch((error: unknown) => error)
        expect(await revoked).toBeUndefined()
      } else await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      await blocker.query('COMMIT'); committed = true
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release(); await Promise.all([created, revoked])
    }
    expect(await created).toMatchObject({ code: 'forbidden' })
    expect(await readdir(f.cfg.projectsRoot)).toEqual([])
    if (state === 'role') {
      expect(await revoked).toBeUndefined()
      await expect(service.create({ name: 'Later administrator provisioning', createdBy: f.creator, actorUserId: f.creator }))
        .rejects.toMatchObject({ code: 'forbidden' })
    } else expect(await service.list()).toEqual([])
  })

  it.each(['active', 'recipient-account', 'recipient-membership', 'recipient-membership-removed', 'organization', 'project', 'inviter-membership'] as const)(
    'requires current invitation eligibility (%s)', async state => {
      const f = await fixture(), project = await f.service.createManaged({ name: 'Invitation eligibility', ownerUserId: f.creator })
      if (state === 'recipient-account') await new PostgresUserService(f.context, f.cfg).setStatus(f.member, 'disabled')
      else if (state === 'recipient-membership-removed') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)', [f.context.organizationId, f.member])
      else if (state === 'recipient-membership' || state === 'inviter-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.context.organizationId, state === 'recipient-membership' ? f.member : f.creator])
      else if (state === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      else if (state === 'project') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project.id])
      const mutation = f.service.createInvitation({ projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
      if (state === 'active') await expect(mutation).resolves.toMatchObject({ status: 'pending', mode: 'rw' })
      else if (state.startsWith('recipient-')) await expect(mutation).rejects.toThrow('user-disabled')
      else await expect(mutation).rejects.toMatchObject({ code: 'forbidden' })
      expect((await pool.query('SELECT 1 FROM harness.project_invitations WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(state === 'active' ? 1 : 0)
    },
  )

  it.each(['recipient-membership', 'inviter-membership', 'organization', 'project-archive', 'project-delete'] as const)(
    'orders queued invitation creation with %s changes', async state => {
      const f = await fixture(), project = await f.service.createManaged({ name: 'Queued invitation issuance', ownerUserId: f.creator })
      const writing = isolated(f.context, 'issuance-write'), revoking = isolated(f.context, 'issuance-revoke')
      const service = new PostgresProjectService(writing.context, f.cfg), blocker = await connectFromPool(pool)
      let created: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, committed = false
      const retainedMembership = state === 'recipient-membership' || state === 'inviter-membership'
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
        created = service.createInvitation({ projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' }).catch((error: unknown) => error)
        await expect.poll(() => waiting(writing.applicationName, 'SELECT status FROM harness.projects'), { timeout: 10_000 }).toBe(true)
        if (retainedMembership) {
          revoked = revoking.context.pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.context.organizationId, state === 'recipient-membership' ? f.member : f.creator]).then(() => undefined, (error: unknown) => error)
          await expect.poll(() => waiting(revoking.applicationName), { timeout: 10_000 }).toBe(true)
        } else if (state === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
        else if (state === 'project-archive') await blocker.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project.id])
        else await blocker.query('DELETE FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [f.context.organizationId, project.id])
        await blocker.query('COMMIT'); committed = true
      } finally {
        if (!committed) await blocker.query('ROLLBACK')
        blocker.release(); await Promise.all([created, revoked])
      }
      if (retainedMembership) {
        expect(await created).toMatchObject({ status: 'pending' }); expect(await revoked).toBeUndefined()
      } else expect(await created).toMatchObject(state === 'project-delete' ? { message: `unknown project ${String(project.id)}` } : { code: 'forbidden' })
      expect((await pool.query('SELECT 1 FROM harness.project_invitations WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(retainedMembership ? 1 : 0)
    },
  )

  it.each(['organization', 'project'] as const)('preserves an expired pending invitation when %s authority is refused', async state => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Refused renewal', ownerUserId: f.creator })
    const input = { projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' as const }
    const invitation = await f.service.createInvitation(input)
    await pool.query("UPDATE harness.project_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [invitation.id])
    if (state === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    else await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project.id])
    await expect(f.service.createInvitation(input)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await pool.query<{ id: string; status: string }>('SELECT id,status FROM harness.project_invitations WHERE organization_id=$1', [f.context.organizationId])).rows)
      .toEqual([{ id: invitation.id, status: 'pending' }])
  })

  it.each((['accept', 'create'] as const).flatMap(operation =>
    (['active', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization',
      ...(operation === 'accept' ? ['archived-project'] as const : [])] as const).map(state => ({ operation, state })),
  ))('requires an active account and scope to $operation a project relationship ($state)', async ({ operation, state }) => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    const project = operation === 'accept' ? await f.service.createManaged({ name: 'Account invitation scope', ownerUserId: f.creator }) : undefined
    const invitation = project === undefined ? undefined : await f.service.createInvitation({ projectId: project.id,
      inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
    await mkdir(f.cfg.userProjectsRoot, { recursive: true })
    const directories = await readdir(f.cfg.userProjectsRoot)
    if (state === 'disabled-account') await users.setStatus(f.member, 'disabled')
    else if (state === 'deleted-account') await users.remove(f.member)
    else if (state === 'disabled-membership' || state === 'missing-membership') await pool.query(state === 'missing-membership'
      ? 'DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)'
      : "UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)",
    [f.context.organizationId, f.member])
    else if (state === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    else if (state === 'archived-project') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project!.id])
    const input = { name: 'Authenticated account creation', ownerUserId: f.member, createdBy: f.member, actorUserId: f.member }
    const mutation = operation === 'accept' ? f.service.acceptInvitation(invitation!.id, f.member) : f.service.createManaged(input)
    if (state === 'active') await expect(mutation).resolves.toEqual(operation === 'accept' ? undefined : expect.objectContaining({ name: input.name }))
    else {
      await expect(mutation).rejects.toMatchObject({ code: 'forbidden' })
      expect(await readdir(f.cfg.userProjectsRoot)).toEqual(directories)
      if (invitation !== undefined) expect((await pool.query<{ status: string }>('SELECT status FROM harness.project_invitations WHERE id=$1', [invitation.id])).rows[0]?.status)
        .toBe(state === 'deleted-account' ? undefined : 'pending')
    }
  })

  it.each(['owner', 'creator'] as const)('refuses authenticated PostgreSQL creation with a different %s', async field => {
    const f = await fixture()
    await expect(f.service.createManaged({ name: 'Foreign actor identity', actorUserId: f.creator,
      ownerUserId: field === 'owner' ? f.member : f.creator, createdBy: field === 'creator' ? f.member : f.creator }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it.each((['accept', 'create'] as const).flatMap(operation =>
    (['account', 'membership'] as const).map(revocation => ({ operation, revocation })),
  ))('orders a queued $operation against $revocation revocation', async ({ operation, revocation }) => {
    const f = await fixture(), writing = isolated(f.context, 'account-write'), revoking = isolated(f.context, 'account-revoke')
    const service = new PostgresProjectService(writing.context, f.cfg), users = new PostgresUserService(revoking.context, f.cfg)
    const project = operation === 'accept' ? await f.service.createManaged({ name: 'Retained invitation scope', ownerUserId: f.creator }) : undefined
    const invitation = project === undefined ? undefined : await f.service.createInvitation({ projectId: project.id,
      inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
    const input = { name: 'Retained account creation', ownerUserId: f.member, actorUserId: f.member }
    const mutate = () => operation === 'accept' ? service.acceptInvitation(invitation!.id, f.member) : service.createManaged(input)
    const blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokedEarly = false
    try {
      await blocker.query('BEGIN')
      if (project === undefined) await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${f.context.nodeId}`])
      else await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      changed = mutate().catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName), { timeout: 10_000 }).toBe(true)
      const revoke = revocation === 'account' ? users.setStatus(f.member, 'disabled')
        : revoking.context.pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)", [f.context.organizationId, f.member])
      revoked = revoke.then(() => { revokedEarly = true }, (error: unknown) => error)
      if (project === undefined) {
        // createManaged takes the port advisory before user rows, so the
        // revocation commits during the wait; the queued create then observes
        // post-revocation state and is refused instead of being retained.
        await revoked
        expect(revokedEarly).toBe(true)
      } else {
        await expect.poll(() => waiting(revoking.applicationName), { timeout: 10_000 }).toBe(true)
        expect(revokedEarly).toBe(false)
      }
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await Promise.all([changed, revoked])
    }
    expect(await revoked).toBeUndefined()
    if (operation === 'accept') expect(await changed).toBeUndefined()
    else expect(await changed).toMatchObject({ code: 'forbidden' })
    await expect(mutate()).rejects.toMatchObject({ code: 'forbidden' })
  })

  it.each(['accept', 'create'] as const)('rechecks organization availability after waiting to %s a project relationship', async operation => {
    const f = await fixture(), writing = isolated(f.context, 'organization-write'), service = new PostgresProjectService(writing.context, f.cfg)
    const project = operation === 'accept' ? await f.service.createManaged({ name: 'Organization invitation', ownerUserId: f.creator }) : undefined
    const invitation = project === undefined ? undefined : await f.service.createInvitation({ projectId: project.id,
      inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
    await mkdir(f.cfg.userProjectsRoot, { recursive: true })
    const directories = await readdir(f.cfg.userProjectsRoot), blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      if (project === undefined) await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${f.context.nodeId}`])
      else await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      const input = { name: 'Late organization creation', ownerUserId: f.member, actorUserId: f.member }
      changed = (operation === 'accept' ? service.acceptInvitation(invitation!.id, f.member) : service.createManaged(input)).catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName), { timeout: 10_000 }).toBe(true)
      await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await changed }
    expect(await changed).toMatchObject({ code: 'forbidden' })
    expect(await readdir(f.cfg.userProjectsRoot)).toEqual(directories)
    if (invitation !== undefined) expect((await pool.query<{ status: string }>('SELECT status FROM harness.project_invitations WHERE id=$1', [invitation.id])).rows[0]?.status).toBe('pending')
  })

  it.each(['archive', 'delete'] as const)('refuses invitation acceptance after a queued project %s', async operation => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Queued invitation scope', ownerUserId: f.creator })
    const invitation = await f.service.createInvitation({ projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
    const writing = isolated(f.context, 'invitation-scope'), service = new PostgresProjectService(writing.context, f.cfg)
    const blocker = await connectFromPool(pool)
    let accepted: Promise<unknown> | undefined, committed = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      accepted = service.acceptInvitation(invitation.id, f.member).catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName, 'SELECT p.status'), { timeout: 10_000 }).toBe(true)
      if (operation === 'archive') await blocker.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project.id])
      else await blocker.query('DELETE FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [f.context.organizationId, project.id])
      await blocker.query('COMMIT'); committed = true
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release(); await accepted
    }
    expect(await accepted).toMatchObject(operation === 'archive' ? { code: 'forbidden' } : { message: 'invitation-not-found' })
    expect(await readdir(project.path)).toEqual([])
  })

  it.each(['name', 'theme'] as const)('refuses a former owner changing project %s through an admitted HTTP request', async (setting) => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    const owner = await users.create({ username: 'former-owner', password: 'pw-12345678' })
    await users.changeOwnPassword(owner.id, 'pw-12345678')
    const project = await f.service.createManaged({ name: 'Management authority', ownerUserId: owner.id })
    const instances = new InstanceManager(new PostgresInstanceRepository(f.context, f.cfg.instancePortBase), f.cfg)
    const server = createGatewayServer({ cfg: f.cfg, users, projects: f.service, instances,
      auth: new PostgresAuthService(f.context, f.cfg), audit: new PostgresAuditService(f.context),
      collaboration: new PostgresCollaborationService(f.context) })
    let observedReady!: () => void, releaseReady!: () => void
    const observed = new Promise<void>((ready) => { observedReady = ready })
    const release = new Promise<void>((ready) => { releaseReady = ready })
    const original = f.service.getById.bind(f.service)
    let held = false, request: Promise<{ status: number; body: unknown }> | undefined
    const reading = vi.spyOn(f.service, 'getById').mockImplementation(async (id) => {
      const view = await original(id)
      if (id === project.id && !held) { held = true; observedReady(); await release }
      return view
    })
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      f.cfg.publicOrigins.push(base)
      const logged = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: owner.username, password: 'pw-12345678' }) })
      const cookie = logged.headers.get('set-cookie')?.split(';')[0]
      await logged.arrayBuffer(); expect(logged.status).toBe(302)
      if (cookie === undefined) throw new Error('Missing project management fixture cookie')
      request = fetch(`${base}/account/api/projects/${String(project.id)}${setting === 'theme' ? '/configuration' : ''}`, {
        method: 'PATCH', headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify(setting === 'theme' ? { themePolicy: 'dark' } : { name: 'Stale owner update' }),
      }).then(async response => ({ status: response.status, body: await response.text() }))
      await observed
      await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users
        WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,
      [f.context.organizationId, project.id, f.creator])
      releaseReady()
      const result = await request
      expect(result.status).toBe(403)
      const current = await original(project.id)
      expect(current?.name).toBe(project.name)
      expect(current?.uiThemePolicy).toBe('follow-user')
      const audit = await pool.query(`SELECT 1 FROM harness.audit_events
        WHERE organization_id=$1 AND action IN ('projects.rename','projects.configuration.theme-policy')`, [f.context.organizationId])
      expect(audit.rowCount).toBe(0)
    } finally {
      releaseReady(); await request?.catch(() => {})
      reading.mockRestore(); server.closeAllConnections()
      await new Promise<void>((closed) => { server.close(() => { closed() }) })
      await instances.stopAll()
    }
  })

  it.each(['owner', 'administrator', 'member', 'disabled-account', 'disabled-membership', 'deleted-account',
    'removed-membership', 'password-required', 'missing-credential', 'computer-withdrawn', 'disabled-organization', 'disabled-project', 'missing-project'] as const)(
    'holds management authority only for a current %s', async (state) => {
      const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
      const project = await f.service.createManaged({ name: 'Current manager', ownerUserId: f.creator })
      let actor = f.member
      if (state === 'owner' || state === 'removed-membership' || state === 'computer-withdrawn') {
        actor = f.creator; await users.setRole(actor, 'user')
      } else if (state === 'member') {
        await users.setRole(actor, 'user'); await f.service.setMember(project.id, actor, 'rw')
      } else if (state === 'disabled-account') await users.setStatus(actor, 'disabled')
      else if (state === 'disabled-membership') await pool.query(`UPDATE harness.memberships SET status='disabled'
        WHERE organization_id=$1 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)`,
      [f.context.organizationId, actor])
      else if (state === 'deleted-account') await users.remove(actor)
      else if (state === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      else if (state === 'password-required') await pool.query(`UPDATE harness.password_credentials SET must_change_password=true
        WHERE user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)`, [f.context.organizationId, actor])
      else if (state === 'missing-credential') await pool.query(`DELETE FROM harness.password_credentials
        WHERE user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2)`, [f.context.organizationId, actor])
      else if (state === 'disabled-project') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, project.id])
      else if (state === 'missing-project') await f.service.remove(project.id)
      if (state === 'removed-membership') await pool.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)', [f.context.organizationId, project.id])
      if (state === 'computer-withdrawn') await pool.query(`UPDATE harness.computer_use_permissions SET enabled=false
        WHERE organization_id=$1 AND node_id=$2 AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)`,
      [f.context.organizationId, f.context.nodeId, actor])
      const client = await connectFromPool(pool)
      try {
        await client.query('BEGIN')
        const result = lockProjectManagement(client, f.context, project.id, actor)
        if (state === 'owner' || state === 'administrator') await expect(result).resolves.toEqual(expect.any(String))
        else await expect(result).rejects.toThrow(state.endsWith('project') ? 'unknown project' : 'forbidden')
      } finally { await client.query('ROLLBACK'); client.release() }
    },
  )

  it.each(['administrator', 'project-manager'] as const)('allows admitted %s work to finish after a later password reset', async (kind) => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    const project = await f.service.createManaged({ name: 'Admitted password reset', ownerUserId: f.creator })
    if (kind === 'project-manager') await users.setRole(f.creator, 'user')
    const reset = isolated(f.context, 'admitted-password-reset')
    const resetUsers = new PostgresUserService(reset.context, f.cfg)
    const client = await connectFromPool(pool)
    const admit = () => kind === 'administrator' ? lockAdministrator(client, f.context, f.creator)
      : lockProjectManagement(client, f.context, project.id, f.creator)
    let resetting: Promise<unknown> | undefined, resetSettled = false
    try {
      await client.query('BEGIN')
      await admit()
      resetting = resetUsers.resetPassword(f.creator, 'pw-replacement').then(
        () => { resetSettled = true },
        (error: unknown) => { resetSettled = true; return error },
      )
      await expect.poll(async () => resetSettled || await waiting(reset.applicationName), { timeout: 10_000 }).toBe(true)
      await client.query("UPDATE harness.projects SET ui_theme_policy='dark' WHERE organization_id=$1 AND public_id=$2",
        [f.context.organizationId, project.id])
      await client.query('COMMIT')
      expect(await resetting).not.toBeInstanceOf(Error)
      expect((await users.getById(f.creator))?.mustChangePassword).toBe(true)
      expect((await f.service.getById(project.id))?.uiThemePolicy).toBe('dark')
      await client.query('BEGIN')
      await expect(admit()).rejects.toMatchObject({ code: 'forbidden' })
    } finally { try { await client.query('ROLLBACK') } finally { client.release(); await resetting } }
  })

  it.each(['unqualified', 'qualified', 'downgraded'] as const)('retains steward management qualification (%s)', async (state) => {
    const f = await fixture(), directory = join(f.root, 'steward-management'); await mkdir(directory)
    const project = await f.service.ensureSteward({ name: 'Steward manager', path: directory })
    if (state !== 'unqualified') {
      const access = new StewardAccess(f.context), owner = { kind: 'user' as const, id: f.creator }
      await access.set(owner, true, (await access.get(owner)).revision)
    }
    if (state === 'downgraded') await new PostgresUserService(f.context, f.cfg).setRole(f.creator, 'user')
    const client = await connectFromPool(pool)
    try {
      await client.query('BEGIN')
      const managed = lockProjectManagement(client, f.context, project.id, f.creator)
      if (state === 'qualified') await expect(managed).resolves.toEqual(expect.any(String))
      else await expect(managed).rejects.toThrow('forbidden')
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it.each((['set', 'remove'] as const).flatMap(operation =>
    (['owner', 'administrator', 'disabled-administrator'] as const).map(state => ({ operation, state })),
  ))('requires a current administrator to $operation membership ($state)', async ({ operation, state }) => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    const project = await f.service.createManaged({ name: 'Membership administration', ownerUserId: f.creator })
    if (operation === 'remove') await f.service.setMember(project.id, f.member, 'ro')
    let actor = f.member
    if (state === 'owner') { actor = f.creator; await users.setRole(actor, 'user') }
    else if (state === 'disabled-administrator') await users.setStatus(actor, 'disabled')
    const mutation = operation === 'set' ? f.service.setMember(project.id, f.member, 'rw', actor)
      : f.service.removeMember(project.id, f.member, actor)
    if (state === 'administrator') await expect(mutation).resolves.toBeUndefined()
    else await expect(mutation).rejects.toMatchObject({ code: 'forbidden' })
    const member = (await f.service.getById(project.id))?.members.find(row => row.userId === f.member)
    expect(member?.mode).toBe(state === 'administrator' ? operation === 'set' ? 'rw' : undefined
      : operation === 'remove' ? 'ro' : undefined)
  })

  it.each(['models', 'credential-set', 'credential-unset', 'discover'] as const)(
    'retains source model management authority for %s without using another pool connection', async (operation) => {
      const f = await fixture(), project = await f.service.createManaged({ name: 'Model management', ownerUserId: f.creator })
      await new PostgresUserService(f.context, f.cfg).setRole(f.member, 'user')
      await f.service.setMember(project.id, f.member, 'rw')
      const limited = isolated(f.context, 'model-manager')
      const governance = new PostgresModelGovernanceService(limited.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 7)))
      let discoveries = 0
      const probe = createServer((_request, response) => {
        discoveries += 1
        void limited.context.pool.query('SELECT 1').then(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
        }, (error: unknown) => { response.destroy(error instanceof Error ? error : new Error('Catalog fixture query failed.', { cause: error })) })
      })
      try {
        await new Promise<void>((ready, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', ready) })
        const endpoint = `http://127.0.0.1:${String((probe.address() as AddressInfo).port)}/v1`
        const ref = projectProviderCredentialRef(project.id, 'fixture')
        await governance.mutateProjectModelSettings(project.id, [{ op: 'set', path: ['providers', 'fixture'], value: {
          api: 'openai-completions', baseURL: endpoint, apiKeyEnv: ref, models: [{ id: 'fixture-model' }],
        } }])
        await governance.setProjectCredential(project.id, ref, 'fixture-initial-secret')
        const before = await governance.describeProjectModelSettings(project.id)
        const actions = {
          models: (actor: number) => governance.mutateProjectModelSettings(project.id,
            [{ op: 'set', path: ['providers', 'fixture', 'displayName'], value: 'Current manager' }], undefined, actor),
          'credential-set': (actor: number) => governance.setProjectCredential(project.id, ref, 'fixture-updated-secret', actor),
          'credential-unset': (actor: number) => governance.unsetProjectCredential(project.id, ref, actor),
          discover: (actor: number) => governance.discoverProjectModels({ projectId: project.id, actorUserId: actor,
            provider: 'fixture', baseURL: endpoint, api: 'openai-completions', allowPrivateNetwork: true }),
        }
        await expect(actions[operation](f.member)).rejects.toThrow('forbidden')
        expect(discoveries).toBe(0)
        expect(await governance.describeProjectModelSettings(project.id)).toEqual(before)
        await actions[operation](f.creator)
        expect(discoveries).toBe(operation === 'discover' ? 1 : 0)
      } finally {
        probe.closeAllConnections()
        await new Promise<void>((closed) => { probe.close(() => { closed() }) })
      }
    },
  )

  it.each(['rename', 'member-set', 'member-remove'] as const)('retains an admitted %s actor while role revocation waits, then rejects a later mutation', async operation => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Queued manager', ownerUserId: f.creator })
    if (operation === 'member-remove') await f.service.setMember(project.id, f.member, 'ro')
    const writing = isolated(f.context, 'manager-write'), revoking = isolated(f.context, 'manager-revoke')
    const projects = new PostgresProjectService(writing.context, f.cfg), users = new PostgresUserService(revoking.context, f.cfg)
    const mutate = () => operation === 'rename' ? projects.rename(project.id, 'Admitted manager', f.member)
      : operation === 'member-set' ? projects.setMember(project.id, f.member, 'rw', f.member)
        : projects.removeMember(project.id, f.member, f.member)
    const blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokedEarly = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [f.context.organizationId, project.id])
      changed = mutate().catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName), { timeout: 10_000 }).toBe(true)
      revoked = users.setRole(f.member, 'user').then(() => { revokedEarly = true }, (error: unknown) => error)
      await expect.poll(() => waiting(revoking.applicationName), { timeout: 10_000 }).toBe(true)
      expect(revokedEarly).toBe(false)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([changed, revoked])
    }
    expect(await changed).toBeUndefined(); expect(await revoked).toBeUndefined()
    const current = await f.service.getById(project.id)
    if (operation === 'rename') expect(current?.name).toBe('Admitted manager')
    else expect(current?.members.find(member => member.userId === f.member)?.mode).toBe(operation === 'member-set' ? 'rw' : undefined)
    await expect(mutate()).rejects.toThrow('forbidden')
  })

  it('does not recreate a deleted account assignment during startup reconciliation', async () => {
    const f = await fixture(), initialization = isolated(f.context, 'initialization'), removal = isolated(f.context, 'startup-deletion')
    const users = new PostgresUserService(removal.context, f.cfg)
    const member = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
      [f.context.organizationId, f.member])).rows[0]!.id
    const name = `audit_assignment_${randomUUID().replaceAll('-', '')}`, barrier = randomUUID()
    const blocker = await connectFromPool(pool)
    let initialized: Promise<unknown> | undefined, deleted: Promise<unknown> | undefined, deletionFinished = false
    try {
      await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0])); RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON harness.instances
        FOR EACH ROW WHEN (NEW.user_id='${member}'::uuid) EXECUTE FUNCTION harness.${name}('${barrier}')`)
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [barrier])
      initialized = new PostgresInstanceRepository(initialization.context, f.cfg.instancePortBase).initialize().catch((error: unknown) => error)
      await expect.poll(() => waiting(initialization.applicationName, 'INSERT INTO harness.instances'), { timeout: 10_000 }).toBe(true)
      deleted = users.remove(f.member).then(value => { deletionFinished = true; return value }, (error: unknown) => { deletionFinished = true; return error })
      await expect.poll(async () => deletionFinished || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity d JOIN pg_stat_activity i ON i.application_name=$1
        WHERE d.application_name=$2 AND i.pid=ANY(pg_blocking_pids(d.pid))) blocked`,
      [initialization.applicationName, removal.applicationName])).rows[0]!.blocked, { timeout: 10_000 }).toBe(true)
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([initialized, deleted])
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.instances`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${name}()`)
    }
    expect(await initialized).toBeUndefined()
    expect(await deleted).toBe(true)
    expect(await users.isDeleted(f.member)).toBe(true)
    expect((await pool.query('SELECT 1 FROM harness.instances WHERE organization_id=$1 AND user_id=$2',
      [f.context.organizationId, member])).rowCount).toBe(0)
  })

  it('does not restore a deleted account membership after waiting for its project', async () => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Deletion order', ownerUserId: f.creator })
    const mutation = isolated(f.context, 'membership'), removal = isolated(f.context, 'deletion')
    const projects = new PostgresProjectService(mutation.context, f.cfg), users = new PostgresUserService(removal.context, f.cfg)
    const blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined, deleted: Promise<unknown> | undefined, deletionFinished = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      changed = projects.setMember(project.id, f.member, 'rw').catch((error: unknown) => error)
      await expect.poll(() => waiting(mutation.applicationName, 'SELECT owner_user_id'), { timeout: 10_000 }).toBe(true)
      deleted = users.remove(f.member).then(value => { deletionFinished = true; return value }, (error: unknown) => { deletionFinished = true; return error })
      await expect.poll(async () => deletionFinished || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity d JOIN pg_stat_activity m ON m.application_name=$1
        WHERE d.application_name=$2 AND m.pid=ANY(pg_blocking_pids(d.pid))) blocked`,
      [mutation.applicationName, removal.applicationName])).rows[0]!.blocked, { timeout: 10_000 }).toBe(true)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([changed, deleted])
    }
    expect(await changed).toBeUndefined()
    expect(await deleted).toBe(true)
    expect((await pool.query(`SELECT 1 FROM harness.project_members m JOIN harness.users u ON u.id=m.user_id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [f.context.organizationId, f.member])).rowCount).toBe(0)
  })

  it.each([...(['membership', 'role', 'mode'] as const).flatMap(kind =>
    (['create', 'append'] as const).map(operation => ({ kind, operation })),
  ), { kind: 'visibility', operation: 'append' } as const])('rechecks $kind revocation after waiting to $operation a project conversation', async ({ kind, operation }) => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Creation authority', ownerUserId: f.creator })
    const mutation = isolated(f.context, `revoke-${kind}`), creation = isolated(f.context, `create-${kind}`)
    const users = new PostgresUserService(mutation.context, f.cfg), projects = new PostgresProjectService(mutation.context, f.cfg)
    if (kind !== 'role') {
      await users.setRole(f.member, 'user')
      await projects.setMember(project.id, f.member, 'rw')
    }
    const ids = (await pool.query<{ user_id: string; project_id: string; owner_id: string }>(`SELECT u.id user_id,p.id project_id,p.owner_user_id owner_id
      FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`, [f.context.organizationId, f.member, project.id])).rows[0]!
    const repository = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    await repository.initialize()
    const target = await repository.resolveTarget({ kind: 'project', id: project.id }), token = randomUUID()
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, f.context.organizationSlug, 60_000)
    const assertion = principals.issue({ user: { id: f.member, username: 'member', displayName: 'Member',
      role: kind === 'role' ? 'admin' : 'user', status: 'active', mustChangePassword: false, autoReviewEligible: false,
      homePath: join(f.root, 'users/member/home') }, runtime: { ...target, generation },
      scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } })
    const conversationStore = new PostgresConversationStore(creation.context.pool)
    const conversations = conversationStore.forRuntime({ organizationId: f.context.organizationId, runtimeId: target.runtimeId! }), collaboration = new PostgresCollaborationService(f.context)
    const manager = new InstanceManager(repository, f.cfg, syntheticRuntimeLauncher())
    const server = createGatewayServer({ cfg: f.cfg, users, projects, instances: manager,
      auth: new PostgresAuthService(f.context, f.cfg), audit: new PostgresAuditService(f.context) }, {
      runtime: createRuntimeApiHandler({ context: f.context, instances: repository, conversations: conversationStore, collaboration, principals,
        governance: { resolveOrganizationCredential: async () => null } }),
    })
    const table = kind === 'visibility' ? 'conversation_sessions' : kind === 'role' ? 'memberships' : 'project_members'
    const name = `audit_creation_${randomUUID().replaceAll('-', '')}`, barrier = randomUUID(), blocker = await pool.connect()
    const sessionId = randomUUID()
    if (operation === 'append') await new ConversationRepository(f.context.pool, { organizationId: f.context.organizationId, runtimeId: await fixtureProjectRuntime(f, project.id) }).create({ runtimeId: await fixtureProjectRuntime(f, project.id), id: sessionId,
      organizationId: f.context.organizationId, creatorUserId: ids.owner_id, projectId: ids.project_id,
      visibility: 'project', sessionFormatVersion: 0, createdAt: Date.now() })
    let revoked: Promise<unknown> | undefined, created: Promise<unknown> | undefined
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      let authorization: string | undefined
      if (operation === 'create') {
        const prepared = await fetch(`${base}/internal/runtime/session/create`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, [PRINCIPAL_HEADER]: assertion, 'content-type': 'application/json' },
          body: JSON.stringify({ visibility: 'private', header: { id: sessionId, version: 0, createdAt: Date.now(), cwd: project.path } }) })
        expect(prepared.status).toBe(200)
        authorization = (await prepared.json() as { authorization: string }).authorization
      }
      await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0])); IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`)
      const mutationEvent = { membership: 'DELETE', role: 'UPDATE OF role', mode: 'UPDATE OF access_mode', visibility: 'UPDATE OF visibility' }
      const changedRow = kind === 'visibility' ? `OLD.id='${sessionId}'` : `OLD.user_id='${ids.user_id}'::uuid`
      await pool.query(`CREATE TRIGGER ${name} BEFORE ${mutationEvent[kind]} ON harness.${table}
        FOR EACH ROW WHEN (${changedRow}) EXECUTE FUNCTION harness.${name}('${barrier}')`)
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [barrier])
      const revoke = { membership: () => projects.removeMember(project.id, f.member),
        role: () => users.setRole(f.member, 'user'), mode: () => projects.setMember(project.id, f.member, 'ro'),
        visibility: () => new PostgresCollaborationService(mutation.context).setVisibility(f.creator, target.runtimeId!, sessionId, 'private') }
      revoked = revoke[kind]().catch((error: unknown) => error)
      await expect.poll(() => waiting(mutation.applicationName), { timeout: 10_000 }).toBe(true)
      created = fetch(`${base}/internal/runtime/session/append`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, batchId: randomUUID(), creationAuthorization: authorization,
          events: operation === 'create' ? [] : [{ type: 'user/message', surfaceOp: 'append', seq: 0, time: Date.now(),
            data: { role: 'user', content: [{ type: 'text', text: 'Member contribution during revocation' }], source: { kind: 'user',
              participant: { userId: f.member, username: 'member', displayName: 'Member', role: kind === 'role' ? 'admin' : 'user',
                scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } } } } }],
        }),
      }).then(async response => { await response.arrayBuffer(); return response.status }, (error: unknown) => error)
      await expect.poll(() => waiting(creation.applicationName), { timeout: 10_000 }).toBe(true)
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([revoked, created])
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.${table}`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${name}()`)
      server.closeAllConnections(); await new Promise<void>(closed => server.close(() => { closed() }))
      await manager.stopAll()
      await repository.markStopped(target, generation)
    }
    expect(await revoked).toBeUndefined()
    expect(await created).toBe(403)
    const stored = await conversations.load(sessionId)
    expect(stored?.events.length ?? 0).toBe(0)
    expect(stored !== undefined).toBe(operation === 'append')
    await expect(`# Project conversation ${operation === 'create' ? 'creation' : 'append'} after ${kind} revocation\n\n${operation === 'create' ? 'materialize' : 'append'}Status=403\nstoredConversation=${String(operation === 'append')}\nstoredEvents=0\n`)
      .toMatchFileSnapshot(join(import.meta.dirname, `snapshots/project-transactions/${operation}-after-${kind}-revocation.expected.md`))
  })

  it.each(['missing', 'disabled'] as const)('refuses project writers with %s organization membership', async state => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Organization authority', ownerUserId: f.creator })
    await new PostgresUserService(f.context, f.cfg).setRole(f.member, 'user')
    await f.service.setMember(project.id, f.member, 'rw')
    const ids = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id
      FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`, [f.context.organizationId, f.member, project.id])).rows[0]!
    await pool.query(state === 'missing' ? 'DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2'
      : "UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, ids.user_id])
    await expect(new ConversationRepository(pool, { organizationId: f.context.organizationId, runtimeId: await fixtureProjectRuntime(f, project.id) }).create({ runtimeId: await fixtureProjectRuntime(f, project.id), id: randomUUID(), organizationId: f.context.organizationId,
      creatorUserId: ids.user_id, projectId: ids.project_id, visibility: 'project', sessionFormatVersion: 0, createdAt: Date.now() }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('serializes invitation acceptance with real account deletion without a deadlock', async () => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Invitation deletion', ownerUserId: f.creator })
    const invitation = await f.service.createInvitation({ projectId: project.id, inviteeUserId: f.member, inviterUserId: f.creator, mode: 'rw' })
    await new PostgresInstanceRepository(f.context, f.cfg.instancePortBase).initialize()
    const mutation = isolated(f.context, 'acceptance'), removal = isolated(f.context, 'deletion')
    const projects = new PostgresProjectService(mutation.context, f.cfg), users = new PostgresUserService(removal.context, f.cfg)
    const blocker = await connectFromPool(pool)
    let accepted: Promise<unknown> | undefined, deleted: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT i.id FROM harness.instances i JOIN harness.users u ON u.id=i.user_id
        WHERE u.organization_id=$1 AND u.public_id=$2 FOR UPDATE OF i`, [f.context.organizationId, f.member])
      deleted = users.remove(f.member).catch((error: unknown) => error)
      await expect.poll(() => waiting(removal.applicationName, 'SELECT i.observed_state'), { timeout: 10_000 }).toBe(true)
      accepted = projects.acceptInvitation(invitation.id, f.member).catch((error: unknown) => error)
      await expect.poll(() => waiting(mutation.applicationName), { timeout: 10_000 }).toBe(true)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([accepted, deleted])
    }
    expect(await deleted).toBe(true)
    expect(await accepted).toMatchObject({ code: 'forbidden' })
    expect((await pool.query(`SELECT 1 FROM harness.project_members m JOIN harness.users u ON u.id=m.user_id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [f.context.organizationId, f.member])).rowCount).toBe(0)
  })

  it.each(['qualification', 'role'] as const)('rechecks steward %s after waiting to claim an interaction', async kind => {
    const f = await fixture(), directory = join(f.imports, 'steward')
    await mkdir(directory)
    const project = await f.service.ensureSteward({ name: 'Steward authority', path: directory })
    const qualification = new StewardAccess(f.context), owner = { kind: 'user' as const, id: f.member }
    await qualification.set(owner, true, (await qualification.get(owner)).revision)
    const ids = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id
      FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`, [f.context.organizationId, f.member, project.id])).rows[0]!
    const sessionId = randomUUID(), interactionId = randomUUID(), claim = isolated(f.context, `steward-${kind}`)
    await new ConversationRepository(pool, { organizationId: f.context.organizationId, runtimeId: await fixtureProjectRuntime(f, project.id) }).create({ runtimeId: await fixtureProjectRuntime(f, project.id), id: sessionId, organizationId: f.context.organizationId,
      creatorUserId: ids.user_id, projectId: ids.project_id, visibility: 'project', sessionFormatVersion: 0, createdAt: Date.now() })
    const repository = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    await repository.initialize()
    const target = await repository.resolveTarget({ kind: 'project', id: project.id }), token = randomUUID()
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, f.context.organizationSlug, 60_000)
    const assertion = principals.issue({ user: { id: f.member, username: 'member', displayName: 'Member',
      role: 'admin', status: 'active', mustChangePassword: false, autoReviewEligible: false,
      homePath: join(f.root, 'users/member/home') }, runtime: { ...target, generation },
      scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } })
    const manager = new InstanceManager(repository, f.cfg, syntheticRuntimeLauncher()), users = new PostgresUserService(f.context, f.cfg)
    const server = createGatewayServer({ cfg: f.cfg, users, projects: f.service, instances: manager,
      auth: new PostgresAuthService(f.context, f.cfg), audit: new PostgresAuditService(f.context) }, {
      runtime: createRuntimeApiHandler({ context: f.context, instances: repository, conversations: new PostgresConversationStore(pool),
        collaboration: new PostgresCollaborationService(claim.context), principals,
        governance: { resolveOrganizationCredential: async () => null } }),
    })
    const blocker = await pool.connect()
    let claimed: Promise<unknown> | undefined
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [f.context.organizationId, sessionId])
      claimed = fetch(`${base}/internal/runtime/collaboration/claim-interaction`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, [PRINCIPAL_HEADER]: assertion, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, kind: 'approval', interactionId, outcome: { allow: true } }),
      }).then(async response => { await response.arrayBuffer(); return response.status }, (error: unknown) => error)
      await expect.poll(() => waiting(claim.applicationName), { timeout: 10_000 }).toBe(true)
      if (kind === 'qualification') await qualification.set(owner, false, (await qualification.get(owner)).revision)
      else await new PostgresUserService(f.context, f.cfg).setRole(f.member, 'user')
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await claimed
      server.closeAllConnections(); await new Promise<void>(closed => server.close(() => { closed() }))
      await manager.stopAll()
      await repository.markStopped(target, generation)
    }
    expect(await claimed).toBe(403)
    expect((await pool.query(`SELECT 1 FROM harness.conversation_interaction_responses
      WHERE organization_id=$1 AND interaction_id=$2`, [f.context.organizationId, interactionId])).rowCount).toBe(0)
    await expect(new ConversationRepository(pool, { organizationId: f.context.organizationId, runtimeId: await fixtureProjectRuntime(f, project.id) }).create({ runtimeId: await fixtureProjectRuntime(f, project.id), id: randomUUID(), organizationId: f.context.organizationId,
      creatorUserId: ids.user_id, projectId: ids.project_id, visibility: 'project', sessionFormatVersion: 0, createdAt: Date.now() }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(`# Steward interaction after ${kind} revocation\n\nclaimStatus=403\nstoredResponse=false\nnewConversation=forbidden\n`)
      .toMatchFileSnapshot(join(import.meta.dirname, `snapshots/project-transactions/steward-after-${kind}-revocation.expected.md`))
  })

  it('settles real administrator membership and deletion requests without restoring access', async () => {
    const f = await fixture(), mutation = isolated(f.context, 'http-membership'), removal = isolated(f.context, 'http-deletion')
    const projects = new PostgresProjectService(mutation.context, f.cfg), users = new PostgresUserService(removal.context, f.cfg)
    const admin = await users.create({ username: 'api-race-admin', password: 'pw-12345678', role: 'admin' })
    const target = await users.create({ username: 'api-race-member', password: 'pw-12345678' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    const project = await projects.createManaged({ name: 'HTTP deletion order', ownerUserId: admin.id })
    const repository = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    await repository.initialize()
    const processOwner = await GatewayModelBudget.open(new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.cfg.resourceBudget),
      join(f.cfg.stateRoot, 'test-gateway-owners'))
    processOwners.push(processOwner)
    const instances = new InstanceManager(repository, f.cfg, undefined, undefined, undefined, processOwner)
    const deps: GatewayDeps = { cfg: f.cfg, users, projects, instances,
      auth: new PostgresAuthService(f.context, f.cfg), audit: new PostgresAuditService(f.context) }
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
    const blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined, deleted: Promise<unknown> | undefined, deletionFinished = false
    try {
      await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      f.cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: admin.username, password: 'pw-12345678' }) })
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      await login.arrayBuffer()
      expect(login.status).toBe(302)
      if (cookie === undefined) throw new Error('Missing administrator fixture cookie')
      const request = async (path: string, method: string, body?: string) => {
        const response = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, body })
        await response.arrayBuffer()
        return response.status
      }
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [f.context.organizationId, project.id])
      changed = request(`/admin/api/projects/${String(project.id)}/members/${String(target.id)}`, 'PUT', '{"mode":"rw"}').catch((error: unknown) => error)
      await expect.poll(() => waiting(mutation.applicationName, 'SELECT id,owner_user_id'), { timeout: 10_000 }).toBe(true)
      deleted = request(`/admin/api/users/${String(target.id)}`, 'DELETE').then(value => { deletionFinished = true; return value }, (error: unknown) => { deletionFinished = true; return error })
      await expect.poll(async () => deletionFinished || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity d JOIN pg_stat_activity m ON m.application_name=$1
        WHERE d.application_name=$2 AND m.pid=ANY(pg_blocking_pids(d.pid))) blocked`,
      [mutation.applicationName, removal.applicationName])).rows[0]!.blocked, { timeout: 10_000 }).toBe(true)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([changed, deleted])
      server.closeAllConnections(); await new Promise<void>(closed => server.close(() => { closed() }))
      await instances.stopAll()
      await processOwner.close()
    }
    expect(await changed).toBe(204)
    expect(await deleted).toBe(204)
    expect(await users.isDeleted(target.id)).toBe(true)
    expect(await users.isDeleted(admin.id)).toBe(false)
    expect(await users.isDeleted(target.id + 10_000)).toBe(false)
    const dangling = (await pool.query(`SELECT 1 FROM harness.project_members m JOIN harness.users u ON u.id=m.user_id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [f.context.organizationId, target.id])).rowCount
    expect(dangling).toBe(0)
    await expect('# Concurrent project membership and account deletion\n\nmembershipStatus=204\ndeleteStatus=204\ndeletedAccount=true\ndanglingMemberships=0\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-transactions/account-deletion.expected.md'))
  })

  it.each(['create', 'membership', 'invite', 'accept'] as const)('refuses %s relationships for a deleted account', async operation => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Deleted actor', ownerUserId: f.creator })
    const invitation = await f.service.createInvitation({ projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' })
    expect(await new PostgresUserService(f.context, f.cfg).remove(f.member)).toBe(true)
    const run = {
      create: () => f.service.createManaged({ name: 'Deleted owner', createdBy: f.creator, ownerUserId: f.member }),
      membership: () => f.service.setMember(project.id, f.member, 'rw'),
      invite: () => f.service.createInvitation({ projectId: project.id, inviterUserId: f.creator, inviteeUserId: f.member, mode: 'rw' }),
      accept: () => f.service.acceptInvitation(invitation.id, f.member),
    }
    await expect(run[operation]()).rejects.toThrow(operation === 'accept' ? 'forbidden' : `unknown user ${String(f.member)}`)
    expect((await pool.query(`SELECT 1 FROM harness.project_members m JOIN harness.users u ON u.id=m.user_id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [f.context.organizationId, f.member])).rowCount).toBe(0)
  })

  it('cleans legacy deleted-account grants while retaining project files, conversations and usage', async () => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Retained project history', ownerUserId: f.creator })
    const ids = (await pool.query<{ user_id: string; project_id: string; creator_id: string }>(`SELECT u.id user_id,p.id project_id,p.owner_user_id creator_id
      FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`, [f.context.organizationId, f.member, project.id])).rows[0]!
    const sessionId = `retained-${randomUUID()}`
    await new ConversationRepository(pool, { organizationId: f.context.organizationId, runtimeId: await fixtureProjectRuntime(f, project.id) }).create({ runtimeId: await fixtureProjectRuntime(f, project.id), id: sessionId, organizationId: f.context.organizationId, creatorUserId: ids.user_id,
      projectId: ids.project_id, visibility: 'private', sessionFormatVersion: 0, createdAt: Date.now() })
    await pool.query(`INSERT INTO harness.model_usage(event_id,organization_id,user_id,occurred_at,provider_key,model_key,purpose,credential_source,credential_class,status)
      VALUES($1,$2,$3,now(),'fixture','chat','chat','organization','company','succeeded')`, [randomUUID(), f.context.organizationId, ids.user_id])
    const retained = join(project.path, 'retained.txt')
    await writeFile(retained, 'project-owned content')
    const users = new PostgresUserService(f.context, f.cfg)
    await users.remove(f.member)
    await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",
      [f.context.organizationId, ids.project_id, ids.user_id])
    await pool.query(`INSERT INTO harness.project_invitations(organization_id,project_id,invitee_user_id,inviter_user_id,access_mode)
      VALUES($1,$2,$3,$4,'rw')`, [f.context.organizationId, ids.project_id, ids.user_id, ids.creator_id])
    await pool.query(await readFile(resolve(import.meta.dirname, '../deploy/postgres/migrations/073_deleted_project_relationships.sql'), 'utf8'))
    expect((await pool.query('SELECT 1 FROM harness.project_members WHERE organization_id=$1 AND user_id=$2', [f.context.organizationId, ids.user_id])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM harness.project_invitations WHERE organization_id=$1 AND invitee_user_id=$2', [f.context.organizationId, ids.user_id])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM harness.conversation_sessions WHERE id=$1', [sessionId])).rowCount).toBe(1)
    expect((await pool.query('SELECT 1 FROM harness.model_usage WHERE organization_id=$1 AND user_id=$2', [f.context.organizationId, ids.user_id])).rowCount).toBe(1)
    expect((await pool.query('SELECT 1 FROM harness.project_members WHERE organization_id=$1 AND user_id=$2', [f.context.organizationId, ids.creator_id])).rowCount).toBe(1)
    expect(await users.isDeleted(f.member)).toBe(true)
    expect(await readFile(retained, 'utf8')).toBe('project-owned content')
  })

  it('preserves committed project files when the response detail cannot be read', async () => {
    const { context, creator, service } = await fixture()
    vi.spyOn(service, 'getById').mockImplementation(async (id) => {
      const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
        FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
        WHERE p.organization_id=$1 AND p.public_id=$2`, [context.organizationId, id])
      await writeFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'committed project content')
      throw new Error('post-commit-detail-unavailable')
    })
    await expect(service.createManaged({ name: 'Committed', ownerUserId: creator })).rejects.toThrow('post-commit-detail-unavailable')
    const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
      WHERE p.organization_id=$1 AND p.name='Committed'`, [context.organizationId])
    expect(mounted.rowCount).toBe(1)
    expect(await readFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'utf8')).toBe('committed project content')
  })

  it.each([['rw', 'ro'], ['ro', 'rw']] as const)(
    'revokes a pending %s invitation when membership is explicitly set to %s',
    async (invitedMode, currentMode) => {
      const { creator, member, service } = await fixture()
      const project = await service.createManaged({ name: 'Membership decisions', ownerUserId: creator })
      const invitation = await service.createInvitation({
        projectId: project.id, inviterUserId: creator, inviteeUserId: member, mode: invitedMode,
      })
      await service.setMember(project.id, member, currentMode)
      await expect(service.acceptInvitation(invitation.id, member)).rejects.toThrow('invitation-not-pending')
      expect((await service.getById(project.id))?.members).toContainEqual({ userId: member, username: 'member', mode: currentMode })
      expect((await service.listInvitations(member)).find(item => item.id === invitation.id)?.status).toBe('revoked')
    },
  )

  it('revokes a pending invitation when membership is removed before acceptance', async () => {
    const { creator, member, service } = await fixture()
    const project = await service.createManaged({ name: 'Revoked membership', ownerUserId: creator })
    const invitation = await service.createInvitation({
      projectId: project.id, inviterUserId: creator, inviteeUserId: member, mode: 'rw',
    })
    await service.removeMember(project.id, member)
    await expect(service.acceptInvitation(invitation.id, member)).rejects.toThrow('invitation-not-pending')
    expect((await service.getById(project.id))?.members.some(item => item.userId === member)).toBe(false)
    expect((await service.listInvitations(member)).find(item => item.id === invitation.id)?.status).toBe('revoked')
  })

  it('does not count expired invitations or let them block a fresh invitation', async () => {
    const { creator, member, context, service } = await fixture()
    const project = await service.createManaged({ name: 'Invitation expiry', ownerUserId: creator })
    const input = { projectId: project.id, inviterUserId: creator, inviteeUserId: member, mode: 'ro' as const }
    const old = await service.createInvitation(input)
    await pool.query("UPDATE harness.project_invitations SET expires_at=clock_timestamp()-interval '1 minute' WHERE organization_id=$1 AND id=$2",
      [context.organizationId, old.id])
    expect(await service.countPendingInvitations(member)).toBe(0)
    expect((await service.listInvitations(member)).find(item => item.id === old.id)?.status).toBe('expired')
    const fresh = await service.createInvitation({ ...input, mode: 'rw' })
    expect(fresh.id).not.toBe(old.id)
    expect(await service.countPendingInvitations(member)).toBe(1)
    await service.acceptInvitation(fresh.id, member)
    expect((await service.getById(project.id))?.members.find(item => item.userId === member)?.mode).toBe('rw')
    expect((await service.listInvitations(member)).find(item => item.id === old.id)?.status).toBe('expired')
  })

  it('reports a revoked invitation through the authenticated account endpoint', async () => {
    const { cfg, context, service } = await fixture()
    const users = new PostgresUserService(context, cfg)
    const owner = await users.create({ username: 'api-owner', password: 'pw-12345678' })
    const invitee = await users.create({ username: 'api-invitee', password: 'pw-12345678' })
    await users.changeOwnPassword(invitee.id, 'pw-12345678')
    const project = await service.createManaged({ name: 'Invitation authority', ownerUserId: owner.id })
    const invitation = await service.createInvitation({
      projectId: project.id, inviterUserId: owner.id, inviteeUserId: invitee.id, mode: 'rw',
    })
    await service.setMember(project.id, invitee.id, 'ro')
    const deps: GatewayDeps = { cfg, users, projects: service,
      auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
      instances: new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg) }
    await deps.instances.stateOf(invitee.id)
    const server = createGatewayServer(deps)
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'api-invitee', password: 'pw-12345678' }),
      })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect(cookie).not.toBe('')
      await login.body?.cancel()
      const response = await fetch(`${base}/account/api/invitations/${invitation.id}/accept`, {
        method: 'POST', headers: { cookie, origin: base },
      })
      const body = await response.json() as { error: string }
      const membership = (await service.getById(project.id))?.members.find(item => item.userId === invitee.id)
      expect(response.status).toBe(409)
      expect(body.error).toBe('invitation-not-pending')
      expect(membership?.mode).toBe('ro')
      const transcript = ['# Superseded project invitation', '',
        `acceptStatus=${String(response.status)}`, `error=${body.error}`, `membership=${membership?.mode ?? '<none>'}`,
        `pendingInvitations=${String(await service.countPendingInvitations(invitee.id))}`, '',
      ].join('\n')
      await expect(transcript).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-transactions/revoked-invitation.expected.md'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>(closed => server.close(() => { closed() }))
      await deps.instances.stopAll()
    }
  })

  it('expires and renews invitations through authenticated Gateway routes', async () => {
    const { cfg, context, service } = await fixture(), users = new PostgresUserService(context, cfg)
    const owner = await users.create({ username: 'expiry-owner', password: 'pw-12345678' })
    const invitee = await users.create({ username: 'expiry-invitee', password: 'pw-12345678' })
    for (const user of [owner, invitee]) await users.changeOwnPassword(user.id, 'pw-12345678')
    const project = await service.createManaged({ name: 'HTTP invitation expiry', ownerUserId: owner.id })
    const old = await service.createInvitation({ projectId: project.id, inviterUserId: owner.id, inviteeUserId: invitee.id, mode: 'ro' })
    await pool.query("UPDATE harness.project_invitations SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [old.id])
    const deps: GatewayDeps = { cfg, users, projects: service,
      auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
      collaboration: new PostgresCollaborationService(context),
      instances: new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg) }
    const server = createGatewayServer(deps)
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const login = async (username: string): Promise<string> => {
        const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username, password: 'pw-12345678' }) })
        const cookie = response.headers.get('set-cookie')?.split(';')[0]
        await response.arrayBuffer()
        expect(response.status).toBe(302)
        if (cookie === undefined) throw new Error('Missing invitation fixture cookie')
        return cookie
      }
      const ownerCookie = await login(owner.username), inviteeCookie = await login(invitee.username)
      const count = async (): Promise<number> => {
        const response = await fetch(`${base}/account/api/invitations/count`, { headers: { cookie: inviteeCookie } })
        expect(response.status).toBe(200)
        return (await response.json() as { pending: number }).pending
      }
      const pendingBefore = await count()
      const listing = await fetch(`${base}/account/api/invitations`, { headers: { cookie: inviteeCookie } })
      expect(listing.status).toBe(200)
      const expired = (await listing.json() as Array<{ id: string; status: string }>).find(item => item.id === old.id)?.status
      const created = await fetch(`${base}/account/api/projects/${String(project.id)}/invitations`, {
        method: 'POST', headers: { cookie: ownerCookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ username: invitee.username, mode: 'rw' }),
      })
      expect(created.status).toBe(201)
      const fresh = await created.json() as { id: string }
      expect(fresh.id).not.toBe(old.id)
      const pendingRenewed = await count()
      const accepted = await fetch(`${base}/account/api/invitations/${fresh.id}/accept`, {
        method: 'POST', headers: { cookie: inviteeCookie, origin: base },
      })
      await accepted.arrayBuffer()
      expect(accepted.status).toBe(204)
      const mode = (await service.getById(project.id))?.members.find(member => member.userId === invitee.id)?.mode
      const pendingAfter = await count()
      expect({ pendingBefore, expired, pendingRenewed, mode, pendingAfter })
        .toEqual({ pendingBefore: 0, expired: 'expired', pendingRenewed: 1, mode: 'rw', pendingAfter: 0 })
      await expect(['# Expired project invitation renewal', '', `pendingBefore=${String(pendingBefore)}`, `oldStatus=${expired ?? '<none>'}`,
        `renewStatus=${String(created.status)}`, `pendingRenewed=${String(pendingRenewed)}`, `acceptStatus=${String(accepted.status)}`,
        `membership=${mode ?? '<none>'}`, `pendingAfter=${String(pendingAfter)}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-transactions/expired-invitation.expected.md'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>(closed => server.close(() => { closed() }))
      await deps.instances.stopAll()
    }
  })

  it('removes only the new managed directory when an insert rolls back', async () => {
    const { cfg, context, creator, service } = await fixture()
    const retained = await service.createManaged({ name: 'Retained', ownerUserId: creator })
    await writeFile(join(retained.path, 'retained.txt'), 'retained')
    await expect(service.createManaged({ name: 'Retained', ownerUserId: creator })).rejects.toThrow('duplicate project name')
    expect(await readdir(cfg.userProjectsRoot)).toEqual([basename(retained.path)])
    expect(await readFile(join(retained.path, 'retained.txt'), 'utf8')).toBe('retained')
    const projects = await pool.query('SELECT id FROM harness.projects WHERE organization_id=$1', [context.organizationId])
    expect(projects.rowCount).toBe(1)
  })

  it('preserves project files when the commit succeeds without an acknowledgement', async () => {
    const { cfg, context, creator } = await fixture()
    const faultPool = createPostgresPool(databaseUrl!, { max: 1 })
    scopedPools.push(faultPool)
    const failure = new Error('commit-acknowledgement-unavailable')
    faultPool.on('connect', (client) => {
      const queryable: Queryable = client
      const query: Queryable['query'] = queryable.query.bind(queryable)
      vi.spyOn(queryable, 'query').mockImplementation(async <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        const result = await query<R>(text, values)
        if (text === 'COMMIT') {
          const [directory] = await readdir(cfg.userProjectsRoot)
          await writeFile(join(cfg.userProjectsRoot, directory!, 'committed.txt'), 'committed without acknowledgement')
          throw failure
        }
        return result
      })
    })
    const service = new PostgresProjectService({ ...context, pool: faultPool }, cfg)
    await expect(service.createManaged({ name: 'Unacknowledged', ownerUserId: creator })).rejects.toBe(failure)
    const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
      WHERE p.organization_id=$1 AND p.name='Unacknowledged'`, [context.organizationId])
    expect(mounted.rowCount).toBe(1)
    expect(await readFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'utf8')).toBe('committed without acknowledgement')
  })

  it('serializes overlapping directory imports before checking existing mounts', async () => {
    const { cfg, context, imports } = await fixture()
    await mkdir(join(imports, 'parent', 'child'), { recursive: true })
    const applicationName = `project-race-${randomUUID()}`
    const racingPool = createPostgresPool(databaseUrl!, { max: 2, application_name: applicationName, lock_timeout: 15_000 })
    scopedPools.push(racingPool)
    const service = new PostgresProjectService({ ...context, pool: racingPool }, cfg)
    const users = new PostgresUserService(context, cfg)
    const administrator = await users.create({ username: 'api-admin', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(administrator.id, 'pw-12345678')
    const deps: GatewayDeps = { cfg, users, projects: service,
      auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
      instances: new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg) }
    await deps.instances.stateOf({ kind: 'user', id: administrator.id })
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'api-admin', password: 'pw-12345678' }),
      })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect(cookie).not.toBe('')
      await login.body?.cancel()
      const blocker = await connectFromPool(pool)
      const lock = `gateway-port:${context.nodeId}`
      await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [lock])
      const requests = Promise.all(['parent', 'parent/child'].map(async (path) => {
        const response = await fetch(`${base}/admin/api/projects`, {
          method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ name: path === 'parent' ? 'Parent' : 'Child', path: resolve(imports, path) }),
        })
        return { status: response.status, body: await response.json() as { error?: string } }
      }))
      void requests.catch(() => {})
      try {
        // Both HTTP requests must reach the node lock before either can publish a mount.
        await expect.poll(async () => {
          const waiting = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM pg_locks l
            JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database()
            AND a.application_name=$1 AND l.locktype='advisory' AND NOT l.granted`, [applicationName])
          return Number(waiting.rows[0]!.n)
        }, { timeout: 10_000 }).toBe(2)
      } finally {
        try { await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]) }
        finally { blocker.release(); await requests }
      }
      const responses = await requests
      expect(responses.map(response => response.status).sort()).toEqual([200, 409])
      const rejected = responses.find(response => response.status === 409)
      expect(rejected?.body).toMatchObject({ error: 'project-path-overlap' })
      const mounts = await pool.query<{ canonical_path: string }>('SELECT canonical_path FROM harness.project_mounts WHERE organization_id=$1', [context.organizationId])
      expect(mounts.rows).toHaveLength(1)
      expect([await realpath(join(imports, 'parent')), await realpath(join(imports, 'parent', 'child'))]).toContain(mounts.rows[0]!.canonical_path)
      const transcript = ['# Concurrent administrator project imports', '',
        `accepted=${String(responses.filter(response => response.status === 200).length)}`,
        `rejected=${String(responses.filter(response => response.status === 409).length)}`,
        `rejectionStatus=${String(rejected?.status)}`, `error=${rejected?.body.error ?? '<none>'}`,
        `registeredMounts=${String(mounts.rowCount)}`, '',
      ].join('\n')
      await expect(transcript).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-transactions/concurrent-import.expected.md'))
    } finally {
      await new Promise<void>(closed => server.close(() => { closed() }))
      await deps.instances.stopAll()
    }
  })

  it('returns all committed members when project deletion waits for a membership transaction', async () => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Deletion member snapshot', ownerUserId: f.creator })
    const deletion = isolated(f.context, 'project-removal'), service = new PostgresProjectService(deletion.context, f.cfg)
    const blocker = await connectFromPool(pool)
    let removed: Promise<unknown> | undefined, committed = false
    try {
      await blocker.query('BEGIN')
      const selected = await blocker.query<{ id: string }>('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [f.context.organizationId, project.id])
      await blocker.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        SELECT $1,$2,u.id,'rw' FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$3`,
      [f.context.organizationId, selected.rows[0]!.id, f.member])
      removed = service.remove(project.id).catch((error: unknown) => error)
      await expect.poll(() => waiting(deletion.applicationName), { timeout: 10_000 }).toBe(true)
      await blocker.query('COMMIT'); committed = true
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release(); await removed
    }
    expect(await removed).toEqual([f.creator, f.member].sort((left, right) => left - right))
    expect(await f.service.getById(project.id)).toBeNull()
    expect(await readdir(project.path)).toEqual([])
  })

  it('rejects a membership write after the project disappears while its lock is awaited', async () => {
    const f = await fixture(), project = await f.service.createManaged({ name: 'Deleted project writer', ownerUserId: f.creator })
    const writing = isolated(f.context, 'missing-project'), service = new PostgresProjectService(writing.context, f.cfg)
    const blocker = await connectFromPool(pool)
    let changed: Promise<unknown> | undefined, committed = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [f.context.organizationId, project.id])
      changed = service.setMember(project.id, f.member, 'rw').catch((error: unknown) => error)
      await expect.poll(() => waiting(writing.applicationName, 'SELECT owner_user_id'), { timeout: 10_000 }).toBe(true)
      await blocker.query('DELETE FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [f.context.organizationId, project.id])
      await blocker.query('COMMIT'); committed = true
    } finally {
      if (!committed) await blocker.query('ROLLBACK')
      blocker.release(); await changed
    }
    expect(await changed).toMatchObject({ message: `unknown project ${String(project.id)}` })
    expect(await f.service.getById(project.id)).toBeNull()
    expect(await readdir(project.path)).toEqual([])
  })

  it.each(['setMember', 'removeMember', 'remove'] as const)('runs %s with one transaction connection', async (operation) => {
    const { cfg, context, creator, member, service } = await fixture()
    const project = await service.createManaged({ name: 'One connection', ownerUserId: creator })
    await service.setMember(project.id, member, 'ro')
    const limitedPool = createPostgresPool(databaseUrl!, { max: 1, connectionTimeoutMillis: 1_000 })
    scopedPools.push(limitedPool)
    const limited = new PostgresProjectService({ ...context, pool: limitedPool }, cfg)
    if (operation === 'setMember') {
      await limited.setMember(project.id, member, 'rw')
      expect((await service.getById(project.id))?.members.find(row => row.userId === member)?.mode).toBe('rw')
    } else if (operation === 'removeMember') {
      await limited.removeMember(project.id, member)
      expect((await service.getById(project.id))?.members.some(row => row.userId === member)).toBe(false)
    } else {
      expect(await limited.remove(project.id)).toContain(member)
      expect(await service.getById(project.id)).toBeNull()
    }
    expect(await readdir(project.path)).toEqual([])
  })
})
