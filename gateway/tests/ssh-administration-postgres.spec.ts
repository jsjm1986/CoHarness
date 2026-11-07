/** SSH administration retains current actor and project-sharing authority. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresSshTargetService } from '../src/postgres/ssh-target-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const fields = { name: 'builder', host: 'ssh-builder', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64), workspace: '/srv/workspaces' }

describePg('PostgreSQL SSH administrator and project sharing authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_SSH_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const slug = `ssh-authority-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'SSH authority') RETURNING id", [slug])).rows[0]!.id
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const accounts = []
      for (const role of ['admin', 'member'] as const) {
        const account = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, role])).rows[0]!
        await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [organizationId, account.id, role])
        await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [account.id])
        accounts.push(account)
      }
      const admin = accounts[0]!, owner = accounts[1]!, actorId = Number(admin.public_id), ownerId = Number(owner.public_id)
      const project = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.projects(organization_id,name,owner_user_id) VALUES($1,'SSH project',$2) RETURNING id,public_id", [organizationId, owner.id])).rows[0]!
      const create = (source: Pool) => new PostgresSshTargetService({ ...context, pool: source }), service = create(pool)
      const target = await service.create(actorId, fields), share = { targetId: target.publicId, projectId: Number(project.public_id), shared: true }
      return { context, actorId, admin, ownerId, owner, project, target, share, service, create, close: () => removeFixtureOrganization(pool, organizationId) }
    } catch (error) {
      try { await removeFixtureOrganization(pool, organizationId) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SSH setup and cleanup failed') }
      throw error
    }
  }

  it.each(['listing', 'sharing'] as const)('rejects inactive organization project %s without changing shares', async operation => {
    const f = await fixture()
    try {
      await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      await expect(operation === 'listing' ? f.service.listForProject(f.ownerId, Number(f.project.public_id))
        : f.service.share(f.ownerId, f.share)).rejects.toMatchObject({ code: 'forbidden' })
      expect((await pool.query('SELECT count(*)::int count FROM harness.ssh_target_shares WHERE organization_id=$1', [f.context.organizationId])).rows[0]!.count).toBe(0)
    } finally { await f.close() }
  })

  it('keeps project ownership separate from organization administration', async () => {
    const f = await fixture()
    try {
      const update = { targetId: f.target.publicId, revision: f.target.revision, fields }
      await expect(f.service.list(f.ownerId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.create(f.ownerId, { ...fields, name: 'forbidden' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.update(update, f.ownerId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.mutate({ targetId: f.target.publicId, revision: f.target.revision, action: 'remove' }, f.ownerId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.shareAsAdministrator(f.ownerId, f.share)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await f.service.listForProject(f.ownerId, Number(f.project.public_id))).toMatchObject([{ publicId: f.target.publicId, shared: false }])
      expect((await f.service.share(f.ownerId, f.share)).sharedProjects).toEqual([Number(f.project.public_id)])
      expect((await f.service.shareAsAdministrator(f.actorId, { ...f.share, shared: false })).sharedProjects).toEqual([])
    } finally { await f.close() }
  })

  it('does not borrow a foreign organization administrator or target', async () => {
    const f = await fixture(), other = await fixture()
    try {
      await expect(f.service.list(other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.create(other.actorId, { ...fields, name: 'foreign' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.update({ targetId: f.target.publicId, revision: f.target.revision, fields }, other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.mutate({ targetId: f.target.publicId, revision: f.target.revision, action: 'remove' }, other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.shareAsAdministrator(other.actorId, f.share)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.update({ targetId: other.target.publicId, revision: other.target.revision, fields }, f.actorId)).rejects.toMatchObject({ status: 404 })
      await expect(f.service.share(f.ownerId, { ...f.share, targetId: other.target.publicId })).rejects.toMatchObject({ status: 404 })
      expect(await f.service.list(f.actorId)).toMatchObject([{ publicId: f.target.publicId }])
    } finally { await f.close(); await other.close() }
  })

  it.each(['administrator', 'organization'] as const)('retains %s eligibility while target writes wait', async kind => {
    const f = await fixture(), name = `ssh-write-${randomUUID()}`, revokeName = `ssh-revoke-${randomUUID()}`
    const writer = createPostgresPool(databaseUrl!, { max: 1, application_name: name }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName }), service = f.create(writer), held = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, settled = false
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM harness.ssh_targets WHERE organization_id=$1 FOR UPDATE', [f.context.organizationId])
      pending = (kind === 'administrator' ? service.update({ targetId: f.target.publicId, revision: f.target.revision, fields: { ...fields, host: 'changed-host' } }, f.actorId)
        : service.share(f.ownerId, f.share)).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name])).rows[0]!.waiting).toBe(true)
      revoked = (kind === 'administrator' ? revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.admin.id])
        : revoker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId]))
        .then(value => { settled = true; return value }, (error: unknown) => { settled = true; return error })
      await expect.poll(async () => settled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity revoked JOIN pg_stat_activity admitted ON admitted.application_name=$1
        WHERE revoked.application_name=$2 AND admitted.pid=ANY(pg_blocking_pids(revoked.pid))) blocked`, [name, revokeName])).rows[0]!.blocked).toBe(true)
      expect(settled).toBe(false)
      await held.query('COMMIT'); expect(await pending).not.toBeInstanceOf(Error); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(service.list(f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.all([pending, revoked]); await writer.end(); await revoker.end(); await f.close() }
  })
})
