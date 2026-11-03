/** Current recipient membership and project availability after an actual Gateway recipient lookup. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Invitation replay requires src or lib.')
const extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${mode}/${name}.${extension}`, import.meta.url))
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
const { PostgresCollaborationService } = await load('postgres/collaboration-service')
const { PostgresAuthService } = await load('postgres/auth-service')
const { PostgresAuditService } = await load('postgres/audit-service')
const { PostgresInstanceRepository } = await load('postgres/instance-repository')
const { InstanceManager } = await load('instances')
const { loadConfig } = await load('config')
const { createGatewayServer } = await load('server')
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl), failures = []
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const revocation of ['recipient-account', 'recipient-membership', 'recipient-membership-removed', 'recipient-computer', 'organization', 'project', 'inviter-membership']) {
    const root = await mkdtemp(join(tmpdir(), 'invitation-admission-')), slug = `invitation-${randomUUID()}`
    let server, instances, pending, release
    try {
      const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,'Invitation admission') RETURNING id`, [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'invitation-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'invitation-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
        HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
      const users = new PostgresUserService(context, cfg)
      const inviter = await users.create({ username: 'invitation-owner', password: 'pw-12345678' })
      const recipient = await users.create({ username: 'invitation-recipient', password: 'pw-12345678' })
      await users.changeOwnPassword(inviter.id, 'pw-12345678')
      if (revocation === 'recipient-computer') await users.changeOwnPassword(recipient.id, 'pw-12345678')
      const ids = (await pool.query('SELECT id,public_id FROM harness.users WHERE organization_id=$1', [organizationId])).rows
      const recipientId = ids.find(row => Number(row.public_id) === recipient.id).id
      const inviterId = ids.find(row => Number(row.public_id) === inviter.id).id
      const projects = new PostgresProjectService(context, cfg)
      const project = await projects.createManaged({ name: 'Invitation admission scope', ownerUserId: inviter.id, actorUserId: inviter.id })
      instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
        instancesOutliveGateway: false, start: async () => { throw new Error('Invitation replay must not start host processes.') },
        attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
      })
      server = createGatewayServer({ cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg),
        audit: new PostgresAuditService(context), collaboration: new PostgresCollaborationService(context) })
      await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${server.address().port}`; cfg.publicOrigins.push(base)
      const login = async (account = inviter) => {
        const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: account.username, password: 'pw-12345678' }) })
        await response.arrayBuffer(); assert.equal(response.status, 302)
        const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined); return cookie
      }
      const cookie = await login(), observed = Promise.withResolvers(), gate = Promise.withResolvers()
      const get = users.getByUsername.bind(users); let held = false
      release = () => gate.resolve()
      users.getByUsername = async username => {
        const user = await get(username)
        if (username === recipient.username && !held) { held = true; observed.resolve(); await gate.promise }
        return user
      }
      const send = session => fetch(`${base}/account/api/projects/${project.id}/invitations`, { method: 'POST',
        headers: { cookie: session, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ username: recipient.username, mode: 'rw', inviterUserId: recipient.id }),
      }).then(async response => ({ status: response.status, body: await response.text() }))
      pending = send(cookie)
      await Promise.race([observed.promise, pending.then(response => { throw new Error(`Request completed before recipient capture: ${response.status}`) })])
      if (revocation === 'recipient-account') await users.setStatus(recipient.id, 'disabled')
      else if (revocation === 'recipient-computer') await pool.query('UPDATE harness.computer_use_permissions SET enabled=false,revision=revision+1 WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, recipientId])
      else if (revocation === 'recipient-membership-removed') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organizationId, recipientId])
      else if (revocation === 'recipient-membership' || revocation === 'inviter-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organizationId, revocation === 'recipient-membership' ? recipientId : inviterId])
      else if (revocation === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      else await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      release()
      const denied = await pending
      const pendingPreserved = (await pool.query('SELECT 1 FROM harness.project_invitations WHERE organization_id=$1', [organizationId])).rowCount === 0
      const successfulAudit = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='projects.invitation.create'", [organizationId])).rowCount > 0
      users.getByUsername = get
      if (revocation === 'recipient-account') await users.setStatus(recipient.id, 'active')
      else if (revocation === 'recipient-computer') await pool.query('UPDATE harness.computer_use_permissions SET enabled=true,revision=revision+1 WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, recipientId])
      else if (revocation === 'recipient-membership-removed') await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'member','active')", [organizationId, recipientId])
      else if (revocation === 'recipient-membership' || revocation === 'inviter-membership') await pool.query("UPDATE harness.memberships SET status='active' WHERE organization_id=$1 AND user_id=$2", [organizationId, revocation === 'recipient-membership' ? recipientId : inviterId])
      else if (revocation === 'organization') await pool.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organizationId])
      else await pool.query("UPDATE harness.projects SET status='active' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
      const restored = await send(await login())
      const stored = await pool.query('SELECT inviter_user_id,invitee_user_id,status FROM harness.project_invitations WHERE organization_id=$1', [organizationId])
      const applied = stored.rowCount === 1 && stored.rows[0].inviter_user_id === inviterId
        && stored.rows[0].invitee_user_id === recipientId && stored.rows[0].status === 'pending'
      const expected = revocation.startsWith('recipient-') && revocation !== 'recipient-computer' ? 409 : 403
      console.log(JSON.stringify({ revocation, deniedStatus: denied.status, noInvitationCreated: pendingPreserved,
        successfulMutationAudited: successfulAudit, restoredStatus: restored.status, authenticatedInviterPreserved: applied }))
      if (denied.status !== expected || !pendingPreserved || successfulAudit || restored.status !== 201 || !applied) failures.push(revocation)
      if (revocation === 'recipient-computer') {
        assert.deepEqual(JSON.parse(denied.body), { error: 'invitation-computer-required' })
        const invitationId = (await pool.query('SELECT id FROM harness.project_invitations WHERE organization_id=$1', [organizationId])).rows[0].id
        const recipientCookie = await login(recipient)
        const accept = () => fetch(`${base}/account/api/invitations/${invitationId}/accept`, { method: 'POST',
          headers: { cookie: recipientCookie, origin: base } }).then(async response => ({ status: response.status, body: await response.text() }))
        await pool.query('UPDATE harness.computer_use_permissions SET enabled=false,revision=revision+1 WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, recipientId])
        const refused = await accept()
        const pending = (await pool.query('SELECT status FROM harness.project_invitations WHERE id=$1', [invitationId])).rows[0].status === 'pending'
        const noMember = (await pool.query('SELECT 1 FROM harness.project_members WHERE organization_id=$1 AND user_id=$2', [organizationId, recipientId])).rowCount === 0
        const audited = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='projects.invitation.accept'", [organizationId])).rowCount > 0
        await pool.query('UPDATE harness.computer_use_permissions SET enabled=true,revision=revision+1 WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, context.nodeId, recipientId])
        const accepted = await accept()
        console.log(JSON.stringify({ operation: 'accept-after-computer-revocation', deniedStatus: refused.status,
          denialReason: JSON.parse(refused.body).error, invitationPreserved: pending, noMembershipCreated: noMember,
          successfulMutationAudited: audited, restoredStatus: accepted.status }))
        assert.equal(refused.status, 403); assert.deepEqual(JSON.parse(refused.body), { error: 'invitation-computer-required' })
        assert(pending && noMember && !audited); assert.equal(accepted.status, 204)
      }
    } finally {
      release?.(); await pending?.catch(() => {})
      if (server !== undefined) {
        server.closeAllConnections()
        await new Promise((closed, reject) => server.close(error => { if (error) reject(error); else closed() }))
      }
      await instances?.stopAll(); await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], 'Invitation creation requires current recipient membership and an available scope.')
} finally { await pool.end() }
