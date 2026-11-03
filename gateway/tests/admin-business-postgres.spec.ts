import type { RuntimeId } from '../src/runtime-catalog.ts'
import type { ConversationSessionIdentity } from '../src/session-identity.ts'
/** PostgreSQL business-rule regressions: archive ownership, document authority, desktop locking, webhook targeting. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPostgresPool, runMigrations, type Queryable } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import {
  ConversationArchiveService,
  type ConversationArchiveRuntimeIdentity,
  type ConversationArchiveRuntimeSnapshot,
} from '../src/postgres/conversation-archive-service.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { PostgresDesktopCoordinatorRepository } from '../src/postgres/desktop-coordinator-repository.ts'
import { PostgresWebhookEndpointService, WebhookSecretCipher } from '../src/postgres/webhook-endpoint-service.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { AuthService, type UserRow } from '../src/auth.ts'
import { UserService } from '../src/users.ts'
import { ProjectService } from '../src/projects.ts'
import { AuditService } from '../src/audit.ts'
import { InstanceManager } from '../src/instances.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { openDb } from '../src/db.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import { testConfig } from './test-config.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import { createExecutionFixture } from './execution-fixture.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const disposableDatabase = databaseUrl !== undefined
// The suite never connects unless the URL targets a disposable test database.
const describePg = disposableDatabase ? describe : describe.skip
let pool: Pool
const cleanup: Array<() => Promise<unknown> | void> = []
const fixtureOrganizations = new Set<string>()
afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  for (const organizationId of [...fixtureOrganizations]) {
    try { await removeFixtureOrganization(organizationId) } catch (error) { failures.push(error) }
  }
  fixtureOrganizations.clear()
  if (failures.length > 0) throw new AggregateError(failures, 'postgres fixture cleanup failed')
})

/** Delete only the rows a fixture organization owns; unrelated fixtures stay untouched. */
async function removeFixtureOrganization(organizationId: string): Promise<void> {
  const tables = (await pool.query<{ table_name: string }>(`SELECT table_name
    FROM information_schema.columns
    WHERE table_schema='harness' AND column_name='organization_id' AND table_name <> 'organizations'`))
    .rows.map(row => row.table_name)
  // Composite foreign keys make one pass order-dependent; retry until every
  // table clears or the ordering can never resolve.
  for (let pass = 0; pass < 12; pass += 1) {
    let blocked = false
    for (const table of tables) {
      try {
        await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
      } catch (error) {
        if ((error as { code?: string }).code === '23503') blocked = true
        else throw error
      }
    }
    if (!blocked) break
  }
  // Access-invalidation triggers enqueue an outbox row while other fixture
  // rows are being deleted, so the outbox clears after the table passes.
  await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId])
  await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
}

function gate(): { passed: Promise<void>; release: () => void } {
  let release!: () => void
  const passed = new Promise<void>(resolve => { release = resolve })
  return { passed, release }
}

interface FixtureUser { uuid: string; publicId: number }
interface FixtureProject { uuid: string; publicId: number }

interface Fixture {
  organizationId: string
  context: PostgresRuntimeContext
  user(role?: 'admin' | 'member'): Promise<FixtureUser>
  project(options?: {
    name?: string
    createdBy?: string
    owner?: string
    members?: readonly { user: string; mode: 'ro' | 'rw' }[]
  }): Promise<FixtureProject>
}

async function fixture(): Promise<Fixture> {
  const slug = randomUUID()
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO harness.organizations(slug,display_name) VALUES($1,'business regressions') RETURNING id`, [slug],
  )).rows[0]!.id
  fixtureOrganizations.add(organizationId)
  const nodeName = randomUUID()
  await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, nodeName])
  const context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
  const user = async (role: 'admin' | 'member' = 'member'): Promise<FixtureUser> => {
    const name = randomUUID().slice(0, 12)
    const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path)
      VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`, [organizationId, name, `/tmp/${slug}/${name}`])).rows[0]!
    await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
      [organizationId, row.id, role])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
      [organizationId, context.nodeId, row.id])
    await new PostgresInstanceRepository(context, 48_000).initialize()
    return { uuid: row.id, publicId: Number(row.public_id) }
  }
  const project = async (options: {
    name?: string
    createdBy?: string
    owner?: string
    members?: readonly { user: string; mode: 'ro' | 'rw' }[]
  } = {}): Promise<FixtureProject> => {
    const row = (await pool.query<{ id: string; public_id: string }>(
      `INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
       VALUES($1,$2,$3,$4) RETURNING id,public_id`,
      [organizationId, options.name ?? `project-${randomUUID().slice(0, 8)}`, options.createdBy ?? null, options.owner ?? null],
    )).rows[0]!
    for (const member of options.members ?? []) {
      await pool.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        VALUES($1,$2,$3,$4)`, [organizationId, row.id, member.user, member.mode])
    }
    await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,$3,$4,$4)`, [organizationId, row.id, context.nodeId, `/tmp/${slug}/${row.id}`])
    await new PostgresInstanceRepository(context, 48_000).initialize()
    return { uuid: row.id, publicId: Number(row.public_id) }
  }
  return { organizationId, context, user, project }
}

const runtimeOf = (user: FixtureUser): ConversationArchiveRuntimeIdentity => ({ kind: 'user', id: user.publicId })

function snapshot(
  runtime: ConversationArchiveRuntimeIdentity,
  overrides: Partial<ConversationArchiveRuntimeSnapshot> = {},
): ConversationArchiveRuntimeSnapshot {
  return {
    runtime,
    revision: 1,
    archivedSessionIds: ['root-a'],
    sessions: [{ sessionId: 'root-a', header: {} }],
    ...overrides,
  }
}

type BlockedWatch = { kind: 'blocked' } | { kind: 'failed', cause: unknown }

/** Poll until the named backend waits on an ungranted lock; bounded well under lock_timeout. */
async function waitForBlocked(appName: string, lockTypes: readonly string[] = ['advisory'], signal?: AbortSignal): Promise<BlockedWatch> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (signal?.aborted) return { kind: 'failed', cause: new Error(`blocked watch for ${appName} aborted`) }
    const row = (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.application_name=$1 AND a.datname=current_database()
        AND l.locktype=ANY($2::text[]) AND NOT l.granted) blocked`,
    [appName, lockTypes])).rows[0]
    if (signal?.aborted) return { kind: 'failed', cause: new Error(`blocked watch for ${appName} aborted`) }
    if (row!.blocked) return { kind: 'blocked' }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return { kind: 'failed', cause: new Error(`backend ${appName} never waited on ${lockTypes.join('/')} lock`) }
}

/**
 * Wait for the lane to park on a lock. The original operation's settlement is
 * part of the race under its own discriminant: fulfillment before the
 * observed lock is an unexpected early settlement, and rejection rethrows the
 * exact cause — rejection values can never collide with the outcome kinds.
 * @param appName - the lane's derived application name.
 * @param lockTypes - pg_locks locktypes to watch for.
 * @param operation - the already-started operation promise, unwrapped.
 */
async function waitForBlockedOrSettled(appName: string, lockTypes: readonly string[], operation: Promise<unknown>): Promise<void> {
  const controller = new AbortController()
  const watcher = waitForBlocked(appName, lockTypes, controller.signal)
    .catch((cause: unknown) => ({ kind: 'failed' as const, cause }))
  try {
    const outcome = await Promise.race([
      watcher,
      Promise.resolve(operation).then(
        () => ({ kind: 'settled' as const }),
        (cause: unknown) => ({ kind: 'failed' as const, cause }),
      ),
    ])
    switch (outcome.kind) {
      case 'blocked': return
      case 'settled': throw new Error(`backend ${appName} settled before waiting on ${lockTypes.join('/')} lock`)
      case 'failed': throw outcome.cause
    }
  } finally {
    controller.abort()
    await watcher
  }
}

const runPrefix = randomUUID().slice(0, 8)

/** The derived application name shared by a lane and every watcher of it. */
function laneName(name: string): string {
  return `hgw-audit-${runPrefix}-${name}`
}

function lane(name: string, options?: string): Pool {
  const value = createPostgresPool(databaseUrl!, { application_name: laneName(name), max: 2, options })
  cleanup.push(() => value.end())
  return value
}

describePg('Admin business PostgreSQL regressions', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('rethrows the original operation rejection with its identity, never a watcher outcome', async () => {
    for (const cause of [new Error('boom'), 'blocked', 'settled', undefined] as const) {
      let thrown: unknown = 'no throw'
      try {
        await waitForBlockedOrSettled(laneName('helper'), ['advisory'], Promise.reject(cause))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(cause)
    }
    await expect(
      waitForBlockedOrSettled(laneName('helper'), ['advisory'], Promise.resolve('early')),
    ).rejects.toThrow('settled before waiting')
  })

  it('preserves the primary operation rejection over a pending watcher query failure', async () => {
    const primaryError = new Error('primary')
    const secondaryError = new Error('secondary')
    const hold = gate()
    // The first watcher poll parks on the gate then fails: without the
    // resolving watcher outcome, finally's await would replace the primary
    // operation rejection with this secondary query error.
    const spy = vi.spyOn(pool, 'query').mockImplementationOnce(async () => {
      await hold.passed
      throw secondaryError
    })
    const observer = waitForBlockedOrSettled(laneName('helper'), ['advisory'], Promise.reject(primaryError))
      .then(() => 'resolved' as const, (error: unknown) => error)
    try {
      await vi.waitFor(() => { expect(spy).toHaveBeenCalledOnce() })
      hold.release()
      expect(await observer).toBe(primaryError)
    } finally {
      hold.release()
      spy.mockRestore()
      await observer
    }
  })

  describe('archive reference deletion', () => {
    it('deletes a project with retained archive metadata without changing its organization', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hgw-project-archive-delete-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const f = await fixture()
      const actor = await f.user()
      const project = await f.project({ members: [{ user: actor.uuid, mode: 'rw' }] })
      const sessionId = `project-delete-${randomUUID()}`
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'project', id: project.publicId })
      await pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,
        creator_user_id,archived_by_user_id,restored_by_user_id,trashed_by_user_id,runtime_id,node_id)
        VALUES($1,$2,'project',$3,$4,$5,$5,$5,$5,$6,$7)`,
      [f.organizationId, sessionId, project.publicId, project.uuid, actor.uuid, runtime.runtimeId, f.context.nodeId])
      const projects = new PostgresProjectService(f.context, testConfig(root))
      await expect(projects.remove(project.publicId)).resolves.toEqual([actor.publicId])
      const removed = await pool.query<{ id: string }>(
        'SELECT id FROM harness.projects WHERE organization_id=$1 AND id=$2',
        [f.organizationId, project.uuid],
      )
      expect(removed.rows).toEqual([])
      const archive = await pool.query<{
        organization_id: string
        project_id: string | null
        creator_user_id: string | null
        archived_by_user_id: string | null
        restored_by_user_id: string | null
        trashed_by_user_id: string | null
      }>(`SELECT organization_id,project_id,creator_user_id,archived_by_user_id,
        restored_by_user_id,trashed_by_user_id
        FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2`,
      [f.organizationId, sessionId])
      expect(archive.rows).toEqual([{
        organization_id: f.organizationId,
        project_id: null,
        creator_user_id: actor.uuid,
        archived_by_user_id: actor.uuid,
        restored_by_user_id: actor.uuid,
        trashed_by_user_id: actor.uuid,
      }])
    })

    it('clears only nullable archive actor references when their user row is removed', async () => {
      const f = await fixture()
      const actor = await f.user()
      const sessionId = `actor-delete-${randomUUID()}`
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'user', id: actor.publicId })
      await pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,
        creator_user_id,archived_by_user_id,restored_by_user_id,trashed_by_user_id,runtime_id,node_id)
        VALUES($1,$2,'user',$3,$4,$4,$4,$4,$5,$6)`,
      [f.organizationId, sessionId, actor.publicId, actor.uuid, runtime.runtimeId, f.context.nodeId])
      await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND user_id=$2', [f.organizationId, actor.uuid])
      const removed = await pool.query(
        'DELETE FROM harness.users WHERE organization_id=$1 AND id=$2',
        [f.organizationId, actor.uuid],
      )
      expect(removed.rowCount).toBe(1)
      const archive = await pool.query<{
        organization_id: string
        creator_user_id: string | null
        archived_by_user_id: string | null
        restored_by_user_id: string | null
        trashed_by_user_id: string | null
      }>(`SELECT organization_id,creator_user_id,archived_by_user_id,
        restored_by_user_id,trashed_by_user_id
        FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2`,
      [f.organizationId, sessionId])
      expect(archive.rows).toEqual([{
        organization_id: f.organizationId,
        creator_user_id: null,
        archived_by_user_id: null,
        restored_by_user_id: null,
        trashed_by_user_id: null,
      }])
    })

    it('retains the composite foreign key refusal for an actor from another organization', async () => {
      const f = await fixture()
      const project = await f.project()
      const other = await fixture()
      const foreignActor = await other.user()
      const sessionId = `foreign-actor-${randomUUID()}`
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'project', id: project.publicId })
      await expect(pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,runtime_id,node_id)
        VALUES($1,$2,'project',$3,$4,$5,$6,$7)`,
      [f.organizationId, sessionId, project.publicId, project.uuid, foreignActor.uuid, runtime.runtimeId, f.context.nodeId]))
        .rejects.toMatchObject({ code: '23503' })
      const archive = await pool.query<{ root_session_id: string }>(
        `SELECT root_session_id FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id=$2`,
        [f.organizationId, sessionId],
      )
      expect(archive.rows).toEqual([])
    })
  })

  describe('archive runtime ownership', () => {
    it('keeps another Runtime archive unchanged when a local child derives an equal Host root', async () => {
      const f = await fixture(), victim = await f.user(), attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      const victimId = await service.syncSnapshot({ rootSessionId: 'same-root', runtime: runtimeOf(victim), syncRevision: 5, title: 'Victim', messageCount: 1 })
      const before = await service.detail(victimId)
      await service.syncRuntimeSnapshot(snapshot(runtimeOf(attacker), {
        revision: 9, archivedSessionIds: ['child'],
        sessions: [{ sessionId: 'child', header: { parentSession: 'same-root' }, title: 'Local child' }],
        search: [{ sessionId: 'child', seq: 0, role: 'user', content: 'Local content', occurredAt: 1 }],
      }), runtimeOf(attacker))
      expect(await service.detail(victimId)).toEqual(before)
      const rows = await service.adminList({ state: 'all' })
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.archiveId)).size).toBe(2)
      expect(rows.every(row => row.rootSessionId === 'same-root')).toBe(true)
      expect((await service.adminList({ query: 'Local content', state: 'all' })).map(row => row.runtime.id)).toEqual([attacker.publicId])
    })

    it('assigns distinct stable archive identities to equal Host roots in two Runtime namespaces', async () => {
      const f = await fixture(), victim = await f.user(), attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      const seed = (runtime: ConversationArchiveRuntimeIdentity) => service.syncSnapshot({ rootSessionId: 'claimed-root', runtime, syncRevision: 1 })
      const victimId = await seed(runtimeOf(victim)), attackerId = await seed(runtimeOf(attacker))
      expect(attackerId).not.toBe(victimId)
      expect(await seed(runtimeOf(victim))).toBe(victimId)
      expect(await seed(runtimeOf(attacker))).toBe(attackerId)
      expect((await service.status(victimId))?.runtime.id).toBe(victim.publicId)
      expect((await service.status(attackerId))?.runtime.id).toBe(attacker.publicId)
    })

    it('drops stale search within one Runtime while retaining an independent same-named archive', async () => {
      const f = await fixture(), victim = await f.user(), attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      const archiveId = await service.syncSnapshot({
        rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 3, title: 'v3',
        search: [{ sessionId: 'owned-root', seq: 0, role: 'user', content: 'current-body', occurredAt: 1 }],
      })
      const otherId = await service.syncSnapshot({ rootSessionId: 'owned-root', runtime: runtimeOf(attacker), syncRevision: 9, title: 'Other' })
      expect(await service.syncSnapshot({ rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 4, title: 'v4' })).toBe(archiveId)
      expect(await service.syncSnapshot({ rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 2, title: 'stale',
        search: [{ sessionId: 'owned-root', seq: 1, role: 'user', content: 'stale-body', occurredAt: 2 }],
      })).toBe(archiveId)
      expect(await service.status(archiveId)).toMatchObject({ title: 'v4', runtime: { id: victim.publicId } })
      expect(await service.status(otherId)).toMatchObject({ title: 'Other', runtime: { id: attacker.publicId } })
      expect((await pool.query('SELECT content FROM harness.conversation_archive_search WHERE archive_id=$1 ORDER BY event_seq', [archiveId])).rows).toEqual([{ content: 'current-body' }])
    })

    it('backfills a same-owner personal root and child that have no session rows', async () => {
      const f = await fixture()
      const owner = await f.user()
      const service = new ConversationArchiveService(f.context)
      await service.syncRuntimeSnapshot(snapshot(runtimeOf(owner), {
        revision: 2,
        archivedSessionIds: ['p-root', 'p-child'],
        sessions: [
          { sessionId: 'p-root', header: {}, title: 'Root' },
          { sessionId: 'p-child', header: { parentSession: 'p-root' }, title: 'Child' },
        ],
        search: [{ sessionId: 'p-child', seq: 0, role: 'user', content: 'child body', occurredAt: 5 }],
      }), runtimeOf(owner))
      // Children fold into their derived root's single archive record.
      const rows = await pool.query<{ root_session_id: string; runtime_kind: string; runtime_public_id: string }>(
        `SELECT root_session_id,runtime_kind,runtime_public_id::text
         FROM harness.conversation_archive_records WHERE organization_id=$1 ORDER BY root_session_id`, [f.organizationId])
      expect(rows.rows).toEqual([
        { root_session_id: 'p-root', runtime_kind: 'user', runtime_public_id: String(owner.publicId) },
      ])
      const search = await pool.query(
        `SELECT content FROM harness.conversation_archive_search WHERE organization_id=$1`, [f.organizationId])
      expect(search.rows.map((row: { content: string }) => row.content)).toEqual(['child body'])
    })

    it('rejects a stored own child whose declared parent derives a false root', async () => {
      const f = await fixture()
      const owner = await f.user()
      const service = new ConversationArchiveService(f.context)
      await pool.query(`INSERT INTO harness.conversation_sessions(
        id,organization_id,creator_user_id,session_format_version,created_at,updated_at,visibility,root_session_id)
        VALUES('real-root',$1,$2,3,now(),now(),'personal','real-root'),
              ('child-1',$1,$2,3,now(),now(),'personal','real-root')`, [f.organizationId, owner.uuid])
      await expect(service.syncRuntimeSnapshot(snapshot(runtimeOf(owner), {
        archivedSessionIds: ['child-1'],
        sessions: [{ sessionId: 'child-1', header: { parentSession: 'fake-root' } }],
      }), runtimeOf(owner))).rejects.toThrow('incorrect lineage root')
    })

    it('serializes overlapping projections of one Runtime into one identity and the newest revision', async () => {
      const f = await fixture(), owner = await f.user()
      const first = new ConversationArchiveService({ ...f.context, pool: lane('same-runtime-first') })
      const second = new ConversationArchiveService({ ...f.context, pool: lane('same-runtime-second') })
      const ids = await Promise.all([first.syncSnapshot({ rootSessionId: 'race-root', runtime: runtimeOf(owner), syncRevision: 1, title: 'v1' }),
        second.syncSnapshot({ rootSessionId: 'race-root', runtime: runtimeOf(owner), syncRevision: 2, title: 'v2' })])
      expect(ids[0]).toBe(ids[1])
      expect(await first.status(ids[0]!)).toMatchObject({ title: 'v2' })
      expect((await pool.query('SELECT sync_revision::text FROM harness.conversation_archive_records WHERE archive_id=$1', [ids[0]])).rows).toEqual([{ sync_revision: '2' }])
    })

    it('keeps a first projection purged when another transaction commits its tombstone before the insert', async () => {
      const f = await fixture(), owner = await f.user(), administrator = await f.user('admin')
      const entered = gate(), resume = gate(), firstPool = lane('purged-first-projection')
      const restores: Array<() => void> = []
      firstPool.on('connect', client => {
        const queryable: Queryable = client, query = queryable.query.bind(queryable)
        const spy = vi.spyOn(queryable, 'query').mockImplementation(async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
          if (sql.startsWith('INSERT INTO harness.conversation_archive_records(')) { entered.release(); await resume.passed }
          return query<R>(sql, values)
        })
        restores.push(() => spy.mockRestore())
      })
      const first = new ConversationArchiveService({ ...f.context, pool: firstPool })
      const pending = first.syncSnapshot({ rootSessionId: 'first-purged', runtime: runtimeOf(owner), syncRevision: 1,
        search: [{ sessionId: 'first-purged', seq: 0, role: 'user', content: 'Stale private body', occurredAt: 1 }] })
      void pending.catch(() => { entered.release() })
      const winner = new ConversationArchiveService(f.context)
      let archiveId: Awaited<typeof pending> | undefined
      try {
        await entered.passed
        archiveId = await winner.syncSnapshot({ rootSessionId: 'first-purged', runtime: runtimeOf(owner), syncRevision: 2 })
        await winner.purge(archiveId, administrator.publicId); await winner.settle(archiveId, administrator.publicId)
      } finally {
        resume.release(); await Promise.allSettled([pending])
        for (const restore of restores) restore()
      }
      expect(await pending).toBe(archiveId)
      expect(await winner.status(archiveId!)).toMatchObject({ state: 'purged', syncState: 'synced' })
      expect((await pool.query('SELECT content FROM harness.conversation_archive_search WHERE archive_id=$1', [archiveId])).rows).toEqual([])
      expect((await pool.query("SELECT action FROM harness.conversation_archive_commands WHERE archive_id=$1 AND status='pending'", [archiveId])).rows).toEqual([{ action: 'purge' }])
    })

    it('delivers and acknowledges pending commands only to the owning runtime', async () => {
      const f = await fixture()
      const victim = await f.user()
      const attacker = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      await service.syncRuntimeSnapshot(snapshot(runtimeOf(victim), {
        archivedSessionIds: ['victim-purge'],
        sessions: [{ sessionId: 'victim-purge', header: {} }],
      }), runtimeOf(victim))
      const archiveId = (await service.adminList({ state: 'all' }))[0]!.archiveId
      await service.setState(archiveId, 'trash', admin.publicId)
      await service.purge(archiveId, admin.publicId)
      const pending = (await pool.query<{ id: string }>(
        `SELECT id FROM harness.conversation_archive_commands
         WHERE organization_id=$1 AND archive_id=$2 AND status='pending'`, [f.organizationId, archiveId])).rows[0]
      expect(pending).toBeDefined()
      const foreign = await service.acknowledgeCommand(pending!.id, 2, undefined, runtimeOf(attacker))
      expect(foreign).toBe(false)
      expect(await service.hasPendingCommands(runtimeOf(attacker))).toBe(false)
      expect(await service.hasPendingCommands(runtimeOf(victim))).toBe(true)
      expect((await pool.query(
        `SELECT status FROM harness.conversation_archive_commands WHERE id=$1`, [pending!.id])).rows[0])
        .toEqual({ status: 'pending' })
      expect((await pool.query(
        `SELECT count(*)::int count FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='victim-purge'`, [f.organizationId])).rows[0]!.count).toBe(1)
    })

    it('treats archive search needles as literal text and stays inside the organization', async () => {
      const f = await fixture()
      const owner = await f.user()
      const service = new ConversationArchiveService(f.context)
      const seed = (root: string, title: string, body?: string) => service.syncSnapshot({
        rootSessionId: root, runtime: runtimeOf(owner), syncRevision: 1, title, messageCount: 1,
        ...(body === undefined ? {} : {
          search: [{ sessionId: root, seq: 0, role: 'user' as const, content: body, occurredAt: 1 }],
        }),
      })
      await seed('t-percent', '99% sure')
      await seed('t-plain', 'plain other')
      await seed('t-underscore', 'flat title', 'under_score body')
      await seed('t-backslash', 'C:\\temp')
      const titles = async (query: string) =>
        (await service.adminList({ query, limit: 20 })).map(row => row.rootSessionId).sort()
      expect(await titles('%')).toEqual(['t-percent'])
      expect(await titles('under_score')).toEqual(['t-underscore'])
      expect(await titles('C:\\temp')).toEqual(['t-backslash'])
      expect(await titles('plain')).toEqual(['t-plain'])

      const other = await fixture()
      const otherOwner = await other.user()
      const otherService = new ConversationArchiveService(other.context)
      await otherService.syncSnapshot({
        rootSessionId: 't-percent', runtime: runtimeOf(otherOwner), syncRevision: 1, title: '99% sure',
        messageCount: 1,
      })
      expect((await service.adminList({ query: '%', limit: 20 })).map(row => row.rootSessionId))
        .toEqual(['t-percent'])
    })
  })

  describe('document project authority', () => {
    const catalog = (context: PostgresRuntimeContext) => new PostgresDocumentCatalogService(context)
    const document = { docId: 'd1', name: 'spec.md', bytes: 10, mediaType: 'text/markdown', modifiedAt: 1 }

    /** Read the real catalog through the shipped admin handler with controlled authentication. */
    async function documentHttp(service: PostgresDocumentCatalogService, actorId: number, catalogId: string, indexState?: 'missing') {
      const root = await mkdtemp(join(tmpdir(), 'hgw-document-lifecycle-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const db = openDb(join(root, 'gateway.sqlite'))
      cleanup.push(() => { db.close() })
      const cfg = testConfig(root)
      const instances = new InstanceManager(db, cfg)
      cleanup.push(() => instances.stopAll())
      const handler = createAdminApiHandler({
        cfg, auth: new AuthService(db, cfg), users: new UserService(db, cfg),
        projects: new ProjectService(db, cfg), audit: new AuditService(db), instances, documents: service,
      })
      const actor: UserRow = { id: actorId, username: 'admin', displayName: 'Admin', role: 'admin',
        status: 'active', mustChangePassword: false, autoReviewEligible: false, homePath: root }
      const server = createServer((request, response) => {
        void handler(request, response, actor, new URL(request.url ?? '/', 'http://gateway').pathname, '')
          .then(handled => { if (!handled) { response.writeHead(404); response.end() } })
          .catch(() => { response.writeHead(500); response.end() })
      })
      await new Promise<void>((ready, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); ready() })
      })
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((ready, reject) => server.close(error => { if (error) reject(error); else ready() }))
      })
      const response = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/admin/api/documents/${catalogId}`)
      expect(response.status).toBe(200)
      const detail = await response.json() as { document: { state: string }; history: readonly { eventKind: string }[] }
      if (indexState === undefined) return { ...detail, index: undefined }
      const index = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/admin/api/documents?state=${indexState}`)
      expect(index.status).toBe(200)
      return { ...detail, index: await index.json() as readonly { catalogId: string; state: string }[] }
    }

    it('retains renewed trash when retention cleanup waits on its row', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      await service.markDeleted(admin.publicId, scope, document.docId)
      const catalogId = (await pool.query<{ id: string }>(`UPDATE harness.document_catalog
        SET purge_after=clock_timestamp()-interval '1 day' WHERE organization_id=$1 RETURNING id`, [f.organizationId])).rows[0]!.id
      const blocker = await pool.connect()
      let clearing: Promise<number> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        clearing = new PostgresDocumentCatalogService({ ...f.context, pool: lane('document-retention') }).purgeDue()
        await waitForBlockedOrSettled(laneName('document-retention'), ['tuple', 'transactionid'], clearing)
        await blocker.query(`UPDATE harness.document_catalog SET purge_after=clock_timestamp()+interval '30 days' WHERE id=$1`, [catalogId])
        await blocker.query('COMMIT')
        expect(await clearing).toBe(0)
        const detail = await documentHttp(service, admin.publicId, catalogId)
        await expect(['# Document retention after a row wait', '', `state=${detail.document.state}`,
          `history=${detail.history.map(item => item.eventKind).join(',')}`, '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/documents/retention-row-wait.expected.md'))
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (clearing !== undefined) await Promise.allSettled([clearing])
      }
    })

    it.for(['delete', 'replace', 'purge', 'copy'] as const)('preserves a committed lifecycle transition during queued %s', async kind => {
      const f = await fixture()
      const admin = await f.user('admin')
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document, { ...document, docId: 'source', name: 'source.md' }] })
      if (kind === 'purge') await service.markDeleted(admin.publicId, scope, document.docId)
      const catalogId = (await pool.query<{ id: string }>(`SELECT id FROM harness.document_catalog
        WHERE organization_id=$1 AND runtime_doc_id=$2`, [f.organizationId, document.docId])).rows[0]!.id
      const contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane(`document-${kind}`) })
      const blocker = await pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        switch (kind) {
          case 'delete': changed = contender.markDeleted(admin.publicId, scope, document.docId); break
          case 'replace': changed = contender.sync({ actorUserId: admin.publicId, scope, documents: [], replace: true }); break
          case 'purge': changed = contender.markPurged(admin.publicId, scope, document.docId); break
          case 'copy': changed = contender.recordCopy({ actorUserId: admin.publicId, source: scope, targetScope: scope,
            sourceDocId: 'source', sourceName: 'source.md', target: document }); break
        }
        await waitForBlockedOrSettled(laneName(`document-${kind}`), ['tuple', 'transactionid'], changed)
        if (kind === 'replace') await blocker.query(`INSERT INTO harness.document_catalog(
          organization_id,scope_kind,scope_user_id,runtime_doc_id,name,bytes,media_type,modified_at_ms,owner_user_id,owner_source,node_id)
          SELECT organization_id,scope_kind,scope_user_id,'concurrent','concurrent.md',bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,node_id FROM harness.document_catalog WHERE id=$1`, [catalogId])
        if (kind === 'purge') {
          await blocker.query(`UPDATE harness.document_catalog SET state='active',deleted_at=NULL,trashed_at=NULL,
            trashed_by_user_id=NULL,purge_after=NULL,restored_at=clock_timestamp() WHERE id=$1`, [catalogId])
        } else {
          await blocker.query(`UPDATE harness.document_catalog SET state='purged',purged_at=clock_timestamp(),purge_after=NULL WHERE id=$1`, [catalogId])
        }
        await blocker.query('COMMIT')
        if (kind === 'copy') await expect(changed).rejects.toMatchObject({ code: 'DOCUMENT_TARGET_CONFLICT', status: 409 })
        else await changed
        const detail = await documentHttp(service, admin.publicId, catalogId)
        expect(detail.document.state).toBe(kind === 'purge' ? 'active' : 'purged')
        if (kind === 'replace') expect((await service.overview(admin.publicId)).documents)
          .toEqual(expect.arrayContaining([expect.objectContaining({ docId: 'concurrent', state: 'active' })]))
        await expect([`# Document ${kind} after a row wait`, '', `state=${detail.document.state}`,
          `history=${detail.history.map(item => item.eventKind).join(',')}`,
          ...(kind === 'replace' ? ['concurrentRegistration=active'] : []), '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/documents/${kind}-row-wait.expected.md`))
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it('records a copy while a concurrent history writer retains its target key', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document, { ...document, docId: 'source', name: 'source.md' }] })
      const catalogId = (await pool.query<{ id: string }>(`SELECT id FROM harness.document_catalog
        WHERE organization_id=$1 AND runtime_doc_id=$2`, [f.organizationId, document.docId])).rows[0]!.id
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.document_catalog WHERE id=$1 FOR KEY SHARE', [catalogId])
        const result = await service.recordCopy({ actorUserId: admin.publicId, source: scope, targetScope: scope,
          sourceDocId: 'source', sourceName: 'source.md', target: { ...document, name: 'copied.md' } })
        expect(result.targetCatalogId).toBe(catalogId)
        expect((await service.detail(catalogId))?.document).toMatchObject({ name: 'copied.md', state: 'active' })
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      }
    })

    it('retires unidentified legacy trash when the private importer registers its exact action', async () => {
      const f = await fixture(), admin = await f.user('admin'), service = catalog(f.context)
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      await service.markDeleted(admin.publicId, scope, document.docId)
      const previous = (await service.adminList({ state: 'trash' }))[0]!
      const rootId = randomUUID(), incarnationId = randomUUID(), trashId = randomUUID()
      await service.project(admin.publicId, scope, { rootId, after: { sequence: 0, ordinal: 0 }, head: { sequence: 1, ordinal: 1 },
        next: { sequence: 1, ordinal: 1 }, hasMore: false, changes: [{ cursor: { sequence: 1, ordinal: 1 },
          previous: { sequence: 0, ordinal: 0 }, action: 'adopt', committedAt: 10, document: {
            incarnationId, revision: 1, origin: 'legacy', state: 'trash', docId: document.docId,
            bytes: document.bytes, mediaType: document.mediaType, modifiedAt: document.modifiedAt,
            trash: { trashId, docId: document.docId, trashedAt: 10, purgeAfter: 20 },
          } }] })
      const current = await service.adminList({ state: 'trash' })
      expect(current).toHaveLength(1)
      expect(current[0]).toMatchObject({ identity: { incarnationId, revision: 1 }, trashId })
      const retired = await documentHttp(service, admin.publicId, previous.catalogId, 'missing')
      expect(retired.document.state).toBe('missing')
      expect(retired.index).toEqual([expect.objectContaining({ catalogId: previous.catalogId, state: 'missing' })])
      await expect(['# Imported document trash', '', 'legacy.state=missing', `trash.count=${String(current.length)}`,
        `action.selected=${String(current[0]!.trashId === trashId)}`, `missing.index.count=${String(retired.index!.length)}`,
        `history=${retired.history.map(item => item.eventKind).join(',')}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'expected/documents/legacy-trash-import.expected.md'))
    })

    it('locks a complete projection batch before catalog updates wait on administrator lifecycle changes', async () => {
      const f = await fixture(), admin = await f.user('admin'), service = catalog(f.context)
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const documents = ['a', 'b'].map(docId => ({ ...document, docId, name: `${docId}.md`, identity: {
        incarnationId: randomUUID(), revision: 1, origin: 'upload' as const, createdBy: `user:${String(admin.publicId)}`,
      } }))
      await service.sync({ actorUserId: admin.publicId, scope, documents })
      const rows = await pool.query<{ id: string; runtime_doc_id: string }>(
        'SELECT id,runtime_doc_id FROM harness.document_catalog WHERE organization_id=$1 ORDER BY id', [f.organizationId])
      const ordered = rows.rows.map(row => documents.find(item => item.docId === row.runtime_doc_id)!)
      const rootId = randomUUID(), contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane('document-projection-batch') })
      await contender.projectionCursor(admin.publicId, scope, rootId)
      const blocker = await pool.connect()
      let projecting: Promise<unknown> | undefined, changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [rows.rows[1]!.id])
        projecting = contender.project(admin.publicId, scope, { rootId, after: { sequence: 0, ordinal: 0 },
          head: { sequence: 2, ordinal: 1 }, next: { sequence: 2, ordinal: 1 }, hasMore: false,
          changes: ordered.map((item, index) => ({ cursor: { sequence: index + 1, ordinal: 1 },
            previous: index === 0 ? { sequence: 0, ordinal: 0 } : { sequence: index, ordinal: 1 },
            action: index === 0 ? 'trash' : 'observe', committedAt: 10 + index, document: { ...item.identity, revision: 2,
              state: index === 0 ? 'trash' : 'active', docId: item.docId,
              bytes: item.bytes + index, mediaType: item.mediaType, modifiedAt: item.modifiedAt + index,
              ...(index === 0 ? { trash: { trashId: randomUUID(), docId: item.docId, trashedAt: 10, purgeAfter: 20 } } : {}) } })) })
        await waitForBlockedOrSettled(laneName('document-projection-batch'), ['tuple', 'transactionid'], projecting)
        changed = (async () => {
          await blocker.query(`UPDATE harness.document_catalog SET state='trash',trash_action_id=gen_random_uuid(),
            runtime_revision=runtime_revision+1 WHERE id=$1`, [rows.rows[1]!.id])
          await blocker.query('COMMIT')
        })()
        await Promise.all([projecting, changed])
        const detail = await documentHttp(service, admin.publicId, rows.rows[1]!.id)
        expect(detail.document.state).toBe('trash')
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        await Promise.allSettled([projecting, changed])
      }
    })

    it('keeps delayed copy lineage on its exact incarnations after path reuse and ownership transfer', async () => {
      const f = await fixture(), admin = await f.user('admin'), uploader = await f.user(), peer = await f.user()
      const project = await f.project({ owner: admin.uuid, members: [
        { user: uploader.uuid, mode: 'rw' }, { user: peer.uuid, mode: 'rw' },
      ] })
      const service = catalog(f.context), scope = { kind: 'project' as const, projectId: project.publicId }
      const source = { ...document, docId: 'source', name: 'source.md', identity: {
        incarnationId: randomUUID(), revision: 1, origin: 'upload' as const, createdBy: `user:${String(uploader.publicId)}`,
      } }
      const target = { ...document, docId: 'target', name: 'target.md', identity: {
        incarnationId: randomUUID(), revision: 1, origin: 'upload' as const, createdBy: `user:${String(uploader.publicId)}`,
      } }
      await service.sync({ actorUserId: uploader.publicId, scope, documents: [source, target] })
      const before = await service.adminList({ projectId: project.publicId })
      const sourceId = before.find(row => row.docId === source.docId)!.catalogId
      const targetId = before.find(row => row.docId === target.docId)!.catalogId
      await service.transferOwnership(admin.publicId, targetId, peer.publicId)
      for (const prior of [source, target]) {
        const trashId = randomUUID()
        await service.markDeletedBatch(admin.publicId, scope, [{ docId: prior.docId,
          incarnationId: prior.identity.incarnationId, revision: 2, trashId, state: 'trash' }])
        await service.markDeletedBatch(admin.publicId, scope, [{ docId: prior.docId,
          incarnationId: prior.identity.incarnationId, revision: 3, trashId, state: 'purged' }])
      }
      const replacements = [source, target].map(prior => ({ ...prior, bytes: 20, identity: { ...prior.identity,
        incarnationId: randomUUID(), createdBy: `user:${String(peer.publicId)}` } }))
      await service.sync({ actorUserId: peer.publicId, scope, documents: replacements })

      const copied = await service.recordCopy({ actorUserId: uploader.publicId, source: scope, targetScope: scope,
        sourceDocId: source.docId, sourceIdentity: source.identity, sourceName: source.name, target })
      expect(copied.targetCatalogId).toBe(targetId)
      expect((await service.detail(targetId))?.document).toMatchObject({ state: 'purged',
        owner: { id: peer.publicId }, identity: { incarnationId: target.identity.incarnationId, revision: 3 } })
      expect((await service.overview(peer.publicId)).documents).toEqual(expect.arrayContaining(replacements.map(current =>
        expect.objectContaining({ docId: current.docId, state: 'active', owner: { id: peer.publicId, displayName: expect.any(String) },
          identity: { incarnationId: current.identity.incarnationId, revision: 1 } }))))
      expect((await pool.query<{ source_catalog_id: string; target_catalog_id: string }>(`SELECT source_catalog_id,target_catalog_id
        FROM harness.document_operation_items WHERE organization_id=$1 AND operation_id=$2`,
      [f.organizationId, copied.operationId])).rows).toEqual([{ source_catalog_id: sourceId, target_catalog_id: targetId }])
      await expect(service.recordCopy({ actorUserId: uploader.publicId, source: scope, targetScope: scope,
        sourceDocId: source.docId, sourceName: source.name, target: { ...document, docId: target.docId } }))
        .rejects.toMatchObject({ code: 'DOCUMENT_TARGET_CONFLICT', status: 409 })
    })

    it('records only committed trash and purge transitions', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      const catalogId = (await pool.query<{ id: string }>(`SELECT id FROM harness.document_catalog
        WHERE organization_id=$1`, [f.organizationId])).rows[0]!.id
      await service.markPurged(admin.publicId, scope, document.docId)
      await service.markDeleted(admin.publicId, scope, document.docId)
      await service.markDeleted(admin.publicId, scope, document.docId)
      await service.markPurged(admin.publicId, scope, document.docId)
      await service.markPurged(admin.publicId, scope, document.docId)
      await service.markDeleted(admin.publicId, scope, document.docId)
      const detail = await documentHttp(service, admin.publicId, catalogId)
      expect(detail.document.state).toBe('purged')
      expect(detail.history.map(item => item.eventKind)).toEqual(['purged', 'deleted', 'created'])
      await expect(['# Committed document lifecycle', '', `state=${detail.document.state}`,
        `history=${detail.history.map(item => item.eventKind).join(',')}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/documents/committed-lifecycle.expected.md'))
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      expect((await service.detail(catalogId))?.document.state).toBe('purged')
    })

    it('purges expired trash once and leaves active metadata available', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const scope = { kind: 'personal' as const, userId: admin.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document, { ...document, docId: 'keep' }] })
      await service.markDeleted(admin.publicId, scope, document.docId)
      await pool.query(`UPDATE harness.document_catalog SET purge_after=clock_timestamp()-interval '1 day'
        WHERE organization_id=$1 AND runtime_doc_id=$2`, [f.organizationId, document.docId])
      expect(await service.purgeDue()).toBe(1)
      expect(await service.purgeDue()).toBe(0)
      expect((await service.overview(admin.publicId)).documents.map(item => item.docId)).toEqual(['keep'])
    })

    it('commits a runtime batch removal alongside a document lifecycle writer without a lock cycle', async () => {
      // Heap scans update one document before reaching the blocked row,
      // making the document/revision lock cycle deterministic.
      const f = await createExecutionFixture(pool, { documentCatalogPool: lane('batch-removal-http', '-c enable_indexscan=off -c enable_bitmapscan=off') })
      cleanup.push(f.dispose); fixtureOrganizations.add(f.organizationId)
      const service = catalog(f.context), scope = { kind: 'project' as const, projectId: f.project.id }
      await service.sync({ actorUserId: f.admin.id, scope, documents: [
        { ...document, docId: 'a' }, { ...document, docId: 'z' },
      ] })
      const rows = (await pool.query<{ id: string; runtime_doc_id: string }>(`SELECT id,runtime_doc_id FROM harness.document_catalog
        WHERE organization_id=$1 ORDER BY ctid`, [f.organizationId])).rows
      const locked = rows.at(-1)!
      const blocker = await pool.connect()
      let removed: Promise<Response> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [locked.id])
        removed = fetch(`${f.base}/internal/runtime/documents/catalog/sync`, { method: 'POST', headers: f.headers(f.project, f.admin),
          body: JSON.stringify({ version: 1, documents: [], removed: ['a', 'z', 'concurrent'] }) })
        await waitForBlockedOrSettled(laneName('batch-removal-http'), ['tuple', 'transactionid'], removed)
        await service.sync({ actorUserId: f.admin.id, scope, documents: [{ ...document, docId: 'concurrent' }] })
        const single = await blocker.query(`UPDATE harness.document_catalog SET state='trash',trash_action_id=gen_random_uuid(),
          runtime_revision=runtime_revision+1,deleted_at=clock_timestamp(),
          trashed_at=clock_timestamp(),trashed_by_user_id=$2,purge_after=clock_timestamp()+interval '30 days'
          WHERE id=$1`, [locked.id, f.admin.uuid]).then(() => ({ ok: true as const }), (error: unknown) => ({ error }))
        if ('error' in single) await blocker.query('ROLLBACK')
        else {
          await blocker.query(`INSERT INTO harness.document_history(organization_id,catalog_id,actor_user_id,event_kind,detail)
            VALUES($1,$2,$3,'deleted','{"reason":"runtime"}')`, [f.organizationId, locked.id, f.admin.uuid])
          await blocker.query('COMMIT')
        }
        expect(single).toEqual({ ok: true })
        const response = await removed
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ version: 1, accepted: 0 })
        const states = (await pool.query<{ runtime_doc_id: string; state: string }>(`SELECT runtime_doc_id,state
          FROM harness.document_catalog WHERE organization_id=$1 ORDER BY runtime_doc_id`, [f.organizationId])).rows
        expect(states).toEqual([{ runtime_doc_id: 'a', state: 'trash' }, { runtime_doc_id: 'concurrent', state: 'active' }, { runtime_doc_id: 'z', state: 'trash' }])
        const detail = await Promise.all(rows.map(row => service.detail(row.id)))
        expect(detail.map(item => item?.history.map(row => row.eventKind))).toEqual([['deleted', 'created'], ['deleted', 'created']])
        await expect(['# Runtime batch removal and a concurrent lifecycle writer', '', `httpStatus=${String(response.status)}`,
          ...states.map(row => `${row.runtime_doc_id}=${row.state}`),
          ...detail.map(item => `${item?.document.docId}.history=${item?.history.map(row => row.eventKind).join(',')}`), '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/documents/batch-removal-lock-order.expected.md'))
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (removed !== undefined) await Promise.allSettled([removed])
      }
    })

    it.for((['sync', 'delete', 'batch-delete', 'purge'] as const).flatMap(kind =>
      [...(['account', 'membership', 'write-mode', 'organization'] as const).map(revoked => ({ kind, revoked, scopeKind: 'project' as const })),
        ...(['account', 'membership', 'organization'] as const).map(revoked => ({ kind, revoked, scopeKind: 'personal' as const }))]))(
      'rechecks $scopeKind $revoked revocation after a catalog row wait for $kind', async ({ kind, revoked, scopeKind }) => {
      const f = await fixture(), admin = await f.user('admin'), actor = await f.user()
      const project = await f.project({ createdBy: admin.uuid, members: [{ user: actor.uuid, mode: 'rw' }] })
      const scope = scopeKind === 'personal' ? { kind: 'personal' as const, userId: actor.publicId }
        : { kind: 'project' as const, projectId: project.publicId }
      const service = catalog(f.context)
      await service.sync({ actorUserId: actor.publicId, scope, documents: [document], ownerSource: 'upload' })
      if (kind === 'purge') await service.markDeleted(actor.publicId, scope, document.docId)
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1',
        [f.organizationId])).rows[0]!.id
      const label = `doc-${scopeKind}-${kind}-${revoked}`
      const contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane(label) })
      const blocker = await pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        switch (kind) {
          case 'sync': changed = contender.sync({ actorUserId: actor.publicId, scope, documents: [{ ...document, name: 'forbidden.md' }] }); break
          case 'delete': changed = contender.markDeleted(actor.publicId, scope, document.docId); break
          case 'batch-delete': changed = contender.markDeletedBatch(actor.publicId, scope, [document.docId]); break
          case 'purge': changed = contender.markPurged(actor.publicId, scope, document.docId); break
        }
        await waitForBlockedOrSettled(laneName(label), ['tuple', 'transactionid'], changed)
        if (revoked === 'account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [actor.uuid])
        else if (revoked === 'membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [actor.uuid])
        else if (revoked === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
        else await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1 AND user_id=$2", [project.uuid, actor.uuid])
        await blocker.query('COMMIT')
        await expect(changed).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
        const detail = await service.detail(catalogId)
        expect(detail?.document).toMatchObject({ name: document.name, state: kind === 'purge' ? 'trash' : 'active' })
        expect(detail?.history.map(item => item.eventKind)).toEqual(kind === 'purge' ? ['deleted', 'created'] : ['created'])
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it.for((['trash', 'restore', 'purge'] as const).flatMap(action =>
      (['role', 'account', 'membership', 'organization'] as const).map(revoked => ({ action, revoked }))))(
      'rechecks administrator $revoked after a catalog row wait for $action', async ({ action, revoked }) => {
      const f = await fixture(), admin = await f.user('admin'), service = catalog(f.context)
      await service.sync({ actorUserId: admin.publicId, scope: { kind: 'personal', userId: admin.publicId }, documents: [document] })
      if (action !== 'trash') await service.markDeleted(admin.publicId, { kind: 'personal', userId: admin.publicId }, document.docId)
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1', [f.organizationId])).rows[0]!.id
      const label = `doc-admin-${action}-${revoked}`
      const contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane(label) })
      const blocker = await pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        switch (action) {
          case 'trash': changed = contender.adminTrash(admin.publicId, catalogId); break
          case 'restore': changed = contender.adminRestore(admin.publicId, catalogId); break
          case 'purge': changed = contender.adminPurge(admin.publicId, catalogId); break
        }
        await waitForBlockedOrSettled(laneName(label), ['tuple', 'transactionid'], changed)
        if (revoked === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [admin.uuid])
        else if (revoked === 'account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [admin.uuid])
        else if (revoked === 'membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [admin.uuid])
        else await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
        await blocker.query('COMMIT')
        await expect(changed).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
        expect((await service.detail(catalogId))?.document.state).toBe(action === 'trash' ? 'active' : 'trash')
        expect((await pool.query('SELECT id FROM harness.document_operations WHERE organization_id=$1', [f.organizationId])).rowCount).toBe(0)
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it.for(['actor-account', 'actor-membership', 'target-account', 'target-membership', 'target-project-membership'] as const)(
      'rechecks ownership transfer %s after a catalog row wait', async (revoked) => {
      const f = await fixture(), actor = await f.user('admin'), target = await f.user()
      const project = await f.project({ createdBy: actor.uuid, members: [{ user: target.uuid, mode: 'rw' }] })
      const scope = { kind: 'project' as const, projectId: project.publicId }, service = catalog(f.context)
      await service.sync({ actorUserId: actor.publicId, scope, documents: [document], ownerSource: 'upload' })
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1', [f.organizationId])).rows[0]!.id
      const label = `transfer-${revoked}`, contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane(label) })
      const blocker = await pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        changed = contender.transferOwnership(actor.publicId, catalogId, target.publicId)
        await waitForBlockedOrSettled(laneName(label), ['tuple', 'transactionid'], changed)
        switch (revoked) {
          case 'actor-account': await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [actor.uuid]); break
          case 'actor-membership': await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [actor.uuid]); break
          case 'target-account': await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [target.uuid]); break
          case 'target-membership': await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [target.uuid]); break
          case 'target-project-membership':
            await pool.query('DELETE FROM harness.project_members WHERE project_id=$1 AND user_id=$2', [project.uuid, target.uuid]); break
        }
        await blocker.query('COMMIT')
        await expect(changed).rejects.toMatchObject({ status: revoked === 'target-project-membership' ? 409 : 403 })
        expect((await pool.query<{ owner_user_id: string }>('SELECT owner_user_id FROM harness.document_catalog WHERE id=$1', [catalogId]))
          .rows[0]!.owner_user_id).toBe(actor.uuid)
        expect((await service.detail(catalogId))?.history.map(item => item.eventKind)).toEqual(['created'])
        expect((await pool.query('SELECT id FROM harness.document_operations WHERE organization_id=$1', [f.organizationId])).rowCount).toBe(0)
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it.for(['administrator', 'owner'] as const)('transfers ownership for a currently eligible %s', async role => {
      const f = await fixture(), actor = await f.user(role === 'administrator' ? 'admin' : 'member'), target = await f.user()
      const project = await f.project({ createdBy: actor.uuid, ...(role === 'owner' ? { owner: actor.uuid } : {}),
        members: [{ user: actor.uuid, mode: 'rw' }, { user: target.uuid, mode: 'rw' }] })
      const service = catalog(f.context)
      await service.sync({ actorUserId: actor.publicId, scope: { kind: 'project', projectId: project.publicId }, documents: [document] })
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1', [f.organizationId])).rows[0]!.id
      await service.transferOwnership(actor.publicId, catalogId, target.publicId)
      const detail = await service.detail(catalogId)
      expect(detail?.document.owner?.id).toBe(target.publicId)
      expect(detail?.history.map(item => item.eventKind)).toEqual(['ownership-transferred', 'created'])
    })

    it('refuses a queued administrator document action through authenticated Gateway HTTP after demotion', async () => {
      const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'hgw-document-authority-http-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      await f.user('admin')
      const cfg = testConfig(root), users = new PostgresUserService(f.context, cfg)
      const admin = await users.create({ username: 'document-admin', password: 'correct-password', role: 'admin' })
      await users.changeOwnPassword(admin.id, 'correct-password')
      const service = catalog(f.context)
      await service.sync({ actorUserId: admin.id, scope: { kind: 'personal', userId: admin.id }, documents: [document] })
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1', [f.organizationId])).rows[0]!.id
      const contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane('document-http-demotion') })
      const instances = new InstanceManager(new PostgresInstanceRepository(f.context, cfg.instancePortBase), cfg)
      cleanup.push(() => instances.stopAll())
      const deps: GatewayDeps = { cfg, users, instances, projects: new PostgresProjectService(f.context, cfg),
        auth: new PostgresAuthService(f.context, cfg), audit: new PostgresAuditService(f.context), documents: contender }
      const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
      await new Promise<void>((ready, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); ready() })
      })
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((ready, reject) => server.close(error => { if (error) reject(error); else ready() }))
      })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: admin.username, password: 'correct-password' }) })
      expect(signedIn.status).toBe(302)
      const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]; await signedIn.arrayBuffer()
      if (cookie === undefined) throw new Error('Document fixture did not receive a login cookie')
      const blocker = await pool.connect()
      let changed: Promise<Response> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        changed = fetch(`${base}/admin/api/documents/actions`, { method: 'POST',
          headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'trash', ids: [catalogId] }) })
        await waitForBlockedOrSettled(laneName('document-http-demotion'), ['tuple', 'transactionid'], changed)
        await users.setRole(admin.id, 'user')
        await blocker.query('COMMIT')
        const response = await changed
        expect(response.status).toBe(200)
        const result = await response.json() as { action: string; results: Array<{ ok: boolean; error: string }> }
        expect(result).toMatchObject({ action: 'trash', results: [{ ok: false, error: 'An active administrator is required.' }] })
        const detail = await service.detail(catalogId)
        expect(detail?.document.state).toBe('active')
        expect(detail?.history.map(item => item.eventKind)).toEqual(['created'])
        await expect(['# Administrator document action after demotion', '', `httpStatus=${String(response.status)}`,
          `action=${result.action}`, `succeeded=${String(result.results[0]!.ok)}`, `error=${result.results[0]!.error}`,
          `catalogState=${detail?.document.state}`, `history=${detail?.history.map(item => item.eventKind).join(',')}`, '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/documents/admin-demotion-row-wait.expected.md'))
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it.for((['unqualified-administrator', 'qualified-member', 'stale-project-member'] as const).flatMap(eligibility =>
      (['overview', 'history', 'authorize', 'sync'] as const).map(operation => ({ eligibility, operation }))))(
      'refuses Steward document $operation for $eligibility', async ({ eligibility, operation }) => {
        const f = await fixture(), steward = await f.user('admin')
        const actor = await f.user(eligibility === 'unqualified-administrator' ? 'admin' : 'member')
        const project = await f.project()
        await pool.query("UPDATE harness.projects SET kind='steward' WHERE id=$1", [project.uuid])
        await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,user_id,enabled,revision,node_id)
          VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))`, [f.organizationId, steward.uuid])
        if (eligibility === 'qualified-member') await pool.query(`INSERT INTO harness.steward_access_policies(
          organization_id,user_id,enabled,revision,node_id) VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))`, [f.organizationId, actor.uuid])
        if (eligibility === 'stale-project-member') await pool.query(`INSERT INTO harness.project_members(
          organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')`, [f.organizationId, project.uuid, actor.uuid])
        const service = catalog(f.context), scope = { kind: 'project' as const, projectId: project.publicId }
        await service.sync({ actorUserId: steward.publicId, scope, documents: [document] })
        switch (operation) {
          case 'overview': {
            const overview = await service.overview(actor.publicId)
            expect(overview.documents).toEqual([])
            expect(overview.totalDocuments).toBe(0)
            expect(overview.metrics).toMatchObject({ total: 0, active: 0, project: 0, bytes: 0 })
            break
          }
          case 'history': await expect(service.history(actor.publicId, scope))
            .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 }); break
          case 'authorize': await expect(service.authorize({ actorUserId: actor.publicId, scope, action: 'delete', docIds: [document.docId] }))
            .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 }); break
          case 'sync': await expect(service.sync({ actorUserId: actor.publicId, scope, documents: [document] }))
            .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 }); break
        }
      },
    )

    it('admits a qualified Steward administrator without a project membership', async () => {
      const f = await fixture(), actor = await f.user('admin'), project = await f.project()
      await pool.query("UPDATE harness.projects SET kind='steward' WHERE id=$1", [project.uuid])
      await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,user_id,enabled,revision,node_id)
        VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))`, [f.organizationId, actor.uuid])
      const service = catalog(f.context), scope = { kind: 'project' as const, projectId: project.publicId }
      const incarnationId = randomUUID()
      await service.sync({ actorUserId: actor.publicId, scope, documents: [{ ...document,
        identity: { incarnationId, revision: 1, origin: 'legacy' } }] })
      expect((await service.overview(actor.publicId)).documents).toMatchObject([{ docId: document.docId, scope: { mode: 'rw' } }])
      expect((await service.history(actor.publicId, scope)).map(item => item.eventKind)).toEqual(['created'])
      await expect(service.authorize({ actorUserId: actor.publicId, scope, action: 'delete', docIds: [document.docId] }))
        .resolves.toEqual({ allowed: true, selections: [{ docId: document.docId, incarnationId, revision: 1, state: 'active' }] })
    })

    it.for(['sync', 'delete', 'batch-delete', 'purge'] as const)('rechecks Steward qualification after a %s row wait', async kind => {
      const f = await fixture(), actor = await f.user('admin'), project = await f.project()
      await pool.query("UPDATE harness.projects SET kind='steward' WHERE id=$1", [project.uuid])
      await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,user_id,enabled,revision,node_id)
        VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))`, [f.organizationId, actor.uuid])
      const service = catalog(f.context), scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({ actorUserId: actor.publicId, scope, documents: [document] })
      if (kind === 'purge') await service.markDeleted(actor.publicId, scope, document.docId)
      const catalogId = (await pool.query<{ id: string }>('SELECT id FROM harness.document_catalog WHERE organization_id=$1',
        [f.organizationId])).rows[0]!.id
      const label = `steward-${kind}`, contender = new PostgresDocumentCatalogService({ ...f.context, pool: lane(label) })
      const blocker = await pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.document_catalog WHERE id=$1 FOR UPDATE', [catalogId])
        switch (kind) {
          case 'sync': changed = contender.sync({ actorUserId: actor.publicId, scope, documents: [{ ...document, name: 'forbidden.md' }] }); break
          case 'delete': changed = contender.markDeleted(actor.publicId, scope, document.docId); break
          case 'batch-delete': changed = contender.markDeletedBatch(actor.publicId, scope, [document.docId]); break
          case 'purge': changed = contender.markPurged(actor.publicId, scope, document.docId); break
        }
        await waitForBlockedOrSettled(laneName(label), ['tuple', 'transactionid'], changed)
        await pool.query('UPDATE harness.steward_access_policies SET enabled=false,revision=revision+1 WHERE user_id=$1', [actor.uuid])
        await blocker.query('COMMIT')
        await expect(changed).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
        const detail = await service.detail(catalogId)
        expect(detail?.document).toMatchObject({ name: document.name, state: kind === 'purge' ? 'trash' : 'active' })
        expect(detail?.history.map(item => item.eventKind)).toEqual(kind === 'purge' ? ['deleted', 'created'] : ['created'])
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        if (changed !== undefined) await Promise.allSettled([changed])
      }
    })

    it.for(['administrator', 'member'] as const)(
      'omits archived project documents from the %s overview', async role => {
        const f = await fixture(), actor = await f.user(role === 'administrator' ? 'admin' : 'member')
        const project = await f.project({ members: [{ user: actor.uuid, mode: 'rw' }] })
        const service = catalog(f.context), scope = { kind: 'project' as const, projectId: project.publicId }
        await service.sync({ actorUserId: actor.publicId, scope, documents: [document] })
        await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [project.uuid])
        const overview = await service.overview(actor.publicId)
        expect(overview.documents).toEqual([])
        expect(overview.totalDocuments).toBe(0)
        expect(overview.metrics).toMatchObject({ total: 0, active: 0, project: 0, bytes: 0 })
      },
    )

    it('projects current Steward qualification through authenticated runtime HTTP metadata', async () => {
      const f = await createExecutionFixture(pool)
      cleanup.push(f.dispose); fixtureOrganizations.add(f.organizationId)
      await pool.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2', [f.organizationId, f.project.uuid])
      await pool.query("UPDATE harness.projects SET kind='steward' WHERE id=$1", [f.project.uuid])
      await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,user_id,enabled,revision,node_id)
        VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1)),($1,$3,false,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))`, [f.organizationId, f.admin.uuid, f.peer.uuid])
      const service = catalog(f.context)
      await service.sync({ actorUserId: f.admin.id, scope: { kind: 'project', projectId: f.project.id }, documents: [{ ...document, docId: 'steward' }] })
      await service.sync({ actorUserId: f.peer.id, scope: { kind: 'personal', userId: f.peer.id }, documents: [{ ...document, docId: 'personal' }] })
      const transcript = ['# Steward document metadata admission', '']
      const observe = async (label: string): Promise<void> => {
        const response = await fetch(`${f.base}/internal/runtime/documents/catalog/overview`, { headers: f.headers(f.peerPersonal, f.peer) })
        expect(response.status).toBe(200)
        const result = await response.json() as { documents: Array<{ docId: string }>; totalDocuments: number; metrics: { bytes: number } }
        transcript.push(`${label}: documents=${result.documents.map(item => item.docId).sort().join(',')}; total=${String(result.totalDocuments)}; bytes=${String(result.metrics.bytes)}`)
        const history = await fetch(`${f.base}/internal/runtime/documents/catalog/history`, { headers: f.headers(f.project, f.peer) })
        const body = await history.json() as { items?: unknown[] }
        transcript.push(`${label}: historyStatus=${String(history.status)}; events=${String(body.items?.length ?? 0)}`)
      }
      await observe('unqualified-administrator')
      await pool.query('UPDATE harness.steward_access_policies SET enabled=true,revision=revision+1 WHERE user_id=$1', [f.peer.uuid])
      await observe('qualified-administrator')
      await pool.query('UPDATE harness.steward_access_policies SET enabled=false,revision=revision+1 WHERE user_id=$1', [f.peer.uuid])
      await observe('revoked-qualification')
      await pool.query('UPDATE harness.steward_access_policies SET enabled=true,revision=revision+1 WHERE user_id=$1', [f.peer.uuid])
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.peer.uuid])
      await observe('demoted-with-stale-grant')
      await pool.query("UPDATE harness.memberships SET role='admin' WHERE user_id=$1", [f.peer.uuid])
      await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.project.uuid])
      const archived = await fetch(`${f.base}/internal/runtime/documents/catalog/overview`, { headers: f.headers(f.peerPersonal, f.peer) })
      expect(archived.status).toBe(200)
      const archivedBody = await archived.json() as { documents: Array<{ docId: string }>; metrics: { total: number } }
      transcript.push(`archived-project: documents=${archivedBody.documents.map(item => item.docId).join(',')}; total=${String(archivedBody.metrics.total)}`)
      await expect([...transcript, ''].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/documents/steward-metadata-admission.expected.md'))
    })

    it('denies a demoted historical creator overview, history, sync, authorize, and transfer', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const demoted = await f.user()
      const owner = await f.user()
      const project = await f.project({
        createdBy: demoted.uuid,
        owner: owner.uuid,
        members: [{ user: owner.uuid, mode: 'rw' }],
      })
      const service = catalog(f.context)
      const scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({
        actorUserId: admin.publicId, scope, documents: [document],
      })
      const catalogId = (await pool.query<{ id: string }>(
        `SELECT id FROM harness.document_catalog WHERE organization_id=$1 AND runtime_doc_id='d1'`,
        [f.organizationId])).rows[0]!.id

      const overview = await service.overview(demoted.publicId, { limit: 50 })
      expect(overview.documents).toEqual([])
      await expect(service.history(demoted.publicId, scope)).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.sync({ actorUserId: demoted.publicId, scope, documents: [document] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.authorize({ actorUserId: demoted.publicId, scope, action: 'delete', docIds: ['d1'] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.transferOwnership(demoted.publicId, catalogId, owner.publicId))
        .rejects.toMatchObject({ code: 'DOCUMENT_OWNERSHIP_FORBIDDEN', status: 403 })
    })

    it('refuses every project operation without an active organization membership', async () => {
      const f = await fixture()
      const member = await f.user()
      const owner = await f.user()
      const admin = await f.user('admin')
      const project = await f.project({ owner: owner.uuid, members: [{ user: member.uuid, mode: 'rw' }] })
      const service = catalog(f.context)
      const scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      const catalogId = (await pool.query<{ id: string }>(
        `SELECT id FROM harness.document_catalog WHERE organization_id=$1 AND runtime_doc_id='d1'`,
        [f.organizationId])).rows[0]!.id
      // The actor keeps an active user row and an rw project membership; only the
      // organization membership is disabled.
      await pool.query(`UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2`,
        [f.organizationId, member.uuid])
      await expect(service.overview(member.publicId, { limit: 50 }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.history(member.publicId, scope)).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.sync({ actorUserId: member.publicId, scope, documents: [document] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.authorize({ actorUserId: member.publicId, scope, action: 'delete', docIds: ['d1'] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.transferOwnership(member.publicId, catalogId, owner.publicId))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      // A missing membership row fails closed the same way.
      await pool.query(`UPDATE harness.memberships SET status='active' WHERE organization_id=$1 AND user_id=$2`,
        [f.organizationId, member.uuid])
      await pool.query(`DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2`,
        [f.organizationId, member.uuid])
      await expect(service.overview(member.publicId, { limit: 50 }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.sync({ actorUserId: member.publicId, scope, documents: [document] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.transferOwnership(member.publicId, catalogId, owner.publicId))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
    })

    it('keeps a historical creator with a read-only membership at read-only', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const creator = await f.user()
      const project = await f.project({
        createdBy: creator.uuid,
        members: [{ user: creator.uuid, mode: 'ro' }],
      })
      const service = catalog(f.context)
      const scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      const overview = await service.overview(creator.publicId, { limit: 50 })
      expect(overview.documents.map(row => ({ docId: row.docId, mode: row.scope.mode })))
        .toEqual([{ docId: 'd1', mode: 'ro' }])
      await expect(service.authorize({ actorUserId: creator.publicId, scope, action: 'delete', docIds: ['d1'] }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.markDeleted(creator.publicId, scope, 'd1'))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
    })

    it('lets a current admin and the protected project owner keep authority', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const owner = await f.user()
      const member = await f.user()
      const project = await f.project({
        owner: owner.uuid,
        members: [{ user: owner.uuid, mode: 'rw' }, { user: member.uuid, mode: 'rw' }],
      })
      const service = catalog(f.context)
      const scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document] })
      const catalogId = (await pool.query<{ id: string }>(
        `SELECT id FROM harness.document_catalog WHERE organization_id=$1 AND runtime_doc_id='d1'`,
        [f.organizationId])).rows[0]!.id
      // A former creator (no project_members row) is never a valid recipient.
      const former = await f.user()
      await expect(service.transferOwnership(admin.publicId, catalogId, former.publicId))
        .rejects.toMatchObject({ code: 'DOCUMENT_OWNER_NOT_MEMBER', status: 409 })
      await service.transferOwnership(admin.publicId, catalogId, member.publicId)
      await service.transferOwnership(owner.publicId, catalogId, owner.publicId)
      const ownerRow = (await pool.query<{ owner_user_id: string }>(
        `SELECT owner_user_id::text FROM harness.document_catalog WHERE id=$1`, [catalogId])).rows[0]!
      expect(ownerRow.owner_user_id).toBe(owner.uuid)
    })

    it('answers the metadata-overview handler without same-name projects from another organization', async () => {
      const f = await fixture()
      const member = await f.user()
      const shared = `shared-${randomUUID().slice(0, 8)}`
      const home = await f.project({ name: shared, members: [{ user: member.uuid, mode: 'rw' }] })
      const service = catalog(f.context)
      await service.sync({
        actorUserId: member.publicId,
        scope: { kind: 'project', projectId: home.publicId },
        documents: [document],
      })
      const foreign = await fixture()
      const outsider = await foreign.user()
      const foreignProject = await foreign.project({ name: shared, members: [{ user: outsider.uuid, mode: 'rw' }] })
      const foreignService = catalog(foreign.context)
      await foreignService.sync({
        actorUserId: outsider.publicId,
        scope: { kind: 'project', projectId: foreignProject.publicId },
        documents: [document],
      })

      const handlers = createDocumentCatalogHandlers(service)
      const principal: GatewayPrincipalClaims = {
        version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: f.context.organizationSlug,
        user: { id: member.publicId, username: 'member', displayName: 'Member', role: 'user' },
        scope: { kind: 'personal' },
        runtime: { kind: 'user', id: member.publicId, generation: 1 },
        issuedAt: 0, expiresAt: 0, nonce: 'n',
      }
      const result = await handlers.overview({
        subject: { organizationId: f.organizationId, target: { kind: 'user', id: member.publicId }, generation: 1 },
        principal,
        options: { limit: 50 },
      }) as { documents: readonly { scope: { id?: number }; docId: string }[] }
      expect(result.documents).toEqual([expect.objectContaining({ docId: 'd1', scope: expect.objectContaining({ id: home.publicId }) })])

      const demoted = await f.user()
      const denied = await handlers.overview({
        subject: { organizationId: f.organizationId, target: { kind: 'user', id: demoted.publicId }, generation: 1 },
        principal: { ...principal, user: { ...principal.user, id: demoted.publicId } },
        options: { limit: 50 },
      }) as { documents: readonly unknown[] }
      expect(denied.documents).toEqual([])
    })

    it('refuses every read-only project sync shape without touching rows or history', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const reader = await f.user()
      const project = await f.project({ members: [{ user: reader.uuid, mode: 'ro' }] })
      const service = catalog(f.context)
      const scope = { kind: 'project' as const, projectId: project.publicId }
      await service.sync({ actorUserId: admin.publicId, scope, documents: [document, { ...document, docId: 'trash-me', name: 'trash-me.md' }] })
      await service.markDeleted(admin.publicId, scope, 'trash-me')
      const counts = async () => (await pool.query<{ catalog: string; history: string }>(
        `SELECT (SELECT count(*)::text FROM harness.document_catalog WHERE organization_id=$1) catalog,
                (SELECT count(*)::text FROM harness.document_history WHERE organization_id=$1) history`,
        [f.organizationId])).rows[0]!
      const before = await counts()
      const attempts = [
        // Insert new rows.
        { actorUserId: reader.publicId, scope, documents: [{ ...document, docId: 'new', name: 'new.md' }] },
        // Alter an active row.
        { actorUserId: reader.publicId, scope, documents: [{ ...document, name: 'renamed.md' }] },
        // Restore a trashed row.
        { actorUserId: reader.publicId, scope, documents: [{ ...document, docId: 'trash-me', name: 'trash-me.md' }] },
        // Reconcile missing rows out of the catalog.
        { actorUserId: reader.publicId, scope, documents: [document], replace: true },
      ]
      for (const attempt of attempts) {
        await expect(service.sync(attempt)).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      }
      await expect(service.markDeleted(reader.publicId, scope, 'd1'))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      await expect(service.markDeletedBatch(reader.publicId, scope, ['d1', 'trash-me']))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      expect(await counts()).toEqual(before)
      const rows = await pool.query<{ runtime_doc_id: string; name: string; state: string }>(
        `SELECT runtime_doc_id,name,state FROM harness.document_catalog
         WHERE organization_id=$1 ORDER BY runtime_doc_id`, [f.organizationId])
      expect(rows.rows).toEqual([
        { runtime_doc_id: 'd1', name: 'spec.md', state: 'active' },
        { runtime_doc_id: 'trash-me', name: 'trash-me.md', state: 'trash' },
      ])
    })

    it('refuses a read-only member through the runtime catalog sync handler but admits rw and admin', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const reader = await f.user()
      const writer = await f.user()
      const project = await f.project({ members: [{ user: reader.uuid, mode: 'ro' }, { user: writer.uuid, mode: 'rw' }] })
      const service = catalog(f.context)
      const handlers = createDocumentCatalogHandlers(service)
      const subject = { organizationId: f.organizationId, target: { kind: 'project' as const, id: project.publicId }, generation: 1 }
      const principalFor = (publicId: number): GatewayPrincipalClaims => ({
        version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: f.context.organizationSlug,
        user: { id: publicId, username: 'member', displayName: 'Member', role: 'user' },
        scope: { kind: 'personal' },
        runtime: { kind: 'project', id: project.publicId, generation: 1 },
        issuedAt: 0, expiresAt: 0, nonce: 'n',
      })
      const payload = { version: 1, replace: true, source: 'legacy', documents: [
        { docId: 'd1', name: 'alpha.md', bytes: 1, mediaType: 'text/markdown', modifiedAt: 1 },
      ] }
      // The sync refusal lands before any removed-id processing.
      await expect(handlers.sync({ subject, principal: principalFor(reader.publicId), payload: { ...payload, removed: ['missing'] } }))
        .rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
      expect((await pool.query(`SELECT 1 FROM harness.document_catalog WHERE organization_id=$1`, [f.organizationId])).rows).toEqual([])
      await expect(handlers.sync({ subject, principal: principalFor(writer.publicId), payload }))
        .resolves.toMatchObject({ version: 1, accepted: 1 })
      await expect(handlers.sync({ subject, principal: principalFor(admin.publicId), payload }))
        .resolves.toMatchObject({ version: 1, accepted: 1 })
    })

    it('treats document names as literal text in overview search', async () => {
      const f = await fixture()
      const member = await f.user()
      const project = await f.project({ members: [{ user: member.uuid, mode: 'rw' }] })
      const service = catalog(f.context)
      await service.sync({
        actorUserId: member.publicId,
        scope: { kind: 'project', projectId: project.publicId },
        documents: [
          { docId: 'a', name: 'under_score.md', bytes: 1, mediaType: 'text/markdown', modifiedAt: 1 },
          { docId: 'b', name: 'underXscore.md', bytes: 1, mediaType: 'text/markdown', modifiedAt: 1 },
          { docId: 'c', name: '100%real.md', bytes: 1, mediaType: 'text/markdown', modifiedAt: 1 },
        ],
      })
      const names = async (query: string) =>
        (await service.overview(member.publicId, { query, limit: 50 })).documents.map(row => row.name).sort()
      expect(await names('under_score')).toEqual(['under_score.md'])
      expect(await names('100%')).toEqual(['100%real.md'])
      expect(await names('under')).toEqual(['underXscore.md', 'under_score.md'])
    })
  })

  describe('desktop coordinator PostgreSQL locks', () => {
    it('lets two per-resource transactions proceed while the coordinator-wide sweep waits', async () => {
      const f = await fixture()
      const repoA = new PostgresDesktopCoordinatorRepository({ ...f.context, pool: lane('desktop-a') })
      const repoB = new PostgresDesktopCoordinatorRepository({ ...f.context, pool: lane('desktop-b') })
      const repoAll = new PostgresDesktopCoordinatorRepository({ ...f.context, pool: lane('desktop-all') })
      const entered = gate(), hold = gate()
      const settled: Promise<unknown>[] = []
      try {
        const first = repoA.transact('res-a', async () => { entered.release(); await hold.passed; return 'a' })
        settled.push(first)
        await Promise.race([entered.passed, first.then(() => undefined, cause => { throw cause })])
        const second = repoB.transact('res-b', async () => 'b')
        settled.push(second)
        await expect(second).resolves.toBe('b')
        const sweep = repoAll.transactAll(async () => 'swept')
        settled.push(sweep)
        await waitForBlockedOrSettled(laneName('desktop-all'), ['advisory'], sweep)
        hold.release()
        await expect(sweep).resolves.toBe('swept')
        await expect(first).resolves.toBe('a')
      } finally {
        hold.release()
        await Promise.allSettled(settled)
      }
    })

    it('blocks a per-resource transaction while the coordinator-wide sweep holds its lock', async () => {
      const f = await fixture()
      const repoA = new PostgresDesktopCoordinatorRepository({ ...f.context, pool: lane('desktop-one') })
      const repoAll = new PostgresDesktopCoordinatorRepository({ ...f.context, pool: lane('desktop-sweep') })
      const entered = gate(), hold = gate()
      const settled: Promise<unknown>[] = []
      try {
        const sweep = repoAll.transactAll(async () => { entered.release(); await hold.passed; return 'swept' })
        settled.push(sweep)
        await Promise.race([entered.passed, sweep.then(() => undefined, cause => { throw cause })])
        const resource = repoA.transact('res-a', async () => 'a')
        settled.push(resource)
        await waitForBlockedOrSettled(laneName('desktop-one'), ['advisory'], resource)
        hold.release()
        await expect(resource).resolves.toBe('a')
        await expect(sweep).resolves.toBe('swept')
      } finally {
        hold.release()
        await Promise.allSettled(settled)
      }
    })
  })

  describe('webhook runtime targeting', () => {
    const cipher = new WebhookSecretCipher(randomBytes(32))
    const input = (f: Fixture, executionUserId: number, over: Record<string, unknown> = {}) => ({
      name: `hook-${randomUUID().slice(0, 8)}`, provider: 'github', source: 'acme',
      events: ['push'], actions: [], repositories: [],
      titleTemplate: 'Push {{payload.ref}}', promptTemplate: 'Review {{payload.after}}',
      workspacePath: '/tmp/workspace', agentPreset: 'default', permissionPreset: 'default',
      executionUserId,
      runtimeKind: 'user', runtimePublicId: executionUserId,
      intakeLimit: 100, intakeWindowMs: 60_000, replayWindowMs: 86_400_000, maxBodyBytes: 1_048_576,
      secret: 'whsec-test-key',
      ...over,
    })

    it('refuses a user runtime target that is not the execution account, without a revision bump', async () => {
      const f = await fixture()
      const admin = await f.user('admin')
      const executor = await f.user()
      const other = await f.user()
      const project = await f.project()
      const service = new PostgresWebhookEndpointService(f.context, cipher)
      await expect(service.create(admin.publicId, input(f, executor.publicId, { runtimePublicId: other.publicId })))
        .rejects.toMatchObject({ status: 400 })
      expect((await pool.query('SELECT count(*)::int count FROM harness.webhook_endpoints WHERE organization_id=$1',
        [f.organizationId])).rows[0]).toEqual({ count: 0 })

      const sameUser = await service.create(admin.publicId, input(f, executor.publicId))
      expect(sameUser.runtimeKind).toBe('user')
      const projectTarget = await service.create(admin.publicId,
        input(f, executor.publicId, { runtimeKind: 'project', runtimePublicId: project.publicId }))
      expect(projectTarget.runtimeKind).toBe('project')

      const { secret: _secret, ...fields } = input(f, executor.publicId, { runtimePublicId: other.publicId })
      await expect(service.update({ targetId: sameUser.publicId, revision: sameUser.revision, fields }, admin.publicId))
        .rejects.toMatchObject({ status: 400 })
      const stored = await service.list(admin.publicId)
      expect(stored.find(row => row.publicId === sameUser.publicId)).toMatchObject({ revision: '1', runtimePublicId: executor.publicId })
    })
  })

  describe('admin query id validation', () => {
    const adminRow: UserRow = {
      id: 1, username: 'boss', displayName: 'Boss', role: 'admin',
      status: 'active', mustChangePassword: false, autoReviewEligible: false, homePath: '/tmp/boss',
    }

    async function server() {
      const root = await mkdtemp(join(tmpdir(), 'hgw-admin-query-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const db = openDb(join(root, 'gateway.sqlite'))
      cleanup.push(() => { db.close() })
      const cfg = testConfig(root)
      const deps: GatewayDeps = {
        cfg,
        auth: new AuthService(db, cfg),
        users: new UserService(db, cfg),
        projects: new ProjectService(db, cfg),
        audit: new AuditService(db),
        instances: new InstanceManager(db, cfg),
        governance: new ModelGovernanceService(db),
      }
      const lookups = {
        users: vi.spyOn(deps.users, 'getById'),
        projects: vi.spyOn(deps.projects, 'getById'),
      }
      const handler = createAdminApiHandler(deps)
      const server = createServer((req, res) => {
        void (async () => {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          if (!await handler(req, res, adminRow, pathname, '')) {
            res.writeHead(404); res.end()
          }
        })().catch(() => { res.writeHead(500); res.end() })
      })
      await new Promise<void>(ready => { server.listen(0, '127.0.0.1', ready) })
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((closed, reject) => { server.close(error => { if (error) reject(error); else closed() }) })
      })
      return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, lookups }
    }

    it('returns 400 for malformed ids before any lookup and 404 for valid missing ids', async () => {
      const { base, lookups } = await server()
      const cases = [
        `/admin/api/model-access?userId=abc`,
        `/admin/api/model-access?userId=1.5`,
        `/admin/api/model-access?userId=0`,
        `/admin/api/model-access?userId=-2`,
        `/admin/api/model-access?userId=Infinity`,
        `/admin/api/model-access?userId=9007199254740993`,
        `/admin/api/model-access`,
        `/admin/api/model-access?userId=`,
        `/admin/api/project-model-access?projectId=abc`,
        `/admin/api/project-model-access?projectId=0`,
        `/admin/api/usage?userId=xyz`,
        `/admin/api/usage?userId=1e3`,
        `/admin/api/usage?projectId=0.5`,
        `/admin/api/usage?projectId=-9`,
      ]
      for (const path of cases) {
        const response = await fetch(`${base}${path}`)
        expect(response.status, path).toBe(400)
      }
      expect(lookups.users).not.toHaveBeenCalled()
      expect(lookups.projects).not.toHaveBeenCalled()

      expect((await fetch(`${base}/admin/api/model-access?userId=424242`)).status).toBe(404)
      expect(lookups.users).toHaveBeenCalledTimes(1)
    })
  })

  describe('model governance role quotas', () => {
    it('reads stored role limits scoped to the organization, preserving zero and unlimited', async () => {
      const f = await fixture()
      const member = await f.user()
      const governance = new PostgresModelGovernanceService(f.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 19)))
      expect(await governance.roleQuota('user')).toEqual({ tokenLimit: null, companyCostMicrosLimit: null })
      await governance.setQuota('role', 'user', 0, 1_250_000)
      expect(await governance.roleQuota('user')).toEqual({ tokenLimit: 0, companyCostMicrosLimit: 1_250_000 })
      expect(await governance.roleQuota('admin')).toEqual({ tokenLimit: null, companyCostMicrosLimit: null })
      // User overrides keep their own storage and do not shadow the role read.
      await governance.setQuota('user', String(member.publicId), 999, null)
      expect(await governance.roleQuota('user')).toEqual({ tokenLimit: 0, companyCostMicrosLimit: 1_250_000 })
      // Another organization's role row stays isolated.
      const foreign = await fixture()
      const foreignGovernance = new PostgresModelGovernanceService(foreign.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 19)))
      expect(await foreignGovernance.roleQuota('user')).toEqual({ tokenLimit: null, companyCostMicrosLimit: null })
    })
  })

  describe('model governance account deletion', () => {
    async function registerModel(f: Fixture, governance: PostgresModelGovernanceService): Promise<string> {
      cleanup.push(async () => { await pool.query(`DELETE FROM harness.model_prices WHERE model_id IN (
        SELECT id FROM harness.model_catalog WHERE organization_id=$1)`, [f.organizationId]) })
      await governance.upsertProvider({ provider: 'org-deletion', displayName: 'Deletion', driver: 'pi-ai', protocol: 'openai-completions',
        baseURL: 'https://deletion.example.test/v1', authMode: 'none', status: 'draft' })
      await governance.upsertModel({ provider: 'org-deletion', model: 'review', displayName: 'Review', enabled: true,
        inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
      return (await pool.query<{ id: string }>('SELECT id FROM harness.model_catalog WHERE organization_id=$1', [f.organizationId])).rows[0]!.id
    }

    it.each([
      ['model-access', 'model_user_access'], ['intake-token', 'model_intake_tokens'], ['quota', 'user_quotas'],
    ] as const)('does not recreate %s after concurrent account cleanup', async (kind, table) => {
      const f = await fixture(), member = await f.user(), root = await mkdtemp(join(tmpdir(), 'hgw-model-deletion-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const mutating = lane(`account-${kind}`), deleting = lane(`delete-${kind}`)
      const governance = new PostgresModelGovernanceService({ ...f.context, pool: mutating }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 19)))
      const users = new PostgresUserService({ ...f.context, pool: deleting }, testConfig(root))
      await registerModel(f, governance)
      const name = `audit_model_${randomUUID().replaceAll('-', '')}`, barrier = randomUUID(), blocker = await pool.connect()
      let changed: Promise<unknown> | undefined, deleted: Promise<unknown> | undefined, deletionFinished = false
      try {
        await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0])); RETURN NEW; END $$`)
        await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON harness.${table}
          FOR EACH ROW WHEN (NEW.user_id='${member.uuid}'::uuid) EXECUTE FUNCTION harness.${name}('${barrier}')`)
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [barrier])
        const run = {
          'model-access': () => governance.setUserAccess(member.publicId, 'org-deletion', 'review', true),
          'intake-token': () => governance.issueIntakeToken({ kind: 'user', id: member.publicId }),
          quota: () => governance.setQuota('user', String(member.publicId), 100, 100),
        }
        changed = run[kind]().catch((error: unknown) => error)
        await waitForBlockedOrSettled(laneName(`account-${kind}`), ['advisory'], changed)
        deleted = users.remove(member.publicId).then(value => { deletionFinished = true; return value }, (error: unknown) => { deletionFinished = true; return error })
        await expect.poll(async () => deletionFinished || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity d JOIN pg_stat_activity m ON m.application_name=$1
          WHERE d.application_name=$2 AND m.pid=ANY(pg_blocking_pids(d.pid))) blocked`,
        [laneName(`account-${kind}`), laneName(`delete-${kind}`)])).rows[0]!.blocked).toBe(true)
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        await Promise.all([changed, deleted])
        await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.${table}`)
        await pool.query(`DROP FUNCTION IF EXISTS harness.${name}()`)
      }
      expect(await changed).not.toBeInstanceOf(Error)
      expect(await deleted).toBe(true)
      expect.soft((await pool.query(`SELECT 1 FROM harness.${table} WHERE user_id=$1`, [member.uuid])).rowCount).toBe(0)
      if (kind === 'intake-token') {
        const token = await changed
        expect(typeof token).toBe('string')
        if (typeof token !== 'string') throw new Error('Intake token fixture did not return a token')
        expect(await governance.subjectForIntakeToken(token)).toBeNull()
        await pool.query('INSERT INTO harness.model_intake_tokens(user_id,token_hash) VALUES($1,$2)',
          [member.uuid, createHash('sha256').update(token).digest()])
        const server = createUsageIntakeServer(governance)
        try {
          await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
          const response = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/usage`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ eventId: randomUUID(), occurredAt: Date.now(), provider: 'org-deletion', model: 'review', purpose: 'chat',
              credentialSource: 'organization', credentialClass: 'company', status: 'succeeded', usage: { inputTokens: 1 } }),
          })
          await response.arrayBuffer()
          expect(response.status).toBe(400)
          await expect('# Deleted account model intake\n\nnewTokenAfterCleanup=revoked\nunprovedLegacyUsageStatus=400\n')
            .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/model-governance/deleted-account-intake.expected.md'))
        } finally {
          server.closeAllConnections()
          await new Promise<void>(closed => server.close(() => { closed() }))
        }
      }
    })

    it('removes legacy deleted-account model configuration while retaining usage history', async () => {
      const f = await fixture(), member = await f.user(), current = await f.user()
      const root = await mkdtemp(join(tmpdir(), 'hgw-model-tombstone-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const users = new PostgresUserService(f.context, testConfig(root))
      const governance = new PostgresModelGovernanceService(f.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 19)))
      const modelId = await registerModel(f, governance)
      const token = randomBytes(32), eventId = randomUUID()
      await users.remove(member.publicId)
      await pool.query(`INSERT INTO harness.model_intake_tokens(user_id,token_hash) VALUES($1,$2),($3,$4)`,
        [member.uuid, createHash('sha256').update(token).digest(), current.uuid, randomBytes(32)])
      await pool.query('INSERT INTO harness.user_quotas(user_id) VALUES($1),($2)', [member.uuid, current.uuid])
      await pool.query(`INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed)
        VALUES($1,$2,$3,true),($1,$4,$3,false)`, [f.organizationId, member.uuid, modelId, current.uuid])
      await pool.query(`INSERT INTO harness.model_usage(event_id,organization_id,user_id,occurred_at,provider_key,model_key,purpose,credential_source,credential_class,status)
        VALUES($1,$2,$3,now(),'fixture','chat','chat','organization','company','succeeded')`, [eventId, f.organizationId, member.uuid])
      await pool.query(await readFile(resolve(import.meta.dirname, '../deploy/postgres/migrations/074_deleted_model_relationships.sql'), 'utf8'))
      for (const table of ['model_intake_tokens', 'user_quotas', 'model_user_access']) {
        expect((await pool.query(`SELECT 1 FROM harness.${table} WHERE user_id=$1`, [member.uuid])).rowCount).toBe(table === 'model_intake_tokens' ? 1 : 0)
        expect((await pool.query(`SELECT 1 FROM harness.${table} WHERE user_id=$1`, [current.uuid])).rowCount).toBe(1)
      }
      expect((await pool.query('SELECT 1 FROM harness.model_usage WHERE event_id=$1 AND organization_id=$2', [eventId, f.organizationId])).rowCount).toBe(1)
      expect(await users.isDeleted(member.publicId)).toBe(true)
    })
  })

  describe('empty draft eligibility', () => {
    const fixtureRuntimes = new Map<string, RuntimeId>()
    const fixtureRuntime = async (f: Fixture, userId: string, projectId?: string): Promise<RuntimeId> => {
      const key = JSON.stringify([f.organizationId, f.context.nodeId, userId, projectId])
      const known = fixtureRuntimes.get(key)
      if (known !== undefined) return known
      const rows = await pool.query<{ runtime_id: RuntimeId }>(`SELECT runtime_id FROM harness.instances
        WHERE organization_id=$1 AND assigned_node_id=$2
        AND (($3::uuid IS NOT NULL AND project_id=$3) OR ($3::uuid IS NULL AND project_id IS NULL AND user_id=$4))`,
      [f.organizationId, f.context.nodeId, projectId ?? null, userId])
      if (rows.rows.length !== 1) throw new Error('Draft fixture requires one explicit owner allocation')
      fixtureRuntimes.set(key, rows.rows[0]!.runtime_id)
      return rows.rows[0]!.runtime_id
    }
    const reviewed = (runtimeId: RuntimeId, roots: readonly string[]): ConversationSessionIdentity[] => roots.map(rootSessionId => ({ rootSessionId, runtimeId }))

    const insertSession = async (f: Fixture, session: {
      id: string
      creator: string
      project?: string
      root?: string
      parent?: string
      visible?: boolean
      status?: 'active' | 'closed' | 'deleted'
      updatedAtMs: number
    }) => pool.query(`INSERT INTO harness.conversation_sessions(
        id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,
        session_format_version,created_at,updated_at,visibility,status,has_visible_content,draft,runtime_id)
        VALUES($1,$2,$3,$4,$5,$6,3,to_timestamp($7/1000.0),to_timestamp($7/1000.0),$8,$9,$10,true,$11)`, [
      session.id, f.organizationId, session.creator, session.project ?? null,
      session.parent ?? null, session.root ?? session.id, session.updatedAtMs,
      session.project === undefined ? 'personal' : 'project',
      session.status ?? 'active', session.visible ?? false, await fixtureRuntime(f, session.creator, session.project),
    ])

    const reserveSession = async (f: Fixture, sessionId: string, userUuid: string, leaseMs = 3_600_000) => pool.query(
      `INSERT INTO harness.conversation_draft_reservations(
        organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,lease_expires_at,runtime_id)
        VALUES($1,'scope-1',$2,$3,$4,NULL,'/work','personal',to_timestamp($5/1000.0),$6)`,
      [f.organizationId, `draft-${sessionId}`, sessionId, userUuid, Date.now() + leaseMs, await fixtureRuntime(f, userUuid)])

    it('admits an old blank root, trashes it, and stays idempotent', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'blank-1', creator: owner.uuid, updatedAtMs: old })

      const preview = await service.previewEmptyDrafts({ olderThanMs: 3_600_000 })
      expect(preview.candidates.map(candidate => candidate.rootSessionId)).toEqual(['blank-1'])
      expect(await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['blank-1']), admin.publicId, preview.cutoff)).toEqual(reviewed(await fixtureRuntime(f, owner.uuid), ['blank-1']))
      const record = await pool.query<{ state: string; record_kind: string }>(
        `SELECT state,record_kind FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='blank-1'`, [f.organizationId])
      expect(record.rows[0]).toMatchObject({ state: 'trash', record_kind: 'empty-draft' })
      expect(await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['blank-1']), admin.publicId, preview.cutoff)).toEqual([])
    })

    it('returns a zero cutoff without candidates when the requested age exceeds the epoch', async () => {
      const f = await fixture()
      const owner = await f.user()
      const service = new ConversationArchiveService(f.context)
      await insertSession(f, { id: 'ancient', creator: owner.uuid, updatedAtMs: 0 })
      const preview = await service.previewEmptyDrafts({ olderThanMs: Date.now() + 3_600_000 })
      expect(preview).toEqual({ cutoff: 0, candidates: [] })
    })

    it('skips recent roots, roots touched after the preview cutoff, and foreign organizations', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'recent', creator: owner.uuid, updatedAtMs: Date.now() })
      await insertSession(f, { id: 'touched', creator: owner.uuid, updatedAtMs: old })

      const foreign = await fixture()
      const foreignOwner = await foreign.user()
      await insertSession(foreign, { id: 'foreign-root', creator: foreignOwner.uuid, updatedAtMs: old })

      const preview = await service.previewEmptyDrafts({ olderThanMs: 3_600_000 })
      expect(preview.candidates.map(candidate => candidate.rootSessionId)).toEqual(['touched'])
      // A fresh root is never admitted even when submitted directly.
      expect(await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['recent']), admin.publicId, preview.cutoff)).toEqual([])
      // Another organization's id cannot be cleaned through this actor.
      expect(await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['foreign-root']), admin.publicId, preview.cutoff)).toEqual([])
      // Activity between preview and submit revokes the preview's eligibility.
      await pool.query(`UPDATE harness.conversation_sessions SET updated_at=now()
        WHERE organization_id=$1 AND id='touched'`, [f.organizationId])
      expect(await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['touched']), admin.publicId, preview.cutoff)).toEqual([])
      // The stored preview cutoff, not a fresh one, governs the recheck.
      expect((await pool.query(`SELECT state FROM harness.conversation_archive_records
        WHERE organization_id=$1 AND root_session_id='touched'`, [f.organizationId])).rows[0]).toBeUndefined()
    })

    it('excludes trees with visible content, fresh descendants, or live leases', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'with-visible-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'visible-child', creator: owner.uuid, root: 'with-visible-child', parent: 'with-visible-child', visible: true, updatedAtMs: old })
      await insertSession(f, { id: 'with-fresh-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'fresh-child', creator: owner.uuid, root: 'with-fresh-child', parent: 'with-fresh-child', updatedAtMs: Date.now() })
      await insertSession(f, { id: 'leased-root', creator: owner.uuid, updatedAtMs: old })
      await reserveSession(f, 'leased-root', owner.uuid)
      await insertSession(f, { id: 'with-leased-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'leased-child', creator: owner.uuid, root: 'with-leased-child', parent: 'with-leased-child', updatedAtMs: old })
      await reserveSession(f, 'leased-child', owner.uuid)
      await insertSession(f, { id: 'expired-lease', creator: owner.uuid, updatedAtMs: old })
      await reserveSession(f, 'expired-lease', owner.uuid, -1_000)
      await insertSession(f, { id: 'with-deleted-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'deleted-child', creator: owner.uuid, root: 'with-deleted-child', parent: 'with-deleted-child', visible: true, status: 'deleted', updatedAtMs: old })

      const preview = await service.previewEmptyDrafts({ olderThanMs: 3_600_000 })
      expect(preview.candidates.map(candidate => candidate.rootSessionId).sort())
        .toEqual(['expired-lease', 'with-deleted-child'])
      const trashed = await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), [
        'with-visible-child', 'with-fresh-child', 'leased-root', 'with-leased-child', 'expired-lease', 'with-deleted-child',
      ]), admin.publicId, preview.cutoff)
      expect(trashed.map(item => item.rootSessionId).sort()).toEqual(['expired-lease', 'with-deleted-child'])
    })

    it('rejects reservations against trashed, deleted, or foreign-scope sessions and admits a fresh draft', async () => {
      const f = await fixture()
      const owner = await f.user()
      const outsider = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const repository = new ConversationRepository(pool, { organizationId: f.organizationId, runtimeId: await fixtureRuntime(f, owner.uuid) })
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'trash-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'deleted-root', creator: owner.uuid, status: 'deleted', updatedAtMs: old })
      await insertSession(f, { id: 'owned-root', creator: owner.uuid, updatedAtMs: old })
      await service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['trash-root']), admin.publicId)
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'user', id: owner.publicId })
      const input = (sessionId: string, userId = owner.uuid) => ({
        runtimeId: runtime.runtimeId!, organizationId: f.organizationId, scopeKey: 'scope-1', draftId: `draft-${sessionId}`,
        sessionId, userId, cwd: '/work', visibility: 'personal' as const,
      })
      await expect(repository.reserveDraft(input('trash-root')))
        .rejects.toThrow('invalid draft reservation: session is archived or unavailable')
      await expect(repository.reserveDraft(input('deleted-root')))
        .rejects.toThrow('invalid draft reservation: session is archived or unavailable')
      await expect(repository.reserveDraft(input('owned-root', outsider.uuid)))
        .rejects.toThrow('invalid draft reservation: session is archived or unavailable')
      const created = await repository.reserveDraft(input('new-draft'))
      expect(created.created).toBe(true)
      expect(created.sessionId).toBe('new-draft')
      const repeated = await repository.reserveDraft(input('new-draft'))
      expect(repeated.created).toBe(false)
    })

    it('returns one canonical identity to overlapping first draft reservations', async () => {
      const f = await fixture()
      const owner = await f.user()
      const inserted = gate()
      const commit = gate()
      const firstPool = lane('draft-first')
      const restore: Array<() => void> = []
      firstPool.on('connect', (client) => {
        const queryable: Queryable = client
        const query = queryable.query.bind(queryable)
        const spy = vi.spyOn(queryable, 'query').mockImplementation(async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
          const result = await query<R>(sql, values)
          if (sql.startsWith('INSERT INTO harness.conversation_draft_reservations(')) {
            inserted.release()
            await commit.passed
          }
          return result
        })
        restore.push(() => spy.mockRestore())
      })
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'user', id: owner.publicId })
      const input = {
        runtimeId: runtime.runtimeId!, organizationId: f.organizationId, scopeKey: 'same-scope', draftId: 'same-browser-draft',
        sessionId: 'first-session', userId: owner.uuid, cwd: '/work', visibility: 'personal' as const,
      }
      const first = new ConversationRepository(firstPool, { organizationId: f.organizationId, runtimeId: await fixtureRuntime(f, owner.uuid) }).reserveDraft(input)
      void first.catch(() => { inserted.release() })
      const pending: Array<Promise<unknown>> = [first]
      let second: ReturnType<ConversationRepository['reserveDraft']> | undefined
      try {
        await inserted.passed
        second = new ConversationRepository(lane('draft-second'), { organizationId: f.organizationId, runtimeId: await fixtureRuntime(f, owner.uuid) }).reserveDraft({ ...input, sessionId: 'second-session' })
        pending.push(second)
        void second.catch(() => {})
        await waitForBlockedOrSettled(laneName('draft-second'), ['advisory', 'tuple', 'transactionid'], second)
      } finally {
        commit.release()
        await Promise.allSettled(pending)
        for (const dispose of restore) dispose()
      }
      await expect(first).resolves.toMatchObject({ created: true, sessionId: 'first-session' })
      await expect(second).resolves.toMatchObject({ created: false, sessionId: 'first-session' })
      const stored = await pool.query<{ session_id: string }>(`SELECT session_id FROM harness.conversation_draft_reservations
        WHERE organization_id=$1 AND scope_key=$2 AND draft_id=$3`, [f.organizationId, input.scopeKey, input.draftId])
      expect(stored.rows).toEqual([{ session_id: 'first-session' }])
    })

    it('serializes reservation and cleanup on the session root lock', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService({ ...f.context, pool: lane('empty-trash') })
      const repository = new ConversationRepository(lane('reserve'), { organizationId: f.organizationId, runtimeId: await fixtureRuntime(f, owner.uuid) })
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'rc-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'cw-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'mv-root', creator: owner.uuid, updatedAtMs: old })

      // A reservation holding the root lock commits first: cleanup's recheck
      // sees the live lease and skips the root.
      const reserver = await pool.connect()
      cleanup.push(() => reserver.release())
      let trashOutcome: Promise<{ status: 'resolved', value: readonly ConversationSessionIdentity[] } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await reserver.query('BEGIN')
        await reserver.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='rc-root' FOR UPDATE`, [f.organizationId])
        await reserver.query(`INSERT INTO harness.conversation_draft_reservations(
          organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,lease_expires_at,runtime_id)
          VALUES($1,'scope-1','draft-rc','rc-root',$2,NULL,'/work','personal',now()+interval '1 hour',$3)`,
          [f.organizationId, owner.uuid, await fixtureRuntime(f, owner.uuid)])
        const trash = service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['rc-root']), admin.publicId)
        const settled = trash.then(
          value => ({ status: 'resolved' as const, value }),
          (cause: unknown) => ({ status: 'rejected' as const, cause }),
        )
        trashOutcome = settled
        await waitForBlockedOrSettled(laneName('empty-trash'), ['tuple', 'transactionid'], trash)
        await reserver.query('COMMIT')
        const outcome = await settled
        if (outcome.status === 'rejected') throw outcome.cause
        expect(outcome.value).toEqual([])
      } finally {
        await reserver.query('ROLLBACK').catch(() => {})
        await trashOutcome
      }

      // Cleanup holding the root lock commits the trash first: the reservation
      // that waited on the lock rejects the now-archived root.
      const cleaner = await pool.connect()
      cleanup.push(() => cleaner.release())
      const runtime = await new PostgresInstanceRepository(f.context, 48_000).resolveTarget({ kind: 'user', id: owner.publicId })
      let reserveOutcome: Promise<{ status: 'resolved' } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await cleaner.query('BEGIN')
        await cleaner.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='cw-root' FOR UPDATE`, [f.organizationId])
        await cleaner.query(`INSERT INTO harness.conversation_archive_records(
          organization_id,root_session_id,runtime_kind,runtime_public_id,state,sync_revision,sync_state,runtime_id,node_id)
          VALUES($1,'cw-root','user',$2,'trash',1,'synced',$3,$4)`, [f.organizationId, owner.publicId, runtime.runtimeId, f.context.nodeId])
        const reserve = repository.reserveDraft({
          runtimeId: runtime.runtimeId!, organizationId: f.organizationId, scopeKey: 'scope-1', draftId: 'draft-cw',
          sessionId: 'cw-root', userId: owner.uuid, cwd: '/work', visibility: 'personal',
        })
        reserveOutcome = reserve.then(
          () => ({ status: 'resolved' as const }),
          (cause: unknown) => ({ status: 'rejected' as const, cause }),
        )
        await waitForBlockedOrSettled(laneName('reserve'), ['tuple', 'transactionid'], reserve)
        await cleaner.query('COMMIT')
        const failure = await reserveOutcome
        expect(failure.status === 'rejected' ? failure.cause : null)
          .toMatchObject({ message: expect.stringContaining('invalid draft reservation') })
      } finally {
        await cleaner.query('ROLLBACK').catch(() => {})
        await reserveOutcome
      }

      // Child materialization holding the root lock lands visible content first:
      // cleanup's recheck finds the tree no longer blank and skips it.
      const writer = await pool.connect()
      cleanup.push(() => writer.release())
      let trashOutcome2: Promise<{ status: 'resolved', value: readonly ConversationSessionIdentity[] } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await writer.query('BEGIN')
        await writer.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='mv-root' FOR UPDATE`, [f.organizationId])
        await writer.query(`INSERT INTO harness.conversation_sessions(
          id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,
          session_format_version,created_at,updated_at,visibility,status,has_visible_content,draft,runtime_id)
          VALUES('mv-child',$1,$2,NULL,'mv-root','mv-root',3,to_timestamp($3/1000.0),to_timestamp($3/1000.0),'personal','active',true,true,$4)`,
          [f.organizationId, owner.uuid, old, await fixtureRuntime(f, owner.uuid)])
        const trash = service.trashEmptyDrafts(reviewed(await fixtureRuntime(f, owner.uuid), ['mv-root']), admin.publicId)
        const settled = trash.then(
          value => ({ status: 'resolved' as const, value }),
          (cause: unknown) => ({ status: 'rejected' as const, cause }),
        )
        trashOutcome2 = settled
        await waitForBlockedOrSettled(laneName('empty-trash'), ['tuple', 'transactionid'], trash)
        await writer.query('COMMIT')
        const moved = await settled
        if (moved.status === 'rejected') throw moved.cause
        expect(moved.value).toEqual([])
      } finally {
        await writer.query('ROLLBACK').catch(() => {})
        await trashOutcome2
      }
    })
  })
})
