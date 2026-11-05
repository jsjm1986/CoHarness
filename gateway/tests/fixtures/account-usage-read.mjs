/** Real personal and project usage reads retain their selected billing owner after authority changes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const [mode = 'src', artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresCollaborationService }, { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository },
  { PostgresModelGovernanceService }, { OrganizationModelCredentialCipher }, { PostgresRuntimeCatalog },
  { GatewayRuntimeRouter, LocalRuntimeAdapter }, { InstanceManager }, { loadConfig }, { createGatewayServer }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/collaboration-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository', 'postgres/model-governance-service',
  'organization-model-credentials', 'postgres/runtime-catalog', 'runtime-router', 'instances', 'config', 'server',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const pool = createPostgresPool(databaseUrl, { max: 1 }), failures = []
const changes = ['current', 'owner-transfer', 'removed-member', 'disabled-account', 'deleted-account', 'disabled-membership',
  'missing-membership', 'disabled-organization', 'password-reset', 'password-required', 'missing-credential', 'logout',
  'session-expired', 'computer-disabled', 'foreign-computer-only', 'project-archived', 'mount-disabled',
  'administrator-current', 'administrator-demoted', 'readonly-member', 'contributor-member', 'administrator-promoted']
const scenarios = ['personal', 'project'].flatMap(scope => changes.map(change => ({ scope, change })))
scenarios.push(...['steward-current', 'steward-withdrawn', 'steward-demoted'].map(change => ({ scope: 'project', change })))
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const { scope, change } of scenarios) {
    const root = await mkdtemp(join(process.env.DSH_USAGE_READ_FIXTURE_ROOT ?? tmpdir(), 'account-usage-read-'))
    let organizationId, server, instances, pending, release, restore, runtimeStarts = 0
    try {
      const slug = randomUUID()
      organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Account usage') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'usage-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'usage-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const steward = change.startsWith('steward-'), administrator = steward || change.startsWith('administrator-') && change !== 'administrator-promoted'
      const actor = await users.create({ username: 'usage-reader', password: 'synthetic-password', ...(administrator ? { role: 'admin' } : {}) })
      const keeper = await users.create({ username: 'keeper-admin', password: 'synthetic-password', role: 'admin' })
      for (const user of [actor, keeper]) await users.changeOwnPassword(user.id, 'synthetic-password')
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const path = join(root, 'steward'); if (steward) await mkdir(path)
      const project = steward ? await projects.ensureSteward({ name: 'Steward usage', path, createdBy: actor.id })
        : await projects.createManaged({ name: 'Selected project usage', ownerUserId: actor.id })
      if (steward) await pool.query('INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision) VALUES($1,$2,$3,true,1)', [organizationId, context.nodeId, internal])
      const transfer = () => pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)
        WHERE organization_id=$1 AND public_id=$2`, [organizationId, project.id, keeper.id])
      if (['administrator-current', 'administrator-demoted', 'readonly-member', 'contributor-member', 'administrator-promoted'].includes(change)) {
        await transfer()
        if (change === 'readonly-member') await projects.setMember(project.id, actor.id, 'ro', keeper.id)
      }
      const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 17)))
      await governance.setQuota('user', String(actor.id), 2841, null)
      await governance.setQuota('project', String(project.id), 4173, null)
      const entered = Promise.withResolvers(), gate = Promise.withResolvers(), original = governance.summary.bind(governance)
      let selected, held = false
      release = () => gate.resolve(); restore = () => { governance.summary = original }
      governance.summary = async (...args) => {
        const value = await original(...args); selected = args[0].kind
        if (!held) { held = true; entered.resolve(); await gate.promise }
        return value
      }
      const auth = new PostgresAuthService(context, cfg), collaboration = new PostgresCollaborationService(context)
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg,
        { instancesOutliveGateway: false, start: async () => { runtimeStarts += 1; throw new Error('Usage reads must not start a Runtime') } })
      const runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration, instances }),
        { localNodeId: context.nodeId, catalog: new PostgresRuntimeCatalog(context, cfg.runtimeCatalog) })
      server = createGatewayServer({ cfg, users, projects, instances, auth, governance, runtimeRouter,
        collaboration, audit: new PostgresAuditService(context) })
      await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
      const origin = `http://127.0.0.1:${server.address().port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      pending = fetch(`${origin}/account/api/usage?month=2026-11&dshTarget=${scope === 'personal' ? 'personal' : `project:${project.id}`}`, {
        headers: { cookie }, signal: AbortSignal.timeout(15000),
      }).then(async response => ({ status: response.status, body: await response.json() }))
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Usage returned before preparation: ${JSON.stringify(result)}`) })])
      assert.equal(pool.idleCount, 1)
      if (change === 'owner-transfer') await transfer()
      if (change === 'removed-member') await pool.query(`DELETE FROM harness.project_members WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2) AND user_id=$3`, [organizationId, project.id, internal])
      if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
      if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
      if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
      if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
      if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      if (change === 'password-reset') await users.resetPassword(actor.id, 'replacement-password', keeper.id)
      if (change === 'password-required') await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1', [internal])
      if (change === 'missing-credential') await pool.query('DELETE FROM harness.password_credentials WHERE user_id=$1', [internal])
      if (change === 'logout') await auth.revoke(cookie.slice(cookie.indexOf('=') + 1))
      if (change === 'session-expired') await pool.query("UPDATE harness.auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND user_id=$2", [organizationId, internal])
      if (change === 'computer-disabled' || change === 'foreign-computer-only') {
        await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, internal, context.nodeId])
        if (change === 'foreign-computer-only') {
          const other = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'foreign-usage-node') RETURNING id", [organizationId])).rows[0].id
          await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, other, internal])
        }
      }
      if (change === 'project-archived') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      if (change === 'mount-disabled') await pool.query(`UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)`, [organizationId, project.id])
      if (change === 'steward-withdrawn') await pool.query('UPDATE harness.steward_access_policies SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, internal])
      if (change === 'administrator-demoted' || change === 'steward-demoted') await users.setRole(actor.id, 'user', keeper.id)
      if (change === 'administrator-promoted') await users.setRole(actor.id, 'admin', keeper.id)
      release(); const result = await pending; restore()
      const accountWithdrawn = ['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization',
        'password-reset', 'password-required', 'missing-credential', 'logout', 'session-expired'].includes(change)
      const projectWithdrawn = ['removed-member', 'computer-disabled', 'foreign-computer-only', 'project-archived', 'mount-disabled', 'steward-withdrawn', 'steward-demoted'].includes(change)
      const readable = !accountWithdrawn && (scope === 'personal' || !projectWithdrawn)
      const quotaRows = await pool.query('SELECT (SELECT count(*)::int FROM harness.user_quotas q JOIN harness.users u ON u.id=q.user_id WHERE u.organization_id=$1) users,(SELECT count(*)::int FROM harness.project_quotas q JOIN harness.projects p ON p.id=q.project_id WHERE p.organization_id=$1) projects', [organizationId])
      const preserved = quotaRows.rows[0].users === 1 && quotaRows.rows[0].projects === 1
      const row = { scope, change, status: result.status, selectedBillingOwner: selected, publishedLimit: result.body.tokenLimit ?? null,
        quotaRowsPreserved: preserved, runtimeStarts }
      process.stdout.write(`${JSON.stringify(row)}\n`)
      if (result.status !== (readable ? 200 : 403) || selected !== (scope === 'personal' ? 'user' : 'project')
        || (result.body.tokenLimit ?? null) !== (readable ? scope === 'personal' ? 2841 : 4173 : null) || !preserved || runtimeStarts !== 0) failures.push(`${scope}:${change}`)
      if (change === 'current') for (const month of ['', '2026-00', '2026-13', 'November', '2026-1']) {
        const response = await fetch(`${origin}/account/api/usage?month=${encodeURIComponent(month)}&dshTarget=${scope === 'personal' ? 'personal' : `project:${project.id}`}`, { headers: { cookie } })
        const text = await response.text()
        process.stdout.write(`${JSON.stringify({ scope, invalidMonth: month, status: response.status,
          inputError: text === '{"error":"invalid-month"}', runtimeStarts })}\n`)
        if (response.status !== 400 || text !== '{"error":"invalid-month"}' || runtimeStarts !== 0) failures.push(`${scope}:invalid-month:${month}`)
      }
    } finally {
      release?.(); await pending?.catch(() => {}); restore?.()
      if (server !== undefined) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
      await instances?.stopAll()
      if (organizationId !== undefined) await removeFixtureOrganization(pool, organizationId)
      await rm(root, { recursive: true, force: true })
    }
  }
} finally { await pool.end() }
assert.deepEqual(failures, [])
