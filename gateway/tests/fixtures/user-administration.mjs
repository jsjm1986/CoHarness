/** Authenticated Gateway account mutations pause after authorization and retain real SQLite and carrier state. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('User administration replay requires src or lib.')
const backend = process.argv[3] ?? 'sqlite'
if (backend !== 'sqlite' && backend !== 'postgres') throw new Error('User administration replay requires sqlite or postgres.')
const extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${mode}/${name}.${extension}`, import.meta.url))
const { openDb } = await load('db')
const { UserService } = await load('users')
const { ProjectService } = await load('projects')
const { AuthService } = await load('auth')
const { AuditService } = await load('audit')
const { InstanceManager } = await load('instances')
const { loadConfig } = await load('config')
const { createGatewayServer } = await load('server')
const { createAdminApiHandler } = await load('admin-api')
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
const { PostgresAuthService } = await load('postgres/auth-service')
const { PostgresAuditService } = await load('postgres/audit-service')
const { PostgresInstanceRepository } = await load('postgres/instance-repository')
const { NodeResourceBudget } = await load('node-resource-budget')
const { GatewayModelBudget } = await load('gateway-model-budget')
const { randomUUID } = await import('node:crypto')
const { resolve } = await import('node:path')
const listen = server => new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
const close = server => new Promise((ready, reject) => {
  server.closeAllConnections(); server.close(error => { if (error) reject(error); else ready() })
})
const failures = []
let pool
try {
if (backend === 'postgres') {
  const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
  assert(databaseUrl !== undefined, 'Disposable PostgreSQL database required')
  pool = createPostgresPool(databaseUrl)
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
}
const revocations = backend === 'postgres'
  ? ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', 'late-role']
  : ['role', 'disabled-account', 'deleted-account', 'current', 'late-role']
for (const scenario of ['name', 'eligibility', 'delete']) for (const revocation of revocations) {
  if (revocation === 'late-role' && scenario !== 'delete') continue
  const root = await mkdtemp(join(tmpdir(), 'user-administration-replay-'))
  let db, writer, gateway, carrier, instances, pending, release, limited, processOwner
  try {
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
      HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
    await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
    let context
    if (pool !== undefined) {
      const slug = `user-administration-${randomUUID()}`
      const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,'User administration replay') RETURNING id`, [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      limited = createPostgresPool(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL), { max: 1 })
      context = await resolvePostgresRuntimeContext(limited, slug, 'local')
      processOwner = await GatewayModelBudget.open(new NodeResourceBudget(limited, organizationId, context.nodeId, cfg.resourceBudget), join(root, 'gateway-owners'))
    } else { db = openDb(join(root, 'gateway.sqlite')); writer = openDb(join(root, 'gateway.sqlite')) }
    const users = context === undefined ? new UserService(db, cfg) : new PostgresUserService(context, cfg)
    const projects = context === undefined ? new ProjectService(db, cfg) : new PostgresProjectService(context, cfg)
    const actor = await users.create({ username: 'acting-admin', password: 'pw-12345678', role: 'admin' })
    const keeper = await users.create({ username: 'current-admin', password: 'pw-12345678', role: 'admin' })
    const target = await users.create({ username: 'retained-user', displayName: 'Retained account', password: 'pw-12345678' })
    await users.changeOwnPassword(actor.id, 'pw-12345678')
    await writeFile(join(target.homePath, 'retained.txt'), 'retained account bytes')
    if (context === undefined) db.prepare("UPDATE instances SET state='ready' WHERE user_id=?").run(target.id)
    else await pool.query(`UPDATE harness.instances i SET observed_state='ready',desired_state='running'
      FROM harness.users u WHERE u.id=i.user_id AND u.organization_id=i.organization_id
        AND u.organization_id=$1 AND u.public_id=$2`, [context.organizationId, target.id])
    carrier = createServer((_request, response) => { response.end('account runtime alive') }); await listen(carrier)
    const carrierUrl = `http://127.0.0.1:${carrier.address().port}`
    let closed = false, stopCalls = 0
    instances = new InstanceManager(context === undefined ? db : new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new Error('Account replay cannot start a model Runtime') },
      attach: () => ({ hasExited: () => closed, isAlive: async () => !closed, terminate: async () => {
        if (closed) return
        stopCalls += 1; await close(carrier); closed = true
        if (revocation === 'late-role') await users.setRole(actor.id, 'user')
      } }),
    }, { principalPublicKey: '' }, undefined, processOwner)
    const observed = Promise.withResolvers(), gate = Promise.withResolvers()
    release = () => gate.resolve()
    let held = false
    const routedUsers = new Proxy(users, { get(service, key) {
      if (key === 'getById') return async id => {
        const value = await service.getById(id)
        if (id === target.id && !held) { held = true; observed.resolve(); await gate.promise }
        return value
      }
      const value = Reflect.get(service, key)
      return typeof value === 'function' ? value.bind(service) : value
    } })
    const deps = { cfg, users: routedUsers, projects, instances,
      auth: context === undefined ? new AuthService(db, cfg) : new PostgresAuthService(context, cfg),
      audit: context === undefined ? new AuditService(db) : new PostgresAuditService(context) }
    gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) }); await listen(gateway)
    const base = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(base)
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
    await login.arrayBuffer(); assert.equal(login.status, 302)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined)
    pending = fetch(`${base}/admin/api/users/${target.id}`, { method: scenario === 'delete' ? 'DELETE' : 'PATCH',
      headers: { origin: base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ actorUserId: keeper.id, ...(scenario === 'name' ? { displayName: 'Changed by revoked administrator' }
        : scenario === 'eligibility' ? { autoReviewEligible: true } : {}) }),
    }).then(async response => { await response.arrayBuffer(); return response.status })
    await observed.promise
    if (context === undefined) {
      if (revocation === 'role') writer.prepare("UPDATE users SET role='user' WHERE id=?").run(actor.id)
      else if (revocation === 'disabled-account') writer.prepare("UPDATE users SET status='disabled' WHERE id=?").run(actor.id)
      else if (revocation === 'deleted-account') writer.prepare("UPDATE users SET status='disabled',deleted_at=? WHERE id=?").run(Date.now(), actor.id)
    } else {
      if (revocation === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [context.organizationId])
      else if (revocation !== 'current') {
        const userId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [context.organizationId, actor.id])).rows[0].id
        if (revocation === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [userId])
        else if (revocation === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [userId])
        else if (revocation === 'deleted-account') await pool.query("UPDATE harness.users SET status='disabled',deleted_at=now() WHERE id=$1", [userId])
        else if (revocation === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [userId])
        else if (revocation === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [userId])
      }
    }
    release()
    const status = await pending, current = await users.getById(target.id)
    const carrierAlive = !closed && await (await fetch(carrierUrl)).text() === 'account runtime alive'
    const successAudit = context === undefined ? db.prepare("SELECT 1 FROM audit_log WHERE action LIKE 'admin.users%'").get() !== undefined
      : (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action LIKE 'admin.users%'", [context.organizationId])).rowCount > 0
    const observation = { backend, scenario, revocation, status, targetRetained: current !== null, targetName: current?.displayName ?? null,
      autoReviewEligible: current?.autoReviewEligible ?? null, carrierAlive, stopCalls,
      instanceState: await instances.stateOf(target.id),
      bytesRetained: await readFile(join(target.homePath, 'retained.txt'), 'utf8') === 'retained account bytes',
      successAudit }
    console.log(JSON.stringify(observation))
    const allowed = revocation === 'current', removed = allowed && scenario === 'delete', stopped = removed || revocation === 'late-role'
    if (status !== (allowed ? 204 : 403) || (current === null) !== removed
      || (!removed && (current.displayName !== (allowed && scenario === 'name' ? 'Changed by revoked administrator' : target.displayName)
        || current.autoReviewEligible !== (allowed && scenario === 'eligibility')))
      || carrierAlive !== !stopped || stopCalls !== (stopped ? 1 : 0) || observation.instanceState !== (stopped ? 'stopped' : 'ready') || !observation.bytesRetained
      || observation.successAudit !== allowed) failures.push(`${scenario}:${revocation}`)
  } finally {
    release?.(); await pending?.catch(() => {})
    if (gateway?.listening) await close(gateway)
    await instances?.stopAll()
    await processOwner?.close()
    if (carrier?.listening) await close(carrier)
    writer?.close(); db?.close(); await limited?.end(); await rm(root, { recursive: true, force: true })
  }
}
assert.deepEqual(failures, [], 'A revoked administrator cannot mutate another account or stop its Runtime.')
} finally { await pool?.end() }
