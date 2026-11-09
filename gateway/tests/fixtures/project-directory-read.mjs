/** Real project metadata and invitation publication after preparation and committed authority changes. */
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
  { InstanceManager }, { loadConfig }, { createGatewayServer }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/collaboration-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository', 'instances', 'config', 'server',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const pool = createPostgresPool(databaseUrl, { max: 1 }), failures = []
const changes = ['current', 'owner-transfer', 'removed-member', 'disabled-account', 'deleted-account', 'disabled-membership',
  'missing-membership', 'disabled-organization', 'password-reset', 'missing-credential', 'computer-disabled', 'foreign-computer-only',
  'project-archived', 'mount-disabled', 'administrator-current', 'administrator-demoted', 'steward-current', 'steward-withdrawn',
  'steward-demoted', 'readonly-member', 'contributor-member', 'administrator-promoted', 'theme-change']
try {
  await runMigrations(pool, process.env.DSH_PROJECT_DIRECTORY_MIGRATIONS ?? resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const operation of ['list', 'detail', 'configuration', 'invitations']) for (const change of changes) {
    const root = await mkdtemp(join(process.env.DSH_PROJECT_DIRECTORY_FIXTURE_ROOT ?? tmpdir(), 'project-directory-read-'))
    let organizationId, gateway, instances, pending, release, restore, runtimeStarts = 0
    try {
      const slug = randomUUID()
      organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Project directory read') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'directory-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'directory-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const administrator = change.startsWith('steward-') || ['administrator-current', 'administrator-demoted'].includes(change)
      const actor = await users.create({ username: 'reading-account', password: 'synthetic-password', ...(administrator ? { role: 'admin' } : {}) })
      const keeper = await users.create({ username: 'keeper-admin', password: 'synthetic-password', role: 'admin' })
      for (const user of [actor, keeper]) await users.changeOwnPassword(user.id, 'synthetic-password')
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const steward = change.startsWith('steward-'), path = join(root, 'steward')
      if (steward) await mkdir(path)
      const project = steward ? await projects.ensureSteward({ name: 'Steward directory', path, createdBy: actor.id })
        : await projects.createManaged({ name: 'Private directory project', ownerUserId: operation === 'invitations' ? keeper.id : actor.id })
      if (steward) await pool.query('INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision) VALUES($1,$2,$3,true,1)', [organizationId, context.nodeId, internal])
      const transfer = () => pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)
        WHERE organization_id=$1 AND public_id=$2`, [organizationId, project.id, keeper.id])
      let ownInvitation, foreignInvitation, receivedInvitation, preparedOwn = false, preparedForeign = false, preparedReceived = false
      if (operation === 'invitations' && !steward) {
        receivedInvitation = await projects.createInvitation({ projectId: project.id, inviterUserId: keeper.id, inviteeUserId: actor.id, mode: 'rw' })
        await projects.acceptInvitation(receivedInvitation.id, actor.id)
        await pool.query(`UPDATE harness.projects SET owner_user_id=$3 WHERE organization_id=$1 AND public_id=$2`, [organizationId, project.id, internal])
        const ownRecipient = await users.create({ username: 'own-recipient', password: 'synthetic-password' })
        const foreignRecipient = await users.create({ username: 'foreign-recipient', password: 'synthetic-password' })
        ownInvitation = await projects.createInvitation({ projectId: project.id, inviterUserId: actor.id, inviteeUserId: ownRecipient.id, mode: 'ro' })
        foreignInvitation = await projects.createInvitation({ projectId: project.id, inviterUserId: keeper.id, inviteeUserId: foreignRecipient.id, mode: 'rw' })
      }
      if (['administrator-current', 'administrator-demoted', 'readonly-member', 'contributor-member', 'administrator-promoted'].includes(change)) {
        await transfer()
        if (change === 'readonly-member') await projects.setMember(project.id, actor.id, 'ro', keeper.id)
      }
      const collaboration = new PostgresCollaborationService(context, context.nodeId), entered = Promise.withResolvers(), gate = Promise.withResolvers()
      release = () => gate.resolve()
      const holder = operation === 'detail' ? collaboration : projects
      const key = operation === 'list' ? 'getByIds' : operation === 'detail' ? 'projectForUser'
        : operation === 'invitations' ? 'listInvitations' : 'getById'
      const original = holder[key].bind(holder); let held = false
      restore = () => { holder[key] = original }
      holder[key] = async (...args) => {
        const value = await original(...args)
        if (operation === 'invitations') {
          preparedOwn = value.some(invitation => invitation.id === ownInvitation?.id)
          preparedForeign = value.some(invitation => invitation.id === foreignInvitation?.id)
          preparedReceived = value.some(invitation => invitation.id === receivedInvitation?.id)
        }
        if (!held) { held = true; entered.resolve(); await gate.promise }
        return value
      }
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg,
        { instancesOutliveGateway: false, start: async () => { runtimeStarts += 1; throw new Error('Directory reads must not start a Runtime') } })
      gateway = createGatewayServer({ cfg, users, projects, collaboration, instances,
        auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) })
      await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
      const origin = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      const suffix = ['configuration', 'invitations'].includes(operation) ? `/${operation}` : ''
      pending = fetch(`${origin}/account/api/projects${operation === 'list' ? '' : `/${project.id}${suffix}`}`, {
        headers: { cookie, origin }, signal: AbortSignal.timeout(15000),
      }).then(async response => ({ status: response.status, body: await response.json() }))
      await Promise.race([entered.promise, pending.then(result => {
        throw new Error(`Project read returned before metadata preparation: ${JSON.stringify(result)}`)
      })])
      assert.equal(pool.idleCount, 1, 'Prepared metadata must release the governance client before waiting')
      if (change === 'owner-transfer') await transfer()
      if (change === 'theme-change') await pool.query("UPDATE harness.projects SET ui_theme_policy='dark' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      if (change === 'removed-member') await pool.query(`DELETE FROM harness.project_members WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2) AND user_id=$3`, [organizationId, project.id, internal])
      if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
      if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
      if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
      if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
      if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      if (change === 'password-reset') await users.resetPassword(actor.id, 'replacement-password', keeper.id)
      if (change === 'missing-credential') await pool.query('DELETE FROM harness.password_credentials WHERE user_id=$1', [internal])
      if (change === 'computer-disabled' || change === 'foreign-computer-only') {
        await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, internal, context.nodeId])
        if (change === 'foreign-computer-only') {
          const other = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other-node') RETURNING id", [organizationId])).rows[0].id
          await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, other, internal])
        }
      }
      if (change === 'project-archived') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      if (change === 'mount-disabled') await pool.query(`UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)`, [organizationId, project.id])
      if (change === 'steward-withdrawn') await pool.query('UPDATE harness.steward_access_policies SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, internal])
      if (change === 'steward-demoted' || change === 'administrator-demoted') await users.setRole(actor.id, 'user', keeper.id)
      if (change === 'administrator-promoted') await users.setRole(actor.id, 'admin', keeper.id)
      release(); const result = await pending; restore()
      const readable = ['current', 'owner-transfer', 'administrator-current', 'administrator-demoted', 'steward-current', 'readonly-member', 'contributor-member', 'administrator-promoted', 'theme-change'].includes(change)
      const accountWithdrawn = ['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'password-reset', 'missing-credential'].includes(change)
      const expected = operation !== 'list' ? readable ? 200 : 403 : accountWithdrawn ? 403 : 200
      const value = operation === 'list' ? Array.isArray(result.body) ? result.body.find(row => row.id === project.id) : undefined
        : result.status !== 200 ? undefined : operation === 'configuration'
          ? { ...result.body.project, canManage: result.body.canManage, uiThemePolicy: result.body.project.themePolicy } : result.body
      const expectedManage = !['owner-transfer', 'administrator-demoted', 'readonly-member', 'contributor-member'].includes(change)
      if (operation === 'invitations') {
        const ownPublished = Array.isArray(result.body) && result.body.some(invitation => invitation.id === ownInvitation?.id)
        const foreignPublished = Array.isArray(result.body) && result.body.some(invitation => invitation.id === foreignInvitation?.id)
        const receivedPublished = Array.isArray(result.body) && result.body.some(invitation => invitation.id === receivedInvitation?.id)
        const preserved = (await pool.query("SELECT count(*)::int n FROM harness.project_invitations WHERE organization_id=$1 AND status='pending'", [organizationId])).rows[0].n === (steward ? 0 : 2)
        process.stdout.write(`${JSON.stringify({ operation, change, status: result.status, ownInvitationPublished: ownPublished,
          receivedInvitationPublished: receivedPublished, foreignInvitationPublished: foreignPublished,
          pendingInvitationsPreserved: preserved, runtimeStarts })}\n`)
        // The recipient history remains readable after accepting the invitation and losing management authority.
        if (result.status !== expected || ownPublished !== (readable && preparedOwn)
          || receivedPublished !== (readable && preparedReceived)
          || foreignPublished !== (readable && expectedManage && preparedForeign) || !preserved || runtimeStarts !== 0) failures.push(`${operation}:${change}`)
        continue
      }
      const owner = (await pool.query(`SELECT u.public_id::float8 id FROM harness.projects p LEFT JOIN harness.users u ON u.id=p.owner_user_id
        WHERE p.organization_id=$1 AND p.public_id=$2`, [organizationId, project.id])).rows[0]?.id ?? null
      const background = ['password-reset', 'missing-credential'].includes(change)
        ? await collaboration.projectForUser(project.id, actor.id) !== null : null
      let reservedMemberDirectoryStatus
      if (operation === 'configuration' && change === 'steward-current') {
        const response = await fetch(`${origin}/account/api/projects/${project.id}/invitable-users`, { headers: { cookie } })
        reservedMemberDirectoryStatus = response.status
        assert.deepEqual(await response.json(), { error: 'steward-reserved' }); assert.equal(response.status, 403)
      }
      const row = { operation, change, status: result.status, projectPublished: value !== undefined,
        canManage: value?.canManage ?? null, ownerCurrent: value === undefined ? null : (value.owner?.id ?? null) === owner,
        backgroundAuthorityRetained: background, runtimeStarts,
        ...(change === 'theme-change' ? { theme: value?.uiThemePolicy ?? null } : {}),
        ...(operation === 'configuration' ? { capabilitiesCurrent: value === undefined ? null
          : result.body.capabilities.themePolicy === expectedManage && result.body.capabilities.runtimeSettings === expectedManage
            && result.body.capabilities.members === (expectedManage && !steward) && result.body.capabilities.projectModels === false
            && result.body.capabilities.sshTargets === false && result.body.capabilities.filesystem === false } : {}),
        ...(reservedMemberDirectoryStatus === undefined ? {} : {
          memberManagementAdvertised: result.body.capabilities.members, reservedMemberDirectoryStatus,
        }),
      }
      process.stdout.write(`${JSON.stringify(row)}\n`)
      if (result.status !== expected || (value !== undefined) !== readable || (value !== undefined
        && (value.canManage !== expectedManage || row.ownerCurrent !== true)) || runtimeStarts !== 0 || background === false
        || row.capabilitiesCurrent === false || change === 'theme-change' && row.theme !== 'dark') failures.push(`${operation}:${change}`)
    } finally {
      release?.(); await pending?.catch(() => {}); restore?.()
      if (gateway !== undefined) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)) }
      await instances?.stopAll()
      if (organizationId !== undefined) await removeFixtureOrganization(pool, organizationId)
      await rm(root, { recursive: true, force: true })
    }
  }
} finally { await pool.end() }
assert.deepEqual(failures, [])
