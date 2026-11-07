/** Authenticated account preference authority and retry through the actual PostgreSQL Gateway. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresAccountPreferencesService }, { PostgresInstanceRepository },
  { InstanceManager }, { createGatewayServer }, { loadConfig }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/account-preferences-service', 'postgres/instance-repository', 'instances', 'server', 'config',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 1 })
try {
  await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const changes = ['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current']
  const scenarios = ['GET', 'PATCH'].flatMap(method => changes.map(change => ({ method, change })))
  scenarios.push({ method: 'GET', change: 'legacy-io' })
  scenarios.push({ method: 'GET', change: 'legacy-fifo' })
  for (const { method, change } of scenarios) {
    const root = await mkdtemp(join(tmpdir(), 'account-preference-http-'))
    let organizationId, gateway, manager, pending, release, primaryError
    try {
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
        HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
      const slug = `account-preference-http-${randomUUID()}`
      organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Account preference HTTP') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const audit = new PostgresAuditService(context), preferences = new PostgresAccountPreferencesService(context, cfg)
      const actor = await users.create({ username: 'member', password: 'pw-12345678' })
      await users.changeOwnPassword(actor.id, 'pw-12345678')
      const other = await users.create({ username: 'other', password: 'pw-12345678' })
      await preferences.mutate(other, { namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'light' })
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const directory = join(cfg.usersRoot, actor.username, 'dsh'), legacy = join(directory, 'settings.yaml')
      if (change === 'legacy-io') { await mkdir(directory, { recursive: true }); await symlink('settings.yaml', legacy) }
      if (change === 'legacy-fifo') { await mkdir(directory, { recursive: true }); await promisify(execFile)('mkfifo', [legacy]) }
      let entered
      const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
      const member = method === 'GET' ? 'describe' : 'mutate', operation = preferences[member].bind(preferences)
      let queued = true
      preferences[member] = async (...args) => { if (queued) { queued = false; entered(); await gate } return operation(...args) }
      manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
      gateway = createGatewayServer({ cfg, users, projects, audit, instances: manager, userPreferences: preferences, auth: new PostgresAuthService(context, cfg) })
      await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
      cfg.port = gateway.address().port
      const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      pending = fetch(`${origin}/account/api/preferences`, { method, headers: { cookie, origin, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'dark', expectedRevision: 0, userId: other.id, username: other.username }) }),
      }).then(async response => ({ status: response.status, cache: response.headers.get('cache-control'), value: await response.json() }))
      await observed
      if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
      if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
      if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
      if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
      if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      release()
      const response = await pending, legacyFailure = change === 'legacy-io' || change === 'legacy-fifo'
      const expected = change === 'current' ? 200 : legacyFailure ? 503 : 403
      assert.equal(response.status, expected)
      const initialized = (await pool.query('SELECT revision::text FROM harness.user_preferences WHERE organization_id=$1 AND user_id=$2', [organizationId, internal])).rows
      assert.equal(initialized.length, change === 'current' ? 1 : 0)
      if (expected === 403) assert.equal(response.value.error, 'forbidden')
      if (expected === 503) { assert.equal(response.value.error, 'account-preferences-unavailable'); assert.equal(response.cache, 'no-store'); assert.ok(!JSON.stringify(response.value).includes(root)) }
      let recoveredTheme = null
      if (legacyFailure) {
        await rm(legacy); await writeFile(legacy, 'ui-theme:\n  preference: dark\n')
        const retry = await fetch(`${origin}/account/api/preferences`, { headers: { cookie } }); assert.equal(retry.status, 200)
        recoveredTheme = (await retry.json()).values['ui-theme'].preference; assert.equal(recoveredTheme, 'dark')
      }
      if (change !== 'disabled-organization') assert.equal((await preferences.describe(other)).values['ui-theme'].preference, 'light')
      const successes = await audit.query({ action: 'account-preference.updated' })
      assert.equal(successes.length, method === 'PATCH' && change === 'current' ? 1 : 0)
      console.log(JSON.stringify({ method, change, status: response.status, error: response.value.error ?? null, initialRows: initialized.length, revision: response.value.revision ?? null, successfulAudit: successes.length, recoveredTheme }))
    } catch (error) { primaryError = error; throw error }
    finally {
      const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
      release?.(); await close(async () => { await pending }); await close(async () => { await manager?.stopAll() })
      if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
      if (organizationId !== undefined) await close(async () => {
        const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
        for (let pass = 0; pass < 12; pass += 1) {
          let blocked = false
          for (const { table_name: table } of tables) {
            try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
            catch (error) { if (error.code === '23503') blocked = true; else throw error }
          }
          if (!blocked) break
        }
        await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId]); await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
      })
      await close(() => rm(root, { recursive: true, force: true }))
      if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Account preference HTTP cleanup failed')
    }
  }
} finally { await pool.end() }
