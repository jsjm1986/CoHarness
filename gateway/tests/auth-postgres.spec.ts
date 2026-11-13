/** Cross-Gateway login admission over the real PostgreSQL lock namespace. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { testConfig } from './test-config.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { InstanceManager } from '../src/instances.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { barrier } from './barrier.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL login admission', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it.each(['release', 'role', 'organization', 'membership', 'disabled', 'revoked', 'credential', 'idle', 'absolute'] as const)(
    'keeps browser authority current without holding the session lock during %s result delivery', async (change) => {
      const releases: Array<() => Promise<void>> = []
      onTestFinished(async () => {
        const failures: unknown[] = []
        for (const release of releases.reverse()) {
          try { await release() } catch (error) { failures.push(error) }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Authentication delivery fixture cleanup failed')
      })
      const root = await mkdtemp(join(tmpdir(), 'hgw-auth-delivery-'))
      releases.push(() => rm(root, { recursive: true, force: true }))
      const slug = `auth-delivery-${randomUUID()}`
      const organizationId = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,'Authentication delivery') RETURNING id`, [slug])).rows[0]!.id
      releases.push(() => removeFixtureOrganization(pool, organizationId))
      await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'auth-node')`, [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'auth-node'), cfg = testConfig(root)
      const users = new PostgresUserService(context, cfg)
      await users.create({ username: 'keeper', password: 'correct-password', role: 'admin' })
      const actor = await users.create({ username: 'actor', password: 'correct-password', role: 'admin' })
      await users.changeOwnPassword(actor.id, 'correct-password')
      const login = await new PostgresAuthService(context, cfg).login('actor', 'correct-password', '127.0.0.1', 'delivery fixture')
      if (typeof login === 'string') throw new Error('Authentication fixture login failed')
      const tokenHash = createHash('sha256').update(login.token).digest()
      const entered = barrier(), delivery = barrier()
      const readerPool = createPostgresPool(databaseUrl!, { max: 1 })
      releases.push(() => readerPool.end())
      let paused = false
      readerPool.on('connect', client => {
        const original = client.query.bind(client)
        // pg exposes both callback and Promise query overloads; preserve the original arguments and result.
        client.query = ((...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : ''
          const hold = sql.includes('harness.auth_sessions') && !paused
          const pause = (): Promise<void> => { paused = true; entered.resolve(); return delivery.promise }
          const callback = args.at(-1)
          if (typeof callback === 'function') {
            args[args.length - 1] = (...values: unknown[]) => {
              if (!hold || values[0] !== null && values[0] !== undefined) {
                Reflect.apply(callback, client, values); return
              }
              void pause().then(() => { Reflect.apply(callback, client, values) })
            }
          }
          const result: unknown = Reflect.apply(original, client, args)
          if (typeof callback !== 'function' && hold) {
            return Promise.resolve(result).then(async value => { await pause(); return value })
          }
          return result
        }) as typeof client.query
      })
      const instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
      releases.push(() => instances.stopAll())
      const deps: GatewayDeps = { cfg, users, instances, projects: new PostgresProjectService(context, cfg),
        auth: new PostgresAuthService({ ...context, pool: readerPool }, cfg), audit: new PostgresAuditService(context) }
      const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
      releases.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) })
      })
      await new Promise<void>(done => { server.listen(0, '127.0.0.1', done) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const pending = fetch(`${base}/admin/api/users`, { headers: { cookie: `hgw_session=${login.token}` } })
      void pending.catch(() => {})
      releases.push(async () => {
        delivery.resolve()
        await pending.then(async response => { if (!response.bodyUsed) await response.body?.cancel() })
      })
      await entered.promise
      let lockReleased = false
      if (change === 'release') {
        const probe = await pool.connect()
        try {
          await probe.query('BEGIN')
          try {
            await probe.query(`SELECT id FROM harness.auth_sessions
              WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE NOWAIT`, [organizationId, tokenHash])
            lockReleased = true
          } catch (error) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')) throw error
          }
        } finally { await probe.query('ROLLBACK'); probe.release() }
        expect(lockReleased).toBe(true)
      } else if (change === 'role') await users.patch(actor.id, { role: 'user' })
      else if (change === 'organization') await pool.query(`UPDATE harness.organizations SET status='disabled' WHERE id=$1`, [organizationId])
      else if (change === 'membership') await pool.query(`UPDATE harness.memberships m SET status='disabled'
        FROM harness.users u WHERE m.user_id=u.id AND m.organization_id=$1 AND u.public_id=$2`, [organizationId, actor.id])
      else if (change === 'disabled') await users.patch(actor.id, { status: 'disabled' })
      else if (change === 'revoked') await new PostgresAuthService(context, cfg).revoke(login.token)
      else if (change === 'credential') await pool.query(`UPDATE harness.password_credentials c SET must_change_password=true
        FROM harness.users u WHERE c.user_id=u.id AND u.organization_id=$1 AND u.public_id=$2`, [organizationId, actor.id])
      else await pool.query(`UPDATE harness.auth_sessions SET ${change === 'idle' ? 'expires_at' : 'absolute_expires_at'}=clock_timestamp()
        WHERE organization_id=$1 AND token_hash=$2`, [organizationId, tokenHash])
      delivery.resolve()
      const response = await pending
      await response.arrayBuffer()
      expect(response.status).toBe(change === 'release' ? 200 : change === 'role' || change === 'credential' ? 403 : 401)
      await expect(['# Browser authentication during database result delivery', '', `change=${change}`,
        'deliveryPaused=true', ...(change === 'release' ? [`sessionLockReleased=${String(lockReleased)}`] : []),
        `status=${String(response.status)}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/auth/delivery-${change}.expected.md`))
    },
  )

  it.each(['role', 'idle', 'absolute', 'idle-clock', 'absolute-clock', 'issuance', 'failed-attempt', 'lockout-window'] as const)(
    'rechecks %s after browser authentication waits', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-auth-wait-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const slug = `auth-wait-${randomUUID()}`
    const org = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Auth wait') RETURNING id`, [slug])
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'auth-node')`, [org.rows[0]!.id])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'auth-node'), cfg = testConfig(root)
    const users = new PostgresUserService(context, cfg)
    await users.create({ username: 'keeper', password: 'correct-password', role: 'admin' })
    const actor = await users.create({ username: 'actor', password: 'correct-password', role: 'admin' })
    await users.changeOwnPassword(actor.id, 'correct-password')
    const applicationName = `auth-wait-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const readerPool = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName, lock_timeout: 15_000 })
    const readerContext = { ...context, pool: readerPool }
    const instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
    const deps: GatewayDeps = { cfg, users, instances, projects: new PostgresProjectService(context, cfg),
      auth: new PostgresAuthService(readerContext, cfg), audit: new PostgresAuditService(context) }
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
    const blocker = await pool.connect()
    let pending: Promise<Response> | undefined
    let clockSchema: string | undefined
    let beforeClockWait: { last_seen_at: Date; expires_at: Date; absolute_expires_at: Date } | undefined
    try {
      await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const signIn = () => fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'actor', password: kind === 'failed-attempt' ? 'wrong-password' : 'correct-password' }) })
      const waitForLock = async () => {
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting`,
        [applicationName])).rows[0]!.waiting).toBe(true)
      }
      if (kind === 'issuance' || kind === 'failed-attempt' || kind === 'lockout-window') {
        if (kind === 'lockout-window') {
          await pool.query(`INSERT INTO harness.login_attempts(organization_id,username,source_ip,occurred_at,succeeded)
            SELECT $1,'actor','127.0.0.1'::inet,clock_timestamp(),false FROM generate_series(1,5)`, [context.organizationId])
        }
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-login:${context.organizationId}:actor`])
        pending = signIn()
        await waitForLock()
        const instant = (await pool.query<{ at: string }>('SELECT clock_timestamp()::text at')).rows[0]!.at
        if (kind === 'lockout-window') {
          await pool.query(`UPDATE harness.login_attempts SET occurred_at=clock_timestamp()-interval '10 minutes'
            WHERE organization_id=$1 AND username='actor'`, [context.organizationId])
        }
        await blocker.query('COMMIT')
        const response = await pending
        expect(response.status).toBe(kind === 'failed-attempt' ? 401 : 302)
        if (kind === 'failed-attempt') {
          const attempt = (await pool.query<{ after_wait: boolean }>(`SELECT occurred_at >= $2::timestamptz after_wait
            FROM harness.login_attempts WHERE organization_id=$1 AND username='actor'`, [context.organizationId, instant])).rows[0]!
          expect(attempt.after_wait).toBe(true)
          await expect(['# Failed browser login after a lock wait', '', 'observedLockWait=true',
            `status=${String(response.status)}`, `recordedAfterWait=${String(attempt.after_wait)}`, '',
          ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/wait-failed-attempt.expected.md'))
          return
        }
        if (kind === 'lockout-window') {
          const failures = (await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM harness.login_attempts
            WHERE organization_id=$1 AND username='actor' AND NOT succeeded`, [context.organizationId])).rows[0]!.n
          expect(failures).toBe('0')
          await expect(['# Expired login failures after a lock wait', '', 'observedLockWait=true',
            `status=${String(response.status)}`, `remainingFailures=${failures}`, '',
          ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/wait-lockout-window.expected.md'))
          return
        }
        const issued = (await pool.query<{ after_wait: boolean; full_idle: boolean }>(`SELECT created_at >= $2::timestamptz after_wait,
          expires_at-created_at >= ($3::double precision * interval '1 millisecond') full_idle
          FROM harness.auth_sessions WHERE organization_id=$1`, [context.organizationId, instant, cfg.sessionTtlMs])).rows[0]!
        expect(issued).toEqual({ after_wait: true, full_idle: true })
        await expect(['# Browser login issuance after a lock wait', '', 'observedLockWait=true',
          `status=${String(response.status)}`, `createdAfterWait=${String(issued.after_wait)}`, `fullIdleLifetime=${String(issued.full_idle)}`, '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/wait-issuance.expected.md'))
        return
      }
      const login = await signIn()
      expect(login.status).toBe(302)
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
      const token = cookie.slice('hgw_session='.length)
      const tokenHash = createHash('sha256').update(token).digest()
      expect((await fetch(`${base}/admin/api/users`, { headers: { cookie } })).status).toBe(200)
      if (kind === 'idle-clock' || kind === 'absolute-clock') {
        clockSchema = `auth_clock_${randomUUID().replaceAll('-', '')}`
        await pool.query(`CREATE SCHEMA "${clockSchema}"`)
        if (kind === 'absolute-clock') await pool.query(`UPDATE harness.auth_sessions SET expires_at=absolute_expires_at
          WHERE organization_id=$1 AND token_hash=$2`, [context.organizationId, tokenHash])
        await pool.query(`CREATE TABLE "${clockSchema}".clock AS
          SELECT expires_at-interval '1 minute' current_at,expires_at+interval '1 minute' expired_at
          FROM harness.auth_sessions WHERE organization_id=$1 AND token_hash=$2`, [context.organizationId, tokenHash])
        await pool.query(`CREATE FUNCTION "${clockSchema}".clock_now() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS
          'BEGIN RETURN (SELECT current_at FROM "${clockSchema}".clock); END'`)
        const clockCall = `"${clockSchema}".clock_now()`
        const reader = await readerPool.connect()
        const original = reader.query.bind(reader)
        // Substitute only the fixture's database clock; statement execution and locking remain PostgreSQL-owned.
        reader.query = ((...args: unknown[]) => {
          if (typeof args[0] === 'string') args[0] = args[0].replaceAll('clock_timestamp()', clockCall)
          return Reflect.apply(original, reader, args)
        }) as typeof reader.query
        reader.release()
        beforeClockWait = (await pool.query<{ last_seen_at: Date; expires_at: Date; absolute_expires_at: Date }>(`SELECT
          last_seen_at,expires_at,absolute_expires_at FROM harness.auth_sessions
          WHERE organization_id=$1 AND token_hash=$2`, [context.organizationId, tokenHash])).rows[0]!
      }
      await blocker.query('BEGIN')
      await blocker.query(`SELECT id FROM harness.auth_sessions
        WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE`, [context.organizationId, tokenHash])
      pending = fetch(`${base}/admin/api/users`, { headers: { cookie } })
      await waitForLock()
      if (kind === 'role') await users.patch(actor.id, { role: 'user' })
      else if (clockSchema !== undefined) {
        await pool.query(`UPDATE "${clockSchema}".clock SET current_at=expired_at`)
      } else {
        const column = kind === 'idle' ? 'expires_at' : 'absolute_expires_at'
        await blocker.query(`UPDATE harness.auth_sessions SET ${column}=clock_timestamp()
          WHERE organization_id=$1 AND token_hash=$2`, [context.organizationId, tokenHash])
      }
      await blocker.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(kind === 'role' ? 403 : 401)
      if (beforeClockWait !== undefined) {
        const after = (await pool.query(`SELECT last_seen_at,expires_at,absolute_expires_at
          FROM harness.auth_sessions WHERE organization_id=$1 AND token_hash=$2`, [context.organizationId, tokenHash])).rows[0]
        expect(after).toEqual(beforeClockWait)
      }
      const body: unknown = await response.json()
      await expect(['# Browser authentication after a row-lock wait', '', `change=${kind}`, 'observedLockWait=true',
        `status=${String(response.status)}`, `body=${JSON.stringify(body)}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/auth/wait-${kind}.expected.md`))
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending?.then(async (response) => { if (!response.bodyUsed) await response.body?.cancel() })
      server.closeAllConnections()
      await new Promise<void>((ready, reject) => { server.close(error => { if (error) reject(error); else ready() }) })
      await instances.stopAll()
      await readerPool.end()
      if (clockSchema !== undefined) await pool.query(`DROP SCHEMA "${clockSchema}" CASCADE`)
    }
  })

  it('revokes a session that is briefly locked by a concurrent renewal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-revoke-wait-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const slug = `revoke-wait-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Revoke wait') RETURNING id`, [slug])).rows[0]!.id
    onTestFinished(() => removeFixtureOrganization(pool, organizationId))
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'auth-node')`, [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'auth-node'), cfg = testConfig(root)
    const users = new PostgresUserService(context, cfg)
    await users.create({ username: 'actor', password: 'correct-password', role: 'user' })
    const login = await new PostgresAuthService(context, cfg).login('actor', 'correct-password', '127.0.0.1', 'revoke fixture')
    if (typeof login === 'string') throw new Error('Authentication fixture login failed')
    const tokenHash = createHash('sha256').update(login.token).digest()
    const contendedPool = createPostgresPool(databaseUrl!, { max: 1, lock_timeout: 100 })
    onTestFinished(() => contendedPool.end())
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT id FROM harness.auth_sessions
        WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE`, [organizationId, tokenHash])
      const revoke = new PostgresAuthService({ ...context, pool: contendedPool }, cfg).revoke(login.token)
      await new Promise(resolve => setTimeout(resolve, 300))
      await blocker.query('COMMIT')
      await expect(revoke).resolves.toBeUndefined()
      const row = (await pool.query<{ reason: string | null }>(`SELECT revoked_reason::text reason
        FROM harness.auth_sessions WHERE organization_id=$1 AND token_hash=$2`, [organizationId, tokenHash])).rows[0]!
      expect(row.reason).toBe('logout')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  })

  it.each([
    { identity: 'member', alias: 'MEMBER', kind: 'ASCII' },
    { identity: 'client', alias: 'clİent', kind: 'PostgreSQL locale' },
  ])('serializes $kind case variants across Gateway instances before counting failures', async ({ identity, alias, kind }) => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-login-admission-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const slug = `login-${randomUUID()}`
    const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Login admission') RETURNING id`, [slug])
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'login-node')`,
      [organization.rows[0]!.id])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'login-node')
    const cfg = testConfig(root)
    await new PostgresUserService(context, cfg).create({ username: identity, password: 'correct-password' })
    const equivalent = await pool.query<{ same: boolean }>('SELECT $1::citext=$2::citext same', [identity, alias])
    if (kind === 'ASCII') expect(equivalent.rows[0]!.same).toBe(true)
    const first = new PostgresAuthService(context, cfg)
    const second = new PostgresAuthService(context, cfg)
    if (!equivalent.rows[0]!.same) {
      expect(await first.login(alias, 'correct-password', '127.0.0.1', 'fixture')).toBe('invalid')
      expect(await second.login(identity, 'correct-password', '127.0.0.1', 'fixture')).toMatchObject({ user: { username: identity } })
      return
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await first.login(identity, 'wrong-password', '127.0.0.1', 'fixture')).toBe('invalid')
    }

    const blocker = await pool.connect()
    const key = `gateway-login:${context.organizationId}:${identity}`
    const pending: Array<Promise<unknown>> = []
    let upperSettled = false
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      pending.push(first.login(identity, 'wrong-password', '127.0.0.1', 'first'))
      pending.push(second.login(alias, 'wrong-password', '127.0.0.1', 'second').finally(() => { upperSettled = true }))
      await expect.poll(async () => {
        const waiting = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM pg_locks
          WHERE locktype='advisory' AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
            AND objid=(hashtext($1)::bigint & 4294967295)::oid`, [key])
        return Number(waiting.rows[0]!.n) === 2 || upperSettled
      }).toBe(true)
      expect(upperSettled).toBe(false)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await Promise.allSettled(pending)
    }
    const outcomes = (await Promise.all(pending)).sort()
    expect(outcomes).toEqual(['invalid', 'locked'])
    const failures = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM harness.login_attempts
      WHERE organization_id=$1 AND username=$2 AND succeeded=false`, [context.organizationId, identity])
    expect(failures.rows[0]!.n).toBe('5')
    const afterLockout = await first.login(alias, 'correct-password', '127.0.0.1', 'fixture')
    expect(afterLockout).toBe('locked')
    const otherSource = await second.login(alias, 'correct-password', '203.0.113.7', 'fixture')
    expect(otherSource).toMatchObject({ user: { username: identity } })
    expect(await first.login(identity, 'correct-password', '127.0.0.1', 'fixture')).toBe('locked')
    await expect(['# Shared PostgreSQL login admission', '',
      `identity=${identity}`, `alias=${alias}`, `concurrentOutcomes=${outcomes.join(',')}`,
      `failedAttempts=${failures.rows[0]!.n}`, `validPasswordAfterLockout=${afterLockout}`,
      `validPasswordFromOtherSource=${otherSource === 'invalid' || otherSource === 'locked' ? otherSource : 'accepted'}`, '',
    ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/auth/lockout-${identity}.expected.md`))
  })

  it('locks one source bucket after 20 failures across usernames across Gateway instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-login-source-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const slug = `login-source-${randomUUID()}`
    const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Login source') RETURNING id`, [slug])
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'login-node')`,
      [organization.rows[0]!.id])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'login-node')
    const cfg = testConfig(root)
    await new PostgresUserService(context, cfg).create({ username: 'owner', password: 'correct-password' })
    const first = new PostgresAuthService(context, cfg)
    const second = new PostgresAuthService(context, cfg)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const service = attempt % 2 === 0 ? first : second
      expect(await service.login(`guess-${String(attempt)}`, 'wrong-password', `2001:db8:1:2::${(attempt + 1).toString(16)}`, 'fixture')).toBe('invalid')
    }
    expect(await first.login('owner', 'correct-password', '2001:db8:1:2:ffff::1', 'fixture')).toBe('locked')
    expect(await second.login('owner', 'correct-password', '2001:db8:1:3::1', 'fixture')).toMatchObject({ user: { username: 'owner' } })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await first.login(`loopback-${String(attempt)}`, 'wrong-password', '127.0.0.1', 'fixture')).toBe('invalid')
    }
    expect(await second.login('owner', 'correct-password', '127.0.0.1', 'fixture')).toMatchObject({ user: { username: 'owner' } })
  })
})
