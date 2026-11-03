/** Archive cleanup completes its own leased tasks while retaining references and foreign-computer work. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('archive file cleanup task ownership', () => {
  let administration: Pool | undefined, pool: Pool | undefined, database: string | undefined, root: string | undefined
  beforeAll(async () => {
    administration = createPostgresPool(databaseUrl!, { max: 1 })
    const name = `archive_cleanup_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE ${name}`); database = name
    const url = new URL(databaseUrl!); url.pathname = `/${name}`
    pool = createPostgresPool(url.toString(), { max: 2 })
    root = await mkdtemp(join(tmpdir(), 'archive-file-cleanup-'))
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => {
    const failures: unknown[] = [], close = async (action: () => Promise<unknown>): Promise<void> => { try { await action() } catch (error) { failures.push(error) } }
    if (pool !== undefined) await close(() => pool!.end())
    if (database !== undefined) await close(() => administration!.query(`DROP DATABASE ${database}`))
    if (administration !== undefined) await close(() => administration!.end())
    if (root !== undefined) await close(() => rm(root!, { recursive: true, force: true }))
    if (failures.length > 0) throw new AggregateError(failures, 'archive cleanup fixture teardown failed')
  })

  it('deletes completed leases, retains referenced files, retries unsafe paths and leaves another computer untouched', async () => {
    const db = pool!, directory = root!, slug = randomUUID()
    const organizationId = (await db.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Cleanup ownership') RETURNING id", [slug])).rows[0]!.id
    const account = (await db.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'owner','Owner',$2) RETURNING id,public_id", [organizationId, directory])).rows[0]!
    const computers = []
    for (const [index, name] of ['computer-a', 'computer-b'].entries()) {
      await db.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
      const context = await resolvePostgresRuntimeContext(db, slug, name)
      const home = join(directory, name); await mkdir(home)
      await db.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)', [organizationId, context.nodeId, account.id, home])
      await db.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, account.id])
      const runtimeId = (await db.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
        VALUES($1,$2,$3,$4,'isolated') RETURNING runtime_id`, [organizationId, account.id, context.nodeId, 48000 + index])).rows[0]!.runtime_id
      const service = new ConversationArchiveService(context), sessionId = `cleanup-${randomUUID()}`
      const archiveId = await service.syncSnapshot({ rootSessionId: sessionId, runtime: { kind: 'user', id: Number(account.public_id), runtimeId }, creatorUserId: Number(account.public_id), syncRevision: 1 })
      computers.push({ context, service, archiveId, runtimeId, sessionId })
    }
    const [a, b] = computers
    const paths = { completed: join(directory, 'completed.bin'), missing: join(directory, 'already-missing.bin'), referenced: join(directory, 'referenced.bin'), unsafe: join(directory, 'directory'), foreign: join(directory, 'other-computer.bin') }
    await Promise.all([writeFile(paths.completed, 'completed'), writeFile(paths.referenced, 'retained'), writeFile(paths.foreign, 'foreign'), mkdir(paths.unsafe)])
    await new ConversationRepository(db, { organizationId, runtimeId: a!.runtimeId }).create({ id: a!.sessionId, organizationId, runtimeId: a!.runtimeId, creatorUserId: account.id, sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal' })
    await db.query(`INSERT INTO harness.content_files(organization_id,runtime_id,owner_user_id,session_id,kind,local_path,sha256,byte_length,media_type)
      VALUES($1,$6,$2,$3,'attachment',$4,$5,8,'text/plain')`, [organizationId, account.id, a!.sessionId, paths.referenced, 'a'.repeat(64), a!.runtimeId])
    for (const [key, path] of Object.entries(paths)) {
      const owner = key === 'foreign' ? b! : a!
      await db.query('INSERT INTO harness.conversation_archive_file_cleanup(organization_id,archive_id,node_id,local_path) VALUES($1,$2,$3,$4)', [organizationId, owner.archiveId, owner.context.nodeId, path])
    }
    expect(await a!.service.cleanupDue()).toBe(3)
    await expect(stat(paths.completed)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(paths.missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(paths.referenced)).isFile()).toBe(true)
    expect((await stat(paths.foreign)).isFile()).toBe(true)
    expect((await stat(paths.unsafe)).isDirectory()).toBe(true)
    const pending = (await db.query<{ local_path: string; attempts: number; unleased: boolean; deferred: boolean }>(`SELECT local_path,attempts,lease_until IS NULL unleased,next_attempt_at>created_at deferred
      FROM harness.conversation_archive_file_cleanup WHERE organization_id=$1 ORDER BY local_path`, [organizationId])).rows
    expect(pending).toEqual([
      { local_path: paths.unsafe, attempts: 1, unleased: true, deferred: true },
      { local_path: paths.foreign, attempts: 0, unleased: true, deferred: false },
    ].sort((left, right) => left.local_path.localeCompare(right.local_path)))
    expect(await a!.service.cleanupDue()).toBe(0)
    expect(await b!.service.cleanupDue()).toBe(1)
    await expect(stat(paths.foreign)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await db.query('SELECT local_path,lease_until FROM harness.conversation_archive_file_cleanup WHERE organization_id=$1', [organizationId])).rows).toEqual([{ local_path: paths.unsafe, lease_until: null }])
  })
})
