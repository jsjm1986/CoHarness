/** Retained administrator authority and shared remote desktop file publication. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { RemoteDesktopService, type RemoteDesktopAdministration } from '../src/remote-desktop-service.ts'
import { remoteDesktopAdministration } from '../src/postgres/remote-desktop-administration.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const endpoints = [{ nodeId: 'configured', host: 'desktop.example', port: 5901 }]
const input = { principal: 'alice', target: { nodeId: 'configured' }, level: 'view' }

describePg('PostgreSQL remote desktop administrator authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_REMOTE_DESKTOP_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const slug = `remote-desktop-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Remote desktop') RETURNING id", [slug])).rows[0]!.id
    const dir = await mkdtemp(join(tmpdir(), 'remote-desktop-pg-'))
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const actor = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'administrator','Administrator','/unused') RETURNING id,public_id`, [organizationId])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, actor.id])
      await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [actor.id])
      const actorId = Number(actor.public_id), administration = remoteDesktopAdministration(context), service = new RemoteDesktopService(dir, administration)
      await service.saveEndpoints(endpoints, actorId)
      return { context, actor, actorId, dir, service, administration,
        close: async () => {
          const results = await Promise.allSettled([removeFixtureOrganization(pool, organizationId), rm(dir, { recursive: true, force: true })])
          const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
          if (errors.length > 0) throw new AggregateError(errors, 'Remote desktop fixture cleanup failed')
        } }
    } catch (error) {
      const results = await Promise.allSettled([removeFixtureOrganization(pool, organizationId), rm(dir, { recursive: true, force: true })])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError([error, ...errors], 'Remote desktop setup and cleanup failed')
      throw error
    }
  }

  it('refuses foreign administrator identity through every file executor', async () => {
    const f = await fixture(), other = await fixture()
    try {
      await expect(f.service.endpoints(other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.saveEndpoints([], other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.listGrants(other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.createGrant(input, other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.setLevel('missing', 'control', other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.revoke('missing', other.actorId)).rejects.toMatchObject({ status: 403 })
      await expect(f.service.audit(10, other.actorId)).rejects.toMatchObject({ status: 403 })
      expect(await f.service.endpoints(f.actorId)).toEqual(endpoints)
      expect(await f.service.listGrants(f.actorId)).toEqual([])
    } finally { await f.close(); await other.close() }
  })

  it('attributes a grant to the retained current administrator username', async () => {
    const f = await fixture()
    try {
      await pool.query("UPDATE harness.users SET username='renamed-administrator' WHERE id=$1", [f.actor.id])
      expect((await f.service.createGrant({ ...input, grantedBy: 'forged' }, f.actorId)).grantedBy).toBe('renamed-administrator')
    } finally { await f.close() }
  })

  it('rechecks the current administrator after the shared writer lock is released', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void, pending: Promise<unknown> | undefined
    const observed = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const held = withFileLock(join(f.dir, 'grants.jsonl'), async () => { entered(); await gate }).catch((error: unknown) => error)
    try {
      await observed
      pending = f.service.saveEndpoints([], f.actorId).catch((error: unknown) => error)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
      release(); expect(await held).toBeUndefined()
      expect(await pending).toMatchObject({ status: 403, message: 'forbidden' })
      expect(JSON.parse(await readFile(join(f.dir, 'endpoints.json'), 'utf8'))).toEqual({ endpoints })
    } finally { release(); await Promise.all([held, pending]); await f.close() }
  })

  it('retains current administrator membership until accepted file publication settles', async () => {
    const f = await fixture(), writerName = `remote-desktop-write-${randomUUID()}`, revokeName = `remote-desktop-revoke-${randomUUID()}`
    const writer = createPostgresPool(databaseUrl!, { max: 1, application_name: writerName }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName })
    const base = remoteDesktopAdministration({ ...f.context, pool: writer })
    let entered!: () => void, release!: () => void, pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, settled = false
    const observed = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const controlled: RemoteDesktopAdministration = { run: (actor, operation) => base.run(actor, async (...args) => { entered(); await gate; return operation(...args) }) }
    const service = new RemoteDesktopService(f.dir, controlled)
    try {
      pending = service.saveEndpoints([], f.actorId).catch((error: unknown) => error)
      await Promise.race([observed, pending.then(() => { throw new Error('File publication bypassed the retained authority observer') })])
      revoked = revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
        .then(value => { settled = true; return value }, (error: unknown) => { settled = true; return error })
      await expect.poll(async () => settled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity revoked JOIN pg_stat_activity admitted ON admitted.application_name=$1
        WHERE revoked.application_name=$2 AND admitted.pid=ANY(pg_blocking_pids(revoked.pid))) blocked`, [writerName, revokeName])).rows[0]!.blocked).toBe(true)
      expect(settled).toBe(false)
      release(); expect(await pending).toEqual([]); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(f.service.endpoints(f.actorId)).rejects.toMatchObject({ status: 403 })
    } finally { release(); await Promise.all([pending, revoked]); await writer.end(); await revoker.end(); await f.close() }
  })

  it('preserves distinct grants from independent Gateway writers', async () => {
    const f = await fixture(), second = new RemoteDesktopService(f.dir, f.administration)
    try {
      await Promise.all([f.service.createGrant(input, f.actorId), second.createGrant({ ...input, principal: 'bob' }, f.actorId)])
      expect((await f.service.listGrants(f.actorId)).map(row => row.principal).sort()).toEqual(['alice', 'bob'])
    } finally { await f.close() }
  })

  it('commits only one concurrent active grant for the same principal and endpoint', async () => {
    const f = await fixture(), second = new RemoteDesktopService(f.dir, f.administration)
    try {
      const results = await Promise.allSettled([f.service.createGrant(input, f.actorId), second.createGrant(input, f.actorId)])
      expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { status: 409, message: 'remote-desktop-grant-exists' } })
      expect(await f.service.listGrants(f.actorId)).toHaveLength(1)
    } finally { await f.close() }
  })
})
