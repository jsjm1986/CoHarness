import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresPluginState } from '../src/plugin-state.ts'
import { StewardQueryService } from '../src/postgres/steward-query.ts'
import { StewardAccess, stewardPolicyOwner } from '../src/steward-access.ts'
import { ResourceAccessError } from '../src/resource-access.ts'
import { CollaborationDeniedError } from '../src/collaboration.ts'
import { testConfig } from './test-config.ts'

const DATABASE_URL = process.env.HGW_TEST_DATABASE_URL
const describePg = DATABASE_URL === undefined ? describe.skip : describe
const MIGRATIONS = resolve(import.meta.dirname, '../deploy/postgres/migrations')

describe('stewardPolicyOwner', () => {
  it('accepts user owners and rejects every other coordinate', () => {
    expect(stewardPolicyOwner('user', 7)).toEqual({ kind: 'user', id: 7 })
    expect(() => stewardPolicyOwner('project', 7)).toThrow(ResourceAccessError)
    expect(() => stewardPolicyOwner('user', 7, 'plugin')).toThrow(ResourceAccessError)
    expect(() => stewardPolicyOwner('user', 'x')).toThrow(ResourceAccessError)
  })
})

describePg('PostgreSQL steward space', () => {
  let pool: Pool
  let root: string
  let organizationId: string
  let context: PostgresRuntimeContext
  let projects: PostgresProjectService
  let collaboration: PostgresCollaborationService
  let instances: PostgresInstanceRepository
  let pluginState: PostgresPluginState
  let stewardQueries: StewardQueryService
  let stewardAccess: StewardAccess
  let admin: { id: string; publicId: number }
  let member: { id: string; publicId: number }
  let outsider: { id: string; publicId: number }
  let stewardInternalId: string
  let stewardPublicId: number
  let standardInternalId: string
  let standardPublicId: number

  const addUser = async (username: string, role: 'admin' | 'member'): Promise<{ id: string; publicId: number }> => {
    const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path) VALUES($1,$2,$3,$4) RETURNING id,public_id`,
    [organizationId, username, username, `/tmp/${username}`])).rows[0]!
    await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)`,
      [organizationId, user.id, role])
    return { id: user.id, publicId: Number(user.public_id) }
  }

  /** Grant or revoke the steward qualification for one account's public id. */
  const qualify = async (publicId: number, enabled: boolean): Promise<void> => {
    const current = await stewardAccess.get({ kind: 'user', id: publicId })
    await stewardAccess.set({ kind: 'user', id: publicId }, enabled, current.revision)
  }

  /** Insert one root conversation row into the given project. */
  const addConversation = async (projectInternalId: string, creatorInternalId: string,
    visibility: 'project' | 'private'): Promise<string> => {
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,project_id,
      session_format_version,created_at,updated_at,visibility,root_session_id)
      VALUES($1,$2,$3,$4,1,now(),now(),$5,$1)`,
      [sessionId, organizationId, creatorInternalId, projectInternalId, visibility])
    return sessionId
  }

  /** Record a granted approval response in one conversation for one responder. */
  const addApproval = async (sessionId: string, responderInternalId: string): Promise<string> => {
    const approvalId = randomUUID()
    await pool.query(`INSERT INTO harness.conversation_interaction_responses(
      organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome)
      VALUES($1,'approval',$2,$3,$4,to_jsonb('allowed-once'::text))`,
      [organizationId, approvalId, sessionId, responderInternalId])
    return approvalId
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgw-steward-'))
    pool = createPostgresPool(DATABASE_URL!, { max: 4 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, MIGRATIONS)
    const slug = `steward-${randomUUID()}`, nodeName = randomUUID()
    organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Steward') RETURNING id`, [slug])).rows[0]!.id
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, nodeName])
    admin = await addUser('steward-admin', 'admin')
    member = await addUser('steward-member', 'member')
    outsider = await addUser('steward-outsider', 'member')
    context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
    const workspace = join(root, 'steward-workspace')
    await mkdir(workspace)
    await mkdir(join(root, 'standard'))
    projects = new PostgresProjectService(context, testConfig(root))
    collaboration = new PostgresCollaborationService(context)
    instances = new PostgresInstanceRepository(context, 41_000)
    pluginState = new PostgresPluginState(context)
    stewardQueries = new StewardQueryService(context, true)
    stewardAccess = new StewardAccess(context)

    const steward = await projects.ensureSteward({ name: 'Steward', path: workspace })
    stewardPublicId = steward.id
    stewardInternalId = (await pool.query<{ id: string }>(
      'SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2',
      [organizationId, steward.id])).rows[0]!.id
    const standard = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by) VALUES($1,'Standard project',$2) RETURNING id,public_id`,
      [organizationId, admin.id])).rows[0]!
    standardInternalId = standard.id
    standardPublicId = Number(standard.public_id)
    await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name=$3),$4,$4)`,
      [organizationId, standardInternalId, nodeName, join(root, 'standard')])
    await pool.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
      VALUES($1,$2,$3,'rw')`, [organizationId, standardInternalId, member.id])
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    await rm(root, { recursive: true, force: true })
  })

  it('seeds the steward project once with an empty member list and stays idempotent', async () => {
    const again = await projects.ensureSteward({ name: 'Steward', path: join(root, 'steward-workspace') })
    expect(again.id).toBe(stewardPublicId)
    expect((await projects.getById(stewardPublicId))?.kind).toBe('steward')
    expect((await pool.query(
      'SELECT COUNT(*)::int count FROM harness.project_members WHERE organization_id=$1 AND project_id=$2',
      [organizationId, stewardInternalId])).rows[0]!.count).toBe(0)
    await expect(pool.query(`INSERT INTO harness.projects(organization_id,name,kind)
      VALUES($1,'Steward clone','steward')`, [organizationId])).rejects.toThrow()
  })

  it('rejects mutations that would break the reserved space', async () => {
    for (const operation of [
      () => projects.rename(stewardPublicId, 'Renamed'),
      () => projects.remove(stewardPublicId),
      () => projects.setMember(stewardPublicId, member.publicId, 'rw'),
      () => projects.removeMember(stewardPublicId, member.publicId),
      () => projects.createInvitation({
        projectId: stewardPublicId, inviteeUserId: member.publicId, inviterUserId: admin.publicId, mode: 'rw',
      }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'steward-reserved' })
    }
    await projects.rename(standardPublicId, 'Standard renamed')
  })

  it('admits through the qualification lane alone', async () => {
    expect(await collaboration.projectForUser(stewardPublicId, admin.publicId)).toBeNull()
    expect(await collaboration.projectForUser(stewardPublicId, member.publicId)).toBeNull()
    await qualify(member.publicId, true)
    expect(await collaboration.projectForUser(stewardPublicId, member.publicId))
      .toMatchObject({ mode: 'rw', kind: 'steward' })
    expect((await collaboration.projectForUser(standardPublicId, member.publicId))?.mode).toBe('rw')
    expect(await collaboration.projectForUser(standardPublicId, admin.publicId)).not.toBeNull()
    await qualify(admin.publicId, true)
    expect(await collaboration.projectForUser(stewardPublicId, admin.publicId)).toMatchObject({ mode: 'rw' })
    await qualify(member.publicId, false)
    expect(await collaboration.projectForUser(stewardPublicId, member.publicId)).toBeNull()
    await qualify(member.publicId, true)
  })

  it('gates conversation access and writes through the lane', async () => {
    const sessionId = await addConversation(stewardInternalId, member.id, 'project')
    await expect(collaboration.access(outsider.publicId, sessionId, 'read'))
      .rejects.toBeInstanceOf(CollaborationDeniedError)
    const access = await collaboration.access(member.publicId, sessionId, 'write')
    expect(access).toMatchObject({ canRead: true, canWrite: true })
    const listed = await collaboration.listConversations(member.publicId, stewardPublicId)
    expect(listed.map(row => row.sessionId)).toContain(sessionId)
    expect(await collaboration.readableSessionIds(member.publicId, stewardPublicId, [sessionId]))
      .toEqual([sessionId])
    // A private steward conversation stays with its creator for non-admin qualifiers.
    const privateId = await addConversation(stewardInternalId, admin.id, 'private')
    expect(await collaboration.readableSessionIds(member.publicId, stewardPublicId, [privateId])).toEqual([])
    expect(await collaboration.readableSessionIds(admin.publicId, stewardPublicId, [privateId])).toEqual([privateId])
  })

  it('excludes the steward instance from idle reaping at the repository level', async () => {
    const node = (await pool.query<{ id: string }>(
      'SELECT id FROM harness.compute_nodes WHERE organization_id=$1', [organizationId])).rows[0]!.id
    // Seeding allocated the steward instance row already; age it past the cutoff.
    await pool.query(`UPDATE harness.instances SET observed_state='ready',
      last_activity_at=now()-interval '2 hours'
      WHERE organization_id=$1 AND project_id=$2`, [organizationId, stewardInternalId])
    await pool.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port,
      observed_state,last_activity_at) VALUES($1,$2,$3,$4,'ready',now()-interval '2 hours')`,
      [organizationId, standardInternalId, node, 42102])
    const idle = await instances.idleTargets(Date.now())
    expect(idle).toContainEqual({ kind: 'project', id: standardPublicId })
    expect(idle).not.toContainEqual({ kind: 'project', id: stewardPublicId })
    expect(await instances.idleTarget({ kind: 'project', id: stewardPublicId }, Date.now())).toBe(false)
    expect(await instances.idleTarget({ kind: 'project', id: standardPublicId }, Date.now())).toBe(true)
  })

  it('locks plugin composition for the steward target', async () => {
    const owner = { kind: 'project' as const, id: stewardPublicId }
    await expect(pluginState.set(owner, { entries: [], bundles: [] }, '0'))
      .rejects.toMatchObject({ status: 403 })
    await expect(pluginState.publishForSubject(
      { organizationId, target: owner, generation: 1, projectInternalId: stewardInternalId },
      { entries: [], bundles: [] }, '0',
    )).rejects.toMatchObject({ status: 403 })
    const standard = { kind: 'project' as const, id: standardPublicId }
    expect((await pluginState.set(standard, { entries: [], bundles: [] }, '0')).revision).toBe('1')
  })

  it('stewardTarget only trusts the database kind', async () => {
    expect(await stewardQueries.stewardTarget(stewardInternalId)).toBe(true)
    expect(await stewardQueries.stewardTarget(standardInternalId)).toBe(false)
    expect(await stewardQueries.stewardTarget(undefined)).toBe(false)
    expect(await new StewardQueryService(context, false).stewardTarget(stewardInternalId)).toBe(false)
  })

  it('executes reads, journals every attempt, and gates writes on a qualified approval', async () => {
    const subject = { organizationId, projectInternalId: stewardInternalId, generation: 1 }
    const read = await stewardQueries.query(subject, { sql: 'SELECT 1 AS one', dryRun: false, rowLimit: 500 })
    expect(read).toMatchObject({ classification: 'read', rows: [{ one: 1 }], truncated: false })

    await expect(stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name', dryRun: false, rowLimit: 500,
    })).rejects.toMatchObject({ status: 403, code: 'steward-approval-required' })
    await expect(stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name', dryRun: false, approvalId: randomUUID(), rowLimit: 500,
    })).rejects.toMatchObject({ status: 403, code: 'steward-approval-invalid' })

    const plan = await stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name WHERE false', dryRun: true, rowLimit: 500,
    })
    expect(plan.classification).toBe('write')
    expect(plan.plan?.length).toBeGreaterThan(0)

    // An unqualified responder's approval does not authorize a write.
    const stewardSession = await addConversation(stewardInternalId, member.id, 'project')
    const outsiderApproval = await addApproval(stewardSession, outsider.id)
    await expect(stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name', dryRun: false, approvalId: outsiderApproval, rowLimit: 500,
    })).rejects.toMatchObject({ status: 403, code: 'steward-approval-invalid' })

    // A qualified responder's approval inside the steward space executes.
    const granted = await addApproval(stewardSession, member.id)
    const applied = await stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name WHERE false', dryRun: false, approvalId: granted, rowLimit: 500,
    })
    expect(applied).toMatchObject({ classification: 'write', rowCount: 0 })

    // An approval granted in a different project does not carry over.
    const foreignSession = await addConversation(standardInternalId, member.id, 'project')
    const foreignApproval = await addApproval(foreignSession, member.id)
    await expect(stewardQueries.query(subject, {
      sql: 'UPDATE harness.projects SET name=name', dryRun: false, approvalId: foreignApproval, rowLimit: 500,
    })).rejects.toMatchObject({ status: 403, code: 'steward-approval-invalid' })

    const journal = await pool.query<{ status: string; classification: string; count: string }>(
      `SELECT status,classification,COUNT(*)::text count FROM harness.steward_query_log
      WHERE organization_id=$1 GROUP BY status,classification`, [organizationId])
    const tally = Object.fromEntries(journal.rows.map(row => [`${row.status}:${row.classification}`, Number(row.count)]))
    expect(tally['ok:read']).toBe(1)
    expect(tally['ok:write']).toBe(2)
    expect(tally['denied:write']).toBe(4)
  })

  it('lets Postgres enforce read-only execution beyond the keyword classifier', async () => {
    const subject = { organizationId, projectInternalId: stewardInternalId, generation: 1 }
    // Data-modifying CTEs and EXPLAIN ANALYZE pass the leading-keyword test;
    // the READ ONLY transaction rejects them at execution and journals 'error'.
    await expect(stewardQueries.query(subject, {
      sql: `WITH d AS (DELETE FROM harness.projects WHERE false RETURNING id) SELECT id FROM d`,
      dryRun: false, rowLimit: 500,
    })).rejects.toThrow(/read-only transaction/)
    await expect(stewardQueries.query(subject, {
      sql: 'EXPLAIN ANALYZE UPDATE harness.projects SET name=name WHERE false', dryRun: false, rowLimit: 500,
    })).rejects.toThrow(/read-only transaction/)

    const journal = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text count FROM harness.steward_query_log
      WHERE organization_id=$1 AND classification='read' AND status='error'`, [organizationId])
    expect(Number(journal.rows[0]!.count)).toBe(2)
  })

  it('spends an allowed-once approval on exactly one write, including under concurrency', async () => {
    const subject = { organizationId, projectInternalId: stewardInternalId, generation: 1 }
    const stewardSession = await addConversation(stewardInternalId, member.id, 'project')
    const approval = await addApproval(stewardSession, member.id)
    const write = { sql: 'UPDATE harness.projects SET name=name WHERE false', dryRun: false, rowLimit: 500 }

    await stewardQueries.query(subject, { ...write, approvalId: approval })
    await expect(stewardQueries.query(subject, { ...write, approvalId: approval }))
      .rejects.toMatchObject({ status: 403, code: 'steward-approval-invalid' })

    const concurrent = await addApproval(stewardSession, member.id)
    const [first, second] = await Promise.allSettled([
      stewardQueries.query(subject, { ...write, approvalId: concurrent }),
      stewardQueries.query(subject, { ...write, approvalId: concurrent }),
    ])
    expect([first, second].filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect([first, second].filter(result =>
      result.status === 'rejected' && result.reason?.code === 'steward-approval-invalid',
    )).toHaveLength(1)
  })

  it('applies statement byte limits before any authorization work', async () => {
    const subject = { organizationId, projectInternalId: stewardInternalId, generation: 1 }
    await expect(stewardQueries.query(subject, {
      sql: `SELECT '${'x'.repeat(70 * 1024)}'`, dryRun: false, rowLimit: 500,
    })).rejects.toMatchObject({ status: 413, code: 'steward-statement-too-large' })
    // The limit counts wire bytes, not UTF-16 code units.
    await expect(stewardQueries.query(subject, {
      sql: `SELECT '${'维'.repeat(22 * 1024)}'`, dryRun: false, rowLimit: 500,
    })).rejects.toMatchObject({ status: 413, code: 'steward-statement-too-large' })
  })

  it('steward access policies stay user-scoped and versioned', async () => {
    expect(await stewardAccess.get({ kind: 'user', id: member.publicId })).toMatchObject({ enabled: true })
    await expect(stewardAccess.set({ kind: 'user', id: member.publicId }, false, '999'))
      .rejects.toMatchObject({ status: 409 })
    // The user-only shape is enforced at the schema level, not just the API.
    await expect(pool.query(`INSERT INTO harness.steward_access_policies(
      organization_id,project_id,enabled,revision) VALUES($1,$2,true,1)`,
      [organizationId, standardInternalId])).rejects.toThrow()
  })
})
