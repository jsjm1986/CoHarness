/** Browser project-settings navigation retains current administrator authority before native startup. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPostgresPool, runMigrations } from '../../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../../src/postgres/user-service.ts'
import { PostgresProjectService } from '../../src/postgres/project-service.ts'
import { PostgresAuthService } from '../../src/postgres/auth-service.ts'
import { PostgresAuditService } from '../../src/postgres/audit-service.ts'
import { PostgresInstanceRepository } from '../../src/postgres/instance-repository.ts'
import { InstanceManager } from '../../src/instances.ts'
import { LocalLauncher } from '../../src/launcher.ts'
import { createGatewayServer } from '../../src/server.ts'
import { createAdminApiHandler } from '../../src/admin-api.ts'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { runtimeRelay } from '../runtime-relay.ts'
import { testConfig } from '../test-config.ts'

const [mode = 'src', repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(databaseUrl)
const root = await mkdtemp(join(tmpdir(), 'hgw-settings-start-'))
const database = `hgw_settings_start_${randomUUID().replaceAll('-', '')}_test`
const administration = createPostgresPool(databaseUrl, { max: 1 })
const cleanups: Array<() => Promise<unknown>> = []
let pool: ReturnType<typeof createPostgresPool> | undefined, created = false
let gateway: ReturnType<typeof createGatewayServer> | undefined, manager: InstanceManager | undefined
let pending: Promise<{ status: number; location: string | null; selectionChanged: boolean; code: string | null }> | undefined
let release: (() => void) | undefined, primaryError: unknown
const handles: Awaited<ReturnType<LocalLauncher['start']>>[] = []
async function isAlive(handle: Awaited<ReturnType<LocalLauncher['start']>>): Promise<boolean> {
  assert.ok(handle.isAlive)
  return handle.isAlive()
}

try {
  await administration.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = createPostgresPool(url.href, { max: 2 })
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = randomUUID()
  const organization: string = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Settings start fixture') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'settings-start-node')", [organization])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'settings-start-node')
  const cfg = testConfig(root, { HGW_DSH_REPO_ROOT: repositoryRoot,
    HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'settings-start-node', HGW_GUARD_PATCH: 'off', HGW_READINESS_TIMEOUT_MS: '10000' })
  const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
  const actor = await users.create({ username: 'initial-admin', password: 'synthetic-password', role: 'admin' })
  const keeper = await users.create({ username: 'remaining-admin', password: 'synthetic-password', role: 'admin' })
  await users.changeOwnPassword(actor.id, 'synthetic-password')
  await users.changeOwnPassword(keeper.id, 'synthetic-password')
  const project = await projects.create({ name: 'Other administrator project', createdBy: keeper.id, actorUserId: keeper.id })
  const internal: string = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, actor.id])).rows[0].id
  const marker = join(root, 'runtime.json'), probe = join(root, 'probe.json')
  const port = await runtimeRelay(marker, close => cleanups.push(close), 'json')
  await pool.query('UPDATE harness.instances i SET port=$3 FROM harness.projects p WHERE i.organization_id=$1 AND i.project_id=p.id AND p.public_id=$2', [organization, project.id, port])
  cfg.dshCommand = [process.execPath, ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./readiness-runtime.mjs', import.meta.url)), new URL(`../../src/runtime-readiness.${mode === 'src' ? 'ts' : 'js'}`, import.meta.url).href,
    marker, 'valid', probe]
  const native = new LocalLauncher(cfg)
  const launcher = { instancesOutliveGateway: false, start: async (runtime: Parameters<LocalLauncher['start']>[0]) => {
    await rm(marker, { force: true })
    const handle = await native.start(runtime); handles.push(handle)
    return handle
  } }
  manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, launcher)
  const deps = { cfg, users, projects, instances: manager, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) }
  gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise<void>((done, fail) => { gateway!.once('error', fail); gateway!.listen(0, '127.0.0.1', done) })
  const address = gateway.address(); assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`; cfg.publicOrigins.push(origin)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
  await login.arrayBuffer(); assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const read = async () => {
    const response = await fetch(`${origin}/admin/projects/${project.id}/settings`, { redirect: 'manual', headers: { origin, cookie } })
    const text = await response.text()
    const body: { code?: string; error?: string | { code: string } } = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : {}
    return { status: response.status, location: response.headers.get('location'), selectionChanged: response.headers.has('set-cookie'), code: body.code ?? (typeof body.error === 'string' ? body.error : body.error?.code) ?? null }
  }
  const target = { kind: 'project' as const, id: project.id }
  const publish = (scenario: string, result: Awaited<ReturnType<typeof read>>, allocated: number) => {
    console.log(JSON.stringify({ scenario, ...result, allocated, resident: manager!.capacitySnapshot().resident }))
  }
  const current = await read(); assert.equal(current.status, 302); assert.equal(handles.length, 1)
  assert.equal(await isAlive(handles[0]!), true); publish('current', current, 1)
  const warm = await read(); assert.equal(warm.status, 302); assert.equal(handles.length, 1); publish('warm-current', warm, 0)
  await manager.stop(target, 'failed'); assert.equal(await manager.stateOf(target), 'stopped')
  assert.equal(await isAlive(handles[0]!), false); await rm(marker, { force: true })

  const ensure = manager.ensureRunning.bind(manager)
  for (const change of ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization']) {
    let entered!: () => void
    const reached = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
    let forwarded: number | undefined, intent: string | undefined
    manager.ensureRunning = async (...args) => { forwarded = args[2]; intent = args[1]; entered(); await gate; return ensure(...args) }
    pending = read()
    await Promise.race([reached, pending.then(result => { throw new Error(`Settings navigation bypassed startup: ${JSON.stringify(result)}`) })])
    if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
    if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
    if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
    if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
    if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
    if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organization])
    release!()
    const result = await pending; pending = undefined; manager.ensureRunning = ensure
    assert.equal(result.status, 403); assert.equal(result.selectionChanged, false); assert.equal(forwarded, actor.id); assert.equal(intent, 'passive')
    assert.equal(handles.length, 1); assert.equal(await manager.stateOf(target), 'stopped'); publish(change, result, 0)
    await pool.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organization])
    await pool.query("UPDATE harness.users SET status='active',deleted_at=NULL WHERE id=$1", [internal])
    await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT (organization_id,user_id) DO UPDATE SET role='admin',status='active'", [organization, internal])
  }
  const restored = await read(); assert.equal(restored.status, 302); assert.equal(handles.length, 2)
  assert.equal(await isAlive(handles[1]!), true); publish('restored', restored, 1)
  await manager.stop(target, 'manual', actor.id)
  const manual = await read(); assert.equal(manual.status, 409); assert.equal(manual.code, 'INSTANCE_STOPPED')
  assert.equal(manual.selectionChanged, false); assert.equal(handles.length, 2); assert.equal(await isAlive(handles[1]!), false)
  publish('manual-stop', manual, 0)
} catch (error) { primaryError = error; throw error }
finally {
  release?.()
  const failures: unknown[] = []
  const dispose = async (operation: () => Promise<unknown>) => { try { await operation() } catch (error) { failures.push(error) } }
  await dispose(async () => { await pending })
  await dispose(async () => { if (gateway?.listening) await new Promise<void>((done, fail) => { gateway!.closeAllConnections(); gateway!.close(error => error ? fail(error) : done()) }) })
  await dispose(async () => { await manager?.stopAll() })
  for (const handle of handles) await dispose(async () => { await handle.terminate(0); assert.equal(await isAlive(handle), false) })
  for (const close of cleanups) await dispose(close)
  await dispose(async () => { await pool?.end() })
  await dispose(async () => { if (created) await administration.query(`DROP DATABASE "${database}" WITH (FORCE)`) })
  await dispose(async () => { await administration.end() })
  if (failures.length === 0) await dispose(() => rm(root, { recursive: true, force: true }))
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], `Settings Runtime cleanup failed; owned files retained at ${root}`)
}
