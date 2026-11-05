/** Model administration through real authentication, stores, policy projection and local discovery HTTP. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, backend, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(backend === 'sqlite' || backend === 'postgres')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ openDb }, { UserService }, { ProjectService }, { AuthService }, { AuditService }, { ModelGovernanceService },
  { InstanceManager }, { loadConfig }, { createGatewayServer }, { createAdminApiHandler }, { createPostgresPool, runMigrations },
  { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService }, { PostgresAuthService },
  { PostgresAuditService }, { PostgresModelGovernanceService }, { PostgresInstanceRepository }, { OrganizationModelCredentialCipher }] = await Promise.all([
  'db', 'users', 'projects', 'auth', 'audit', 'model-governance', 'instances', 'config', 'server', 'admin-api',
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/model-governance-service', 'postgres/instance-repository', 'organization-model-credentials',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const listen = server => new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
const closeServer = server => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) })
const operations = ['model', 'user-access', 'role-quota', 'user-quota', ...(backend === 'postgres'
  ? ['provider', 'settings', 'credential-set', 'credential-unset', 'project-access', 'project-access-all', 'project-quota', 'discovery', 'explicit-discovery'] : [])]
const scenarios = [
  ...operations.flatMap(operation => ['role', 'current'].map(change => ({ operation, change }))),
  ...operations.map(operation => ({ operation, change: 'password-reset' })),
  ...['user-access', 'user-quota'].map(operation => ({ operation, change: 'deleted-target' })),
  { operation: 'user-quota', change: 'numeric-alias' },
  ...(backend === 'postgres' ? ['project-access', 'project-access-all', 'project-quota'].map(operation => ({ operation, change: 'archived-target' })) : []),
  ...(backend === 'postgres' ? ['discovery', 'explicit-discovery'].flatMap(operation => [
    'late-role', 'late-disabled-account', 'late-deleted-account', 'late-disabled-membership',
    'late-missing-membership', 'late-disabled-organization', 'late-password-reset',
  ].map(change => ({ operation, change }))) : []),
]
const selected = process.env.DSH_MODEL_ADMIN_SCENARIO
if (selected !== undefined) assert.ok(scenarios.some(row => `${row.operation}-${row.change}` === selected))
let pool
try {
  if (backend === 'postgres') {
    const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
    pool = createPostgresPool(url, { max: 1 })
    await runMigrations(pool, process.env.DSH_AUDIT_MODEL_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  }
  for (const { operation, change } of scenarios) {
    if (selected !== undefined && `${operation}-${change}` !== selected) continue
    const root = await mkdtemp(join(tmpdir(), 'model-admin-http-'))
    let db, context, manager, gateway, probe, pending, release, primaryError
    let discoveries = 0, decryptions = 0
    const lateRead = change.startsWith('late-')
    try {
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
        HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
      if (backend === 'postgres') {
        const slug = `model-admin-http-${randomUUID()}`
        const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Model admin HTTP') RETURNING id", [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organization])
        context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      } else db = openDb(join(root, 'gateway.sqlite'))
      const users = context === undefined ? new UserService(db, cfg) : new PostgresUserService(context, cfg)
      const projects = context === undefined ? new ProjectService(db, cfg) : new PostgresProjectService(context, cfg)
      const audit = context === undefined ? new AuditService(db) : new PostgresAuditService(context)
      const cipher = new OrganizationModelCredentialCipher(Buffer.alloc(32, 17))
      const decrypt = cipher.decrypt.bind(cipher)
      cipher.decrypt = (...args) => { decryptions += 1; return decrypt(...args) }
      const governance = context === undefined ? new ModelGovernanceService(db) : new PostgresModelGovernanceService(context, cipher)
      const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
      await users.changeOwnPassword(actor.id, 'pw-12345678')
      const keeper = await users.create({ username: 'keeper', password: 'pw-12345678', role: 'admin' })
      await users.changeOwnPassword(keeper.id, 'pw-12345678')
      const target = await users.create({ username: 'member', password: 'pw-12345678' })
      const project = context === undefined ? undefined : await projects.create({ name: 'Model project', createdBy: actor.id })
      probe = createServer(async (request, response) => {
        discoveries += 1
        const expected = operation === 'explicit-discovery' ? 'fixture-explicit-secret' : 'fixture-initial-secret'
        const authorized = request.headers.authorization === `Bearer ${expected}`
        if (lateRead) { entered(); await gate }
        response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' })
          .end(JSON.stringify(authorized ? { data: [{ id: 'fixture-discovered' }] } : { error: 'unauthorized' }))
      })
      await listen(probe)
      const endpoint = `http://127.0.0.1:${probe.address().port}/v1`
      const provider = backend === 'postgres' ? 'org-administration' : 'p'
      const providerInput = { provider, displayName: 'Original', driver: 'pi-ai', protocol: 'openai-completions',
        baseURL: endpoint, authMode: 'api-key', status: 'draft' }
      if (context !== undefined) await governance.upsertProvider({ ...providerInput, credential: 'fixture-initial-secret' })
      await governance.upsertModel({ provider, model: 'chat', displayName: 'Original', enabled: true,
        adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
        cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
      let ref
      if (context !== undefined) {
        await governance.upsertProvider({ ...providerInput, status: 'enabled' })
        ref = (await governance.listProviders())[0].credentialRef
        await governance.setProjectAccess(project.id, provider, 'chat', false)
      }
      manager = new InstanceManager(context === undefined ? db : new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
      const deps = { cfg, users, projects, audit, governance, instances: manager,
        auth: context === undefined ? new AuthService(db, cfg) : new PostgresAuthService(context, cfg) }
      const routes = {
        model: ['models', 'PUT', { provider, model: 'chat', displayName: 'Updated' }, 'upsertModel', 'admin.models.upsert'],
        'user-access': ['model-access', 'PUT', { userId: target.id, provider, model: 'chat', allowed: true }, 'setUserAccess', 'admin.models.user-access'],
        'role-quota': ['quotas', 'PUT', { subjectType: 'role', subjectId: 'user', tokenLimit: 0, companyCostMicrosLimit: null }, 'setQuota', 'admin.models.quota'],
        'user-quota': ['quotas', 'PUT', { subjectType: 'user', subjectId: change === 'numeric-alias' ? String(target.id).padStart(8, '0') : String(target.id), tokenLimit: 0, companyCostMicrosLimit: null }, 'setQuota', 'admin.models.quota'],
        provider: ['model-providers', 'PUT', { ...providerInput, displayName: 'Updated', status: 'enabled' }, 'upsertProvider', 'admin.model-providers.upsert'],
        settings: ['model-settings', 'PUT', { ops: [{ op: 'set', path: ['providers', provider, 'displayName'], value: 'Updated' }] }, 'mutateOrganizationModelSettings', 'admin.model-settings.mutate'],
        'credential-set': ['model-settings/credentials', 'PUT', { ref, value: 'fixture-updated-secret' }, 'setOrganizationCredential', 'admin.model-settings.credential.set'],
        'credential-unset': ['model-settings/credentials', 'DELETE', { ref }, 'unsetOrganizationCredential', 'admin.model-settings.credential.unset'],
        'project-access': ['project-model-access', 'PUT', { projectId: project?.id, provider, model: 'chat', allowed: true }, 'setProjectAccess', 'admin.models.project-access'],
        'project-access-all': ['project-model-access', 'PUT', { projectId: project?.id, all: true, allowed: true }, 'setAllProjectAccess', 'admin.models.project-access-all'],
        'project-quota': ['quotas', 'PUT', { subjectType: 'project', subjectId: String(project?.id), tokenLimit: 0, companyCostMicrosLimit: null }, 'setQuota', 'admin.models.quota'],
        discovery: ['model-settings/discover', 'POST', { provider, baseURL: endpoint, api: 'openai-completions' }, 'discoverOrganizationModels', null],
        'explicit-discovery': ['model-settings/discover', 'POST', { provider, baseURL: endpoint, api: 'openai-completions', apiKey: 'fixture-explicit-secret' }, 'discoverOrganizationModels', null],
      }
      const [path, method, body, member, action] = routes[operation]
      let entered
      const observed = new Promise(done => { entered = done })
      const gate = new Promise(done => { release = done })
      const mutate = governance[member].bind(governance)
      governance[member] = async (...args) => {
        if (!lateRead) { entered(); await gate }
        return mutate(...args)
      }
      gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) }); await listen(gateway)
      cfg.port = gateway.address().port
      const origin = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      const state = async () => {
        const value = { models: await governance.listModels(), access: await governance.userOverrides(target.id),
          quota: context === undefined ? await governance.userQuota(target.id)
            : (await pool.query(`SELECT q.* FROM harness.user_quotas q JOIN harness.users u ON u.id=q.user_id
              WHERE u.organization_id=$1 AND u.public_id=$2`, [context.organizationId, target.id])).rows,
          role: await governance.roleQuota('user'), revision: await governance.configurationRevision(),
          ...(context === undefined ? {} : { providers: await governance.listProviders(), projectAccess: await governance.projectOverrides(project.id), projectQuota: await governance.projectQuota(project.id) }) }
        return createHash('sha256').update(JSON.stringify(value)).digest('hex')
      }
      const discovery = operation === 'discovery' || operation === 'explicit-discovery'
      decryptions = 0
      pending = fetch(`${origin}/admin/api/${path}`, { method, headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, actorUserId: keeper.id }),
      }).then(async response => ({ status: response.status, body: await response.text() }))
      await observed
      if (change === 'role' || change === 'late-role') await users.setRole(actor.id, 'user')
      if (lateRead) {
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [context.organizationId, actor.id])).rows[0].id
        if (change === 'late-disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'late-deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'late-disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'late-missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'late-disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [context.organizationId])
        if (change === 'late-password-reset') await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [internal])
      }
      if (change === 'deleted-target') await users.remove(target.id)
      if (change === 'archived-target') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [context.organizationId, project.id])
      if (change === 'password-reset') await users.resetPassword(actor.id, 'pw-replacement', keeper.id)
      const before = await state()
      release()
      const response = await pending
      const expected = change === 'role' || change === 'password-reset' || lateRead ? 403 : change === 'deleted-target' || change === 'archived-target' ? 400
        : discovery || operation === 'settings' ? 200 : 204
      assert.equal(response.status, expected, JSON.stringify({ operation, change, discoveryRequests: discoveries, decryptions }))
      const code = response.status >= 400 ? JSON.parse(response.body).error : null
      if (change === 'role' || change === 'password-reset' || lateRead) assert.equal(code, 'forbidden')
      if (lateRead) assert.equal(response.body.includes('fixture-discovered'), false)
      const changed = before !== await state()
      if (response.status >= 400) assert.equal(changed, false)
      assert.equal(discoveries, discovery && (change === 'current' || lateRead) ? 1 : 0)
      if (change === 'role' || change === 'password-reset') assert.equal(decryptions, 0)
      if (discovery && change === 'current') assert.deepEqual(JSON.parse(response.body).models.map(row => row.id), ['fixture-discovered'])
      let quotaApplied = null
      if (change === 'numeric-alias') { quotaApplied = (await governance.userQuota(target.id)).tokenLimit === 0; assert.equal(quotaApplied, true) }
      const successes = action === null ? [] : await audit.query({ action })
      const failures = await audit.query({ action: 'admin.request' })
      assert.equal(successes.length, action !== null && response.status < 400 ? 1 : 0)
      assert.equal(failures.length, response.status >= 400 ? 1 : 0)
      console.log(JSON.stringify({ backend, operation, change, status: response.status,
        code: typeof code === 'string' && code.startsWith('unknown user') ? 'unknown-user' : typeof code === 'string' && code.startsWith('unknown project') ? 'unknown-project' : code,
        changed, discoveryRequests: discoveries, successAudit: successes.length, failedAuditStatus: failures[0]?.status ?? null, quotaApplied }))
    } catch (error) { primaryError = error; throw error }
    finally {
      const failures = [], close = async work => { try { await work() } catch (error) { failures.push(error) } }
      release?.()
      await close(async () => { await pending })
      await close(async () => { await manager?.stopAll() })
      if (gateway?.listening) await close(() => closeServer(gateway))
      if (probe?.listening) await close(() => closeServer(probe))
      await close(async () => { db?.close() })
      if (context !== undefined) await close(async () => {
        await pool.query('DELETE FROM harness.model_prices WHERE model_id IN (SELECT id FROM harness.model_catalog WHERE organization_id=$1)', [context.organizationId])
        await pool.query('DELETE FROM harness.user_quotas WHERE user_id IN (SELECT id FROM harness.users WHERE organization_id=$1)', [context.organizationId])
        await pool.query('DELETE FROM harness.project_quotas WHERE project_id IN (SELECT id FROM harness.projects WHERE organization_id=$1)', [context.organizationId])
        const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
        for (let pass = 0; pass < 12; pass += 1) {
          let blocked = false
          for (const { table_name: table } of tables) {
            try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [context.organizationId]) }
            catch (error) { if (error.code === '23503') blocked = true; else throw error }
          }
          if (!blocked) break
        }
        await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [context.organizationId])
        await pool.query('DELETE FROM harness.organizations WHERE id=$1', [context.organizationId])
      })
      await close(() => rm(root, { recursive: true, force: true }))
      if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Model administration replay cleanup failed')
    }
  }
} finally { await pool?.end() }
