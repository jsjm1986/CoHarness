/** Real stored/draft credential discovery through Gateway HTTP, PostgreSQL and two owned catalog origins. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
const gatewayRoot = artifactRoot ?? fileURLToPath(new URL('../../', import.meta.url))
const load = name => import(pathToFileURL(`${gatewayRoot}/${mode}/${name}.${mode === 'src' ? 'ts' : 'js'}`))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresCollaborationService }, { PostgresAuthService }, { PostgresAuditService },
  { PostgresInstanceRepository }, { PostgresModelGovernanceService, projectProviderCredentialRef },
  { OrganizationModelCredentialCipher }, { InstanceManager }, { loadConfig }, { createGatewayServer },
  { createAdminApiHandler }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/collaboration-service', 'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository',
  'postgres/model-governance-service', 'organization-model-credentials', 'instances', 'config', 'server', 'admin-api',
].map(load))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(url)
const pool = createPostgresPool(url, { max: 1 })
const listen = server => new Promise((done, fail) => {
  server.once('error', fail)
  server.listen(0, '127.0.0.1', () => { server.off('error', fail); done() })
})
const close = async server => {
  server.closeAllConnections()
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
}
try {
  await runMigrations(pool, join(gatewayRoot, 'deploy/postgres/migrations'))
  for (const scope of ['organization', 'project']) for (const api of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
    for (const credential of ['stored', 'draft']) for (const redirect of ['same-origin', 'cross-origin']) {
      const root = await mkdtemp(join(tmpdir(), 'model-discovery-redirect-'))
      let organizationId, gateway, source, destination, instances
      try {
        const slug = `model-redirect-${randomUUID()}`
        organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Discovery redirect') RETURNING id", [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'redirect-node')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'redirect-node')
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
        await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
        const owner = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(owner.id, 'pw-12345678')
        const project = await projects.createManaged({ name: 'Discovery redirect', ownerUserId: owner.id })
        const cipher = new OrganizationModelCredentialCipher(Buffer.alloc(32, 7)), decrypt = cipher.decrypt.bind(cipher)
        let decryptions = 0, sourceRequests = 0, destinationRequests = 0, forwardedCredential = false
        cipher.decrypt = (...args) => { decryptions += 1; return decrypt(...args) }
        const governance = new PostgresModelGovernanceService(context, cipher)
        const key = credential === 'draft' ? 'fixture-draft-key' : 'fixture-stored-key'
        const authenticated = request => api === 'anthropic-messages' ? request.headers['x-api-key'] === key : request.headers.authorization === `Bearer ${key}`
        const models = { data: [{ id: 'fixture-redirect-model' }], has_more: false }
        destination = createServer((request, response) => {
          destinationRequests += 1
          forwardedCredential ||= authenticated(request)
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models))
        })
        await listen(destination)
        source = createServer((request, response) => {
          sourceRequests += 1
          assert.equal(authenticated(request), true)
          if (request.url.startsWith('/final-models')) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models))
          else response.writeHead(302, { location: redirect === 'same-origin' ? '/final-models' : `http://127.0.0.1:${destination.address().port}/models` }).end()
        })
        await listen(source)
        const endpoint = `http://127.0.0.1:${source.address().port}`, provider = scope === 'organization' ? 'org-redirect-fixture' : 'redirect-fixture'
        if (scope === 'project') {
          const ref = projectProviderCredentialRef(project.id, provider)
          await governance.mutateProjectModelSettings(project.id, [{ op: 'set', path: ['providers', provider], value: {
            api, baseURL: endpoint, apiKeyEnv: ref, models: [{ id: 'fixture-redirect-model' }],
          } }])
          await governance.setProjectCredential(project.id, ref, 'fixture-stored-key')
        } else {
          await governance.upsertProvider({ provider, displayName: 'Fixture provider', driver: 'pi-ai', protocol: api, baseURL: endpoint, authMode: 'api-key', status: 'draft', credential: 'fixture-stored-key' })
        }
        instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
        const deps = { cfg, users, projects, governance, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context), collaboration: new PostgresCollaborationService(context) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await listen(gateway)
        const base = `http://127.0.0.1:${gateway.address().port}`
        cfg.publicOrigins.push(base)
        const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: owner.username, password: 'pw-12345678' }) })
        await login.arrayBuffer()
        assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]
        assert.ok(cookie)
        const path = scope === 'project' ? `/account/api/projects/${project.id}/model-settings/discover` : '/admin/api/model-settings/discover'
        const response = await fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ provider, api, baseURL: endpoint, ...(credential === 'draft' ? { apiKey: key } : {}) }) })
        const body = await response.text(), expected = redirect === 'same-origin' ? 200 : 400
        assert.equal(response.status, expected, body)
        assert.equal(destinationRequests, 0)
        assert.equal(forwardedCredential, false)
        assert.equal(sourceRequests, redirect === 'same-origin' ? 2 : 1)
        assert.equal(decryptions, credential === 'stored' ? 1 : 0)
        assert.equal(body.includes(key), false)
        assert.equal(body.includes('fixture-redirect-model'), redirect === 'same-origin')
        process.stdout.write(JSON.stringify({ scope, api, credential, redirect, status: response.status, sourceRequests, destinationRequests, forwardedCredential, decryptions }) + '\n')
      } finally {
        if (gateway) await close(gateway)
        if (source) await close(source)
        if (destination) await close(destination)
        await instances?.stopAll()
        if (organizationId) await removeFixtureOrganization(pool, organizationId)
        await rm(root, { recursive: true, force: true })
      }
    }
  }
} finally { await pool.end() }
