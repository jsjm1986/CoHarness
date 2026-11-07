/** Real authenticated Gateway and PostgreSQL Remote desktop administration without remote VNC transport or inference. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { RemoteDesktopService }, { remoteDesktopAdministration }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'remote-desktop-service', 'postgres/remote-desktop-administration',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const poolName = `remote-desktop-http-${randomUUID()}`
const pool = createPostgresPool(url, { max: 1, application_name: poolName })
async function removeOrganization(id) {
  const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
  for (let pass = 0; pass < 12; pass += 1) {
    let blocked = false
    for (const { table_name: table } of tables) {
      try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [id]) }
      catch (error) { if (error.code === '23503') blocked = true; else throw error }
    }
    if (!blocked) break
  }
  await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [id]); await pool.query('DELETE FROM harness.organizations WHERE id=$1', [id])
}
const endpoints = [{ nodeId: 'configured', host: 'desktop.example', port: 5901 }]

try {
  await runMigrations(pool, process.env.DSH_AUDIT_REMOTE_DESKTOP_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['endpoints', 'save-endpoints', 'grants', 'create-grant', 'level', 'revoke', 'audit']) {
    for (const change of ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', ...(operation === 'save-endpoints' ? ['database-authority-lost'] : operation === 'revoke' ? ['runtime-preserved-mtime'] : [])]) {
      const root = await mkdtemp(join(tmpdir(), 'remote-desktop-http-')), organizations = []
      let gateway, manager, pending, release, publish, primaryError, observerPool, desktopContext
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `remote-desktop-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Remote desktop administration HTTP') RETURNING id", [slug])).rows[0].id
        organizations.push(organizationId)
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const administration = remoteDesktopAdministration(context)
        let retained
        const admitted = new Promise(done => { retained = done }), publication = new Promise(done => { publish = done })
        if (change === 'database-authority-lost') {
          const original = administration.run.bind(administration)
          administration.run = (actorUserId, work) => original(actorUserId, async (...args) => { retained(args[1]); await publication; return work(...args) })
        }
        const remoteDesktop = new RemoteDesktopService(join(root,'remote-desktop'), administration)
        await mkdir(remoteDesktop.dir, { recursive: true })
        await writeFile(join(remoteDesktop.dir, 'endpoints.json'), JSON.stringify({ endpoints }))
        await writeFile(join(remoteDesktop.dir, 'grants.jsonl'), JSON.stringify({ id: 'first', principal: 'alice', target: { nodeId: 'configured' }, level: 'view', scope: { kind: 'machine' }, recording: false, grantedBy: 'administrator', createdAt: 1 })+'\n')
        await writeFile(join(remoteDesktop.dir, 'audit.jsonl'), JSON.stringify({ kind: 'grant', principal: 'alice', at: 1 })+'\n')
        if (change === 'runtime-preserved-mtime') {
          const [{ Context }, { default: Loader }, { default: Include }, { default: Provider }] = await Promise.all([
            import('@deepseek-ai/cordis'),
            mode === 'src' ? import('@deepseek-ai/cordis-plugin-loader') : import(new URL('../../../vendor/loader/lib/index.js',import.meta.url)),
            mode === 'src' ? import('@deepseek-ai/cordis-plugin-include') : import(new URL('../../../vendor/include/lib/index.js',import.meta.url)),
            mode === 'src' ? import('@deepseek-ai/dsh-remote-desktop-vnc') : import(new URL('../../../packages/remote-desktop/remote-desktop-vnc/lib/index.js',import.meta.url)),
          ])
          await utimes(join(remoteDesktop.dir, 'grants.jsonl'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
          await writeFile(join(root,'cordis.yml'), ['- id: remote-desktop-vnc', "  name: '@deepseek-ai/dsh-remote-desktop-vnc'", '  config:',
            `    endpointsFile: ${JSON.stringify(join(remoteDesktop.dir,'endpoints.json'))}`,
            `    grantsFile: ${JSON.stringify(join(remoteDesktop.dir,'grants.jsonl'))}`,
            `    auditFile: ${JSON.stringify(join(remoteDesktop.dir,'audit.jsonl'))}`,
          ].join('\n'))
          desktopContext = new Context(); desktopContext.baseUrl = pathToFileURL(root).href+'/'
          await desktopContext.plugin(Loader); desktopContext.loader.builtins.include = Include
          const unreachable = name => () => { throw new Error(`Unreachable test ModuleLoader.${name}`) }
          desktopContext.loader.internal = { version: 'v2', loadCache: new Map(), async import(specifier) {
            assert.equal(specifier,'@deepseek-ai/dsh-remote-desktop-vnc'); return Provider
          }, register: unreachable('register'), getOrCreateModuleJob: unreachable('getOrCreateModuleJob'), resolveSync: unreachable('resolveSync'), load: unreachable('load') }
          await desktopContext.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root,'cordis.yml')).href } })
          await desktopContext.loader.await()
          await desktopContext.remoteDesktop.resolve({ principal: 'alice', target: { nodeId: 'configured' }, level: 'view' })
        }
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        const method = { endpoints: 'endpoints', 'save-endpoints': 'saveEndpoints', grants: 'listGrants', 'create-grant': 'createGrant', level: 'setLevel', revoke: 'revoke', audit: 'audit' }[operation]
        const original = remoteDesktop[method].bind(remoteDesktop)
        remoteDesktop[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg); await manager.stopAll()
        const deps = { cfg, users, projects, audit, remoteDesktop, instances: manager, auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const input = operation === 'save-endpoints' ? { endpoints: [{ ...endpoints[0], host: 'changed.example' }] }
          : operation === 'create-grant' ? { principal: 'bob', target: { nodeId: 'configured' }, level: 'control' }
          : { id: 'first', level: 'control' }
        const suffix = ['endpoints','save-endpoints'].includes(operation) ? 'endpoints' : ['grants','create-grant'].includes(operation) ? 'grants' : operation === 'audit' ? 'audit' : `grants/${operation}`
        const read = ['endpoints','grants','audit'].includes(operation)
        pending = fetch(`${origin}/admin/api/remote-desktop/${suffix}`, { method: read ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, ...(read ? {} : { body: JSON.stringify(input) }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        await Promise.race([observed, pending.then(response => { throw new Error(`Remote desktop request bypassed the observer: ${operation}/${change} status ${response.status}`) })])
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        release()
        if (change === 'database-authority-lost') {
          const signal = await admitted
          observerPool = createPostgresPool(url, { max: 1 })
          const backend = (await observerPool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [poolName])).rows
          assert.equal(backend.length, 1)
          assert.equal((await observerPool.query('SELECT pg_terminate_backend($1,5000) terminated', [backend[0].pid])).rows[0].terminated, true)
          await observerPool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
          if (signal !== undefined) {
            const deadline = performance.now()+15000
            while (!signal.aborted) { assert.ok(performance.now()<deadline, 'Database loss did not abort publication'); await new Promise(done => setTimeout(done,10)) }
          }
          publish()
        }
        const response = await pending
        let runtimeRevocation
        if (desktopContext !== undefined) {
          await utimes(join(remoteDesktop.dir, 'grants.jsonl'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
          runtimeRevocation = await desktopContext.remoteDesktop.resolve({ principal: 'alice', target: { nodeId: 'configured' }, level: 'view' })
            .then(() => 'accepted', error => error.code ?? 'unclassified-error')
        }
        const storedEndpoints = JSON.parse(await readFile(join(remoteDesktop.dir, 'endpoints.json'), 'utf8')).endpoints
        const grants = (await readFile(join(remoteDesktop.dir, 'grants.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          .map(row => ({ principal: row.principal, level: row.level, revoked: row.revokedAt !== undefined, grantedBy: row.grantedBy })).sort((a,b) => a.principal.localeCompare(b.principal))
        const action = { 'save-endpoints': 'endpoints.save', 'create-grant': 'grant', level: 'grant-level', revoke: 'grant-revoke' }[operation]
        const successes = action === undefined ? [] : await audit.query({ action: `admin.remote-desktop.${action}` })
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null,
          exposedEndpoints: response.value.endpoints?.length ?? 0, exposedGrants: response.value.grants?.length ?? 0, exposedEvents: response.value.events?.length ?? 0,
          storedEndpoints, grants, successfulAudit: successes.length, ...(runtimeRevocation === undefined ? {} : { runtimeRevocation }) }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.(); publish?.()
        await close(async () => { await pending })
        if (observerPool !== undefined) await close(() => observerPool.end())
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (desktopContext !== undefined) await close(() => desktopContext.fiber.dispose())
        if (manager !== undefined) await close(() => manager.stopAll())
        for (const id of organizations.reverse()) await close(() => removeOrganization(id))
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Remote desktop administration HTTP cleanup failed')
      }
    }
  }
} finally { await pool.end() }
