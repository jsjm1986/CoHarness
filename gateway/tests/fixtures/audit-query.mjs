/** Authenticated audit filtering and pagination through both actual Gateway stores. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, backend, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(backend === 'sqlite' || backend === 'postgres')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ openDb }, { UserService }, { ProjectService }, { AuthService }, { AuditService }, { InstanceManager },
  { loadConfig }, { createGatewayServer }, { createAdminApiHandler }, { createPostgresPool, runMigrations },
  { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService }, { PostgresAuthService },
  { PostgresAuditService }, { PostgresInstanceRepository }] = await Promise.all([
  'db', 'users', 'projects', 'auth', 'audit', 'instances', 'config', 'server', 'admin-api', 'postgres/database',
  'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))

const root = await mkdtemp(join(tmpdir(), 'audit-query-replay-'))
const browserRoot = process.env.DSH_AUDIT_BROWSER_ROOT
if (browserRoot !== undefined) assert.equal(typeof process.send, 'function', 'Browser replay requires a parent IPC channel')
let db, pool, organizationId, manager, server, primaryError
let releaseOlder, finishBrowser, messageHandler
try {
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
    HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  let context
  if (backend === 'postgres') {
    const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
    pool = createPostgresPool(databaseUrl, { max: 1 })
    await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
    const slug = `audit-query-${randomUUID()}`
    organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Audit query') RETURNING id", [slug])).rows[0].id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  } else db = openDb(join(root, 'gateway.sqlite'))
  const users = context === undefined ? new UserService(db, cfg) : new PostgresUserService(context, cfg)
  const audit = context === undefined ? new AuditService(db) : new PostgresAuditService(context)
  manager = new InstanceManager(context === undefined ? db : new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
  const deps = { cfg, users, audit, instances: manager,
    projects: context === undefined ? new ProjectService(db, cfg) : new PostgresProjectService(context, cfg),
    auth: context === undefined ? new AuthService(db, cfg) : new PostgresAuthService(context, cfg) }
  const admin = await users.create({ username: 'audit-admin', password: 'pw-12345678', role: 'admin' })
  await users.changeOwnPassword(admin.id, 'pw-12345678')
  assert.equal(await manager.stateOf(admin.id), 'stopped')
  const handler = createAdminApiHandler(deps)
  const olderGate = new Promise(done => { releaseOlder = done })
  const browserLifetime = new Promise(done => { finishBrowser = done })
  let olderArmed = browserRoot !== undefined
  messageHandler = message => {
    if (message === 'release-older') releaseOlder()
    if (message === 'close') { releaseOlder(); finishBrowser() }
  }
  if (browserRoot !== undefined) {
    process.on('message', messageHandler)
    process.once('disconnect', finishBrowser)
  }
  server = createGatewayServer(deps, {
    ...(browserRoot === undefined ? {} : { adminRoot: browserRoot }),
    admin: async (...args) => {
      if (olderArmed && args[3] === '/admin/api/audit' && !new URL(args[0].url, 'http://fixture').searchParams.has('family')) {
        olderArmed = false; process.send({ kind: 'older-entered' }); await olderGate
      }
      return handler(...args)
    },
  })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const origin = `http://127.0.0.1:${server.address().port}`; cfg.publicOrigins.push(origin)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: admin.username, password: 'pw-12345678' }) })
  await login.arrayBuffer(); assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const entries = [
    { action: 'audit-check.ordinary', status: 200, outcome: 'success' },
    { action: 'audit-check.http.failed', status: 204, outcome: 'success' },
    { action: 'audit-check.upper.FAILED', outcome: 'success' },
    { action: 'audit-check.line.error\n', outcome: 'success' },
    ...['failed', 'denied', 'locked', 'error'].map(suffix => ({ action: `audit-check.no-status.${suffix}`, outcome: 'failure' })),
    { action: 'audit-check.no-status.restart-failed', outcome: 'failure' },
    { action: 'audit-check.http', status: 503, outcome: 'failure' },
  ]
  for (const { action, status } of entries) await audit.write({ userId: admin.id, action, status, detail: '{"password":"private-audit-detail"}' })
  entries.reverse()
  if (browserRoot !== undefined) {
    process.send({ kind: 'ready', origin, cookie })
    await browserLifetime
    releaseOlder()
    if (process.connected) process.disconnect()
  } else {
    for (const scenario of ['all', 'success', 'failure', 'page', 'negative-clamp', 'maximum-clamp', 'zero-clamp']) {
      const q = new URLSearchParams({ actionPrefix: 'audit-check.' })
      const outcome = scenario === 'success' || scenario === 'failure' ? scenario : scenario === 'page' ? 'failure' : undefined
      if (outcome !== undefined) q.set('outcome', outcome)
      if (scenario === 'page') { q.set('limit', '2'); q.set('offset', '1') }
      if (scenario === 'negative-clamp') { q.set('limit', '-2'); q.set('offset', '-3') }
      if (scenario === 'maximum-clamp') q.set('limit', '900')
      if (scenario === 'zero-clamp') { q.set('limit', '0'); q.set('offset', '1') }
      const response = await fetch(`${origin}/admin/api/audit?${q}`, { headers: { cookie } })
      assert.equal(response.status, 200)
      const body = await response.json(), total = Number(response.headers.get('x-total-count'))
      let expected = entries.filter(row => outcome === undefined || row.outcome === outcome)
      assert.equal(total, expected.length)
      if (scenario === 'page') expected = expected.slice(1, 3)
      if (scenario === 'negative-clamp') expected = expected.slice(0, 1)
      if (scenario === 'zero-clamp') expected = expected.slice(1, 2)
      const rows = body.map(({ action, outcome, status }) => ({ action, outcome, status }))
      assert.deepEqual(rows, expected.map(({ action, outcome, status }) => ({ action, outcome, status: status ?? null })))
      assert.ok(!JSON.stringify(body).includes('private-audit-detail'))
      console.log(JSON.stringify({ backend, scenario, status: response.status, total, rows }))
    }
    for (const query of ['limit=1.5', 'offset=1.5', 'limit=1e100', 'offset=1e100', 'offset=9007199254740992']) {
      const response = await fetch(`${origin}/admin/api/audit?${query}`, { headers: { cookie } })
      const body = await response.json(); assert.equal(response.status, 400)
      assert.deepEqual(body, { error: 'invalid audit pagination' })
      console.log(JSON.stringify({ backend, query, status: response.status, error: body.error }))
    }
  }
} catch (error) {
  primaryError = error
  throw error
} finally {
  const failures = []
  const close = async work => { try { await work() } catch (error) { failures.push(error) } }
  releaseOlder?.()
  if (messageHandler !== undefined) process.removeListener('message', messageHandler)
  if (finishBrowser !== undefined) process.removeListener('disconnect', finishBrowser)
  await close(async () => { await manager?.stopAll() })
  if (server?.listening) await close(async () => {
    server.closeAllConnections()
    await new Promise((ready, reject) => server.close(error => error ? reject(error) : ready()))
  })
  await close(async () => { db?.close() })
  if (organizationId !== undefined) await close(async () => {
    for (const table of ['instances', 'runtime_environments', 'auth_sessions', 'audit_events', 'login_attempts',
      'memberships', 'users', 'outbox', 'compute_nodes']) await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
    await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
  })
  await close(async () => { await pool?.end() })
  await close(async () => { await rm(root, { recursive: true, force: true }) })
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Audit query replay cleanup failed')
}
