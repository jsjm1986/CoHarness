/** Blank-draft leases and cleanup respect archived and recently restored roots. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('blank-draft archive lifecycle', () => {
  let administration: Pool | undefined, pool: Pool | undefined, database: string | undefined
  let context: PostgresRuntimeContext, userId: string, actorId: number, runtimeId: RuntimeId
  beforeAll(async () => {
    administration = createPostgresPool(databaseUrl!, { max: 1 })
    const name = `draft_lifecycle_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE ${name}`); database = name
    const url = new URL(databaseUrl!); url.pathname = `/${name}`; pool = createPostgresPool(url.toString(), { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID(), organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Blank lifecycle') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId]); context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const user = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/unused-lifecycle') RETURNING id,public_id", [organizationId])).rows[0]!
    userId = user.id; actorId = Number(user.public_id)
    await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [userId])
    await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, userId])
    await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/unused-lifecycle')", [organizationId, context.nodeId, userId])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, userId])
    runtimeId = (await pool.query<{ runtime_id: RuntimeId }>("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48000,'isolated') RETURNING runtime_id", [organizationId, userId, context.nodeId])).rows[0]!.runtime_id
  })
  afterAll(async () => {
    const failures: unknown[] = [], close = async (action: () => Promise<unknown>): Promise<void> => { try { await action() } catch (error) { failures.push(error) } }
    if (pool !== undefined) await close(() => pool!.end())
    if (database !== undefined) await close(() => administration!.query(`DROP DATABASE ${database}`))
    if (administration !== undefined) await close(() => administration!.end())
    if (failures.length > 0) throw new AggregateError(failures, 'Draft lifecycle fixture teardown failed')
  })

  it('checks the canonical reserved Session when a retry proposes a different id', async () => {
    const db = pool!, root = randomUUID(), repository = new ConversationRepository(db, { organizationId: context.organizationId, runtimeId }), archives = new ConversationArchiveService(context)
    await repository.create({ id: root, organizationId: context.organizationId, runtimeId, creatorUserId: userId, sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal', draft: true })
    const input = { organizationId: context.organizationId, runtimeId, scopeKey: root, draftId: root, sessionId: root, userId, cwd: '/unused-lifecycle', visibility: 'personal' as const }
    expect((await repository.reserveDraft(input)).created).toBe(true)
    expect(await repository.reserveDraft({ ...input, sessionId: randomUUID() })).toMatchObject({ sessionId: root, created: false })
    await archives.syncSnapshot({ rootSessionId: root, runtime: { kind: 'user', id: actorId, runtimeId }, creatorUserId: actorId, syncRevision: 1, messageCount: 0 })
    await expect(repository.reserveDraft({ ...input, sessionId: randomUUID() })).rejects.toThrow('archived or unavailable')
    await repository.releaseDraftForSession(context.organizationId, root)
  })

  it('refuses a reservation released while the retry waits for the canonical root', async () => {
    const db = pool!, root = randomUUID(), repository = new ConversationRepository(db, { organizationId: context.organizationId, runtimeId })
    await repository.create({ id: root, organizationId: context.organizationId, runtimeId, creatorUserId: userId, sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal', draft: true })
    const input = { organizationId: context.organizationId, runtimeId, scopeKey: root, draftId: root, sessionId: root, userId, cwd: '/unused-lifecycle', visibility: 'personal' as const }
    await repository.reserveDraft(input)
    const blocker = await db.connect()
    let pending: Promise<{ error?: unknown }> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.conversation_sessions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [context.organizationId, root])
      pending = repository.reserveDraft({ ...input, sessionId: randomUUID() }).then(() => ({}), error => ({ error: error as unknown }))
      await expect.poll(async () => {
        const rows = await administration!.query<{ waiting: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
          AND query LIKE 'SELECT r.id FROM%conversation_sessions%FOR UPDATE%') waiting`, [database])
        return rows.rows[0]!.waiting
      }).toBe(true)
      await repository.releaseDraftForSession(context.organizationId, root)
      await blocker.query('COMMIT')
      expect((await pending).error).toMatchObject({ message: 'invalid draft reservation: reservation changed while waiting; retry' })
      expect((await repository.reserveDraft({ ...input, sessionId: randomUUID() })).created).toBe(true)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
      await repository.releaseDraftForSession(context.organizationId, root)
      await repository.releaseDraft(context.organizationId, input.scopeKey, input.draftId)
    }
  })

  it('preserves a restoration committed while cleanup waits for the archive lock', async () => {
    const db = pool!, root = randomUUID(), repository = new ConversationRepository(db, { organizationId: context.organizationId, runtimeId }), archives = new ConversationArchiveService(context)
    await repository.create({ id: root, organizationId: context.organizationId, runtimeId, creatorUserId: userId, sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal', draft: true })
    await db.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [context.organizationId, root])
    const archiveId = await archives.syncSnapshot({ rootSessionId: root, runtime: { kind: 'user', id: actorId, runtimeId }, creatorUserId: actorId, syncRevision: 1, messageCount: 0 })
    await db.query("UPDATE harness.conversation_archive_records SET restored_at=now()-interval '2 hours' WHERE archive_id=$1", [archiveId])
    const preview = await archives.previewEmptyDrafts({ olderThanMs: 60 * 60_000 }, actorId)
    expect(preview.candidates.some(row => row.rootSessionId === root)).toBe(true)
    const blocker = await db.connect()
    let pending: Promise<readonly { rootSessionId: string; runtimeId: RuntimeId }[]> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT archive_id FROM harness.conversation_archive_records WHERE archive_id=$1 FOR UPDATE', [archiveId])
      pending = archives.trashEmptyDrafts([{ rootSessionId: root, runtimeId }], actorId, preview.cutoff)
      await expect.poll(async () => {
        const rows = await administration!.query<{ waiting: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
          AND query LIKE 'SELECT state,sync_revision::text,restored_at%FOR UPDATE%') waiting`, [database])
        return rows.rows[0]!.waiting
      }).toBe(true)
      await blocker.query('UPDATE harness.conversation_archive_records SET restored_at=now() WHERE archive_id=$1', [archiveId])
      await blocker.query('COMMIT')
      expect(await pending).toEqual([])
      expect((await archives.status(archiveId))?.state).toBe('archived')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
  })

  it.each(['archived', 'trash', 'purged', 'recently-restored', 'old-restored', 'unarchived'] as const)('checks draft lifecycle for %s', async state => {
    const db = pool!, root = randomUUID(), repository = new ConversationRepository(db, { organizationId: context.organizationId, runtimeId }), archives = new ConversationArchiveService(context)
    await repository.create({ id: root, organizationId: context.organizationId, runtimeId, creatorUserId: userId, sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal', draft: true })
    await db.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [context.organizationId, root])
    if (state !== 'unarchived') {
      const archiveId = await archives.syncSnapshot({ rootSessionId: root, runtime: { kind: 'user', id: actorId, runtimeId }, creatorUserId: actorId, syncRevision: 1, messageCount: 0 })
      const status = state === 'recently-restored' || state === 'old-restored' ? 'archived' : state
      await db.query(`UPDATE harness.conversation_archive_records SET state=$3,
        restored_at=CASE WHEN $4::text='recently-restored' THEN now() WHEN $4::text='old-restored' THEN now()-interval '2 hours' ELSE NULL END
        WHERE organization_id=$1 AND archive_id=$2`, [context.organizationId, archiveId, status, state])
    }
    const reserve = repository.reserveDraft({ organizationId: context.organizationId, runtimeId, scopeKey: root, draftId: root, sessionId: root, userId, cwd: '/unused-lifecycle', visibility: 'personal' })
    const inactive = state === 'archived' || state === 'trash' || state === 'purged'
    if (inactive) await expect(reserve).rejects.toThrow('archived or unavailable')
    else {
      expect((await reserve).sessionId).toBe(root)
      await repository.releaseDraftForSession(context.organizationId, root)
    }
    const eligible = state === 'old-restored' || state === 'unarchived'
    const preview = await archives.previewEmptyDrafts({ olderThanMs: 60 * 60_000 }, actorId)
    expect(preview.candidates.some(row => row.rootSessionId === root)).toBe(eligible)
    expect(await archives.trashEmptyDrafts([{ rootSessionId: root, runtimeId }], actorId, preview.cutoff)).toEqual(eligible ? [{ rootSessionId: root, runtimeId }] : [])
  })
})
