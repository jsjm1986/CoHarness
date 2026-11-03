/** Real authenticated Gateway and PostgreSQL digest-route administration without inference. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { PostgresProgressService }, { PostgresCollaborationService }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'postgres/progress-service', 'postgres/collaboration-service',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const poolName = `digest-model-http-${randomUUID()}`
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
async function catalog(organizationId, models) {
  const provider = (await pool.query(`INSERT INTO harness.model_providers(organization_id,provider_key,display_name,protocol,base_url,auth_mode,status)
    VALUES($1,'org-shared','Fixture provider','openai-completions','https://provider.invalid/v1','none','enabled') RETURNING id`, [organizationId])).rows[0].id
  for (const model of models) await pool.query(`INSERT INTO harness.model_catalog(organization_id,provider_key,model_key,display_name,provider_id)
    VALUES($1,'org-shared',$2,$2,$3)`, [organizationId, model, provider])
}
try {
  await runMigrations(pool, process.env.DSH_AUDIT_DIGEST_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['read', 'pin', 'clear', 'pin-foreign', 'pin-spaces']) {
    for (const change of operation.startsWith('pin-') ? ['current'] : ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', 'current-local', ...(operation === 'pin' ? ['disabled-model-during-admission'] : [])]) {
      const root = await mkdtemp(join(tmpdir(), 'digest-model-http-')), organizations = []
      let gateway, manager, progress, pending, release, primaryError, fencePool, fence
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `digest-model-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Digest model HTTP') RETURNING id", [slug])).rows[0].id
        organizations.push(organizationId)
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        await catalog(organizationId, ['own-model', 'space model'])
        if (change !== 'current-local') {
          const foreign = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Foreign digest catalog') RETURNING id", [`foreign-digest-${randomUUID()}`])).rows[0].id
          organizations.push(foreign); await catalog(foreign, ['foreign-model'])
        }
        if (operation === 'clear') await pool.query("UPDATE harness.organizations SET digest_model='org-shared/own-model' WHERE id=$1", [organizationId])
        progress = new PostgresProgressService(context, { collaboration: new PostgresCollaborationService(context) }, cfg.progress)
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        const method = operation === 'read' ? 'digestModelSettings' : 'setDigestModel', original = progress[method].bind(progress)
        progress[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg); await manager.stopAll()
        const deps = { cfg, users, projects, audit, progress, instances: manager, auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const model = operation === 'clear' ? null : operation === 'pin-foreign' ? 'org-shared/foreign-model' : operation === 'pin-spaces' ? 'org-shared/space model' : 'org-shared/own-model'
        pending = fetch(`${origin}/admin/api/progress/digest-model`, { method: operation === 'read' ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, ...(operation === 'read' ? {} : { body: JSON.stringify({ model, actorUserId: actor.id + 1 }) }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        await observed
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        if (change === 'disabled-model-during-admission') {
          fencePool = createPostgresPool(url, { max: 1 }); fence = await fencePool.connect()
          await fence.query('BEGIN')
          await fence.query('SELECT id FROM harness.organizations WHERE id=$1 FOR NO KEY UPDATE', [organizationId])
          await fence.query("UPDATE harness.model_catalog SET enabled=false WHERE organization_id=$1 AND model_key='own-model'", [organizationId])
        }
        release()
        if (fence !== undefined) {
          const deadline = performance.now() + 15000
          for (;;) {
            const waiting = (await fence.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [poolName])).rows[0].waiting
            if (waiting) break
            assert.ok(performance.now() < deadline, 'Digest mutation did not wait for the controlled configuration writer')
            await new Promise(done => setTimeout(done, 10))
          }
          await fence.query('COMMIT')
        }
        const response = await pending
        const stored = (await pool.query('SELECT digest_model FROM harness.organizations WHERE id=$1', [organizationId])).rows[0].digest_model
        const candidates = response.value.candidates?.map(row => `${row.provider}/${row.model}`) ?? []
        const successes = await audit.query({ action: 'admin.progress.digest-model' })
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null, model: response.value.model ?? null, candidates, storedPin: stored, successfulAudit: successes.length }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.()
        if (fence !== undefined) { await close(() => fence.query('ROLLBACK')); fence.release() }
        if (fencePool !== undefined) await close(() => fencePool.end())
        await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (progress !== undefined) await close(() => progress.close())
        if (manager !== undefined) await close(() => manager.stopAll())
        for (const id of organizations.reverse()) await close(() => removeOrganization(id))
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Digest model HTTP cleanup failed')
      }
    }
  }
} finally { await pool.end() }
