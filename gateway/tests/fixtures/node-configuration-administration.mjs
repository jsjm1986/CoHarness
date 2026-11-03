/** Real authenticated Gateway and PostgreSQL node configuration administration without service restart or inference. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { NodeConfigurationStore }, { nodeConfigurationAuthority }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'node-config-store', 'postgres/node-configuration-authority',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const poolName = `node-configuration-http-${randomUUID()}`
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

try {
  await runMigrations(pool, process.env.DSH_AUDIT_NODE_CONFIGURATION_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['read', 'save', 'apply']) {
    for (const change of ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', ...(operation === 'save' ? ['successor'] : operation === 'apply' ? ['single-checkout'] : [])]) {
      const root = await mkdtemp(join(tmpdir(), 'node-configuration-http-')), organizations = []
      let gateway, manager, pending, release, successorRelease, primaryError, configurationPool
      try {
        const environment = { HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) }
        const cfg = loadConfig(environment)
        const slug = `node-configuration-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node configuration HTTP') RETURNING id", [slug])).rows[0].id
        organizations.push(organizationId)
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        cfg.organizationSlug = slug; cfg.computeNodeName = 'local'
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const otherAdministrator = await users.create({ username: 'other-administrator', password: 'pw-12345678', role: 'admin' })
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organizationId])
        configurationPool = createPostgresPool(url, { max: change === 'single-checkout' ? 1 : 2, connectionTimeoutMillis: 1000 })
        const identity = { organizationId: context.organizationId, nodeId: context.nodeId }
        const authority = nodeConfigurationAuthority({ ...context, pool: configurationPool })
        const nodeConfiguration = new NodeConfigurationStore(identity, cfg, environment, authority)
        await nodeConfiguration.initialize()
        const initial = await nodeConfiguration.view(actor.id)
        const values = { ...initial.desired, HGW_PORT: '9301' }
        if (operation === 'apply') await nodeConfiguration.save(identity, 0, values, actor.id)
        let saved
        const committed = new Promise(done => { saved = done }), successor = new Promise(done => { successorRelease = done })
        if (change === 'successor') {
          const original = authority.run.bind(authority)
          let first = true
          authority.run = async (...args) => { const result = await original(...args); if (first) { first = false; saved(); await successor } return result }
        }
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        const method = operation === 'read' ? 'view' : operation === 'save' ? 'save' : 'requestApply', original = nodeConfiguration[method].bind(nodeConfiguration)
        nodeConfiguration[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg); await manager.stopAll()
        const deps = { cfg, users, projects, audit, nodeConfiguration, instances: manager, auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const payload = { ...identity, actorUserId: otherAdministrator.id, revision: operation === 'apply' ? 1 : 0, action: operation, values }
        const request = value => fetch(`${origin}/admin/api/deployment/configuration`, { method: operation === 'read' ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, ...(operation === 'read' ? {} : { body: JSON.stringify(value) }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        pending = request(payload)
        await Promise.race([observed, pending.then(response => { throw new Error(`Node configuration request bypassed the observer: ${operation}/${change} status ${response.status}`) })])
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        release()
        let successorResponse
        if (change === 'successor') {
          await Promise.race([committed, pending.then(() => { throw new Error('Save bypassed the committed-view observer') })])
          successorResponse = await request({ ...payload, revision: 1, values: { ...values, HGW_PORT: '9302' } })
          successorRelease()
        }
        const response = await pending
        const stored = JSON.parse(await readFile(cfg.nodeConfigFile, 'utf8'))
        const successful = operation === 'read' ? [] : await audit.query({ action: `admin.deployment.configuration.${operation}` })
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null,
          acceptedRevision: response.value.revision ?? null, acceptedPort: response.value.desired?.HGW_PORT ?? null,
          operationStatus: response.value.operation?.status ?? null, storedRevision: stored.revision, storedPort: stored.desired.HGW_PORT,
          storedOperation: stored.operation?.status ?? null, storedActor: stored.operation === null ? null : stored.operation.actor === actor.id ? 'current-admin' : 'foreign',
          successfulAudits: successful.length,
          ...(successorResponse === undefined ? {} : { successorStatus: successorResponse.status, successorRevision: successorResponse.value.revision, successorPort: successorResponse.value.desired.HGW_PORT }),
        }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.(); successorRelease?.()
        await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (configurationPool !== undefined) await close(() => configurationPool.end())
        if (manager !== undefined) await close(() => manager.stopAll())
        for (const id of organizations.reverse()) await close(() => removeOrganization(id))
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Node configuration HTTP cleanup failed')
      }
    }
  }
} finally { await pool.end() }
