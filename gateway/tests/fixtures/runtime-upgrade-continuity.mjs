/** Real Gateway admission and a supervised process retain admitted work across an incompatible release. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeRelay } from '../runtime-relay.ts'
import { testConfig } from '../test-config.ts'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const mode = process.argv[2]
assert.equal(mode, 'src')
const load = name => import(new URL(`../../src/${name}.ts`, import.meta.url))
const [{ createPostgresPool, runMigrations }, { PostgresUserService }, { PostgresProjectService }, { PostgresAuthService }, { PostgresAuditService }, { InstanceManager },
  { createGatewayServer }, { createAdminApiHandler }, { PostgresInstanceRepository }, { resolvePostgresRuntimeContext }] = await Promise.all([
  'postgres/database', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service', 'postgres/audit-service', 'instances', 'server', 'admin-api',
  'postgres/instance-repository', 'postgres/runtime-context',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const administration = createPostgresPool(databaseUrl, { max: 1 })
const database = `upgrade_continuity_${randomUUID().replaceAll('-', '')}_test`
const root = await mkdtemp(join(tmpdir(), 'hgw-upgrade-continuity-'))
const cleanup = []
let pool, created = false, original, upgraded, server, held
try {
  await administration.query(`CREATE DATABASE ${database}`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = createPostgresPool(url.href, { max: 2 })
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  const slug = `continuity-${randomUUID()}`
  const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Upgrade continuity') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  const marker = join(root, 'runtime.json')
  const cfg = testConfig(root, { HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE: 'local', HGW_GUARD_PATCH: 'off', HGW_DSH_REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    HGW_PERFORMANCE_ENABLED: 'false', // This fixture reserves stdout for its transcript.
    HGW_READINESS_TIMEOUT_MS: '30000' })
  cfg.dshCommand = [process.execPath, '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./readiness-runtime.mjs', import.meta.url)),
    new URL('../../src/runtime-readiness.ts', import.meta.url).href, marker, 'retained-work', join(root, 'probe.json')]
  const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
  const actor = await users.create({ username: 'operator', password: 'pw-12345678', role: 'admin' })
  await users.changeOwnPassword(actor.id, 'pw-12345678')
  const port = await runtimeRelay(marker, disposer => cleanup.push(disposer), 'json')
  const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
  await repository.initialize()
  const target = await repository.resolveTarget({ kind: 'user', id: actor.id })
  await pool.query('UPDATE harness.instances SET port=$1 WHERE organization_id=$2 AND runtime_id=$3', [port, organizationId, target.runtimeId])
  original = new InstanceManager(repository, cfg)
  await original.ensureRunning({ ...actor, runtimeId: target.runtimeId })
  held = await fetch(`http://127.0.0.1:${port}/hold`)
  assert.equal(held.status, 200)
  await original.stopAll(true)

  const next = { ...cfg, streamPrincipalRenewal: !cfg.streamPrincipalRenewal }
  upgraded = new InstanceManager(repository, next)
  assert.deepEqual(await upgraded.inspectUpgradeSurvivors(), { compatible: 0, pending: 1 })
  await upgraded.reconcile()
  const deps = { cfg: next, users, projects, instances: upgraded, auth: new PostgresAuthService(context, next), audit: new PostgresAuditService(context) }
  server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const origin = `http://127.0.0.1:${server.address().port}`
  next.publicOrigins.push(origin)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
  await login.arrayBuffer(); assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const start = await fetch(`${origin}/admin/api/users/${actor.id}/instance/start`, { method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' })
  const result = await start.json()
  assert.equal(start.status, 503, JSON.stringify(result))
  assert.equal(result.code, 'INSTANCE_UNAVAILABLE')
  assert.equal(result.error, 'This Runtime process is retained and awaiting a safe upgrade. Gateway restarts can interrupt tasks. Ask an administrator to confirm a safe stopping point before stopping and restarting it.')
  const completed = await fetch(`http://127.0.0.1:${port}/finish`); await completed.arrayBuffer()
  assert.equal(await held.text(), 'completed-after-upgrade')
  assert.equal(await upgraded.stateOf(actor.id), 'ready')
  console.log(JSON.stringify({ scenario: 'incompatible-release', newAdmission: start.status, code: result.code, message: result.error, existingWork: 'completed', retainedState: 'ready' }))
  await upgraded.stop(actor.id, 'manual', actor.id)
  assert.equal(await upgraded.stateOf(actor.id), 'stopped')
  assert.equal((await upgraded.reconcile()).warmed, 0)
  console.log(JSON.stringify({ scenario: 'explicit-administrator-stop', state: 'stopped', automaticallyRestarted: false }))
} finally {
  const failures = []
  const settle = async operation => { try { await operation() } catch (error) { failures.push(error) } }
  if (server?.listening) await settle(() => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  if (held && !held.bodyUsed) await settle(() => held.body.cancel())
  if (upgraded) await settle(() => upgraded.stopAll())
  if (original) await settle(() => original.stopAll())
  for (const dispose of cleanup.reverse()) await settle(dispose)
  if (pool) await settle(() => pool.end())
  if (created) await settle(() => administration.query(`DROP DATABASE ${database}`))
  await settle(() => administration.end())
  await settle(() => rm(root, { recursive: true, force: true }))
  if (failures.length) throw new AggregateError(failures, 'Runtime continuity fixture cleanup failed')
}
