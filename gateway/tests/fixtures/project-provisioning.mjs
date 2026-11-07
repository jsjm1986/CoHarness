/** Current administrator admission through real Gateway project creation and directory import. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project provisioning replay requires src or lib.')
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

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl), failures = []
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const operation of ['managed', 'import']) {
    for (const revocation of ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization']) {
      const root = await mkdtemp(join(tmpdir(), 'project-provisioning-replay-')), slug = `provision-${randomUUID()}`
      let server, instances, pending, release
      try {
        const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
          VALUES($1,'Project provisioning replay') RETURNING id`, [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'provision-node')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'provision-node')
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
          HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'),
          HGW_PROJECT_PATH_ROOTS: join(root, 'imports'), HGW_DEFAULT_ENV_FILE: '' })
        const imported = join(root, 'imports', 'preserved')
        await mkdir(imported, { recursive: true })
        await mkdir(cfg.projectsRoot, { recursive: true })
        await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
        await writeFile(join(imported, 'retained.txt'), 'imported project bytes')
        const users = new PostgresUserService(context, cfg)
        const actor = await users.create({ username: 'former-admin', password: 'pw-12345678', role: 'admin' })
        const keeper = await users.create({ username: 'current-admin', password: 'pw-12345678', role: 'admin' })
        for (const user of [actor, keeper]) await users.changeOwnPassword(user.id, 'pw-12345678')
        const actorId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const projects = new PostgresProjectService(context, cfg), auth = new PostgresAuthService(context, cfg)
        instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg, {
          instancesOutliveGateway: false,
          start: async () => { throw new Error('Project provisioning replay must not start host processes.') },
          attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
        })
        const deps = { cfg, users, projects, instances, auth, audit: new PostgresAuditService(context) }
        server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
        const base = `http://127.0.0.1:${server.address().port}`
        cfg.publicOrigins.push(base)
        const login = async user => {
          const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
            headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: user.username, password: 'pw-12345678' }) })
          await response.arrayBuffer(); assert.equal(response.status, 302)
          const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined); return cookie
        }
        const formerCookie = await login(actor), currentCookie = await login(keeper)
        const names = (await readdir(cfg.projectsRoot)).sort(), validate = auth.validate.bind(auth)
        const observed = Promise.withResolvers(), gate = Promise.withResolvers()
        let held = false
        release = () => gate.resolve()
        auth.validate = async token => {
          const current = await validate(token)
          if (current?.id === actor.id && !held) { held = true; observed.resolve(); await gate.promise }
          return current
        }
        const send = (cookie, name) => fetch(`${base}/admin/api/projects`, { method: 'POST',
          headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ name, ...(operation === 'import' ? { path: imported } : {}),
            createdBy: keeper.id, actorUserId: keeper.id, ownerUserId: keeper.id }),
        }).then(async response => ({ status: response.status, body: await response.text() }))
        pending = send(formerCookie, 'Blocked provisioning')
        await observed.promise
        if (revocation === 'role') await users.setRole(actor.id, 'user')
        else if (revocation === 'disabled-account') await users.setStatus(actor.id, 'disabled')
        else if (revocation === 'deleted-account') await users.remove(actor.id)
        else if (revocation === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organizationId, actorId])
        else if (revocation === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organizationId, actorId])
        else await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        release()
        const denied = await pending
        const noProject = (await pool.query('SELECT 1 FROM harness.projects WHERE organization_id=$1', [organizationId])).rowCount === 0
        const noNewDirectory = (await readdir(cfg.projectsRoot)).sort().join('\n') === names.join('\n')
        const noSuccessAudit = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='admin.projects.create'", [organizationId])).rowCount === 0
        const denialAudit = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='admin.request' AND status_code=403", [organizationId])).rowCount === 1
        auth.validate = validate
        if (revocation === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='active' WHERE id=$1", [organizationId])
        const allowed = await send(currentCookie, 'Authorized provisioning')
        const current = (await projects.list()).find(project => project.name === 'Authorized provisioning')
        const currentCreator = current?.createdBy?.id === keeper.id && current.origin === 'admin' && current.owner === null
        const bytesRetained = await readFile(join(imported, 'retained.txt'), 'utf8') === 'imported project bytes'
        const observation = { operation, revocation, revokedStatus: denied.status, noProject, noNewDirectory,
          noSuccessAudit, denialAudit, currentAdminStatus: allowed.status, authenticatedCreator: currentCreator, importedBytesRetained: bytesRetained }
        console.log(JSON.stringify(observation))
        if (denied.status !== 403 || !noProject || !noNewDirectory || !noSuccessAudit || !denialAudit
          || allowed.status !== 200 || !currentCreator || !bytesRetained) failures.push(`${operation}:${revocation}`)
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
  assert.deepEqual(failures, [], 'Revoked administrator authority cannot provision a project or directory.')
} finally { await pool.end() }
