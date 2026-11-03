/** Current personal authority through real Gateway HTTP, LocalLauncher, policy files and resource registration. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'
import { chmodSync, cpSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, backend, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(backend === 'sqlite' || backend === 'postgres')
assert.ok(artifactRoot === undefined || mode === 'lib')
const moduleBase = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, moduleBase))
const administratorReplay = process.env.DSH_RUNTIME_POLICY_SCENARIOS === 'administrators'
assert.ok(process.env.DSH_RUNTIME_POLICY_SCENARIOS === undefined || administratorReplay)
const [{ openDb }, { UserService }, { ProjectService }, { AuthService }, { AuditService }, { InstanceManager },
  { LocalLauncher }, { loadConfig }, { createGatewayServer }, { createAdminApiHandler }, { createProxyHandlers },
  { createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository },
  { NodeResourceBudget }, { createRuntimeApiHandler }, { loadPrincipalKeys }, { PostgresConversationStore },
  { PostgresCollaborationService }, { PostgresModelGovernanceService }, { OrganizationModelCredentialCipher }] = await Promise.all([
  'db', 'users', 'projects', 'auth', 'audit', 'instances', 'launcher', 'config', 'server', 'admin-api', 'proxy',
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/auth-service', 'postgres/audit-service', 'postgres/instance-repository', 'node-resource-budget', 'runtime-api',
  'principal', 'postgres/conversation-repository', 'postgres/collaboration-service', 'postgres/model-governance-service',
  'organization-model-credentials',
].map(load))
const listen = server => new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
const closeServer = server => new Promise((ready, reject) => {
  server.closeAllConnections(); server.close(error => error ? reject(error) : ready())
})
async function until(condition, pending) {
  const deadline = Date.now() + 30_000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'Personal Runtime admission did not reach its observable wait')
    if (pending !== undefined) {
      const ended = await Promise.race([pending.then(() => true), delay(10).then(() => false)])
      assert.equal(ended, false, 'The request completed before its admission wait')
    } else await delay(10)
  }
}

let pool
try {
  if (backend === 'postgres') {
    const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
    pool = createPostgresPool(url, { max: administratorReplay ? 1 : 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  }
  const scenarios = administratorReplay
    ? [...(backend === 'postgres' ? ['user', 'project'] : ['user']).flatMap(scope => [
      ...['start', 'stop', 'restart'].flatMap(action => [`${scope}-${action}-role`, `${scope}-${action}-current`]), `${scope}-restart-late-role`,
    ]), ...(backend === 'postgres' ? ['user-start-database-capacity'] : [])]
    : ['capacity-demotion', 'prepare-demotion', 'current',
      ...(backend === 'postgres' ? ['pressure-demotion', 'pressure-membership', 'capacity-membership'] : [])]
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), 'personal-policy-replay-'))
    const cleanups = []
    let db, context, manager, gateway, proxies, pending, resources, releaseLookup, limited, heldConnection, queuedConnection, primaryError, previousUmask
    const releaseDatabaseLane = async () => {
      heldConnection?.release(); heldConnection = undefined
      const queued = queuedConnection; queuedConnection = undefined
      if (queued !== undefined) {
        const result = await queued
        if (result.error !== undefined) throw result.error
        result.client.release()
      }
    }
    try {
      const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
        HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
        HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
        HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)),
        HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1', HGW_READINESS_TIMEOUT_MS: '30000',
        HGW_RESOURCE_SAMPLE_MS: '20', HGW_RESOURCE_STALE_MS: '30000' })
      cfg.dshRepoRoot = fileURLToPath(new URL('../../../', import.meta.url))
      cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./personal-runtime-carrier.mjs', import.meta.url)), backend]
      const inspectPolicyArtifacts = scenario === 'current' && !administratorReplay
      if (inspectPolicyArtifacts) {
        previousUmask = process.umask(0o007)
        for (const [name, source] of [['dsh-model-governance', cfg.modelGovernancePackage], ['dsh-directory-guard', resolve(cfg.guardPatch, '..')]]) {
          const copied = join(root, 'policy-source', name)
          await mkdir(copied, { recursive: true })
          for (const entry of ['package.json', 'lib', 'locale', 'cordis.patch.yml', 'cordis.admin.patch.yml']) {
            if (existsSync(join(source, entry))) cpSync(join(source, entry), join(copied, entry), { recursive: true, dereference: true })
          }
          chmodSync(join(copied, 'lib'), 0o770)
          chmodSync(join(copied, 'lib', 'index.js'), 0o640)
          if (name === 'dsh-model-governance') cfg.modelGovernancePackage = copied
          else cfg.guardPatch = join(copied, 'cordis.patch.yml')
        }
      }
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      if (pool !== undefined) {
        const slug = `personal-policy-replay-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Personal replay') RETURNING id", [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        resources = new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget)
        await resources.configure()
        await resources.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
      } else db = openDb(join(root, 'gateway.sqlite'))
      const users = context === undefined ? new UserService(db, cfg) : new PostgresUserService(context, cfg)
      const projects = context === undefined ? new ProjectService(db, cfg) : new PostgresProjectService(context, cfg)
      const actor = await users.create({ username: 'current-admin', password: 'pw-12345678', role: 'admin' })
      const target = await users.create({ username: 'personal-admin', password: 'pw-12345678', role: 'admin' })
      const privateHome = join(cfg.usersRoot, target.username, 'dsh')
      if (inspectPolicyArtifacts) {
        await mkdir(privateHome, { recursive: true, mode: 0o700 })
        chmodSync(privateHome, 0o700)
        writeFileSync(join(privateHome, 'private-artifact-probe'), 'fixture-private\n', { mode: 0o600 })
      }
      await users.changeOwnPassword(actor.id, 'pw-12345678')
      const project = administratorReplay && scenario.startsWith('project-')
        ? await projects.createManaged({ name: 'Controlled project', ownerUserId: target.id }) : undefined
      const controlledTarget = project === undefined ? { kind: 'user', id: target.id } : { kind: 'project', id: project.id }
      const controlledSubject = project === undefined ? target : { kind: 'project', id: project.id, name: project.name, path: project.path }
      if (scenario.endsWith('-database-capacity')) limited = createPostgresPool(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL), { max: 1, maxCheckoutQueue: 1 })
      const repository = context === undefined ? undefined : new PostgresInstanceRepository(limited === undefined ? context : { ...context, pool: limited }, cfg.instancePortBase)
      const launcher = new LocalLauncher(cfg)
      if (administratorReplay && scenario.endsWith('-late-role')) {
        const allocate = launcher.start.bind(launcher)
        let revoked = false
        launcher.start = async runtime => {
          const proc = await allocate(runtime), terminate = proc.terminate.bind(proc)
          proc.terminate = async grace => {
            await terminate(grace)
            if (!revoked) { revoked = true; await users.setRole(actor.id, 'user') }
          }
          return proc
        }
      }
      manager = new InstanceManager(repository ?? db, cfg, launcher, { principalPublicKey: '' }, resources)
      await manager.stateOf(target.id)
      const placements = [actor, target].map(user => ({ kind: 'user', id: user.id, home: join(cfg.usersRoot, user.username, 'dsh') }))
      if (project !== undefined) placements.push({ kind: 'project', id: project.id, home: join(cfg.projectRuntimesRoot, String(project.id), 'dsh') })
      for (const placement of placements) {
        const portFile = join(placement.home, 'child-port'), sockets = new Set()
        const relay = createServer(downstream => {
          downstream.on('error', () => downstream.destroy()); sockets.add(downstream)
          downstream.once('close', () => sockets.delete(downstream))
          let port
          try { port = Number(readFileSync(portFile, 'utf8')) } catch (error) {
            if (error.code !== 'ENOENT') throw error
            downstream.destroy(); return
          }
          assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
          const upstream = connect(port, '127.0.0.1'); sockets.add(upstream)
          upstream.once('close', () => { sockets.delete(upstream); downstream.destroy() })
          downstream.once('close', () => upstream.destroy()); upstream.on('error', () => downstream.destroy())
          downstream.pipe(upstream).pipe(downstream)
        })
        cleanups.push(async () => {
          const closed = new Promise((ready, reject) => relay.close(error => error ? reject(error) : ready()))
          const connections = [...sockets].map(socket => new Promise(ready => { socket.once('close', ready); socket.destroy() }))
          await Promise.all([closed, ...connections])
        })
        await listen(relay)
        const port = relay.address().port
        if (context === undefined) db.prepare('UPDATE instances SET port=? WHERE user_id=?').run(port, placement.id)
        else await pool.query(`UPDATE harness.instances i SET port=$1 FROM harness.${placement.kind === 'user' ? 'users' : 'projects'} u WHERE u.id=${placement.kind === 'user' ? 'i.user_id' : 'i.project_id'}
          AND i.organization_id=$2 AND u.public_id=$3`, [port, context.organizationId, placement.id])
      }
      const governance = context === undefined ? undefined : new PostgresModelGovernanceService(context,
        new OrganizationModelCredentialCipher(Buffer.alloc(32, 1)), 'UTC')
      const lookupEntered = Promise.withResolvers(), lookupGate = Promise.withResolvers()
      releaseLookup = () => lookupGate.resolve()
      let held = false
      const routed = (service, kind) => new Proxy(service, { get(source, key) {
        if (key === 'getById') return async id => {
          const value = await source.getById(id)
          if (administratorReplay && controlledTarget.kind === kind && id === controlledTarget.id && !held) {
            held = true; lookupEntered.resolve(); await lookupGate.promise
          }
          return value
        }
        const value = Reflect.get(source, key)
        return typeof value === 'function' ? value.bind(source) : value
      } })
      const deps = { cfg, users: routed(users, 'user'), projects: routed(projects, 'project'), instances: manager, governance,
        auth: context === undefined ? new AuthService(db, cfg) : new PostgresAuthService(context, cfg),
        audit: context === undefined ? new AuditService(db) : new PostgresAuditService(context) }
      const principals = loadPrincipalKeys(cfg.principalKeyDir, cfg.organizationSlug, 300000)
      proxies = createProxyHandlers(deps, principals.signer)
      const runtime = context === undefined ? undefined : createRuntimeApiHandler({ context, instances: repository, resourceBudget: resources,
        conversations: new PostgresConversationStore(pool), collaboration: new PostgresCollaborationService(context), principals: principals.signer, governance })
      gateway = createGatewayServer(deps, { ...proxies, runtime, admin: createAdminApiHandler(deps) }); await listen(gateway)
      cfg.port = gateway.address().port
      const base = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
      await login.arrayBuffer(); assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
      if (administratorReplay) {
        const [scope, action] = scenario.split('-')
        const current = scenario.endsWith('-current'), late = scenario.endsWith('-late-role'), capacity = scenario.endsWith('-database-capacity')
        if (action !== 'start') await manager.ensureRunning(controlledSubject, 'explicit')
        const generation = await manager.generationOf(controlledTarget)
        pending = fetch(`${base}/admin/api/${scope === 'user' ? 'users' : 'projects'}/${controlledTarget.id}/instance/${action}`, {
          method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ actorUserId: target.id }),
        }).then(async response => {
          const text = await response.text(), body = text === '' ? {} : JSON.parse(text)
          return { status: response.status, code: body.code ?? body.error ?? null }
        })
        await lookupEntered.promise
        if (capacity) {
          heldConnection = await limited.connect()
          queuedConnection = limited.connect().then(client => ({ client }), error => ({ error }))
          await until(() => limited.waitingCount === 1, pending)
        } else if (!current && !late) await users.setRole(actor.id, 'user')
        releaseLookup()
        const { status, code } = await pending
        await releaseDatabaseLane()
        assert.equal(status, capacity ? 503 : current ? 204 : 403)
        assert.equal(code, capacity ? 'DB_CHECKOUT_QUEUE_FULL' : current ? null : 'forbidden')
        const expectedLive = current ? action !== 'stop' : !late && action !== 'start'
        const state = await manager.stateOf(controlledTarget); assert.equal(state, expectedLive ? 'ready' : 'stopped')
        const runtimeUrl = `http://127.0.0.1:${await manager.portOf(controlledTarget)}/inspect`
        if (expectedLive) { const response = await fetch(runtimeUrl); await response.arrayBuffer(); assert.equal(response.status, 200) }
        else await assert.rejects(fetch(runtimeUrl))
        const actionName = scope === 'user' ? `admin.instances.${action}` : `admin.project-instances.${action}`
        const successAudit = context === undefined ? db.prepare('SELECT 1 FROM audit_log WHERE action=?').get(actionName) !== undefined
          : (await pool.query('SELECT 1 FROM harness.audit_events WHERE organization_id=$1 AND action=$2', [context.organizationId, actionName])).rowCount > 0
        assert.equal(successAudit, current)
        const failedAuditStatus = context === undefined ? db.prepare("SELECT status FROM audit_log WHERE action='admin.request'").get()?.status ?? null
          : (await pool.query("SELECT status_code status FROM harness.audit_events WHERE organization_id=$1 AND action='admin.request'", [context.organizationId])).rows[0]?.status ?? null
        assert.equal(failedAuditStatus, current ? null : status)
        const unchanged = current ? null : await manager.generationOf(controlledTarget) === generation
        if (!current) assert.equal(unchanged, true)
        console.log(JSON.stringify({ backend, scenario, status, code, state, runtimeReachable: expectedLive,
          successAudit, failedAuditStatus, generationUnchangedOnRefusal: unchanged }))
        continue
      }
      if (scenario.startsWith('capacity-')) await manager.ensureRunning(actor, 'explicit')
      if (scenario.startsWith('pressure-')) await pool.query('UPDATE harness.node_resource_state SET credits=0,valid_until=NULL WHERE organization_id=$1 AND node_id=$2', [context.organizationId, context.nodeId])
      let policy = null
      const prepare = manager.beforeStart
      manager.beforeStart = async runtime => {
        await prepare(runtime)
        if (runtime.ownerId !== target.id) return
        policy = { role: runtime.user.role, privileged: runtime.privileged }
        if (scenario === 'prepare-demotion') await users.setRole(target.id, 'user')
      }
      pending = fetch(`${base}/admin/api/users/${target.id}/instance/start`, { method: 'POST', headers: { cookie, origin: base } })
        .then(async response => { const text = await response.text(); return { status: response.status, code: text === '' ? null : JSON.parse(text).code ?? null } })
      if (scenario.startsWith('capacity-')) await until(() => manager.capacitySnapshot().queued === 1, pending)
      if (scenario.startsWith('pressure-')) await until(async () => (await pool.query(`SELECT allocation_state FROM harness.instances i
        JOIN harness.users u ON u.id=i.user_id WHERE i.organization_id=$1 AND u.public_id=$2`, [context.organizationId, target.id])).rows[0].allocation_state === 'waiting', pending)
      if (scenario.endsWith('-demotion') && scenario !== 'prepare-demotion') await users.setRole(target.id, 'user')
      if (scenario.endsWith('-membership')) await pool.query(`UPDATE harness.memberships m SET status='disabled' FROM harness.users u
        WHERE u.id=m.user_id AND m.organization_id=$1 AND u.public_id=$2`, [context.organizationId, target.id])
      if (scenario.startsWith('capacity-')) await manager.stop(actor.id)
      if (scenario.startsWith('pressure-')) await resources.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
      const { status, code } = await pending, allowed = scenario === 'capacity-demotion' || scenario === 'current'
      assert.equal(status, allowed ? 204 : 503)
      assert.equal(code, allowed ? null : 'INSTANCE_UNAVAILABLE')
      const childAllocated = existsSync(join(cfg.usersRoot, target.username, 'dsh', 'child-port'))
      assert.equal(childAllocated, allowed)
      let child = null
      if (allowed) {
        const response = await fetch(`http://127.0.0.1:${await manager.portOf(target.id)}/inspect`)
        child = await response.json()
        assert.deepEqual(child, { administratorPatch: scenario === 'current', rootGrant: scenario === 'current' })
      }
      const state = await manager.stateOf(target.id); assert.equal(state, allowed ? 'ready' : 'stopped')
      const firstPolicy = policy
      let retry = null
      if (scenario === 'prepare-demotion' || scenario === 'pressure-demotion') {
        const response = await fetch(`${base}/admin/api/users/${target.id}/instance/start`, { method: 'POST', headers: { cookie, origin: base } })
        await response.arrayBuffer(); assert.equal(response.status, 204)
        const current = await (await fetch(`http://127.0.0.1:${await manager.portOf(target.id)}/inspect`)).json()
        assert.deepEqual(current, { administratorPatch: false, rootGrant: false })
        retry = { status: response.status, policy, child: current, state: await manager.stateOf(target.id) }
      }
      let combinedDisable = null
      if (scenario === 'current') {
        const generation = await manager.generationOf(target.id)
        const response = await fetch(`${base}/admin/api/users/${target.id}`, { method: 'PATCH',
          headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', status: 'disabled' }) })
        await response.arrayBuffer(); assert.equal(response.status, 204)
        const next = await users.getById(target.id); assert.equal(next.status, 'disabled'); assert.equal(next.role, 'user')
        assert.equal(await manager.stateOf(target.id), 'stopped')
        assert.equal(await manager.generationOf(target.id), generation)
        await assert.rejects(fetch(`http://127.0.0.1:${await manager.portOf(target.id)}/inspect`))
        combinedDisable = { status: response.status, state: 'stopped', generationUnchanged: true, childUnavailable: true }
      }
      let policyArtifacts
      if (inspectPolicyArtifacts) {
        const modeOf = path => (statSync(path).mode & 0o777).toString(8)
        const modules = join(privateHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
        policyArtifacts = {
          directories: ['dsh-model-governance', 'dsh-directory-guard'].map(name => modeOf(join(modules, name, 'lib'))),
          entries: ['dsh-model-governance', 'dsh-directory-guard'].map(name => modeOf(join(modules, name, 'lib', 'index.js'))),
          privateHome: modeOf(privateHome), privateData: modeOf(join(privateHome, 'private-artifact-probe')),
          releaseDirectory: modeOf(join(cfg.modelGovernancePackage, 'lib')),
        }
        assert.deepEqual(policyArtifacts, { directories: ['755', '755'], entries: ['644', '644'], privateHome: '700', privateData: '600', releaseDirectory: '770' })
      }
      console.log(JSON.stringify({ backend, scenario, status, code, policy: firstPolicy, childAllocated, child, state, retry, combinedDisable, policyArtifacts }))
    } catch (error) {
      primaryError = error
      for (const username of ['current-admin', 'personal-admin']) {
        const home = join(root, 'users', username, 'dsh'), log = join(home, 'logs', 'runtime.log')
        console.error(JSON.stringify({ backend, scenario, username, published: existsSync(join(home, 'child-port')),
          runtimeLog: existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : null }))
      }
      throw error
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask)
      releaseLookup?.()
      const failures = [], close = async fn => { try { await fn() } catch (error) { failures.push(error) } }
      await close(releaseDatabaseLane)
      let stopped = manager === undefined
      if (manager !== undefined) await close(async () => { await manager.stopAll(); stopped = true })
      await close(async () => { await pending })
      if (gateway?.listening) await close(() => closeServer(gateway))
      await close(async () => { await proxies?.close() })
      for (const cleanup of cleanups.reverse()) await close(cleanup)
      await close(async () => { db?.close() }); await close(async () => { await limited?.end() })
      if (stopped) {
        if (context !== undefined) await close(() => removeFixtureOrganization(pool, context.organizationId))
        await close(() => rm(root, { recursive: true, force: true }))
      } else failures.push(new Error('Unconfirmed Runtime ownership retained at ' + root))
      // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
      if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Personal Runtime replay cleanup failed')
    }
  }
} finally { await pool?.end() }
