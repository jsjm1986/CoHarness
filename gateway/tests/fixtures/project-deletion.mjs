/** Real project deletion waits for committed membership before invalidating personal grants. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project deletion replay requires src or lib.')
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
const { GatewayModelBudget } = await load('gateway-model-budget')
const { NodeResourceBudget } = await load('node-resource-budget')
const { loadConfig } = await load('config')
const { createGatewayServer } = await load('server')
const { createAdminApiHandler } = await load('admin-api')
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl), applicationName = `delete-${randomUUID()}`
const limited = createPostgresPool(databaseUrl, { max: 1, application_name: applicationName })
const root = await mkdtemp(join(tmpdir(), 'project-deletion-replay-'))
let server, instances, blocker, pending, processOwner, committed = false
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  const slug = `deletion-${randomUUID()}`, organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
    VALUES($1,'Project deletion replay') RETURNING id`, [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'deletion-node')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'deletion-node')
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
  await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
  const users = new PostgresUserService(context, cfg)
  const owner = await users.create({ username: 'deletion-owner', password: 'pw-12345678', role: 'admin' })
  const member = await users.create({ username: 'deletion-member', password: 'pw-12345678' })
  await users.changeOwnPassword(owner.id, 'pw-12345678')
  const projects = new PostgresProjectService({ ...context, pool: limited }, cfg)
  const project = await projects.createManaged({ name: 'Project deletion snapshot', ownerUserId: owner.id })
  await writeFile(join(project.path, 'preserved.txt'), 'retained project bytes')
  const repository = new PostgresInstanceRepository({ ...context, pool: limited }, cfg.instancePortBase)
  processOwner = await GatewayModelBudget.open(new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget), join(root, 'gateway-owners'))
  instances = new InstanceManager(repository, cfg, { instancesOutliveGateway: false,
    start: async () => { throw new Error('Project deletion replay must not start host processes.') },
    attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
  }, { principalPublicKey: '' }, undefined, processOwner)
  await instances.stateOf({ kind: 'project', id: project.id })
  const deps = { cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) }
  const invalidated = []
  server = createGatewayServer(deps, { admin: createAdminApiHandler(deps, undefined, subject => { invalidated.push(subject) }) })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const base = `http://127.0.0.1:${server.address().port}`
  cfg.publicOrigins.push(base)
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: owner.username, password: 'pw-12345678' }) })
  await login.arrayBuffer(); assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined)
  blocker = await pool.connect()
  await blocker.query('BEGIN')
  const selected = await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE', [organizationId, project.id])
  await blocker.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
    SELECT $1,$2,u.id,'rw' FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$3`, [organizationId, selected.rows[0].id, member.id])
  pending = fetch(`${base}/admin/api/projects/${project.id}`, { method: 'DELETE', headers: { cookie, origin: base } })
    .then(async response => { await response.arrayBuffer(); return response.status }, error => error)
  let waiting = false
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock') waiting`, [applicationName])).rows[0].waiting
    if (waiting) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(waiting, 'The delete request must wait for the uncommitted membership transaction.')
  await blocker.query('COMMIT'); committed = true
  const status = await pending
  const refreshedMembers = new Set(invalidated.flatMap(subject => subject.userId === undefined ? [] : [subject.userId]))
  const successfulAudit = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='admin.projects.delete'", [organizationId])).rowCount === 1
  const observation = { status, projectAbsent: await projects.getById(project.id) === null,
    directoryRetained: await readFile(join(project.path, 'preserved.txt'), 'utf8') === 'retained project bytes',
    committedMembersInvalidated: refreshedMembers.size, newMemberInvalidated: refreshedMembers.has(member.id), successfulAudit }
  console.log(JSON.stringify(observation))
  assert.deepEqual(observation, { status: 204, projectAbsent: true, directoryRetained: true,
    committedMembersInvalidated: 2, newMemberInvalidated: true, successfulAudit: true })
} finally {
  if (blocker !== undefined) {
    if (!committed) await blocker.query('ROLLBACK')
    blocker.release()
  }
  await pending?.catch(() => {})
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise((closed, reject) => server.close(error => { if (error) reject(error); else closed() }))
  }
  await instances?.stopAll()
  await processOwner?.close()
  await limited.end(); await pool.end()
  await rm(root, { recursive: true, force: true })
}
