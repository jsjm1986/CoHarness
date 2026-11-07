/** Real Gateway/PostgreSQL deletion with an observable HTTP listener as the synthetic Runtime carrier. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Project removal replay requires src or lib.')
const extension = mode === 'src' ? 'ts' : 'js'
const load = name => import(new URL(`../../${mode}/${name}.${extension}`, import.meta.url))
const { createPostgresPool, runMigrations } = await load('postgres/database')
const { resolvePostgresRuntimeContext } = await load('postgres/runtime-context')
const { PostgresUserService } = await load('postgres/user-service')
const { PostgresProjectService } = await load('postgres/project-service')
const { PostgresAuthService } = await load('postgres/auth-service')
const { PostgresAuditService } = await load('postgres/audit-service')
const { PostgresInstanceRepository } = await load('postgres/instance-repository')
const { NodeResourceBudget } = await load('node-resource-budget')
const { GatewayModelBudget } = await load('gateway-model-budget')
const { InstanceManager } = await load('instances')
const { loadConfig } = await load('config')
const { createGatewayServer } = await load('server')
const { createAdminApiHandler } = await load('admin-api')

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert(databaseUrl !== undefined, 'HGW_TEST_DATABASE_URL is required for PostgreSQL replay.')
const pool = createPostgresPool(databaseUrl), failures = []
const scenarios = ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership',
  'disabled-organization', 'steward', 'delete', 'cold-delete', 'data-failure', 'cross-restart', 'cross-stop-restart',
  'late-revocation', 'stop-failure', 'owner-closed', 'resource-delete', 'resource-stop']
const selectedScenario = process.argv[3]
if (selectedScenario !== undefined && !scenarios.includes(selectedScenario)) throw new Error('Unknown project removal scenario.')
const close = server => new Promise((done, reject) => {
  server.closeAllConnections()
  server.close(error => { if (error) reject(error); else done() })
})
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  for (const scenario of selectedScenario === undefined ? scenarios : [selectedScenario]) {
    const root = await mkdtemp(join(tmpdir(), 'project-removal-replay-'))
    const limited = createPostgresPool(databaseUrl, { max: 1 })
    let gateway, carrier, instances, pending, release, processOwner
    try {
      const slug = `removal-${randomUUID()}`
      const organizationId = (await pool.query(`INSERT INTO harness.organizations(slug,display_name)
        VALUES($1,'Project removal replay') RETURNING id`, [slug])).rows[0].id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'removal-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'removal-node')
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
        HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
      await mkdir(cfg.stateRoot, { mode: 0o700, recursive: true })
      const users = new PostgresUserService(context, cfg)
      const actor = await users.create({ username: 'removal-admin', password: 'pw-12345678', role: 'admin' })
      const keeper = await users.create({ username: 'current-admin', password: 'pw-12345678', role: 'admin' })
      await users.changeOwnPassword(actor.id, 'pw-12345678')
      const actorId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const projects = new PostgresProjectService({ ...context, pool: limited }, cfg)
      const stewardPath = join(root, 'steward'); await mkdir(stewardPath)
      const project = scenario === 'steward'
        ? await projects.ensureSteward({ name: 'Reserved Steward', path: stewardPath })
        : await projects.createManaged({ name: 'Removal scope', ownerUserId: actor.id })
      await writeFile(join(project.path, 'retained.txt'), 'retained project bytes')
      if (scenario !== 'cold-delete') await pool.query(`UPDATE harness.instances i SET observed_state='ready',desired_state='running',generation=1
        FROM harness.projects p WHERE p.id=i.project_id AND p.organization_id=i.organization_id
          AND p.organization_id=$1 AND p.public_id=$2`, [organizationId, project.id])
      let carrierUrl
      if (scenario !== 'cold-delete') {
        carrier = createServer((_req, res) => { res.end('runtime alive') })
        await new Promise((done, reject) => { carrier.once('error', reject); carrier.listen(0, '127.0.0.1', done) })
        carrierUrl = `http://127.0.0.1:${carrier.address().port}`
      }
      const repository = new PostgresInstanceRepository({ ...context, pool: limited }, cfg.instancePortBase)
      const processBudget = new NodeResourceBudget(limited, organizationId, context.nodeId, cfg.resourceBudget)
      processOwner = await GatewayModelBudget.open(processBudget, join(root, 'gateway-owners'))
      let stopCalls = 0, closed = false, lateRevoked = false
      let resources, queuedOwner
      if (scenario.startsWith('resource-')) {
        resources = new NodeResourceBudget(limited, organizationId, context.nodeId, cfg.resourceBudget)
        const projectId = (await pool.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [organizationId, project.id])).rows[0].id
        const keeperId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, keeper.id])).rows[0].id
        await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running',generation=1 WHERE organization_id=$1 AND user_id=$2", [organizationId, keeperId])
        const subject = { organizationId, target: { kind: 'project', id: project.id }, generation: 1, projectInternalId: projectId }
        queuedOwner = { organizationId, target: { kind: 'user', id: keeper.id }, generation: 1, userInternalId: keeperId }
        await resources.register(subject); await resources.register(queuedOwner)
        await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [organizationId, context.nodeId])
        assert.deepEqual(await resources.request(subject, { requestId: randomUUID(), sequence: 1, kind: 'model', actorId: actor.id, projectId: project.id }), { state: 'active' })
        assert.deepEqual(await resources.request(queuedOwner, { requestId: randomUUID(), sequence: 1, kind: 'model', actorId: keeper.id, projectId: 0 }), { state: 'queued' })
        await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [organizationId, context.nodeId])
      }
      instances = new InstanceManager(repository, cfg, {
        instancesOutliveGateway: false,
        start: async () => { throw new Error('Removal replay cannot start a model Runtime.') },
        attach: () => {
          if (scenario === 'cold-delete') throw new Error('A never-started assignment must not attach a process.')
          return { hasExited: () => closed, isAlive: async () => !closed, terminate: async () => {
          if (closed) return
          stopCalls += 1
          if (scenario === 'stop-failure') throw new Error('Synthetic stop refusal')
          if (scenario === 'late-revocation' && !lateRevoked) { lateRevoked = true; await users.setRole(actor.id, 'user') }
          await close(carrier); closed = true
          } }
        },
      }, { principalPublicKey: '' }, resources, processOwner)
      let invalidations = 0
      const deps = { cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) }
      gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps, undefined, () => { invalidations += 1 }) })
      await new Promise((done, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', done) })
      const base = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie !== undefined)
      const get = projects.getById.bind(projects), observed = Promise.withResolvers(), gate = Promise.withResolvers()
      let held = false, stateAtDelete = null, restartRefused = null, queuedGranted = null, registrationRetained = null, unregisteredDuringDelete = null
      release = () => gate.resolve()
      const state = async () => (await pool.query(`SELECT i.observed_state state FROM harness.instances i
        JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
        WHERE p.organization_id=$1 AND p.public_id=$2`, [organizationId, project.id])).rows[0]?.state ?? null
      projects.getById = async id => {
        const result = await get(id)
        if (id === project.id && !held) { held = true; observed.resolve(); await gate.promise }
        return result
      }
      const remove = projects.remove.bind(projects)
      projects.remove = async (...args) => {
        stateAtDelete = await state()
        if (resources !== undefined) {
          queuedGranted = (await pool.query(`SELECT state FROM harness.node_resource_requests WHERE organization_id=$1
            AND runtime_kind='user' AND runtime_public_id=$2`, [organizationId, queuedOwner.target.id])).rows[0]?.state === 'active'
          registrationRetained = (await pool.query(`SELECT 1 FROM harness.node_resource_runtimes WHERE organization_id=$1
            AND runtime_kind='project' AND runtime_public_id=$2`, [organizationId, project.id])).rowCount === 1
          unregisteredDuringDelete = (await resources.snapshot()).unregisteredRuntimes
        }
        if (scenario === 'data-failure') await limited.query('SELECT missing_project_removal_column FROM harness.projects')
        if (scenario === 'cross-restart' || scenario === 'cross-stop-restart') {
          const other = new PostgresInstanceRepository(context, cfg.instancePortBase)
          if (scenario === 'cross-stop-restart') {
            const coordinator = new InstanceManager(other, cfg, {
              instancesOutliveGateway: false,
              start: async () => { throw new Error('The competing stop cannot allocate a process.') },
              attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
            })
            try { await coordinator.stop({ kind: 'project', id: project.id }) }
            finally { await coordinator.stopAll() }
          }
          try { await other.beginStart({ kind: 'project', id: project.id }, Date.now(), randomBytes(32), 'explicit'); restartRefused = false }
          catch (error) { if (error?.code !== 'INSTANCE_UNAVAILABLE') throw error; restartRefused = true }
        }
        return remove(...args)
      }
      pending = fetch(`${base}/admin/api/projects/${project.id}${scenario === 'resource-stop' ? '/instance/stop' : ''}`, { method: scenario === 'resource-stop' ? 'POST' : 'DELETE',
        headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ actorUserId: keeper.id }),
      }).then(async response => ({ status: response.status, body: await response.text() }))
      await observed.promise
      if (scenario === 'role') await users.setRole(actor.id, 'user')
      else if (scenario === 'disabled-account') await users.setStatus(actor.id, 'disabled')
      else if (scenario === 'deleted-account') await users.remove(actor.id)
      else if (scenario === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organizationId, actorId])
      else if (scenario === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organizationId, actorId])
      else if (scenario === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      else if (scenario === 'owner-closed') await processOwner.close()
      release()
      const result = await pending
      let carrierAlive = false
      if (carrierUrl !== undefined && !closed) { const response = await fetch(carrierUrl); carrierAlive = await response.text() === 'runtime alive' }
      const projectRetained = await get(project.id) !== null
      const successAudit = (await pool.query('SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action=$2',
        [organizationId, scenario === 'resource-stop' ? 'admin.project-instances.stop' : 'admin.projects.delete'])).rowCount > 0
      if (scenario === 'resource-stop') queuedGranted = (await pool.query(`SELECT state FROM harness.node_resource_requests WHERE organization_id=$1
        AND runtime_kind='user' AND runtime_public_id=$2`, [organizationId, queuedOwner.target.id])).rows[0]?.state === 'active'
      const deleteAllowed = ['delete','cold-delete','cross-restart','cross-stop-restart','resource-delete'].includes(scenario)
      const operationAllowed = deleteAllowed || scenario === 'resource-stop'
      const beforeStopDenied = ['role','disabled-account','deleted-account','disabled-membership','missing-membership','disabled-organization','steward'].includes(scenario)
      const untouched = beforeStopDenied || scenario === 'owner-closed'
      const expectedStatus = scenario === 'steward' ? 409 : beforeStopDenied || scenario === 'late-revocation' ? 403 : operationAllowed ? 204 : ['stop-failure','owner-closed'].includes(scenario) ? 503 : 500
      const deniedAudit = (await pool.query("SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action='admin.request' AND status_code=$2", [organizationId, result.status])).rowCount === 1
      const observation = { scenario, status: result.status, projectRetained, carrierAlive, stopCalls,
        stateAtDelete, finalState: await state(), restartRefused, successAudit, invalidations,
        bytesRetained: await readFile(join(project.path, 'retained.txt'), 'utf8') === 'retained project bytes',
        deniedAudit, queuedGranted, registrationRetained, unregisteredDuringDelete }
      console.log(JSON.stringify(observation))
      if (result.status !== expectedStatus || projectRetained !== !deleteAllowed || carrierAlive !== (untouched || scenario === 'stop-failure')
        || stopCalls !== (untouched || scenario === 'cold-delete' ? 0 : 1) || successAudit !== operationAllowed || !observation.bytesRetained
        || deniedAudit !== !operationAllowed
        || (untouched && (observation.finalState !== 'ready' || stateAtDelete !== null || invalidations !== 0))
        || (!untouched && scenario !== 'stop-failure' && scenario !== 'resource-stop' && stateAtDelete !== 'stopping')
        || (['cross-restart','cross-stop-restart'].includes(scenario) && !restartRefused)
        || (['data-failure','late-revocation'].includes(scenario) && observation.finalState !== 'stopped')
        || (scenario === 'stop-failure' && observation.finalState !== 'stopping')
        || (resources !== undefined && !queuedGranted)
        || (scenario === 'resource-delete' && (!registrationRetained || unregisteredDuringDelete !== 0))
        || (scenario === 'resource-stop' && observation.finalState !== 'stopped')) failures.push(scenario)
      if (scenario === 'stop-failure') {
        await close(carrier); closed = true
      }
    } finally {
      release?.(); await pending?.catch(() => {})
      if (gateway?.listening) await close(gateway)
      await instances?.stopAll()
      await processOwner?.close()
      if (carrier?.listening) await close(carrier)
      await limited.end(); await rm(root, { recursive: true, force: true })
    }
  }
  assert.deepEqual(failures, [], 'Deletion admission, quiescence and data mutation must retain their permissions and ordering.')
} finally { await pool.end() }
