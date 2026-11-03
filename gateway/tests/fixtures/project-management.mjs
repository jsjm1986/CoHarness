/** Real project manager revocation through Gateway HTTP, PostgreSQL and a loopback-only model catalog. */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project management replay requires src or lib.')
const entry = mode, extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${entry}/${name}.${extension}`, import.meta.url))
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
const { PostgresCollaborationService } = await load('postgres/collaboration-service')
const { PostgresAuthService } = await load('postgres/auth-service')
const { PostgresAuditService } = await load('postgres/audit-service')
const { PostgresInstanceRepository } = await load('postgres/instance-repository')
const { PostgresModelGovernanceService, projectProviderCredentialRef } = await load('postgres/model-governance-service')
const { OrganizationModelCredentialCipher } = await load('organization-model-credentials')
const { InstanceManager } = await load('instances')
const { loadConfig } = await load('config')
const { createGatewayServer } = await load('server')
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl)
const listen = server => new Promise((ready, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); ready() })
})
const close = async server => {
  server.closeAllConnections()
  await new Promise((done, reject) => server.close(error => { if (error) reject(error); else done() }))
}
const failures = []
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const operation of ['name', 'theme', 'models', 'credential-set', 'credential-unset', 'discover']) {
    const root = await mkdtemp(join(tmpdir(), 'project-manager-replay-')), slug = `manager-${randomUUID()}`
    let server, probe, instances, pending, release, organizationId
    try {
      organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,'Project manager replay') RETURNING id`, [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'manager-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'manager-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
        HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
      const users = new PostgresUserService(context, cfg)
      const owner = await users.create({ username: 'former-owner', password: 'pw-12345678' })
      const administrator = await users.create({ username: 'current-owner', password: 'pw-12345678', role: 'admin' })
      for (const actor of [owner, administrator]) await users.changeOwnPassword(actor.id, 'pw-12345678')
      const projects = new PostgresProjectService(context, cfg)
      const project = await projects.createManaged({ name: 'Management authority', ownerUserId: owner.id })
      const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 7)))
      let discoveries = 0
      probe = createServer((_request, response) => {
        discoveries += 1
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      })
      await listen(probe)
      const endpoint = `http://127.0.0.1:${probe.address().port}/v1`, ref = projectProviderCredentialRef(project.id, 'fixture')
      await governance.mutateProjectModelSettings(project.id, [{ op: 'set', path: ['providers', 'fixture'], value: {
        api: 'openai-completions', baseURL: endpoint, apiKeyEnv: ref, displayName: 'Fixture provider', models: [{ id: 'fixture-model' }],
      } }])
      await governance.setProjectCredential(project.id, ref, 'fixture-initial-secret')
      const currentView = await governance.describeProjectModelSettings(project.id)
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
      server = createGatewayServer({ cfg, users, projects, governance, instances,
        auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
        collaboration: new PostgresCollaborationService(context) }, {
        proxy: async (_request, response, selected) => {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(selected.scope))
        },
      })
      await listen(server)
      const base = `http://127.0.0.1:${server.address().port}`
      cfg.publicOrigins.push(base)
      const login = async actor => {
        const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await response.arrayBuffer(); assert.equal(response.status, 302)
        const cookie = response.headers.get('set-cookie')?.split(';')[0]
        assert(cookie !== undefined); return cookie
      }
      const ownerCookie = await login(owner), adminCookie = await login(administrator)
      if (operation === 'name') {
        const viewer = await users.create({ username: 'viewer', password: 'pw-12345678' })
        await users.changeOwnPassword(viewer.id, 'pw-12345678')
        await projects.setMember(project.id, viewer.id, 'ro', administrator.id)
        const viewerCookie = await login(viewer), get = projects.getById.bind(projects)
        let detailReads = 0
        projects.getById = async id => { detailReads += 1; return get(id) }
        try {
          const route = async cookie => {
            const response = await fetch(`${base}/api/host.describe?dshTarget=project:${project.id}`, { headers: { cookie } })
            return { status: response.status, scope: await response.json() }
          }
          const currentOwner = await route(ownerCookie), readonlyMember = await route(viewerCookie)
          assert.equal(currentOwner.status, 200)
          assert.equal(currentOwner.scope.canManage, true)
          assert.equal(readonlyMember.status, 200)
          assert.equal(readonlyMember.scope.mode, 'ro')
          assert.equal(readonlyMember.scope.canManage, false)
          await projects.setThemePolicy(project.id, 'dark', administrator.id)
          const theme = await route(ownerCookie)
          assert.equal(theme.scope.uiThemePolicy, 'dark')
          await projects.setThemePolicy(project.id, 'follow-user', administrator.id)
          await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users
            WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,
          [organizationId, project.id, administrator.id])
          const formerOwner = await route(ownerCookie)
          assert.equal(formerOwner.status, 200)
          assert.equal(formerOwner.scope.canManage, false)
          await projects.removeMember(project.id, viewer.id, administrator.id)
          const withdrawn = await route(viewerCookie)
          assert.equal(withdrawn.status, 403)
          await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users
            WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,
          [organizationId, project.id, owner.id])
          assert.equal(detailReads, 0, 'Project routing must not load the member directory')
          process.stdout.write(`${JSON.stringify({ operation: 'route-authority', ownerCanManage: currentOwner.scope.canManage,
            readonlyMemberMode: readonlyMember.scope.mode, readonlyMemberCanManage: readonlyMember.scope.canManage,
            currentTheme: theme.scope.uiThemePolicy, formerOwnerCanManage: formerOwner.scope.canManage,
            withdrawnMemberStatus: withdrawn.status, projectDetailReads: detailReads })}\n`)
        } finally { projects.getById = get }
      }
      const routes = {
        name: ['', 'PATCH', { name: 'Authorized update' }],
        theme: ['/configuration', 'PATCH', { themePolicy: 'dark' }],
        models: ['/model-settings', 'PATCH', { expectedRevision: currentView.revision,
          ops: [{ op: 'set', path: ['providers', 'fixture', 'displayName'], value: 'Authorized provider' }] }],
        'credential-set': ['/model-settings/credentials', 'PUT', { ref, value: 'fixture-changed-secret' }],
        'credential-unset': ['/model-settings/credentials', 'DELETE', { ref }],
        discover: ['/model-settings/discover', 'POST', { provider: 'fixture', api: 'openai-completions', baseURL: endpoint }],
      }
      const [suffix, method, body] = routes[operation]
      const send = cookie => fetch(`${base}/account/api/projects/${project.id}${suffix}`, { method,
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, actorUserId: administrator.id }),
      }).then(async response => ({ status: response.status, body: await response.text() }))
      const state = async () => {
        const row = await pool.query(`SELECT p.name,p.ui_theme_policy,p.project_model_configuration_revision,
          (SELECT jsonb_agg(jsonb_build_object('profile',m.profile,'status',m.status)) FROM harness.project_model_providers m
            WHERE m.organization_id=p.organization_id AND m.project_id=p.id) providers,
          (SELECT jsonb_agg(jsonb_build_object('nonce',encode(c.nonce,'hex'),'ciphertext',encode(c.ciphertext,'hex')))
            FROM harness.project_model_credentials c WHERE c.organization_id=p.organization_id AND c.project_id=p.id) credentials
          FROM harness.projects p WHERE p.organization_id=$1 AND p.public_id=$2`, [organizationId, project.id])
        return row.rows[0]
      }
      const before = await state(), observed = Promise.withResolvers(), gate = Promise.withResolvers()
      release = () => gate.resolve()
      const get = projects.getById.bind(projects)
      let held = false
      projects.getById = async id => {
        const value = await get(id)
        if (id === project.id && !held) { held = true; observed.resolve(); await gate.promise }
        return value
      }
      pending = send(ownerCookie)
      await observed.promise
      await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users
        WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,
      [organizationId, project.id, administrator.id])
      release()
      const denied = await pending, preserved = isDeepStrictEqual(before, await state()), dispatchedBeforeAdmission = discoveries
      const audit = await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action LIKE 'projects.%'", [organizationId])
      projects.getById = get
      const allowed = await send(adminCookie), changed = operation === 'discover' ? discoveries > dispatchedBeforeAdmission
        : !isDeepStrictEqual(before, await state())
      const expectedAllowed = ['name', 'credential-set', 'credential-unset'].includes(operation) ? 204 : 200
      const event = { operation, formerOwnerStatus: denied.status, originalStatePreserved: preserved,
        successfulMutationAuditAfterDenial: audit.rowCount !== 0, unauthorizedDiscoveryCalls: dispatchedBeforeAdmission,
        currentOwnerStatus: allowed.status, currentOwnerActionApplied: changed }
      process.stdout.write(`${JSON.stringify(event)}\n`)
      if (denied.status !== 403 || !preserved || audit.rowCount !== 0 || dispatchedBeforeAdmission !== 0
        || allowed.status !== expectedAllowed || !changed) failures.push(operation)
    } finally {
      release?.(); await pending?.catch(() => {})
      if (server !== undefined) await close(server)
      if (probe !== undefined) await close(probe)
      await instances?.stopAll()
      if (organizationId !== undefined) await removeFixtureOrganization(pool, organizationId)
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], 'Project management authority was not retained')
} finally { await pool.end() }
