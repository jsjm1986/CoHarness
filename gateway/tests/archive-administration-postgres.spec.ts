/** Current archive administrator qualification after real PostgreSQL lock waits. @module */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
describePg('PostgreSQL archive administrative mutation', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  const changes = ['current', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'password-required', 'missing-credential'] as const
  for (const action of ['trash', 'restore', 'purge', 'settle', 'empty-draft'] as const) {
    const scenarios = action === 'settle' || action === 'empty-draft' ? changes : [...changes, 'replayed-role'] as const
    it.each(scenarios)(`${action} retains current authority after its organization lock waits: %s`, async change => {
      const organizationId = (await pool.query<{ id: PostgresRuntimeContext['organizationId'] }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive lock') RETURNING id", [`archive-lock-${randomUUID()}`],
      )).rows[0]!.id
      const applicationName = `archive-lock-${randomUUID()}`
      const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
      let blocker: PoolClient | undefined, primaryError: unknown
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined
      try {
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const slug = (await pool.query<{ slug: string }>('SELECT slug FROM harness.organizations WHERE id=$1', [organizationId])).rows[0]!.slug
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const accounts = []
        for (const username of ['actor', 'owner']) {
          const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
            VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`, [organizationId, username, join(tmpdir(), organizationId, username)])).rows[0]!
          await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, user.id])
          await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, user.id])
          await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [user.id])
          accounts.push({ id: user.id, publicId: Number(user.public_id) })
        }
        const [actor, owner] = accounts
        await new PostgresInstanceRepository(context, 48_000).initialize()
        const runtimeId = (await new PostgresInstanceRepository(context, 48_000).resolveTarget({ kind: 'user', id: owner!.publicId })).runtimeId!
        const root = `archive-lock-${randomUUID()}`, archive = new ConversationArchiveService(context)
        if (action === 'empty-draft') {
          await new ConversationRepository(pool, { organizationId, runtimeId }).create({ id: root, organizationId, runtimeId, creatorUserId: owner!.id, sessionFormatVersion: 1,
            createdAt: Date.now() - 7_200_000, visibility: 'personal', draft: true })
          await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [organizationId, root])
        }
        const archiveId = await archive.syncSnapshot({ runtime: { kind: 'user', id: owner!.publicId }, rootSessionId: root, creatorUserId: owner!.publicId, syncRevision: 1 })
        if (action === 'empty-draft') await pool.query("UPDATE harness.conversation_archive_records SET restored_at=now()-interval '2 hours' WHERE archive_id=$1", [archiveId])
        if (action === 'restore') await archive.setState(archiveId, 'trash', actor!.publicId)
        if (action === 'settle') await archive.purge(archiveId, actor!.publicId)
        const idempotencyKey = change === 'replayed-role' ? randomUUID() : undefined
        const invoke = (service: ConversationArchiveService) => action === 'empty-draft' ? service.trashEmptyDrafts([{ rootSessionId: root, runtimeId }], actor!.publicId)
          : action === 'purge' ? service.purge(archiveId, actor!.publicId, idempotencyKey) : action === 'settle' ? service.settle(archiveId, actor!.publicId)
            : service.setState(archiveId, action === 'restore' ? 'archived' : 'trash', actor!.publicId, idempotencyKey)
        if (idempotencyKey !== undefined) await invoke(archive)
        const stored = async () => ({
          archive: (await pool.query('SELECT state,sync_revision::text,sync_state FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2', [organizationId, root])).rows,
          commands: (await pool.query('SELECT action,status,desired_revision::text FROM harness.conversation_archive_commands WHERE organization_id=$1 AND archive_id=$2 ORDER BY id', [organizationId, archiveId])).rows,
        })
        const before = await stored(), controlled = new ConversationArchiveService({ ...context, pool: reader })
        blocker = await pool.connect()
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.organizations WHERE id=$1 FOR UPDATE', [organizationId])
        pending = invoke(controlled).then(value => ({ value }), (error: unknown) => ({ error }))
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event_type='Lock') waiting`, [applicationName])).rows[0]!.waiting).toBe(true)
        if (change === 'role' || change === 'replayed-role') await blocker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [actor!.id])
        if (change === 'disabled-account') await blocker.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [actor!.id])
        if (change === 'deleted-account') await blocker.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [actor!.id])
        if (change === 'disabled-membership') await blocker.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [actor!.id])
        if (change === 'missing-membership') await blocker.query('DELETE FROM harness.memberships WHERE user_id=$1', [actor!.id])
        if (change === 'disabled-organization') await blocker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        if (change === 'password-required') await blocker.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [actor!.id])
        if (change === 'missing-credential') await blocker.query('DELETE FROM harness.password_credentials WHERE user_id=$1', [actor!.id])
        await blocker.query('COMMIT')
        const result = await pending
        if (change === 'current') { expect(result).toHaveProperty('value'); expect(await stored()).not.toEqual(before) }
        else { expect(result).toMatchObject({ error: { code: 'forbidden' } }); expect(await stored()).toEqual(before) }
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors: unknown[] = []
        const close = async (operation: () => Promise<unknown>): Promise<void> => { try { await operation() } catch (error) { errors.push(error) } }
        if (blocker !== undefined) {
          const connection = blocker
          await close(async () => { try { await connection.query('ROLLBACK') } finally { connection.release() } })
        }
        await close(async () => { await pending })
        await close(() => reader.end())
        await close(() => removeFixtureOrganization(pool, organizationId))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Archive lock fixture cleanup failed')
      }
    })
  }
})
