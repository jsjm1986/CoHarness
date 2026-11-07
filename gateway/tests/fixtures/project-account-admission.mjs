/** Real account revocation between browser authentication and project relationship writes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project account replay requires src or lib.')
const extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${mode}/${name}.${extension}`, import.meta.url))
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
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
  for (const operation of ['accept', 'create']) {
    const states = ['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization',
      ...(operation === 'accept' ? ['archived-project'] : [])]
    for (const revocation of states) {
      const root = await mkdtemp(join(tmpdir(), 'project-account-replay-')), slug = `account-${randomUUID()}`
      let server, instances, pending, release
      try {
        const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
          VALUES($1,'Project account replay') RETURNING id`, [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'account-node')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'account-node')
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
          HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
        await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
        await mkdir(cfg.userProjectsRoot, { mode: 0o700, recursive: true })
        const users = new PostgresUserService(context, cfg)
        const administrator = await users.create({ username: 'account-admin', password: 'pw-12345678', role: 'admin' })
        const actor = await users.create({ username: 'account-actor', password: 'pw-12345678' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const actorId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const projects = new PostgresProjectService(context, cfg)
        const project = operation === 'accept' ? await projects.createManaged({ name: 'Invitation account', ownerUserId: administrator.id }) : undefined
        const invitation = project === undefined ? undefined : await projects.createInvitation({ projectId: project.id,
          inviteeUserId: actor.id, inviterUserId: administrator.id, mode: 'rw' })
        const auth = new PostgresAuthService(context, cfg)
        instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
          instancesOutliveGateway: false,
          start: async () => { throw new Error('Project account replay must not start host processes.') },
          attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
        })
        server = createGatewayServer({ cfg, users, projects, instances, auth, audit: new PostgresAuditService(context) })
        await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
        const base = `http://127.0.0.1:${server.address().port}`
        cfg.publicOrigins.push(base)
        const login = async () => {
          const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
            headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
          await response.arrayBuffer(); assert.equal(response.status, 302)
          const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined); return cookie
        }
        const cookie = await login(), originalFiles = await readdir(cfg.userProjectsRoot)
        const beforeCount = Number((await pool.query('SELECT count(*) n FROM harness.projects WHERE organization_id=$1', [organizationId])).rows[0].n)
        const observed = Promise.withResolvers(), gate = Promise.withResolvers(), validate = auth.validate.bind(auth)
        let held = false
        release = () => gate.resolve()
        auth.validate = async token => {
          const user = await validate(token)
          if (user?.id === actor.id && !held) { held = true; observed.resolve(); await gate.promise }
          return user
        }
        const path = operation === 'accept' ? `/account/api/invitations/${invitation.id}/accept` : '/account/api/projects'
        const send = session => fetch(`${base}${path}`, { method: 'POST',
          headers: { cookie: session, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New account project', actorUserId: administrator.id,
            ownerUserId: administrator.id, createdBy: administrator.id, userId: administrator.id }),
        }).then(async response => ({ status: response.status, body: await response.text() }))
        pending = send(cookie)
        await observed.promise
        if (revocation === 'disabled-account') await users.setStatus(actor.id, 'disabled')
        else if (revocation === 'deleted-account') await users.remove(actor.id)
        else if (revocation === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organizationId, actorId])
        else if (revocation === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organizationId, actorId])
        else if (revocation === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        else await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
        const expectedInvitation = invitation === undefined ? undefined : (await pool.query('SELECT status FROM harness.project_invitations WHERE organization_id=$1 AND id=$2', [organizationId, invitation.id])).rows[0]?.status
        release()
        const denied = await pending
        const count = Number((await pool.query('SELECT count(*) n FROM harness.projects WHERE organization_id=$1', [organizationId])).rows[0].n)
        const newGrant = (await pool.query(`SELECT 1 FROM harness.project_members
          WHERE organization_id=$1 AND user_id=$2`, [organizationId, actorId])).rowCount > 0
        const pendingPreserved = invitation === undefined || (await pool.query('SELECT status FROM harness.project_invitations WHERE organization_id=$1 AND id=$2', [organizationId, invitation.id])).rows[0]?.status === expectedInvitation
        const filesPreserved = (await readdir(cfg.userProjectsRoot)).sort().join('\n') === originalFiles.sort().join('\n')
        const successfulAudit = (await pool.query(`SELECT 1 FROM harness.audit_events WHERE organization_id=$1
          AND action IN ('projects.invitation.accept','projects.create')`, [organizationId])).rowCount > 0
        auth.validate = validate
        let restored = { status: null }, applied = false
        const restorable = revocation !== 'deleted-account'
        if (restorable) {
          if (revocation === 'disabled-account') await users.setStatus(actor.id, 'active')
          else if (revocation === 'disabled-membership' || revocation === 'missing-membership') await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role,status)
            VALUES($1,$2,'member','active') ON CONFLICT(organization_id,user_id) DO UPDATE SET status='active'`, [organizationId, actorId])
          else if (revocation === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organizationId])
          else await pool.query("UPDATE harness.projects SET status='active' WHERE organization_id=$1 AND public_id=$2", [organizationId, project.id])
          restored = await send(await login())
          applied = operation === 'accept' ? (await pool.query('SELECT status FROM harness.project_invitations WHERE organization_id=$1 AND id=$2', [organizationId, invitation.id])).rows[0]?.status === 'accepted'
            : (await pool.query(`SELECT 1 FROM harness.projects WHERE organization_id=$1 AND name='New account project'
              AND owner_user_id=$2 AND created_by=$2`, [organizationId, actorId])).rowCount === 1
        }
        const expected = restorable ? operation === 'accept' ? 204 : 201 : null
        const observation = { operation, revocation, revokedStatus: denied.status, projectCountPreserved: count === beforeCount,
          noNewGrant: !newGrant, pendingInvitationPreserved: pendingPreserved, managedDirectoriesPreserved: filesPreserved,
          successfulMutationAudited: successfulAudit, restoredStatus: restored.status, restoredActionApplied: applied }
        console.log(JSON.stringify(observation))
        if (denied.status !== 403 || count !== beforeCount || newGrant || !pendingPreserved || !filesPreserved
          || successfulAudit || restored.status !== expected || applied !== restorable) failures.push(`${operation}:${revocation}`)
      } finally {
        release?.(); await pending?.catch(() => {})
        if (server !== undefined) {
          server.closeAllConnections()
          await new Promise((closed, reject) => server.close(error => { if (error) reject(error); else closed() }))
        }
        await instances?.stopAll()
        await rm(root, { recursive: true, force: true })
      }
    }
  }
  assert.deepEqual(failures, [], 'Revoked account authority must not create projects or consume invitations.')
} finally { await pool.end() }
