/** PostgreSQL business-rule regressions: archive ownership, document authority, desktop locking, webhook targeting. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
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
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { PostgresDesktopCoordinatorRepository } from '../src/postgres/desktop-coordinator-repository.ts'
import { PostgresWebhookEndpointService, WebhookSecretCipher } from '../src/postgres/webhook-endpoint-service.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import type { GatewayDeps } from '../src/server.ts'
import { AuthService, type UserRow } from '../src/auth.ts'
import { UserService } from '../src/users.ts'
import { ProjectService } from '../src/projects.ts'
import { AuditService } from '../src/audit.ts'
import { InstanceManager } from '../src/instances.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { openDb } from '../src/db.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const disposableDatabase = (() => {
  if (databaseUrl === undefined) return false
  try {
    return /(_test|_accept|_acceptance)$/.test(decodeURIComponent(new URL(databaseUrl).pathname))
  } catch {
    return false
  }
})()
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

function lane(name: string): Pool {
  const value = createPostgresPool(databaseUrl!, { application_name: laneName(name), max: 2 })
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
      await pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,
        creator_user_id,archived_by_user_id,restored_by_user_id,trashed_by_user_id)
        VALUES($1,$2,'project',$3,$4,$5,$5,$5,$5)`,
      [f.organizationId, sessionId, project.publicId, project.uuid, actor.uuid])
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
      await pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,
        creator_user_id,archived_by_user_id,restored_by_user_id,trashed_by_user_id)
        VALUES($1,$2,'user',$3,$4,$4,$4,$4)`,
      [f.organizationId, sessionId, actor.publicId, actor.uuid])
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
      await expect(pool.query(`INSERT INTO harness.conversation_archive_records(
        organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id)
        VALUES($1,$2,'project',$3,$4,$5)`,
      [f.organizationId, sessionId, project.publicId, project.uuid, foreignActor.uuid]))
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
    it('rejects a child whose parentSession derives a foreign archive root without writing anything', async () => {
      const f = await fixture()
      const victim = await f.user()
      const attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      await service.syncRuntimeSnapshot(snapshot(runtimeOf(victim), {
        revision: 5,
        archivedSessionIds: ['victim-root'],
        sessions: [{ sessionId: 'victim-root', header: {}, title: 'Victim archive' }],
      }), runtimeOf(victim))
      const before = (await pool.query<{ sync_revision: string; title: string | null }>(
        `SELECT sync_revision::text,title FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='victim-root'`, [f.organizationId])).rows[0]!

      await expect(service.syncRuntimeSnapshot(snapshot(runtimeOf(attacker), {
        revision: 9,
        archivedSessionIds: ['attack-child'],
        sessions: [{ sessionId: 'attack-child', header: { parentSession: 'victim-root' } }],
        search: [{ sessionId: 'attack-child', seq: 0, role: 'user', content: 'stolen', occurredAt: 1 }],
      }), runtimeOf(attacker))).rejects.toThrow('outside the authenticated runtime')

      const after = await pool.query(
        `SELECT sync_revision::text,title FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='victim-root'`, [f.organizationId])
      expect(after.rows[0]).toEqual(before)
      expect((await pool.query(
        `SELECT root_session_id FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='attack-child'`, [f.organizationId])).rows).toEqual([])
      expect((await pool.query(
        `SELECT session_id FROM harness.conversation_archive_search
         WHERE organization_id=$1 AND session_id='attack-child'`, [f.organizationId])).rows).toEqual([])
      expect(await service.hasPendingCommands(runtimeOf(attacker))).toBe(false)
    })

    it('rejects an explicit foreign root that has an archive record but no session row', async () => {
      const f = await fixture()
      const victim = await f.user()
      const attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      await service.syncRuntimeSnapshot(snapshot(runtimeOf(victim), {
        archivedSessionIds: ['claimed-root'],
        sessions: [{ sessionId: 'claimed-root', header: {} }],
      }), runtimeOf(victim))
      await expect(service.syncRuntimeSnapshot(snapshot(runtimeOf(attacker), {
        archivedSessionIds: ['claimed-root'],
        sessions: [{ sessionId: 'other-session', rootSessionId: 'claimed-root', header: {} }],
      }), runtimeOf(attacker))).rejects.toThrow('outside the authenticated runtime')
    })

    it('keeps archive identity immutable: foreign reassign rejects, same-owner stale search is dropped', async () => {
      const f = await fixture()
      const victim = await f.user()
      const attacker = await f.user()
      const service = new ConversationArchiveService(f.context)
      await service.syncSnapshot({
        rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 3, title: 'v3',
        search: [{ sessionId: 'owned-root', seq: 0, role: 'user', content: 'current-body', occurredAt: 1 }],
      })
      await expect(service.syncSnapshot({
        rootSessionId: 'owned-root', runtime: runtimeOf(attacker), syncRevision: 9, title: 'takeover',
      })).rejects.toThrow('outside the authenticated runtime')
      await service.syncSnapshot({
        rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 4, title: 'v4',
      })
      await service.syncSnapshot({
        rootSessionId: 'owned-root', runtime: runtimeOf(victim), syncRevision: 2, title: 'stale',
        search: [{ sessionId: 'owned-root', seq: 1, role: 'user', content: 'stale-body', occurredAt: 2 }],
      })
      const record = (await pool.query<{ runtime_kind: string; runtime_public_id: string; title: string | null; sync_revision: string }>(
        `SELECT runtime_kind,runtime_public_id::text,title,sync_revision::text
         FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='owned-root'`, [f.organizationId])).rows[0]!
      expect(record).toEqual({
        runtime_kind: 'user', runtime_public_id: String(victim.publicId), title: 'v4', sync_revision: '4',
      })
      const search = await pool.query<{ content: string }>(
        `SELECT content FROM harness.conversation_archive_search
         WHERE organization_id=$1 AND root_session_id='owned-root' ORDER BY event_seq`, [f.organizationId])
      expect(search.rows.map(row => row.content)).toEqual(['current-body'])
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

    it('serializes a racing first claim: the blocked foreign claimant rejects after the winner commits', async () => {
      const f = await fixture()
      const victim = await f.user()
      const attacker = await f.user()
      const claimant = await pool.connect()
      cleanup.push(() => claimant.release())
      const attackerService = new ConversationArchiveService({ ...f.context, pool: lane('claim-race') })
      let attemptOutcome: Promise<{ status: 'resolved' } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await claimant.query('BEGIN')
        await claimant.query(`INSERT INTO harness.conversation_archive_records(
          organization_id,root_session_id,runtime_kind,runtime_public_id,sync_revision,sync_state)
          VALUES($1,'race-root','user',$2,1,'synced')`, [f.organizationId, victim.publicId])
        const attempt = attackerService.syncSnapshot({
          rootSessionId: 'race-root', runtime: runtimeOf(attacker), syncRevision: 1, title: 'racer',
        })
        attemptOutcome = attempt.then(
          () => ({ status: 'resolved' as const }),
          (cause: unknown) => ({ status: 'rejected' as const, cause }),
        )
        await waitForBlockedOrSettled(laneName('claim-race'), ['tuple', 'transactionid'], attempt)
        await claimant.query('COMMIT')
        const failure = await attemptOutcome
        expect(failure.status === 'rejected' ? failure.cause : null)
          .toMatchObject({ message: expect.stringContaining('outside the authenticated runtime') })
      } finally {
        await claimant.query('ROLLBACK').catch(() => {})
        await attemptOutcome
      }
      const owner = (await pool.query<{ runtime_public_id: string; title: string | null }>(
        `SELECT runtime_public_id::text,title FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='race-root'`, [f.organizationId])).rows[0]!
      expect(owner.runtime_public_id).toBe(String(victim.publicId))
      expect(owner.title).toBeNull()
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
      await service.setState('victim-purge', 'trash', admin.publicId)
      await service.purge('victim-purge', admin.publicId)
      const pending = (await pool.query<{ id: string }>(
        `SELECT id FROM harness.conversation_archive_commands
         WHERE organization_id=$1 AND root_session_id='victim-purge' AND status='pending'`, [f.organizationId])).rows[0]
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
      await expect(service.update({ targetId: sameUser.publicId, revision: sameUser.revision, fields }))
        .rejects.toMatchObject({ status: 400 })
      const stored = await service.list()
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

  describe('empty draft eligibility', () => {
    const insertSession = (f: Fixture, session: {
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
        session_format_version,created_at,updated_at,visibility,status,has_visible_content,draft)
        VALUES($1,$2,$3,$4,$5,$6,3,to_timestamp($7/1000.0),to_timestamp($7/1000.0),$8,$9,$10,true)`, [
      session.id, f.organizationId, session.creator, session.project ?? null,
      session.parent ?? null, session.root ?? session.id, session.updatedAtMs,
      session.project === undefined ? 'personal' : 'project',
      session.status ?? 'active', session.visible ?? false,
    ])

    const reserveSession = (organizationId: string, sessionId: string, userUuid: string, leaseMs = 3_600_000) => pool.query(
      `INSERT INTO harness.conversation_draft_reservations(
        organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,lease_expires_at)
        VALUES($1,'scope-1',$2,$3,$4,NULL,'/work','personal',to_timestamp($5/1000.0))`,
      [organizationId, `draft-${sessionId}`, sessionId, userUuid, Date.now() + leaseMs])

    it('admits an old blank root, trashes it, and stays idempotent', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'blank-1', creator: owner.uuid, updatedAtMs: old })

      const preview = await service.previewEmptyDrafts({ olderThanMs: 3_600_000 })
      expect(preview.candidates.map(candidate => candidate.rootSessionId)).toEqual(['blank-1'])
      expect(await service.trashEmptyDrafts(['blank-1'], admin.publicId, preview.cutoff)).toEqual(['blank-1'])
      const record = await pool.query<{ state: string; record_kind: string }>(
        `SELECT state,record_kind FROM harness.conversation_archive_records
         WHERE organization_id=$1 AND root_session_id='blank-1'`, [f.organizationId])
      expect(record.rows[0]).toMatchObject({ state: 'trash', record_kind: 'empty-draft' })
      expect(await service.trashEmptyDrafts(['blank-1'], admin.publicId, preview.cutoff)).toEqual([])
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
      expect(await service.trashEmptyDrafts(['recent'], admin.publicId, preview.cutoff)).toEqual([])
      // Another organization's id cannot be cleaned through this actor.
      expect(await service.trashEmptyDrafts(['foreign-root'], admin.publicId, preview.cutoff)).toEqual([])
      // Activity between preview and submit revokes the preview's eligibility.
      await pool.query(`UPDATE harness.conversation_sessions SET updated_at=now()
        WHERE organization_id=$1 AND id='touched'`, [f.organizationId])
      expect(await service.trashEmptyDrafts(['touched'], admin.publicId, preview.cutoff)).toEqual([])
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
      await reserveSession(f.organizationId, 'leased-root', owner.uuid)
      await insertSession(f, { id: 'with-leased-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'leased-child', creator: owner.uuid, root: 'with-leased-child', parent: 'with-leased-child', updatedAtMs: old })
      await reserveSession(f.organizationId, 'leased-child', owner.uuid)
      await insertSession(f, { id: 'expired-lease', creator: owner.uuid, updatedAtMs: old })
      await reserveSession(f.organizationId, 'expired-lease', owner.uuid, -1_000)
      await insertSession(f, { id: 'with-deleted-child', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'deleted-child', creator: owner.uuid, root: 'with-deleted-child', parent: 'with-deleted-child', visible: true, status: 'deleted', updatedAtMs: old })

      const preview = await service.previewEmptyDrafts({ olderThanMs: 3_600_000 })
      expect(preview.candidates.map(candidate => candidate.rootSessionId).sort())
        .toEqual(['expired-lease', 'with-deleted-child'])
      const trashed = await service.trashEmptyDrafts([
        'with-visible-child', 'with-fresh-child', 'leased-root', 'with-leased-child', 'expired-lease', 'with-deleted-child',
      ], admin.publicId, preview.cutoff)
      expect([...trashed].sort()).toEqual(['expired-lease', 'with-deleted-child'])
    })

    it('rejects reservations against trashed, deleted, or foreign-scope sessions and admits a fresh draft', async () => {
      const f = await fixture()
      const owner = await f.user()
      const outsider = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService(f.context)
      const repository = new ConversationRepository(pool)
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'trash-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'deleted-root', creator: owner.uuid, status: 'deleted', updatedAtMs: old })
      await insertSession(f, { id: 'owned-root', creator: owner.uuid, updatedAtMs: old })
      await service.trashEmptyDrafts(['trash-root'], admin.publicId)
      const input = (sessionId: string, userId = owner.uuid) => ({
        organizationId: f.organizationId, scopeKey: 'scope-1', draftId: `draft-${sessionId}`,
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

    it('serializes reservation and cleanup on the session root lock', async () => {
      const f = await fixture()
      const owner = await f.user()
      const admin = await f.user('admin')
      const service = new ConversationArchiveService({ ...f.context, pool: lane('empty-trash') })
      const repository = new ConversationRepository(lane('reserve'))
      const old = Date.now() - 2 * 3_600_000
      await insertSession(f, { id: 'rc-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'cw-root', creator: owner.uuid, updatedAtMs: old })
      await insertSession(f, { id: 'mv-root', creator: owner.uuid, updatedAtMs: old })

      // A reservation holding the root lock commits first: cleanup's recheck
      // sees the live lease and skips the root.
      const reserver = await pool.connect()
      cleanup.push(() => reserver.release())
      let trashOutcome: Promise<{ status: 'resolved', value: readonly string[] } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await reserver.query('BEGIN')
        await reserver.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='rc-root' FOR UPDATE`, [f.organizationId])
        await reserver.query(`INSERT INTO harness.conversation_draft_reservations(
          organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,lease_expires_at)
          VALUES($1,'scope-1','draft-rc','rc-root',$2,NULL,'/work','personal',now()+interval '1 hour')`,
          [f.organizationId, owner.uuid])
        const trash = service.trashEmptyDrafts(['rc-root'], admin.publicId)
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
      let reserveOutcome: Promise<{ status: 'resolved' } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await cleaner.query('BEGIN')
        await cleaner.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='cw-root' FOR UPDATE`, [f.organizationId])
        await cleaner.query(`INSERT INTO harness.conversation_archive_records(
          organization_id,root_session_id,runtime_kind,runtime_public_id,state,sync_revision,sync_state)
          VALUES($1,'cw-root','user',$2,'trash',1,'synced')`, [f.organizationId, admin.publicId])
        const reserve = repository.reserveDraft({
          organizationId: f.organizationId, scopeKey: 'scope-1', draftId: 'draft-cw',
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
      let trashOutcome2: Promise<{ status: 'resolved', value: readonly string[] } | { status: 'rejected', cause: unknown }> | undefined
      try {
        await writer.query('BEGIN')
        await writer.query(`SELECT id FROM harness.conversation_sessions
          WHERE organization_id=$1 AND id='mv-root' FOR UPDATE`, [f.organizationId])
        await writer.query(`INSERT INTO harness.conversation_sessions(
          id,organization_id,creator_user_id,project_id,parent_session_id,root_session_id,
          session_format_version,created_at,updated_at,visibility,status,has_visible_content,draft)
          VALUES('mv-child',$1,$2,NULL,'mv-root','mv-root',3,to_timestamp($3/1000.0),to_timestamp($3/1000.0),'personal','active',true,true)`,
          [f.organizationId, owner.uuid, old])
        const trash = service.trashEmptyDrafts(['mv-root'], admin.publicId)
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
