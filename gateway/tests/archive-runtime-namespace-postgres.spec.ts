/** PostgreSQL archive keys scope search, lifecycle commands and maintenance to one Runtime. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('archive Runtime namespace', () => {
  let pool: Pool
  const organizations: string[] = []
  beforeAll(async () => { pool = createPostgresPool(databaseUrl!, { max: 4 }); await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations')) })
  afterEach(async () => { for (const organizationId of organizations.splice(0)) await removeFixtureOrganization(pool, organizationId) })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const slug = randomUUID(), organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive namespace') RETURNING id", [slug])).rows[0]!.id as string
    organizations.push(organizationId)
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const owner = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/tmp/archive-owner') RETURNING id,public_id", [organizationId])).rows[0]!
    await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, owner.id])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, owner.id])
    await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [owner.id])
    const instances = new PostgresInstanceRepository(context, 48_000); await instances.initialize()
    const runtime = await instances.resolveTarget({ kind: 'user', id: Number(owner.public_id) })
    const siblingId = (await pool.query<{ runtime_id: RuntimeId }>("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48001,'isolated') RETURNING runtime_id", [organizationId, owner.id, context.nodeId])).rows[0]!.runtime_id
    const sibling = { ...runtime, runtimeId: siblingId }
    return { context, owner, runtime, sibling, service: new ConversationArchiveService(context), repository: new ConversationRepository(pool, { organizationId, runtimeId: runtime.runtimeId! }) }
  }

  it('rolls back every batch when a Runtime attempts to move an indexed event to a different root', async () => {
    const f = await fixture(), { service, runtime } = f
    const original = await service.syncSnapshot({ rootSessionId: 'first-root', runtime, syncRevision: 1,
      search: [{ sessionId: 'already-owned-child', seq: 0, role: 'user', content: 'Original', occurredAt: 1 }] })
    const search = Array.from({ length: 1000 }, (_, seq) => ({ sessionId: 'new-child', seq, role: 'user' as const, content: 'New', occurredAt: seq }))
    search.push({ sessionId: 'already-owned-child', seq: 0, role: 'user', content: 'Moved', occurredAt: 1 })
    await expect(service.syncSnapshot({ rootSessionId: 'second-root', runtime, syncRevision: 2, search })).rejects.toThrow('different root in this Runtime')
    expect((await service.adminList({ state: 'all' })).map(row => row.archiveId)).toEqual([original])
    expect((await pool.query('SELECT session_id,content FROM harness.conversation_archive_search WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([{ session_id: 'already-owned-child', content: 'Original' }])
    const other = await service.syncSnapshot({ rootSessionId: 'second-root', runtime: f.sibling, syncRevision: 2, search })
    expect(other).not.toBe(original)
    expect((await pool.query('SELECT count(*)::int total FROM harness.conversation_archive_search WHERE archive_id=$1', [other])).rows[0]!.total).toBe(1001)
  })

  it('keeps a sibling archive tombstone out of blank-draft admission and cleanup', async () => {
    const f = await fixture(), hostId = `blank-${randomUUID()}`, now = Date.now(), actorId = Number(f.owner.public_id)
    const siblingId = await f.service.syncSnapshot({ rootSessionId: hostId, runtime: f.sibling, creatorUserId: actorId, syncRevision: 1 })
    await f.service.purge(siblingId, actorId); await f.service.settle(siblingId, actorId)
    const reservation = await f.repository.reserveDraft({ organizationId: f.context.organizationId, runtimeId: f.runtime.runtimeId!, scopeKey: 'blank', draftId: 'blank-first', sessionId: hostId, userId: f.owner.id, cwd: '/tmp', visibility: 'personal' })
    expect(reservation.created).toBe(true)
    await f.repository.releaseDraft(f.context.organizationId, 'blank', 'blank-first', hostId)
    await f.repository.create({ id: hostId, organizationId: f.context.organizationId, runtimeId: f.runtime.runtimeId!, creatorUserId: f.owner.id, sessionFormatVersion: 1, createdAt: now - 7_200_000, visibility: 'personal', draft: true })
    await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE id=$1", [hostId])
    const preview = await f.service.previewEmptyDrafts(); expect(preview.candidates.map(row => row.rootSessionId)).toContain(hostId)
    expect(await f.service.trashEmptyDrafts([{ rootSessionId: hostId, runtimeId: f.runtime.runtimeId! }], actorId, preview.cutoff)).toEqual([{ rootSessionId: hostId, runtimeId: f.runtime.runtimeId! }])
    const own = (await f.service.adminList({ state: 'all', recordKind: 'all' })).find(row => row.runtime.runtimeId === f.runtime.runtimeId)!
    expect(own.archiveId).not.toBe(siblingId); expect(own.state).toBe('trash')
    expect((await f.service.status(siblingId))?.state).toBe('purged')
    const commands = await f.service.syncRuntimeSnapshot({ runtime: f.runtime, revision: 1, archivedSessionIds: [], sessions: [] }, f.runtime)
    expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ rootSessionId: hostId, action: 'trash' })
  })

  it('refuses another organization or computer record including a known purge idempotency replay', async () => {
    const f = await fixture(), other = await fixture(), actorId = Number(f.owner.public_id)
    const archiveId = await f.service.syncSnapshot({ rootSessionId: 'same-root', runtime: f.runtime, syncRevision: 1 })
    expect(await f.service.purge(archiveId, actorId, 'known-purge')).toBe(true)
    const nodeId = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other') RETURNING id", [f.context.organizationId])).rows[0]!.id
    const foreignComputer = new ConversationArchiveService({ ...f.context, nodeId, nodeName: 'other' })
    for (const service of [foreignComputer, other.service]) {
      expect(await service.status(archiveId)).toBeNull()
      expect(await service.detail(archiveId)).toBeNull()
      expect(await service.exportDetail(archiveId)).toBeNull()
      expect(await service.settle(archiveId)).toBeNull()
      expect(await service.purge(archiveId)).toBe(false)
    }
    expect(await foreignComputer.purge(archiveId, actorId, 'known-purge')).toBe(false)
    const stateId = await f.service.syncSnapshot({ rootSessionId: 'state-root', runtime: f.runtime, syncRevision: 1 })
    await f.service.setState(stateId, 'trash', actorId, 'known-trash')
    expect(await foreignComputer.setState(stateId, 'trash', actorId, 'known-trash')).toBeNull()
    expect(await foreignComputer.setState(archiveId, 'trash', actorId)).toBeNull()
    expect((await pool.query('SELECT action,status FROM harness.conversation_archive_commands WHERE archive_id=$1', [archiveId])).rows).toEqual([{ action: 'purge', status: 'pending' }])
  })
})
