/** PostgreSQL stream qualification reads current login authority without sliding the session. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
if (databaseUrl !== undefined && !/(_test|_accept|_acceptance)(\?.*)?$/.test(databaseUrl)) {
  throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database ending in _test, _accept, or _acceptance')
}
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL stream login qualification', () => {
  let pool: Pool
  let reads: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 2 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    reads = createPostgresPool(databaseUrl!, { max: 2, options: '-c default_transaction_read_only=on' })
  })
  afterAll(async () => {
    try { await reads?.end() }
    finally { await pool?.end() }
  })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-pg-stream-auth-'))
    let organizationId: string | undefined
    onTestFinished(async () => {
      try {
        if (organizationId !== undefined) {
          for (const table of ['auth_sessions', 'memberships', 'users', 'compute_nodes', 'outbox']) {
            await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
          }
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    })
    const slug = `stream-qualification-${randomUUID()}`
    organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Stream qualification') RETURNING id", [slug],
    )).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path) VALUES($1,'stream-user','Stream User',$2) RETURNING id,public_id`,
    [organizationId, root])).rows[0]!
    await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, user.id])
    await pool.query(`INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password)
      VALUES($1,'unused-password-hash',false)`, [user.id])
    const now = Date.now()
    const token = randomUUID()
    const session = (await pool.query<{ id: string }>(`INSERT INTO harness.auth_sessions(
      organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at)
      VALUES($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),to_timestamp($6/1000.0),to_timestamp($4/1000.0)) RETURNING id`,
    [organizationId, user.id, createHash('sha256').update(token).digest(), now - 600_000, now + 3_600_000, now + 7_200_000])).rows[0]!
    const cfg = testConfig(root, { HGW_SESSION_TTL_MS: '5400000', HGW_SESSION_ABS_TTL_MS: '10800000' })
    const snapshot = async () => (await pool.query<{
      last_seen_at: string
      expires_at: string
      absolute_expires_at: string
    }>(`SELECT last_seen_at::text,expires_at::text,absolute_expires_at::text FROM harness.auth_sessions
      WHERE organization_id=$1 AND id=$2`, [organizationId, session.id])).rows
    return {
      pool, reads, cfg, now, token, snapshot, organizationId, userId: user.id, publicId: Number(user.public_id), sessionId: session.id,
      auth: new PostgresAuthService(context, cfg),
      stream: new PostgresAuthService({ ...context, pool: reads }, cfg),
    }
  }

  it('qualifies through a read-only connection without changing last-seen, idle, or absolute timestamps', async () => {
    const f = await fixture()
    expect((await reads.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only).toBe('on')
    const before = await f.snapshot()
    const qualified = await f.stream.qualifyForStream(f.token)
    expect(qualified).toMatchObject({
      user: { id: f.publicId, username: 'stream-user', role: 'user', mustChangePassword: false },
      expiresAt: f.now + 3_600_000,
    })
    expect(await f.stream.qualifyForStream(f.token)).toEqual(qualified)
    expect(await f.snapshot()).toEqual(before)
  })

  it('returns the earlier absolute deadline without renewing idle activity', async () => {
    const f = await fixture()
    await pool.query('UPDATE harness.auth_sessions SET absolute_expires_at=to_timestamp($2/1000.0) WHERE id=$1', [f.sessionId, f.now + 1_800_000])
    const before = await f.snapshot()
    expect((await f.stream.qualifyForStream(f.token))?.expiresAt).toBe(f.now + 1_800_000)
    expect(await f.snapshot()).toEqual(before)
  })

  it('reflects current membership role and user review eligibility on each qualification', async () => {
    const f = await fixture()
    expect((await f.stream.qualifyForStream(f.token))?.user.role).toBe('user')
    await pool.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.userId])
    await pool.query("UPDATE harness.users SET auto_review_eligible=true,display_name='Updated User' WHERE id=$1", [f.userId])
    const before = await f.snapshot()
    expect((await f.stream.qualifyForStream(f.token))?.user).toMatchObject({ role: 'admin', autoReviewEligible: true, displayName: 'Updated User' })
    expect(await f.snapshot()).toEqual(before)
  })

  const refusals = [
    { state: 'disabled user', target: 'user', sql: "UPDATE harness.users SET status='disabled' WHERE id=$1" },
    { state: 'deleted user', target: 'user', sql: 'UPDATE harness.users SET deleted_at=now() WHERE id=$1' },
    { state: 'disabled membership', target: 'user', sql: "UPDATE harness.memberships SET status='disabled' WHERE user_id=$1" },
    { state: 'removed membership', target: 'user', sql: 'DELETE FROM harness.memberships WHERE user_id=$1' },
    { state: 'password change required', target: 'user', sql: 'UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1' },
    { state: 'removed password identity', target: 'user', sql: 'DELETE FROM harness.password_credentials WHERE user_id=$1' },
    { state: 'revoked session', target: 'session', sql: "UPDATE harness.auth_sessions SET revoked_at=now(),revoked_reason='fixture' WHERE id=$1" },
    { state: 'idle expiry', target: 'session', sql: "UPDATE harness.auth_sessions SET expires_at=now()-interval '1 millisecond' WHERE id=$1" },
    { state: 'absolute expiry', target: 'session', sql: "UPDATE harness.auth_sessions SET absolute_expires_at=now()-interval '1 millisecond' WHERE id=$1" },
  ] as const

  it.each(refusals)('rejects $state and leaves the stored session unchanged', async ({ target, sql }) => {
    const f = await fixture()
    expect(await f.stream.qualifyForStream(f.token)).not.toBeNull()
    await pool.query(sql, [target === 'user' ? f.userId : f.sessionId])
    const before = await f.snapshot()
    expect(await f.stream.qualifyForStream(f.token)).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  })

  it('rejects unknown tokens without modifying another live login', async () => {
    const f = await fixture()
    const before = await f.snapshot()
    expect(await f.stream.qualifyForStream('unknown-stream-token')).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  })

  it('keeps ordinary validation updating idle activity while preserving and capping absolute expiry', async () => {
    const f = await fixture()
    const before = (await f.snapshot())[0]!
    expect((await f.auth.validate(f.token))?.username).toBe('stream-user')
    const slid = (await f.snapshot())[0]!
    expect(slid.last_seen_at).not.toBe(before.last_seen_at)
    expect(slid.absolute_expires_at).toBe(before.absolute_expires_at)
    expect(Date.parse(slid.expires_at)).toBe(Math.min(Date.parse(slid.last_seen_at) + f.cfg.sessionTtlMs, Date.parse(slid.absolute_expires_at)))
    expect(Date.parse(slid.expires_at)).toBeGreaterThan(Date.parse(before.expires_at))
    await pool.query('UPDATE harness.auth_sessions SET absolute_expires_at=to_timestamp($2/1000.0) WHERE id=$1', [f.sessionId, f.now + 1_800_000])
    expect((await f.auth.validate(f.token))?.username).toBe('stream-user')
    const capped = (await f.snapshot())[0]!
    expect(capped.expires_at).toBe(capped.absolute_expires_at)
  })

  it('retains ordinary password-change validation while stream qualification refuses it', async () => {
    const f = await fixture()
    await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [f.userId])
    expect(await f.stream.qualifyForStream(f.token)).toBeNull()
    expect(await f.auth.validate(f.token)).toMatchObject({ username: 'stream-user', mustChangePassword: true })
  })
})
