/** Archive identities preserve assigned and unassigned history across the Runtime namespace migration. @module */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConversationArchiveId } from '../src/archive-identity.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const migrations = resolve(import.meta.dirname, '../deploy/postgres/migrations')
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('archive Runtime namespace migration', () => {
  let administration: Pool | undefined, pool: Pool | undefined, root: string | undefined, database: string | undefined
  beforeAll(async () => {
    administration = createPostgresPool(databaseUrl!, { max: 1 })
    const name = `archive_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE ${name}`); database = name
    const url = new URL(databaseUrl!); url.pathname = `/${name}`
    pool = createPostgresPool(url.toString(), { max: 2 })
    root = await mkdtemp(join(tmpdir(), 'archive-namespace-migration-'))
  })
  afterAll(async () => {
    const errors: unknown[] = [], close = async (action: () => Promise<unknown>): Promise<void> => { try { await action() } catch (error) { errors.push(error) } }
    if (pool !== undefined) await close(() => pool!.end())
    if (database !== undefined) await close(() => administration!.query(`DROP DATABASE ${database}`))
    if (administration !== undefined) await close(() => administration!.end())
    if (root !== undefined) await close(() => rm(root!, { recursive: true, force: true }))
    if (errors.length > 0) throw new AggregateError(errors, 'archive migration fixture cleanup failed')
  })

  it('retains all legacy facts, refuses reassignment and keeps new Runtime data independent', async () => {
    const db = pool!, through86 = root!
    for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 86) await copyFile(join(migrations, name), join(through86, name))
    await runMigrations(db, through86)
    const slug = randomUUID(), organizationId = (await db.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive migration') RETURNING id", [slug])).rows[0]!.id as string
    const nodeId = (await db.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id", [organizationId])).rows[0]!.id as string
    const accounts: Array<{ id: string; public_id: string }> = []
    for (const username of ['assigned', 'unassigned', 'other']) accounts.push((await db.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
      VALUES($1,$2::text,$2::text,'/tmp/archive-migration') RETURNING id,public_id`, [organizationId, username])).rows[0]!)
    const [assigned, unassigned, other] = accounts
    await db.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, assigned!.id])
    const runtimeId = (await db.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,48000) RETURNING runtime_id`, [organizationId, assigned!.id, nodeId])).rows[0]!.runtime_id
    for (const [index, hostId] of ['legacy-owned', 'legacy-unassigned', 'legacy-no-owner'].entries()) {
      const account = index === 0 ? assigned! : unassigned!
      await db.query(`INSERT INTO harness.conversation_archive_records(organization_id,root_session_id,runtime_kind,runtime_public_id,creator_user_id,title,message_count)
        VALUES($1,$2,'user',$3,$4,$2,1)`, [organizationId, hostId, account.public_id, index === 2 ? null : account.id])
      await db.query(`INSERT INTO harness.conversation_archive_search(organization_id,root_session_id,session_id,event_seq,role,content,occurred_at)
        VALUES($1,$2,$2,0,'user',$2,to_timestamp(1))`, [organizationId, hostId])
      await db.query(`INSERT INTO harness.conversation_archive_commands(organization_id,root_session_id,action,desired_revision,idempotency_key)
        VALUES($1,$2,'purge',1,$2)`, [organizationId, hostId])
      await db.query(`INSERT INTO harness.conversation_archive_file_cleanup(organization_id,root_session_id,local_path)
        VALUES($1,$2,$3)`, [organizationId, hostId, `/tmp/${slug}/${hostId}`])
      await db.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,session_format_version,created_at,updated_at,visibility,root_session_id)
        VALUES($1,$2,$3,1,to_timestamp(1),to_timestamp(1),'personal',$1)`, [hostId, organizationId, index === 2 ? other!.id : account.id])
    }
    const through96 = await mkdtemp(join(tmpdir(), 'archive-before-namespace-'))
    try {
      for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 96) await copyFile(join(migrations, name), join(through96, name))
      await runMigrations(db, through96)
    } finally { await rm(through96, { recursive: true, force: true }) }
    const history = async (migrated: boolean) => ({
      records: (await db.query(`SELECT to_jsonb(row)${migrated ? "-'archive_id'" : ''} record FROM harness.conversation_archive_records row ORDER BY root_session_id`)).rows,
      search: (await db.query(migrated
        ? "SELECT (to_jsonb(row)-'archive_id'-'runtime_id')||jsonb_build_object('root_session_id',a.root_session_id) record FROM harness.conversation_archive_search row JOIN harness.conversation_archive_records a USING(organization_id,archive_id) ORDER BY session_id,event_seq"
        : 'SELECT to_jsonb(row) record FROM harness.conversation_archive_search row ORDER BY session_id,event_seq')).rows,
      commands: (await db.query(migrated
        ? "SELECT (to_jsonb(row)-'archive_id')||jsonb_build_object('root_session_id',a.root_session_id) record FROM harness.conversation_archive_commands row JOIN harness.conversation_archive_records a USING(organization_id,archive_id) ORDER BY row.id"
        : 'SELECT to_jsonb(row) record FROM harness.conversation_archive_commands row ORDER BY id')).rows,
      cleanup: (await db.query(migrated
        ? "SELECT (to_jsonb(row)-'archive_id')||jsonb_build_object('root_session_id',a.root_session_id) record FROM harness.conversation_archive_file_cleanup row JOIN harness.conversation_archive_records a USING(organization_id,archive_id) ORDER BY row.id"
        : 'SELECT to_jsonb(row) record FROM harness.conversation_archive_file_cleanup row ORDER BY id')).rows,
    })
    const before = await history(false)
    const through97 = join(root!, 'through97')
    await mkdir(through97)
    for (const name of await readdir(migrations)) if (/^\d+.*\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 97) await copyFile(join(migrations, name), join(through97, name))
    expect(await runMigrations(db, through97)).toEqual({ applied: [97], current: 97 })
    expect(await history(true)).toEqual(before)
    expect(await runMigrations(db, through97)).toEqual({ applied: [], current: 97 })
    await runMigrations(db, migrations)
    const legacy = (await db.query<{ archive_id: ConversationArchiveId; root_session_id: string; runtime_id: RuntimeId | null }>('SELECT archive_id,root_session_id,runtime_id FROM harness.conversation_archive_records ORDER BY root_session_id')).rows
    expect(new Set(legacy.map(row => row.archive_id)).size).toBe(3)
    expect(legacy.find(row => row.root_session_id === 'legacy-owned')?.runtime_id).toBe(runtimeId)
    expect(legacy.filter(row => row.root_session_id !== 'legacy-owned').map(row => row.runtime_id)).toEqual([null, null])
    const service = new ConversationArchiveService({ pool: db, organizationId, organizationSlug: slug, nodeId, nodeName: 'local' })
    const noOwner = legacy.find(row => row.root_session_id === 'legacy-no-owner')!
    expect((await service.detail(noOwner.archive_id))?.descendants).toEqual([])
    expect(await service.purge(noOwner.archive_id)).toBe(true)
    await service.settle(noOwner.archive_id)
    expect((await db.query("SELECT id FROM harness.conversation_sessions WHERE id='legacy-no-owner'")).rowCount).toBe(1)
    const replacement = (await db.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,48001) RETURNING runtime_id`, [organizationId, unassigned!.id, nodeId])).rows[0]!.runtime_id
    const oldId = legacy.find(row => row.root_session_id === 'legacy-unassigned')!.archive_id
    const newId = await service.syncSnapshot({ rootSessionId: 'legacy-unassigned', runtime: { kind: 'user', id: Number(unassigned!.public_id), runtimeId: replacement }, creatorUserId: Number(unassigned!.public_id), syncRevision: 1 })
    expect(newId).not.toBe(oldId)
    expect((await service.detail(newId))?.descendants).toEqual([])
    expect((await db.query('SELECT runtime_id FROM harness.conversation_archive_records WHERE archive_id=$1', [oldId])).rows).toEqual([{ runtime_id: null }])
    for (const sql of ['archive_id=gen_random_uuid()', "root_session_id='replacement-root'", "runtime_kind='project'", 'runtime_public_id=runtime_public_id+1', 'runtime_id=NULL', 'node_id=gen_random_uuid()', 'organization_id=gen_random_uuid()', 'legacy_unassigned=true']) {
      await expect(db.query(`UPDATE harness.conversation_archive_records SET ${sql} WHERE archive_id=$1`, [newId])).rejects.toMatchObject({ code: '23514' })
    }
    await expect(db.query(`INSERT INTO harness.conversation_archive_search(organization_id,archive_id,runtime_id,session_id,event_seq,role,content,occurred_at)
      VALUES($1,$2,$3,'foreign-event',0,'user','foreign',now())`, [organizationId, newId, runtimeId])).rejects.toMatchObject({ code: '23503' })
    await expect(db.query(`INSERT INTO harness.conversation_archive_file_cleanup(organization_id,archive_id,node_id,local_path) VALUES($1,$2,gen_random_uuid(),'/tmp/foreign')`, [organizationId, newId])).rejects.toMatchObject({ code: '23503' })
  })
})
