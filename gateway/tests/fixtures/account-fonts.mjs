/** Actual account font persistence across authenticated Gateway computer contexts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const names = ['postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/account-preferences-service', 'postgres/instance-repository', 'instances', 'server', 'config']
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresAccountPreferencesService }, { PostgresInstanceRepository },
  { InstanceManager }, { createGatewayServer }, { loadConfig }] = await Promise.all(names.map(name => {
    const selected = name === 'postgres/account-preferences-service' && process.env.DSH_ACCOUNT_FONT_OLD_PACKAGE !== undefined
      ? pathToFileURL(`${resolve(process.env.DSH_ACCOUNT_FONT_OLD_PACKAGE)}/${mode}/`) : base
    return import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, selected))
  }))
const { createBrowserAccountPreferencesTransport } = await import('../../../packages/client/connection/src/client/account-preferences.ts')
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 4 }), root = await mkdtemp(join(tmpdir(), 'account-font-http-'))
const servers = [], managers = []
let organizationId, primaryError
try {
  await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = `account-font-${randomUUID()}`
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Account fonts') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'first'),($1,'second')", [organizationId])
  const contexts = await Promise.all(['first', 'second'].map(name => resolvePostgresRuntimeContext(pool, slug, name)))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
    HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  const users = new PostgresUserService(contexts[0], cfg), actors = []
  for (const username of ['first-user', 'second-user']) {
    const user = await users.create({ username, password: 'pw-12345678' })
    await users.changeOwnPassword(user.id, 'pw-12345678'); actors.push(user)
  }
  const directory = join(cfg.usersRoot, actors[0].username, 'dsh'), legacy = join(directory, 'settings.yaml')
  const raw = 'ui-theme:\n  preference: dark\n  fontSize: 18\n  codeFontSize: 15\n  terminalFontSize: 16\n  textFontFamily: Noto Sans\n  codeFontFamily: Fira Code\n  terminalFontFamily: JetBrains Mono\n'
  await mkdir(directory, { recursive: true }); await writeFile(legacy, raw)
  const origins = []
  for (const context of contexts) {
    const nodeConfig = { ...cfg, publicOrigins: [...cfg.publicOrigins] }
    const manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), nodeConfig); managers.push(manager)
    const gateway = createGatewayServer({ cfg: nodeConfig, users: new PostgresUserService(context, nodeConfig),
      projects: new PostgresProjectService(context, nodeConfig), audit: new PostgresAuditService(context),
      instances: manager, userPreferences: new PostgresAccountPreferencesService(context, nodeConfig), auth: new PostgresAuthService(context, nodeConfig) })
    servers.push(gateway)
    await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
    nodeConfig.port = gateway.address().port
    const origin = `http://127.0.0.1:${nodeConfig.port}`; nodeConfig.publicOrigins.push(origin); origins.push(origin)
  }
  const cookies = []
  for (const actor of actors) {
    const login = await fetch(`${origins[0]}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: origins[0], 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
    await login.arrayBuffer(); assert.equal(login.status, 302)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); cookies.push(cookie)
  }
  const transport = (node, actor) => createBrowserAccountPreferencesTransport((path, init) => fetch(origins[node] + path, {
    ...init, headers: { ...init?.headers, origin: origins[node], cookie: cookies[actor] },
  }))
  const first = transport(0, 0), remote = transport(1, 0), other = transport(1, 1)
  const original = await first.describe()
  assert.equal(original.revision, 1); assert.equal(await readFile(legacy, 'utf8'), raw)
  for (const field of ['fontSize', 'codeFontSize', 'terminalFontSize', 'textFontFamily', 'codeFontFamily', 'terminalFontFamily']) assert.ok(field in original.overrides['ui-theme'])
  console.log(JSON.stringify({ scenario: 'personal-import', values: original.values['ui-theme'], retainedLegacy: true }))
  let revision = original.revision
  for (const [field, value] of [['fontSize', 20], ['codeFontSize', 14], ['terminalFontSize', 17], ['textFontFamily', 'Account Text'], ['codeFontFamily', 'Account Code'], ['terminalFontFamily', 'Account Terminal']]) {
    const updated = await first.mutate({ namespace: 'ui-theme', field, operation: 'set', value, expectedRevision: revision,
      ...(field === 'fontSize' ? { userId: actors[1].id } : {}) })
    revision = updated.revision
    assert.equal((await remote.describe()).values['ui-theme'][field], value)
    assert.equal(updated.values['ui-theme'][field], value)
    assert.notEqual((await other.describe()).values['ui-theme'][field], value)
    console.log(JSON.stringify({ scenario: 'account-field', field, value, secondComputer: true, otherAccountIsolated: true, accountRoute: true }))
  }
  await first.mutate({ namespace: 'ui-theme', field: 'fontSize', operation: 'unset', expectedRevision: revision })
  await writeFile(legacy, raw.replace('fontSize: 18', 'fontSize: 22'))
  const reset = await remote.describe(); assert.equal(reset.values['ui-theme'].fontSize, 14); assert.equal('fontSize' in reset.overrides['ui-theme'], false)
  console.log(JSON.stringify({ scenario: 'reset-retained', fontSize: 14, revision: reset.revision, accountRoute: true }))
  await pool.query("UPDATE harness.users SET status='disabled' WHERE organization_id=$1 AND public_id=$2", [organizationId, actors[0].id])
  await assert.rejects(() => remote.mutate({ namespace: 'ui-theme', field: 'fontSize', operation: 'set', value: 21 }), error => error.status === 401 || error.status === 403)
  assert.equal((await other.describe()).values['ui-theme'].fontSize, 14)
  console.log(JSON.stringify({ scenario: 'revoked-account', denied: true, otherAccountFontSize: 14 }))
} catch (error) { primaryError = error; throw error }
finally {
  const errors = [], settle = async fn => { try { await fn() } catch (error) { errors.push(error) } }
  for (const manager of managers) await settle(() => manager.stopAll())
  for (const server of servers) if (server.listening) await settle(() => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  if (organizationId !== undefined) await settle(async () => {
    const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
    for (let pass = 0; pass < 12; pass++) {
      let blocked = false
      for (const { table_name: table } of tables) {
        try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
        catch (error) { if (error.code === '23503') blocked = true; else throw error }
      }
      if (!blocked) break
    }
    await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId])
    await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
  })
  await settle(() => pool.end()); await settle(() => rm(root, { recursive: true, force: true }))
  if (errors.length) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Account font fixture cleanup failed')
}
