/** Real account invitation history and pending counts after committed browser or management changes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
const changes = ['current', 'owner-transfer', 'removed-member', 'computer-disabled', 'project-archived', 'mount-disabled',
  'administrator-current', 'administrator-demoted', 'disabled-account', 'deleted-account', 'disabled-membership',
  'missing-membership', 'disabled-organization', 'password-reset', 'password-required', 'missing-credential', 'logout', 'session-expired']
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const operation of ['list', 'count']) for (const change of changes) {
    const root = await mkdtemp(join(process.env.DSH_INVITATION_INBOX_FIXTURE_ROOT ?? tmpdir(), 'invitation-inbox-read-'))
    let organizationId, server, instances, pending, release, restore, runtimeStarts = 0
    try {
      const slug = randomUUID()
      organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Invitation inbox') RETURNING id", [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'inbox-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'inbox-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
      const actor = await users.create({ username: 'inbox-account', password: 'synthetic-password',
        ...(change.startsWith('administrator-') ? { role: 'admin' } : {}) })
      const keeper = await users.create({ username: 'keeper-admin', password: 'synthetic-password', role: 'admin' })
      for (const user of [actor, keeper]) await users.changeOwnPassword(user.id, 'synthetic-password')
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const project = await projects.createManaged({ name: 'Previously managed invitations', ownerUserId: keeper.id })
      const received = await projects.createInvitation({ projectId: project.id, inviterUserId: keeper.id, inviteeUserId: actor.id, mode: 'rw' })
      await projects.acceptInvitation(received.id, actor.id)
      const transfer = owner => pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)
        WHERE organization_id=$1 AND public_id=$2`, [organizationId, project.id, owner])
      if (!change.startsWith('administrator-')) await transfer(actor.id)
      const ownRecipient = await users.create({ username: 'own-recipient', password: 'synthetic-password' })
      const otherRecipient = await users.create({ username: 'other-recipient', password: 'synthetic-password' })
      const outgoing = await projects.createInvitation({ projectId: project.id, inviterUserId: actor.id, inviteeUserId: ownRecipient.id, mode: 'ro' })
      const foreign = await projects.createInvitation({ projectId: project.id, inviterUserId: keeper.id, inviteeUserId: otherRecipient.id, mode: 'rw' })
      const unjoined = await projects.createManaged({ name: 'Pending incoming project', ownerUserId: keeper.id })
      const incoming = await projects.createInvitation({ projectId: unjoined.id, inviterUserId: keeper.id, inviteeUserId: actor.id, mode: 'ro' })
      const auth = new PostgresAuthService(context, cfg), entered = Promise.withResolvers(), gate = Promise.withResolvers()
      const key = operation === 'list' ? 'listInvitations' : 'countPendingInvitations', original = projects[key].bind(projects)
      release = () => gate.resolve(); restore = () => { projects[key] = original }
      let held = false
      projects[key] = async (...args) => {
        const value = await original(...args)
        if (!held) { held = true; entered.resolve(); await gate.promise }
        return value
      }
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg,
        { instancesOutliveGateway: false, start: async () => { runtimeStarts += 1; throw new Error('Inbox reads must not start a Runtime') } })
      server = createGatewayServer({ cfg, users, projects, instances, auth, audit: new PostgresAuditService(context),
        collaboration: new PostgresCollaborationService(context) })
      await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
      const origin = `http://127.0.0.1:${server.address().port}`; cfg.publicOrigins.push(origin)
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      pending = fetch(`${origin}/account/api/invitations${operation === 'count' ? '/count' : ''}`, {
        headers: { cookie }, signal: AbortSignal.timeout(15000),
      }).then(async response => ({ status: response.status, body: await response.json() }))
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Inbox returned before preparation: ${JSON.stringify(result)}`) })])
      assert.equal(pool.idleCount, 1)
      if (change === 'owner-transfer') await transfer(keeper.id)
      if (change === 'removed-member') await pool.query(`DELETE FROM harness.project_members WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2) AND user_id=$3`, [organizationId, project.id, internal])
      if (change === 'computer-disabled') await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, internal, context.nodeId])
      if (change === 'project-archived') await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      if (change === 'mount-disabled') await pool.query(`UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1
        AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)`, [organizationId, project.id])
      if (change === 'administrator-demoted') await users.setRole(actor.id, 'user', keeper.id)
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
      release(); const result = await pending; restore()
      const eligible = changes.indexOf(change) < changes.indexOf('disabled-account')
      const manages = ['current', 'administrator-current'].includes(change)
      const includes = invitation => Array.isArray(result.body) && result.body.some(row => row.id === invitation.id)
      const preserved = (await pool.query('SELECT count(*)::int n FROM harness.project_invitations WHERE organization_id=$1', [organizationId])).rows[0].n === 4
      const row = { operation, change, status: result.status,
        ...(operation === 'list' ? { receivedHistory: includes(received), outgoingHistory: includes(outgoing),
          pendingIncoming: includes(incoming), otherAccounts: includes(foreign) } : { pendingCount: result.body.pending ?? null }),
        invitationRowsPreserved: preserved, runtimeStarts }
      process.stdout.write(`${JSON.stringify(row)}\n`)
      if (result.status !== (eligible ? 200 : 403) || !preserved || runtimeStarts !== 0
        || operation === 'list' && (includes(received) !== eligible || includes(outgoing) !== eligible
          || includes(incoming) !== eligible || includes(foreign) !== (eligible && manages))
        || operation === 'count' && (result.body.pending ?? null) !== (eligible ? 1 : null)) failures.push(`${operation}:${change}`)
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
