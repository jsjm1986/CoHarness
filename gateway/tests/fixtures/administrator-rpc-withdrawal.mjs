/** Real Runtime admission does not retain administrator access to later management replies. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresInstanceRepository }, { PostgresAuthService }, { PostgresAuditService },
  { InstanceManager, INSTANCE_PROFILE }, { loadConfig }, { createGatewayServer }, { createAdminApiHandler },
  { GatewayTerminalManagement }, { GatewayPluginManagement }, { GatewayPrincipalSigner, PRINCIPAL_HEADER },
  { createRuntimeApiHandler }, { PostgresRuntimeCatalog }, { computeLaunchStamps }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/instance-repository', 'postgres/auth-service', 'postgres/audit-service', 'instances', 'config',
  'server', 'admin-api', 'terminal-management', 'plugin-management', 'principal', 'runtime-api', 'postgres/runtime-catalog',
  'launch-stamp',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const administration = createPostgresPool(databaseUrl, { max: 1 })
const database = `administrator_rpc_${randomUUID().replaceAll('-', '')}_test`
const servers = [], handlers = new Set(), failures = []
let created = false, pool, root, instances, releaseTail = () => {}, releaseLeasePause = () => {}
const closeServer = async server => {
  if (!server.listening) return
  await new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) })
}
const listen = async server => {
  servers.push(server)
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${server.address().port}`
}
try {
  await administration.query(`CREATE DATABASE ${database}`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = createPostgresPool(url.toString(), { max: 3 })
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations/', import.meta.url)))
  root = await mkdtemp(join(tmpdir(), 'administrator-rpc-'))
  const slug = `administrator-rpc-${randomUUID()}`, name = 'local'
  const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Administrator RPC') RETURNING id", [slug])).rows[0].id
  await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
  const context = await resolvePostgresRuntimeContext(pool, slug, name)
  const cfg = loadConfig({ HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE: name,
    HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
    HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '', HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  cfg.computeNodeName = name
  const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
  const actor = await users.create({ username: 'operator', password: 'pw-12345678' })
  await users.changeOwnPassword(actor.id, 'pw-12345678')
  const owner = await users.create({ username: 'private-owner', password: 'pw-12345678' })
  const role = async value => {
    await pool.query(`UPDATE harness.memberships m SET role=$3 FROM harness.users u WHERE u.id=m.user_id
      AND u.organization_id=m.organization_id AND u.organization_id=$1 AND u.public_id=$2`, [organizationId, actor.id, value])
  }
  const organization = async status => { await pool.query('UPDATE harness.organizations SET status=$2 WHERE id=$1', [organizationId, status]) }
  await role('admin')
  let leasePause
  const pauseLease = async () => {
    const pause = leasePause
    if (pause === undefined) return
    leasePause = undefined
    pause.entered.resolve()
    await pause.release.promise
  }
  const repository = new (class extends PostgresInstanceRepository {
    async admitLease(target, at, generation) { await pauseLease(); return super.admitLease(target, at, generation) }
    async touch(target, at) { await pauseLease(); return super.touch(target, at) }
  })(context, cfg.instancePortBase)
  await repository.initialize()
  const target = await repository.resolveTarget({ kind: 'user', id: owner.id })
  const token = randomUUID(), tokenHash = createHash('sha256').update(token).digest()
  const launchStamp = [...computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps][0]
  const generation = await repository.beginStart(target, Date.now(), tokenHash, 'passive', undefined, true, launchStamp)
  await repository.markReady(target, generation)
  const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 60_000)
  const secret = 'private-owner-only', publicProgress = 'installation-started'
  const terminal = { ownerId: randomUUID(), sessionId: secret, id: 'terminal-private', creatorUserId: owner.id, state: 'running' }
  let origin, phase, admissions = 0
  const runtimeServer = createServer((req, res) => {
    const operation = (async () => {
      const selected = phase, chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()), assertion = req.headers[PRINCIPAL_HEADER]
      const claims = principals.verify(assertion)
      const isTerminal = req.url === '/api/terminal/adminList'
      assert.equal(claims.user.id, actor.id)
      assert.equal(claims.runtime.id, owner.id); assert.equal(claims.runtime.runtimeId, target.runtimeId)
      assert.equal(claims.runtime.generation, generation)
      assert.equal(claims.purpose, isTerminal ? 'terminal-admin' : 'plugin-admin')
      const admission = await fetch(`${origin}/internal/runtime/${isTerminal ? 'terminal' : 'plugin'}-management/authorize`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, [PRINCIPAL_HEADER]: assertion }, signal: AbortSignal.timeout(10_000),
      })
      await admission.arrayBuffer(); assert.equal(admission.status, 204); admissions += 1
      if (selected.withdrawBefore === 'role') await role('member')
      else if (selected.withdrawBefore === 'organization') await organization('disabled')
      res.writeHead(200, { 'content-type': selected.streaming ? 'application/x-ndjson' : 'application/json' })
      const response = value => JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } })
      if (selected.midStream) {
        res.write(`${response(publicProgress)}\n`)
        await selected.tail
      }
      res.end(`${response(isTerminal ? [terminal] : [secret])}${selected.streaming ? '\n' : ''}`)
    })()
    handlers.add(operation)
    void operation.catch(error => { failures.push(error); res.destroy(error) }).finally(() => handlers.delete(operation))
  })
  await listen(runtimeServer)
  await pool.query('UPDATE harness.instances SET port=$3 WHERE organization_id=$1 AND runtime_id=$2', [organizationId, target.runtimeId, runtimeServer.address().port])
  // The fixture owns this HTTP Runtime; this adapter observes its listener and starts no OS process.
  instances = new InstanceManager(repository, cfg, { instancesOutliveGateway: true,
    start: async () => { throw new Error('Management verification must not start a Runtime') },
    attach: identity => {
      assert.equal(identity.generation, generation); assert.equal(identity.ownerId, owner.id)
      return { hasExited: () => !runtimeServer.listening, isAlive: async () => runtimeServer.listening,
        terminate: async () => closeServer(runtimeServer) }
    } })
  let outstanding = 0, inspectOwnerAtAdmission = false, admittedAfterOwnerDisabled = false
  const operationRef = instances.operationRef.bind(instances)
  instances.operationRef = async (...args) => {
    await operationRef(...args)
    outstanding += args[1]
    if (inspectOwnerAtAdmission && args[1] === 1) {
      const row = (await pool.query('SELECT status FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, owner.id])).rows[0]
      admittedAfterOwnerDisabled = row.status !== 'active'
    }
  }
  const deps = { cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
    runtimeCatalog: new PostgresRuntimeCatalog(context, cfg.runtimeCatalog),
    terminalManagement: new GatewayTerminalManagement({ cfg, users, projects, instances }, principals, context.nodeId),
    pluginManagement: new GatewayPluginManagement({ cfg, users, projects, instances }, principals, context.nodeId) }
  const runtime = createRuntimeApiHandler({ context, instances: repository, principals })
  origin = await listen(createGatewayServer(deps, { admin: createAdminApiHandler(deps), runtime,
    runtimeAuthorize: async req => (await repository.authenticateRuntimeToken(req.headers.authorization?.slice(7) ?? '')) !== null }))
  cfg.publicOrigins.push(origin)
  const signedIn = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'operator', password: 'pw-12345678' }) })
  await signedIn.arrayBuffer(); assert.equal(signedIn.status, 302)
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  const call = terminal => fetch(terminal ? `${origin}/admin/api/terminals?kind=user&id=${owner.id}&dshRuntime=${target.runtimeId}` : `${origin}/admin/api/plugins/invoke`, {
    headers: { cookie, origin, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    ...(terminal ? {} : { method: 'POST', body: JSON.stringify({ target, nodeId: context.nodeId, generation, rpcId: randomUUID(),
      endpoint: phase.streaming ? 'pluginManager/installBundleStream' : 'pluginManager/listBundles', args: {} }) }),
  })
  for (const [withdrawal, kind] of ['role', 'organization'].flatMap(withdrawal => ['terminal', 'plugin-unary', 'plugin-first-stream'].map(kind => [withdrawal, kind]))) {
    await organization('active'); await role('admin')
    phase = { streaming: kind === 'plugin-first-stream', withdrawBefore: withdrawal }
    const response = await call(kind === 'terminal'), text = await response.text()
    assert.equal(response.status, 403, `${kind}: ${text}`); assert.ok(!text.includes(secret)); assert.equal(outstanding, 0)
    console.log(JSON.stringify({ scenario: `${kind}-${withdrawal}`, runtimeAdmitted: true, withdrawnStatus: 403, privateMetadataPublished: false, operationRefs: 0 }))
  }
  await organization('active')
  await role('admin')
  phase = { streaming: true, midStream: true, tail: new Promise(done => { releaseTail = done }) }
  const streamed = await call(false); assert.equal(streamed.status, 200)
  const reader = streamed.body.getReader(), first = await reader.read()
  assert.equal(first.done, false); assert.ok(Buffer.from(first.value).toString().includes(publicProgress))
  await role('member'); releaseTail()
  let tail = '', interrupted = false
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; tail += Buffer.from(next.value).toString() }
  } catch { interrupted = true } finally { reader.releaseLock() }
  assert.equal(interrupted, true); assert.ok(!tail.includes(secret)); assert.equal(outstanding, 0)
  console.log(JSON.stringify({ scenario: 'plugin-mid-stream', runtimeAdmitted: true, initialStatus: 200, authorizedProgressPublished: true, withdrawnStreamInterrupted: true, privateMetadataPublished: false, operationRefs: 0 }))
  for (const kind of ['terminal', 'plugin-unary']) {
    await role('admin'); phase = { streaming: false, withdrawBefore: false }
    const response = await call(kind === 'terminal'), text = await response.text()
    assert.equal(response.status, 200, text); assert.ok(text.includes(secret)); assert.equal(outstanding, 0)
    console.log(JSON.stringify({ scenario: `${kind}-current-administrator`, status: 200, privateMetadataPublished: true, operationRefs: 0 }))
  }
  assert.equal(admissions, 9)
  assert.equal(await repository.stateOf(target), 'ready'); assert.equal(await repository.generationOf(target), generation)
  const activity = async () => (await pool.query('SELECT last_activity_at::text value FROM harness.instances WHERE runtime_id=$1', [target.runtimeId])).rows[0].value
  const beforeActivity = await activity(), beforeAdmissions = admissions
  const pause = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  leasePause = pause; releaseLeasePause = pause.release.resolve
  inspectOwnerAtAdmission = true
  phase = { streaming: false, withdrawBefore: false }
  const pending = call(true).then(async response => ({ response, text: await response.text() }))
  try {
    await Promise.race([pause.entered.promise, pending.then(() => { throw new Error('Management completed before lease activity admission') })])
    await pool.query("UPDATE harness.users SET status='disabled' WHERE organization_id=$1 AND public_id=$2", [organizationId, owner.id])
    pause.release.resolve()
    const result = await pending.then(value => ({ kind: 'response', ...value }), error => ({ kind: 'error', error }))
    assert.equal(admittedAfterOwnerDisabled, false, 'A disabled owner cannot receive a new Runtime operation lease')
    if (result.kind === 'error') throw result.error
    const { response, text } = result
    assert.equal(response.status, 409, text); assert.ok(!text.includes(secret))
    assert.equal(await activity(), beforeActivity); assert.equal(admissions, beforeAdmissions); assert.equal(outstanding, 0)
    console.log(JSON.stringify({ scenario: 'owner-disabled-before-lease-commit', status: 409,
      runtimeReached: false, activityChanged: false, operationRefs: 0 }))
  } finally {
    pause.release.resolve()
    await pending.catch(error => failures.push(error))
    await pool.query("UPDATE harness.users SET status='active' WHERE organization_id=$1 AND public_id=$2", [organizationId, owner.id])
  }
} catch (error) { failures.push(error) } finally {
  releaseTail()
  releaseLeasePause()
  const close = async action => { try { await action() } catch (error) { failures.push(error) } }
  for (const server of servers.reverse()) await close(() => closeServer(server))
  await close(() => Promise.allSettled([...handlers]))
  if (instances !== undefined) await close(() => instances.stopAll())
  if (pool !== undefined) await close(() => pool.end())
  if (created) await close(() => administration.query(`DROP DATABASE ${database}`))
  await close(() => administration.end())
  if (root !== undefined) await close(() => rm(root, { recursive: true, force: true }))
}
if (failures.length > 0) throw new AggregateError(failures, 'Administrator management verification or cleanup failed')
