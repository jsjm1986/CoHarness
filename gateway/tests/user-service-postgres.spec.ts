/** Real account mutations retain current administrator authority after database queue waits. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const operations = ['create', 'patch', 'status', 'role', 'name', 'remove', 'password'] as const
type Mutation = typeof operations[number]
const revocations = ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'password-required', 'missing-credential'] as const

describePg('PostgreSQL current account administrator authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-account-authority-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const applicationName = `account-authority-${randomUUID()}`
    const limited = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    cleanups.push(() => limited.end())
    const slug = `account-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Account authority') RETURNING id`, [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(limited, slug, 'local'), cfg = testConfig(root)
    const users = new PostgresUserService(context, cfg)
    const actor = await users.create({ username: 'actor', password: 'pw-123456', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'pw-123456')
    await users.create({ username: 'keeper', password: 'pw-123456', role: 'admin' })
    const target = await users.create({ username: 'target', password: 'pw-123456', displayName: 'Retained target' })
    const actorId = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
      [organizationId, actor.id])).rows[0]!.id
    await writeFile(join(target.homePath, 'retained.txt'), 'retained bytes')
    const snapshot = async () => (await pool.query(`SELECT u.status,u.deleted_at,u.display_name,u.auto_review_eligible,
      m.role,m.status membership_status,c.password_hash,c.password_version,c.must_change_password
      FROM harness.users u JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
      JOIN harness.password_credentials c ON c.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2`, [organizationId, target.id])).rows
    const apply = (operation: Mutation): Promise<unknown> => {
      switch (operation) {
        case 'create': return users.create({ username: 'blocked-account', password: 'pw-123456', role: 'admin' }, actor.id)
        case 'patch': return users.patch(target.id, { role: 'admin', status: 'disabled', displayName: 'Changed', autoReviewEligible: true }, actor.id)
        case 'status': return users.setStatus(target.id, 'disabled', actor.id)
        case 'role': return users.setRole(target.id, 'admin', actor.id)
        case 'name': return users.setDisplayName(target.id, 'Changed', actor.id)
        case 'remove': return users.remove(target.id, actor.id)
        case 'password': return users.resetPassword(target.id, 'replacement-password', actor.id)
        default: return assertNever(operation)
      }
    }
    const revoke = async (kind: typeof revocations[number]): Promise<void> => {
      switch (kind) {
        case 'role': await users.setRole(actor.id, 'user'); break
        case 'disabled-account': await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [actorId]); break
        case 'deleted-account': await users.remove(actor.id); break
        case 'disabled-membership': await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [actorId]); break
        case 'missing-membership': await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [actorId]); break
        case 'disabled-organization': await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId]); break
        case 'password-required': await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [actorId]); break
        case 'missing-credential': await pool.query('DELETE FROM harness.password_credentials WHERE user_id=$1', [actorId]); break
        default: assertNever(kind)
      }
    }
    return { root, context, cfg, users, actor, actorId, target, snapshot, apply, revoke, applicationName }
  }

  it.for(operations.flatMap(operation => revocations.map(revocation => ({ operation, revocation }))))(
    'refuses $operation after $revocation with no data or directory changes', async ({ operation, revocation }) => {
      const f = await fixture(), before = await f.snapshot()
      await f.revoke(revocation)
      await expect(f.apply(operation)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await f.snapshot()).toEqual(before)
      expect(await f.users.getByUsername('blocked-account')).toBeNull()
      expect(existsSync(join(f.cfg.usersRoot, 'blocked-account'))).toBe(false)
      expect(await readFile(join(f.target.homePath, 'retained.txt'), 'utf8')).toBe('retained bytes')
    },
  )

  it.for(['create', 'patch', 'remove', 'password'] as const)('rechecks the actor after a queued %s operation', async operation => {
    const f = await fixture(), before = await f.snapshot(), blocker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [operation === 'create' ? `gateway-port:${f.context.nodeId}` : `gateway-admin:${f.context.organizationId}`])
      pending = f.apply(operation).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [f.applicationName])).rowCount).toBe(1)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actorId])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect(await f.snapshot()).toEqual(before)
      expect(existsSync(join(f.cfg.usersRoot, 'blocked-account'))).toBe(false)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await pending
    }
  })

  it('orders organization revocation with administrator admission while the actor row is locked', async () => {
    const f = await fixture(), before = await f.snapshot(), blocker = await pool.connect(), revoker = await pool.connect()
    let pending: Promise<unknown> | undefined, disabling: Promise<unknown> | undefined, revoked = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.users WHERE id=$1 FOR UPDATE', [f.actorId])
      pending = f.apply('patch').catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [f.applicationName])).rowCount).toBe(1)
      const revokerPid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
      disabling = revoker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
        .then(() => { revoked = true })
      await expect.poll(async () => revoked || (await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 blocked',
        [revokerPid])).rows[0]!.blocked).toBe(true)
      const revokedBeforeAdmission = revoked
      await blocker.query('COMMIT')
      const result = await pending
      await disabling
      if (revokedBeforeAdmission) {
        expect(result).toMatchObject({ code: 'forbidden' })
        expect(await f.snapshot()).toEqual(before)
      } else {
        expect(result).toBeUndefined()
        expect((await f.snapshot())[0]).toMatchObject({ display_name: 'Changed', status: 'disabled', auto_review_eligible: true })
      }
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.allSettled([pending, disabling]); revoker.release()
    }
  })
})
