/** Real administrator revocation during project membership and metadata HTTP requests. */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project administration replay requires src or lib.')
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
const { createAdminApiHandler } = await load('admin-api')
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl), failures = []
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const operation of ['member-set', 'member-remove', 'name']) {
    for (const revocation of ['role', 'status']) {
      const root = await mkdtemp(join(tmpdir(), 'project-admin-replay-')), slug = `administration-${randomUUID()}`
      let server, instances, pending, release
      try {
        const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
          VALUES($1,'Project administration replay') RETURNING id`, [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'admin-node')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'admin-node')
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
          HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
        await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
        const users = new PostgresUserService(context, cfg)
        const actor = await users.create({ username: 'former-admin', password: 'pw-12345678', role: 'admin' })
        const keeper = await users.create({ username: 'current-admin', password: 'pw-12345678', role: 'admin' })
        const target = await users.create({ username: 'target-member', password: 'pw-12345678' })
        for (const user of [actor, keeper]) await users.changeOwnPassword(user.id, 'pw-12345678')
        const projects = new PostgresProjectService(context, cfg)
        const project = await projects.createManaged({ name: 'Administration authority', ownerUserId: operation === 'name' ? keeper.id : actor.id })
        if (operation === 'member-remove') await projects.setMember(project.id, target.id, 'ro')
        const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
        await repository.initialize()
        instances = new InstanceManager(repository, cfg)
        const deps = { cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) }
        let invalidations = 0
        server = createGatewayServer(deps, { admin: createAdminApiHandler(deps, undefined, () => { invalidations += 1 }) })
        await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
        const base = `http://127.0.0.1:${server.address().port}`
        cfg.publicOrigins.push(base)
        const login = async user => {
          const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
            headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: user.username, password: 'pw-12345678' }) })
          await response.arrayBuffer(); assert.equal(response.status, 302)
          const cookie = response.headers.get('set-cookie')?.split(';')[0]
          assert(cookie !== undefined); return cookie
        }
        const formerCookie = await login(actor), currentCookie = await login(keeper)
        const path = `/admin/api/projects/${project.id}${operation === 'name' ? '' : `/members/${target.id}`}`
        const method = operation === 'member-set' ? 'PUT' : operation === 'member-remove' ? 'DELETE' : 'PATCH'
        const body = operation === 'member-set' ? { mode: 'rw' } : { name: 'Authorized administration' }
        const send = cookie => fetch(`${base}${path}`, { method,
          headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, actorUserId: keeper.id }),
        }).then(async response => ({ status: response.status, body: await response.text() }))
        const state = async () => (await pool.query(`SELECT p.name,
          (SELECT jsonb_agg(jsonb_build_object('user',u.public_id,'mode',m.access_mode) ORDER BY u.public_id)
            FROM harness.project_members m JOIN harness.users u ON u.id=m.user_id
            WHERE m.organization_id=p.organization_id AND m.project_id=p.id) members
          FROM harness.projects p WHERE p.organization_id=$1 AND p.public_id=$2`, [organizationId, project.id])).rows[0]
        const before = await state(), observed = Promise.withResolvers(), gate = Promise.withResolvers()
        release = () => gate.resolve()
        const get = projects.getById.bind(projects)
        let held = false
        projects.getById = async id => {
          const value = await get(id)
          if (id === project.id && !held) { held = true; observed.resolve(); await gate.promise }
          return value
        }
        pending = send(formerCookie)
        await observed.promise
        if (revocation === 'role') await users.setRole(actor.id, 'user')
        else await users.setStatus(actor.id, 'disabled')
        release()
        const denied = await pending, unchanged = isDeepStrictEqual(before, await state()), deniedInvalidations = invalidations
        const succeeded = await pool.query(`SELECT 1 FROM harness.audit_events
          WHERE organization_id=$1 AND action IN ('admin.members.set','admin.members.remove','admin.projects.rename')`, [organizationId])
        const denialAudit = await pool.query(`SELECT 1 FROM harness.audit_events
          WHERE organization_id=$1 AND action='admin.request' AND status_code=403`, [organizationId])
        projects.getById = get
        const allowed = await send(currentCookie), changed = !isDeepStrictEqual(before, await state())
        const observation = { operation, revocation, formerAdminStatus: denied.status, originalStatePreserved: unchanged,
          successfulMutationAudited: succeeded.rowCount > 0, denialAudited: denialAudit.rowCount === 1,
          unauthorizedInvalidations: deniedInvalidations, currentAdminStatus: allowed.status, currentAdminActionApplied: changed }
        console.log(JSON.stringify(observation))
        if (denied.status !== 403 || !unchanged || succeeded.rowCount !== 0 || denialAudit.rowCount !== 1
          || deniedInvalidations !== 0 || allowed.status !== 204 || !changed) failures.push(`${operation}:${revocation}`)
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
  assert.deepEqual(failures, [], 'Revoked administrator requests must not change project state.')
} finally { await pool.end() }
