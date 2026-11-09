/** Current administrator reads through the real Gateway and PostgreSQL; no Runtime or model starts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode = 'src', artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const modules = await Promise.all(['postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config',
  'desktop-access', 'terminal-access', 'ssh-access', 'plugin-access', 'steward-access', 'memory-access',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { DesktopAccess }, { TerminalAccess }, { SshAccess }, { PluginAccess }, { StewardAccess }, { MemoryAccess }] = modules
const providers = { desktop: DesktopAccess, terminal: TerminalAccess, ssh: SshAccess, plugin: PluginAccess, steward: StewardAccess, memory: MemoryAccess }
const selected = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(selected)
const database = `hgw_policy_read_${randomUUID().replaceAll('-', '')}_test`
const administration = createPostgresPool(selected, { max: 1 })
let created = false, pool, observer
async function until(predicate, message) {
  const deadline = performance.now() + 15000
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, message)
    await delay(10)
  }
}
try {
  await administration.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(selected); url.pathname = `/${database}`
  const application = `resource-policy-read-${randomUUID()}`
  pool = createPostgresPool(url.href, { max: 1, application_name: application })
  observer = createPostgresPool(url.href, { max: 3 })
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const entries = ['desktop', 'terminal', 'ssh', 'plugin', 'steward', 'memory', 'steward-directory']
  const changes = ['current', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization']
  for (const entry of entries) {
    if (process.env.DSH_POLICY_READ_SMOKE === '1' && !['desktop', 'steward-directory'].includes(entry)) continue
    const root = await mkdtemp(join(tmpdir(), 'hgw-policy-read-'))
    let gateway, manager, pending, release, restore, starts = 0
    try {
      const lane = entry === 'steward-directory' ? 'steward' : entry
      const slug = `policy-read-${randomUUID()}`
      const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Resource read fixture') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'resource-node')", [organization])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'resource-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const actor = await users.create({ username: 'reading-admin', password: 'synthetic-password', role: 'admin' })
      const owner = await users.create({ username: 'other-policy-owner', password: 'synthetic-password', role: 'admin' })
      await users.changeOwnPassword(actor.id, 'synthetic-password')
      assert.notEqual(actor.id, owner.id)
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, actor.id])).rows[0].id
      const access = new providers[lane](context)
      const policy = await access.set({ kind: 'user', id: owner.id }, true, '0', actor.id)
      manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
        instancesOutliveGateway: false, start: async () => { starts++; throw new Error('Policy reads must not start a Runtime') },
      })
      const deps = { cfg, users, projects, audit: new PostgresAuditService(context), instances: manager,
        auth: new PostgresAuthService(context, cfg), [lane + 'Access']: access }
      gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
      await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
      const origin = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      const path = entry === 'steward-directory' ? '/admin/api/steward'
        : `/admin/api/${({ desktop: 'desktops', terminal: 'terminals', plugin: 'plugins' })[lane] ?? lane}/permissions?kind=user&id=${owner.id}`
      const read = async () => { const response = await fetch(origin + path, { headers: { origin, cookie } }); return { status: response.status, value: await response.json() } }
      const reset = async () => {
        await pool.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organization])
        await pool.query("UPDATE harness.users SET status='active',deleted_at=NULL WHERE id=$1", [internal])
        await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'admin','active')
          ON CONFLICT(organization_id,user_id) DO UPDATE SET role='admin',status='active'`, [organization, internal])
      }
      const method = entry === 'steward-directory' ? 'list' : 'get', original = access[method]
      restore = () => { access[method] = original }
      for (const change of changes) {
        if (process.env.DSH_POLICY_READ_SMOKE === '1' && !['current', 'role'].includes(change)) continue
        await reset()
        const entered = Promise.withResolvers(), gate = Promise.withResolvers()
        release = () => { gate.resolve() }
        access[method] = async function (...args) { entered.resolve(); await gate.promise; return original.apply(this, args) }
        pending = read()
        await Promise.race([entered.promise, pending.then(value => { throw new Error(`Read bypassed its barrier: ${entry}/${change} ${value.status}`) })])
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=clock_timestamp() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organization, internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organization, internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organization])
        release()
        const result = await pending; pending = undefined; restore()
        assert.equal(result.status, change === 'current' ? 200 : 403)
        if (change !== 'current') assert.deepEqual(result.value, { error: 'forbidden' })
        else if (entry === 'steward-directory') assert.equal(result.value.members.length, 2)
        else assert.deepEqual(result.value, policy)
        assert.deepEqual(await access.get({ kind: 'user', id: owner.id }), policy)
        assert.equal(starts, 0)
        console.log(JSON.stringify({ entry, change, status: result.status, error: result.value.error ?? null,
          policyReturned: result.value.enabled === true, membersReturned: result.value.members?.length ?? 0, unchangedPolicy: true, runtimeStarts: starts }))
      }
      if (process.env.DSH_POLICY_READ_SMOKE !== '1' && ['terminal', 'steward-directory'].includes(entry)) {
        await reset(); restore()
        const blocker = await observer.connect(), withdraw = await observer.connect()
        let withdrawal, released = false, withdrawalSettled = false, withdrawalCommitted = false
        try {
          await blocker.query('BEGIN')
          await blocker.query(`LOCK TABLE harness.${lane}_access_policies IN ACCESS EXCLUSIVE MODE`)
          await withdraw.query('BEGIN')
          const withdrawingPid = (await withdraw.query('SELECT pg_backend_pid() pid')).rows[0].pid
          pending = read()
          await until(async () => (await observer.query("SELECT FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2", [application, `%harness.${lane}_access_policies%`])).rowCount === 1, 'Resource read never reached the locked table')
          withdrawal = withdraw.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [organization, internal])
          void withdrawal.then(() => { withdrawalSettled = true }, () => { withdrawalSettled = true })
          await until(async () => (await observer.query("SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [withdrawingPid])).rowCount === 1, 'Demotion was not held by the authorized read')
          assert.equal(withdrawalSettled, false)
          await blocker.query('COMMIT'); released = true
          assert.equal((await pending).status, 200); pending = undefined
          await withdrawal
          await withdraw.query('COMMIT'); withdrawalCommitted = true
          assert.equal((await read()).status, 403)
          console.log(JSON.stringify({ entry, change: 'withdrawal-during-read', admittedRead: 200, withdrawalWaited: true, laterRead: 403, runtimeStarts: starts }))
        } finally {
          if (!released) await blocker.query('ROLLBACK')
          await Promise.allSettled([pending, withdrawal]); pending = undefined
          if (!withdrawalCommitted) await withdraw.query('ROLLBACK')
          blocker.release(); withdraw.release()
        }
      }
    } finally {
      release?.(); restore?.()
      try { await pending } finally {
        try {
          if (gateway?.listening) await new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) })
        } finally { try { await manager?.stopAll() } finally { await rm(root, { recursive: true, force: true }) } }
      }
    }
  }
} finally {
  try { await observer?.end() } finally {
    try { await pool?.end() } finally {
      try { if (created) await administration.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
      finally { await administration.end() }
    }
  }
}
