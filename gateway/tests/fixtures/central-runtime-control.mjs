/** Authenticated exact Admin process control keeps reserved project data protected. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(['src', 'lib'].includes(mode)); assert.ok(artifactRoot === '-' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(resolve(artifactRoot) + '/')
const load = name => import(new URL(name + (mode === 'src' ? '.ts' : '.js'), base))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository },
  { PostgresRuntimeCatalog }, { PostgresRuntimeManagement }, { NodeResourceBudget }, { GatewayModelBudget },
  { InstanceManager }, { loadConfig }, { createGatewayServer }, { createAdminApiHandler }, readiness] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'postgres/runtime-catalog', 'runtime-management', 'node-resource-budget',
  'gateway-model-budget', 'instances', 'config', 'server', 'admin-api', 'runtime-readiness',
].map(load))
const pool = createPostgresPool(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL))
const root = await mkdtemp(join(tmpdir(), 'central-runtime-control-')), carriers = new Map(), transcript = []
let gateway, supervisor, manager, processOwner, active, stops = 0, starts = 0, budget, organizationId, target, revokeOnStop = false
const closeServer = server => new Promise((done, reject) => { server.closeAllConnections(); server.close(error => { if (error) reject(error); else done() }) })
const stopCarrier = async state => {
  if (state.closed) return
  state.abort.abort(); await state.read; await state.closedSignal.promise
  state.closed = true; if (active === state) active = undefined
}
try {
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  const slug = 'central-control-' + randomUUID()
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Central control') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  const cfg = loadConfig({ HGW_DSH_REPO_ROOT: resolve(import.meta.dirname, '../../..'), HGW_GATEWAY_DIR: resolve(import.meta.dirname, '../..'), HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'),
    HGW_STEWARD_ROOT: join(root, 'steward-root'), HGW_DEFAULT_ENV_FILE: '' })
  await mkdir(cfg.stateRoot, { recursive: true })
  const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
  const admin = await users.create({ username: 'operator', password: 'test-password', role: 'admin' })
  const keeper = await users.create({ username: 'keeper', password: 'test-password', role: 'admin' })
  await users.changeOwnPassword(admin.id, 'test-password')
  const projectPath = join(root, 'steward'); await mkdir(projectPath)
  const project = await projects.ensureSteward({ name: 'Reserved maintenance', path: projectPath })
  const marker = join(project.path, 'retained.txt'); await writeFile(marker, 'reserved data retained')
  const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
  target = await repository.resolveTarget({ kind: 'project', id: project.id })
  supervisor = createServer((req, res) => {
    if (req.url?.startsWith('/carrier/')) {
      const state = carriers.get(Number(req.url.slice('/carrier/'.length))); assert.ok(state)
      state.responded.resolve(); res.once('close', () => { state.closedSignal.resolve() })
      res.writeHead(200); res.write('owned process response'); return
    }
    if (req.url === readiness.RUNTIME_READINESS_PATH && active !== undefined) {
      const nonce = req.headers[readiness.RUNTIME_READINESS_NONCE_HEADER]
      const identity = { ...target, generation: active.generation }
      if (typeof nonce !== 'string' || req.headers[readiness.RUNTIME_READINESS_REQUEST_HEADER] !== readiness.runtimeReadinessRequestProof(active.token, nonce, identity)) {
        res.writeHead(401); res.end(); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: 1, runtime: { ...identity, runtimeId: target.runtimeId },
        proof: readiness.runtimeReadinessResponseProof(active.token, nonce, identity) })); return
    }
    res.writeHead(503); res.end()
  })
  await new Promise(done => { supervisor.listen(0, '127.0.0.1', done) })
  const port = supervisor.address().port
  await pool.query('UPDATE harness.instances SET port=$3 WHERE organization_id=$1 AND runtime_id=$2', [organizationId, target.runtimeId, port])
  const openCarrier = async (generation, token) => {
    const state = { generation, token, abort: new AbortController(), responded: Promise.withResolvers(), closedSignal: Promise.withResolvers(), closed: false }
    carriers.set(generation, state); active = state
    state.read = (async () => {
      try { const response = await fetch(`http://127.0.0.1:${port}/carrier/${generation}`, { signal: state.abort.signal }); for await (const bytes of response.body) assert.ok(bytes.length > 0) }
      catch (error) { if (!state.abort.signal.aborted) throw error }
    })()
    void state.read.catch(() => { /* the owned stop path observes transport failure */ })
    await state.responded.promise
    return state
  }
  const initialToken = randomBytes(32).toString('base64url')
  await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running',runtime_token_hash=$3 WHERE organization_id=$1 AND runtime_id=$2",
    [organizationId, target.runtimeId, createHash('sha256').update(initialToken).digest()])
  await openCarrier(1, initialToken)
  budget = new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget)
  const projectInternalId = (await pool.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [organizationId, project.id])).rows[0].id
  const register = generation => budget.register({ organizationId, target, generation, projectInternalId })
  await register(1)
  processOwner = await GatewayModelBudget.open(budget, join(root, 'gateway-owners'))
  const handle = state => ({ hasExited: () => state.closed, isAlive: async () => !state.closed,
    terminate: async () => { if (!state.closed) {
      stops++; await stopCarrier(state)
      if (revokeOnStop) { revokeOnStop = false; await users.setRole(admin.id, 'user') }
    } } })
  manager = new InstanceManager(repository, cfg, { instancesOutliveGateway: false,
    attach: runtime => { const state = carriers.get(runtime.generation); assert.ok(state); return handle(state) },
    start: async runtime => {
      await budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 4 })
      await runtime.beforeAllocation?.(); starts++
      const state = await openCarrier(runtime.generation, JSON.parse(runtime.gatewayCredential).token)
      await register(runtime.generation); return handle(state)
    },
  }, { principalPublicKey: '' }, budget, processOwner)
  const audit = new PostgresAuditService(context)
  const deps = { cfg, users, projects, instances: manager, auth: new PostgresAuthService(context, cfg), audit,
    runtimeCatalog: new PostgresRuntimeCatalog(context, cfg.runtimeCatalog), runtimeManagement: new PostgresRuntimeManagement(context, cfg),
    nodeServiceIdentity: { organizationId, nodeId: context.nodeId } }
  gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise(done => { gateway.listen(0, '127.0.0.1', done) })
  const endpoint = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(endpoint)
  const login = await fetch(endpoint + '/login', { method: 'POST', redirect: 'manual', headers: { origin: endpoint,
    'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: admin.username, password: 'test-password' }) })
  await login.arrayBuffer(); assert.equal(login.status, 302)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const call = async (path, body) => {
    const response = await fetch(endpoint + path, { method: 'POST', headers: { cookie, origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text(); return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }
  const exact = action => `/admin/api/runtimes/${target.runtimeId}/${action}`
  const show = async (label, path, body, status) => {
    if (/\/(?:start|restart)$/.test(path)) await budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 4 })
    const reply = await call(path, body); assert.equal(reply.status, status, label + ': ' + JSON.stringify(reply))
    const snapshot = await repository.snapshotOf(target)
    transcript.push({ label, status, state: snapshot.state, generation: snapshot.generation, stops, starts,
      dataRetained: await readFile(marker, 'utf8') === 'reserved data retained', operations: (await pool.query('SELECT 1 FROM harness.runtime_destructive_operations WHERE organization_id=$1', [organizationId])).rowCount })
    return reply
  }
  await show('body cannot select control policy', exact('stop'), { generation: 1, purpose: 'control' }, 400)
  await show('exact central stop without data qualification', exact('stop'), { generation: 1 }, 200)
  await show('stale exact stop', exact('stop'), { generation: 2 }, 409)
  await show('exact central start', exact('start'), {}, 200)
  await show('stale restart', exact('restart'), { generation: 1 }, 409)
  await show('exact central restart', exact('restart'), { generation: 2 }, 200)
  await show('project cannot retire', exact('retire'), { generation: 3 }, 400)
  await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision)
    SELECT $1,$2,id,true,1 FROM harness.users WHERE organization_id=$1 AND public_id=$3`, [organizationId, context.nodeId, admin.id])
  const destructive = await fetch(`${endpoint}/admin/api/projects/${project.id}`, { method: 'DELETE', headers: { cookie, origin: endpoint } })
  const denied = await destructive.json(); assert.equal(destructive.status, 409); assert.equal(denied.error, 'steward-reserved')
  transcript.push({ label: 'central deletion remains protected', status: destructive.status, state: (await repository.snapshotOf(target)).state,
    stops, starts, dataRetained: await readFile(marker, 'utf8') === 'reserved data retained' })
  await users.setRole(admin.id, 'user')
  await show('revoked administrator stop', exact('stop'), { generation: 3 }, 403)
  await users.setRole(admin.id, 'admin')
  await show('legacy central stop', `/admin/api/projects/${project.id}/instance/stop`, {}, 204)
  await show('idempotent exact central stop', exact('stop'), { generation: 3 }, 200)
  await show('start before late withdrawal', exact('start'), {}, 200)
  revokeOnStop = true
  await show('restart withdrawal after approved stop', exact('restart'), { generation: 4 }, 403)
  await users.setRole(admin.id, 'admin')
  const allocated = await deps.runtimeManagement.allocate(admin, keeper.id, { requestId: randomUUID() })
  const personalMarker = join(cfg.usersRoot, keeper.username, 'runtimes', allocated.runtimeId, 'dsh', 'retained.txt')
  await writeFile(personalMarker, 'personal data retained')
  const retired = await call(`/admin/api/runtimes/${allocated.runtimeId}/retire`, { generation: 1 })
  assert.equal(retired.status, 200, 'personal retirement: ' + JSON.stringify(retired))
  assert.equal(retired.body.retired, true)
  assert.equal((await pool.query('SELECT 1 FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2', [organizationId, allocated.runtimeId])).rowCount, 0)
  transcript.push({ label: 'personal retirement keeps destructive policy and data', status: retired.status, retired: retired.body.retired,
    stops, starts, dataRetained: await readFile(personalMarker, 'utf8') === 'personal data retained',
    operations: (await pool.query('SELECT 1 FROM harness.runtime_destructive_operations WHERE organization_id=$1', [organizationId])).rowCount })
  for (const row of transcript) console.log(JSON.stringify(row))
} finally {
  if (gateway !== undefined) await closeServer(gateway)
  if (manager !== undefined) await manager.stopAll()
  for (const state of carriers.values()) await stopCarrier(state)
  if (processOwner !== undefined) await processOwner.close()
  if (supervisor !== undefined) await closeServer(supervisor)
  await pool.end(); await rm(root, { recursive: true, force: true })
}
