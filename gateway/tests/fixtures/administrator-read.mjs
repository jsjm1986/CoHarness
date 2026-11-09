/** Real Gateway authentication and current PostgreSQL accounts gate prepared Admin JSON results. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode = 'src', artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const modules = await Promise.all(['postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository', 'postgres/model-governance-service',
  'organization-model-credentials', 'instances', 'server', 'admin-api', 'config',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { PostgresModelGovernanceService },
  { OrganizationModelCredentialCipher }, { InstanceManager }, { createGatewayServer }, { createAdminApiHandler }, { loadConfig }] = modules
const selected = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(selected)
const database = `hgw_admin_read_${randomUUID().replaceAll('-', '')}_test`
const administration = createPostgresPool(selected, { max: 1 })
let created = false, pool, observer
try {
  await administration.query(`CREATE DATABASE "${database}"`); created = true
  const url = new URL(selected); url.pathname = `/${database}`
  pool = createPostgresPool(url.href, { max: 1 })
  observer = createPostgresPool(url.href, { max: 1 })
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const entries = ['users', 'user-detail', 'user-memberships', 'projects', 'models', 'providers', 'model-settings', 'credential-metadata', 'model-access',
    'account-quota', 'role-quota', 'account-usage', 'usage-overview', 'usage-contributors', 'usage-health', 'model-registrations', 'audit',
    'node-health-adapter', 'runtime-policy-adapter', 'archive-export-adapter']
  const changes = ['current', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'password-reset']
  for (const entry of entries) {
    if (process.env.DSH_ADMIN_READ_SMOKE === '1' && !['users', 'audit', 'runtime-policy-adapter', 'archive-export-adapter'].includes(entry)) continue
    const root = await mkdtemp(join(tmpdir(), 'hgw-admin-read-'))
    let gateway, manager, pending, release, restore, runtimeStarts = 0
    try {
      const slug = `admin-read-${randomUUID()}`
      const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Admin read fixture') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'admin-read-node')", [organization])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'admin-read-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'), HGW_PROJECTS_ROOT: join(root, 'projects'),
        HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
      const actor = await users.create({ username: 'reading-admin', password: 'synthetic-password', role: 'admin' })
      await users.create({ username: 'remaining-admin', password: 'synthetic-password', role: 'admin' })
      const target = await users.create({ username: 'other-account', password: 'synthetic-password', role: 'user' })
      await users.changeOwnPassword(actor.id, 'synthetic-password')
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, actor.id])).rows[0].id
      const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 7)))
      await audit.write({ userId: target.id, action: 'synthetic.private-account-read', detail: 'Synthetic account metadata' })
      manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg,
        { instancesOutliveGateway: false, start: async () => { runtimeStarts += 1; throw new Error('Admin reads must not launch a Runtime') } })
      const archiveId = randomUUID()
      const nodeContent = { health: async () => ({ configured: true, fixtureAdapter: true }) }
      const runtimeManagement = { policy: async () => ({ fixtureAdapter: true, syntheticPolicy: 'administrator-only' }) }
      const archives = { exportDetail: async () => ({ record: { rootSessionId: 'synthetic-private-root' }, events: [{ private: 'synthetic archive adapter' }] }) }
      const deps = { cfg, users, projects, audit, instances: manager, auth: new PostgresAuthService(context, cfg), governance, nodeContent, runtimeManagement, archives }
      gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
      await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
      const address = gateway.address(); assert.ok(address && typeof address === 'object')
      const origin = `http://127.0.0.1:${address.port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      const routes = {
        users: ['/admin/api/users', users, 'list'], 'user-detail': [`/admin/api/users/${target.id}`, users, 'getListedById'],
        'user-memberships': [`/admin/api/users/${target.id}/memberships`, projects, 'membershipsFor'], projects: ['/admin/api/projects', projects, 'list'],
        models: ['/admin/api/models', governance, 'listModels'], providers: ['/admin/api/model-providers', governance, 'listProviders'],
        'model-settings': ['/admin/api/model-settings', governance, 'describeOrganizationModelSettings'],
        'credential-metadata': ['/admin/api/model-settings/credentials', governance, 'describeOrganizationCredentials'],
        'model-access': [`/admin/api/model-access?userId=${target.id}`, governance, 'userOverrides'],
        'account-quota': [`/admin/api/quotas?subjectType=user&subjectId=${target.id}`, governance, 'userQuota'],
        'role-quota': ['/admin/api/quotas?subjectType=role&subjectId=user', governance, 'roleQuota'],
        'account-usage': [`/admin/api/usage?userId=${target.id}`, governance, 'summary'],
        'usage-overview': ['/admin/api/usage/overview', governance, 'usageOverview'], 'usage-contributors': ['/admin/api/usage/contributors', governance, 'usageContributors'],
        'usage-health': ['/admin/api/usage/health', governance, 'usageHealth'], 'model-registrations': ['/admin/api/model-registrations', governance, 'registrationReport'],
        audit: ['/admin/api/audit', audit, 'query'], 'node-health-adapter': ['/admin/api/deployment/node-content', nodeContent, 'health'],
        'runtime-policy-adapter': ['/admin/api/runtime-allocation-policy', runtimeManagement, 'policy'],
        'archive-export-adapter': [`/admin/api/archives/records/${archiveId}/export`, archives, 'exportDetail'],
      }
      const [path, owner, method] = routes[entry], original = owner[method].bind(owner)
      restore = () => { owner[method] = original }
      const read = async () => {
        const result = await fetch(origin + path, { headers: { origin, cookie } })
        return { status: result.status, value: await result.json(), total: result.headers.get('x-total-count'), attachment: result.headers.get('content-disposition') }
      }
      const reset = async () => {
        await observer.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organization])
        await observer.query("UPDATE harness.users SET status='active',deleted_at=NULL WHERE id=$1", [internal])
        await observer.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT (organization_id,user_id) DO UPDATE SET role='admin',status='active'", [organization, internal])
        await observer.query('UPDATE harness.password_credentials SET must_change_password=false WHERE user_id=$1', [internal])
      }
      const control = await read(); assert.equal(control.status, 200, `${entry}: ${JSON.stringify(control.value)}`)
      if (entry === 'users') assert.ok(control.value.some(row => row.username === target.username))
      if (entry === 'audit') assert.ok(Number(control.total) > 0)
      if (entry === 'archive-export-adapter') assert.ok(control.attachment?.includes(archiveId))
      for (const change of [...changes, ...(entry === 'archive-export-adapter' ? ['authority-unavailable'] : [])]) {
        await reset(); restore()
        let entered
        const entryReached = new Promise(done => { entered = done })
        const gate = new Promise(done => { release = done })
        owner[method] = async (...args) => { const result = await original(...args); entered(); await gate; return result }
        pending = read()
        await Promise.race([entryReached, pending.then(result => { throw new Error(`${entry} bypassed preparation: ${JSON.stringify(result)}`) })])
        if (change === 'role') await observer.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await observer.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await observer.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await observer.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await observer.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await observer.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organization])
        if (change === 'password-reset') await observer.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [internal])
        if (change === 'authority-unavailable') { await pool.end(); pool = undefined }
        release()
        const result = await pending; pending = undefined; restore()
        assert.equal(result.status, change === 'current' ? 200 : change === 'authority-unavailable' ? 503 : 403, `${entry}/${change}: ${JSON.stringify(result.value)}`)
        if (change !== 'current') {
          if (change === 'authority-unavailable') assert.equal(result.value.code, 'admin-authorization-unavailable')
          else assert.deepEqual(result.value, { error: 'forbidden' })
          assert.equal(result.total, null); assert.equal(result.attachment, null)
        }
        assert.equal(runtimeStarts, 0)
        console.log(JSON.stringify({ entry, change, status: result.status, sensitiveHeadersReturned: result.total !== null || result.attachment !== null,
          runtimeStarts, source: entry.endsWith('-adapter') ? 'controlled-read-adapter' : 'postgres' }))
      }
    } finally {
      release?.(); restore?.()
      try { await pending } finally {
        try { if (gateway?.listening) await new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }) }
        finally { try { await manager?.stopAll() } finally { await rm(root, { recursive: true, force: true }) } }
      }
    }
  }
} finally {
  try { await observer?.end() } finally { try { await pool?.end() } finally {
    try { if (created) await administration.query(`DROP DATABASE "${database}" WITH (FORCE)`) } finally { await administration.end() }
  } }
}
