/** Two real Gateway HTTP servers, a real local Runtime owner, and a deliberately lost start response. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer as createRelay, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ InstanceManager }, { LocalLauncher }, { openDb }, { UserService }, { AuthService }, { AuditService },
  { ProjectService }, { loadConfig }, { createGatewayServer, scopeCookie }, { GatewayNodeServiceProxy },
  { GatewayRuntimeRouter, LocalRuntimeAdapter }, { RuntimeCatalogError }, { DeploymentTopologyError }] = await Promise.all([
  'instances', 'launcher', 'db', 'users', 'auth', 'audit', 'projects', 'config', 'server', 'node-service-proxy',
  'runtime-router', 'runtime-catalog', 'deployment-topology',
].map(load))
const root = await mkdtemp(join(tmpdir(), 'hgw-start-observation-'))
const marker = join(root, 'runtime.json'), probeMarker = join(root, 'probe.json'), sockets = new Set(), servers = []
const databases = [], managers = [], transports = new Set(), transcript = [], errors = []
const admitted = Promise.withResolvers(), proceed = Promise.withResolvers(), ready = Promise.withResolvers()
let processOwner, forwarding, pendingStart, remoteStarts = 0, localStarts = 0, primaryFailure, relayFailure
const clockNow = Date.now
let environment, allowed = true, topologyAllowed = true
async function listen(server) {
  servers.push(server)
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${server.address().port}`
}
async function until(check) {
  const deadline = performance.now() + 20_000
  for (;;) { if (await check()) return; if (performance.now() >= deadline) throw new Error('Owned fixture operation did not settle'); await delay(10) }
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture deadline')), 25_000) })]) }
  finally { clearTimeout(timer) }
}
function config(name) {
  const home = join(root, name)
  return loadConfig({ HGW_USERS_ROOT: join(home, 'users'), HGW_STATE_ROOT: join(home, 'state'),
    HGW_PROJECTS_ROOT: join(home, 'projects'), HGW_PROJECT_RUNTIMES_ROOT: join(home, 'runtimes'),
    HGW_USER_PROJECTS_ROOT: join(home, 'user-projects'), HGW_SYSTEMD_UNIT_DIR: join(home, 'units'),
    HGW_DEFAULT_ENV_FILE: '', HGW_GUARD_PATCH: 'off', HGW_READINESS_TIMEOUT_MS: '30000',
    HGW_NODE_SERVICE_FORWARDING: 'on', HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
}
function track(socket) {
  sockets.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket))
  return socket
}
try {
  const centerConfig = config('center'), remoteConfig = config('remote')
  const accounts = openDb(join(root, 'accounts.sqlite')); databases.push(accounts)
  const localData = openDb(join(root, 'runtime.sqlite')); databases.push(localData)
  const users = new UserService(accounts, centerConfig), remoteUsers = new UserService(localData, remoteConfig)
  const actor = await users.create({ username: 'observer', password: 'fixture-password-12345' })
  await users.changeOwnPassword(actor.id, 'fixture-password-12345')
  const remoteActor = await remoteUsers.create({ username: 'observer', password: 'fixture-password-12345' })
  assert.equal(remoteActor.id, actor.id)
  const other = await users.create({ username: 'other', password: 'fixture-password-12345' })
  await users.changeOwnPassword(other.id, 'fixture-password-12345')
  const runtimeId = randomUUID(), nodeId = randomUUID(), localNodeId = randomUUID()
  const relay = createRelay(downstream => {
    track(downstream)
    let port
    try { port = JSON.parse(readFileSync(marker, 'utf8')).port }
    catch (error) { downstream.destroy(); if (error.code !== 'ENOENT') relayFailure ??= error; return }
    const upstream = track(connect(port, '127.0.0.1'))
    downstream.once('close', () => upstream.destroy()); upstream.once('close', () => downstream.destroy())
    downstream.pipe(upstream).pipe(downstream)
  })
  await listen(relay)
  localData.prepare('UPDATE instances SET port=? WHERE user_id=?').run(relay.address().port, actor.id)
  remoteConfig.dshCommand = [process.execPath, ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./readiness-runtime.mjs', import.meta.url)), new URL(`runtime-readiness.${mode === 'src' ? 'ts' : 'js'}`, base).href,
    marker, 'valid', probeMarker]
  const native = new LocalLauncher(remoteConfig)
  const remoteManager = new InstanceManager(localData, remoteConfig, { instancesOutliveGateway: false,
    start: async input => {
      remoteStarts++; admitted.resolve(); await proceed.promise
      processOwner = await native.start(input)
      await until(async () => { try { await readFile(marker); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } })
      return processOwner
    } })
  managers.push(remoteManager)
  // The SQLite fixture has one allocation per account; project its stable catalog identity into the owner.
  const originalPolicy = remoteManager.repository.personalPolicy.bind(remoteManager.repository)
  remoteManager.repository.personalPolicy = async (...args) => {
    const policy = await originalPolicy(...args)
    return policy === null ? null : { ...policy, runtimeId }
  }
  const originalReady = remoteManager.repository.markReady.bind(remoteManager.repository)
  remoteManager.repository.markReady = async (...args) => {
    const result = await originalReady(...args); ready.resolve(); return result
  }
  const centerManager = new InstanceManager(accounts, centerConfig, { instancesOutliveGateway: false,
    start: async () => { localStarts++; throw new Error('A remote selection must not start at the center') } })
  managers.push(centerManager)
  environment = { id: runtimeId, owner: { kind: 'personal', id: actor.id, name: actor.displayName },
    node: { id: nodeId, name: 'Remote', status: 'active', lastHeartbeatAt: null },
    generation: 1, observedState: 'stopped', routing: 'unavailable' }
  const resolveForAccount = async (user, id) => {
    if (!allowed || user.id !== actor.id || users.getById(user.id)?.status !== 'active' || id !== runtimeId) throw new RuntimeCatalogError(403, 'runtime-catalog/forbidden')
    return { ...environment, observedState: await remoteManager.stateOf({ kind: 'user', id: actor.id, runtimeId }) }
  }
  const catalog = { resolveForAccount, resolveForOwner: user => resolveForAccount(user, runtimeId), resolveForLanding: user => resolveForAccount(user, runtimeId) }
  const common = { users, auth: new AuthService(accounts, centerConfig), audit: new AuditService(accounts) }
  const remoteDeps = { ...common, cfg: remoteConfig, projects: new ProjectService(accounts, remoteConfig), instances: remoteManager,
    nodeServiceIdentity: { nodeId, organizationId: randomUUID(), authorize: async () => { throw new Error('Not a control-channel fixture') } } }
  const centerDeps = { ...common, cfg: centerConfig, projects: new ProjectService(accounts, centerConfig), instances: centerManager,
    runtimeCatalog: { pageForAccount: async (user, query) => ({ items: [await resolveForAccount(user, query.ids)], nextCursor: null }) },
    topology: { assertNode: async id => { if (!topologyAllowed || id !== nodeId) throw new DeploymentTopologyError(403, 'deployment-topology/remote-disabled') } } }
  remoteDeps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(remoteDeps), { localNodeId: nodeId, catalog })
  centerDeps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(centerDeps), { localNodeId, catalog })
  const remote = createGatewayServer(remoteDeps)
  const remoteOrigin = await listen(remote)
  forwarding = new GatewayNodeServiceProxy({ localNodeId, resolveForAccount,
    resolvePlacement: (user, selection) => centerDeps.runtimeRouter.placement(user, selection),
    resetScopeCookie: () => scopeCookie('personal', centerConfig), assertNode: id => centerDeps.topology.assertNode(id),
    authorizeAdministratorNode: async () => { throw new Error('No administrator operation') } }, {
    capacity: () => 'available', revalidate: async () => {}, released: async () => {},
    open: async id => {
      assert.equal(id, nodeId)
      const socket = track(connect(Number(new URL(remoteOrigin).port), '127.0.0.1'))
      transports.add(socket); socket.once('close', () => transports.delete(socket))
      await new Promise((done, fail) => { socket.once('connect', done); socket.once('error', fail) })
      return socket
    },
  }, 20_000, centerConfig.nodeService)
  centerDeps.nodeServiceProxy = forwarding
  const center = createGatewayServer(centerDeps), origin = await listen(center)
  centerConfig.publicOrigins.push(origin); remoteConfig.publicOrigins.push(origin, remoteOrigin)
  const login = async username => {
    const result = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin },
      body: new URLSearchParams({ username, password: 'fixture-password-12345' }) })
    assert.equal(result.status, 302); await result.arrayBuffer(); return result.headers.get('set-cookie').split(';')[0]
  }
  const cookie = await login('observer'), secondCookie = await login('other')
  const request = (path, selectedCookie = cookie) => fetch(origin + path, { redirect: 'manual', headers: { cookie: selectedCookie } })
  pendingStart = fetch(origin + '/account/runtime/start?dshRuntime=' + runtimeId, { method: 'POST', redirect: 'manual',
    headers: { origin, cookie: cookie + '; hgw_scope=project:999', 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=personal' })
  await bounded(admitted.promise)
  assert.equal(transports.size, 1)
  for (const socket of transports) socket.destroy()
  const response = await bounded(pendingStart); await response.arrayBuffer()
  assert.equal(response.status, 303); assert.equal(response.headers.get('set-cookie'), null)
  const waitPath = response.headers.get('location')
  assert.ok(waitPath.startsWith('/account/runtime/wait?observation='))
  transcript.push('A submitted start with a lost response redirects to a read-only observation; it is not sent again.')
  for (let tab = 0; tab < 2; tab++) {
    const waiting = await request(waitPath)
    assert.equal(waiting.status, 200); assert.equal(waiting.headers.get('set-cookie'), null)
    const html = await waiting.text(); assert.match(html, /正在确认工作台状态/); assert.doesNotMatch(html, /<form/)
  }
  assert.equal(remoteStarts, 1); assert.equal(localStarts, 0)
  transcript.push('Two browser tabs observe the same original computer without changing scope cookies or starting another Runtime.')
  const foreign = await request(waitPath, secondCookie); assert.equal(foreign.status, 400); await foreign.arrayBuffer()
  const altered = await request(waitPath + '&dshNode=' + localNodeId); assert.equal(altered.status, 400); await altered.arrayBuffer()
  allowed = false
  const denied = await request(waitPath); assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /http-equiv="refresh"/)
  allowed = true; topologyAllowed = false
  const disabled = await request(waitPath); assert.equal(disabled.status, 403); await disabled.arrayBuffer()
  topologyAllowed = true
  transcript.push('Foreign accounts, altered selectors, revoked use permission and disabled aggregation cannot continue the observation.')
  const originalNode = environment.node.id
  environment.node = { ...environment.node, id: localNodeId }
  const moved = await request(waitPath); assert.equal(moved.status, 409); await moved.arrayBuffer()
  environment.node = { ...environment.node, id: originalNode }
  Date.now = () => clockNow() + centerConfig.readinessTimeoutMs + centerConfig.runtimeCapacity.maxQueueWaitMs + 1
  const expired = await request(waitPath); assert.equal(expired.status, 504)
  const expiredHtml = await expired.text(); assert.match(expiredHtml, /后台启动可能仍在继续/); assert.doesNotMatch(expiredHtml, /http-equiv="refresh"|<form/)
  Date.now = clockNow
  transcript.push('A changed computer or elapsed configured observation budget ends polling without fallback or POST replay.')
  proceed.resolve(); await bounded(ready.promise)
  const opened = await request(waitPath); assert.equal(opened.status, 302); await opened.arrayBuffer()
  assert.deepEqual(Object.fromEntries(new URL(opened.headers.get('location'), origin).searchParams), { dshRuntime: runtimeId, dshNode: nodeId, dshTarget: 'personal' })
  assert.equal(opened.headers.get('set-cookie'), null)
  assert.equal(await processOwner.isAlive(), true); assert.equal(remoteStarts, 1); assert.equal(localStarts, 0)
  assert.equal(JSON.parse(await readFile(probeMarker, 'utf8')).authenticated, true)
  transcript.push('The original real Runtime completes authenticated readiness after the lost response; the browser opens only its exact target.')
  await remoteManager.stop({ kind: 'user', id: actor.id, runtimeId })
  const stopped = await request(waitPath); assert.equal(stopped.status, 409)
  assert.doesNotMatch(await stopped.text(), /http-equiv="refresh"|<form/)
  assert.equal(await processOwner.isAlive(), false); assert.equal(remoteStarts, 1)
  transcript.push('A subsequent explicit stop remains stopped; reopening the observation never wakes it.')
} catch (error) { primaryFailure = error; throw error }
finally {
  Date.now = clockNow; proceed.resolve()
  const cleanup = async fn => { try { await fn() } catch (error) { errors.push(error) } }
  await cleanup(async () => { await pendingStart?.then(response => response.bodyUsed ? undefined : response.arrayBuffer()) })
  if (forwarding !== undefined) await cleanup(() => forwarding.close())
  for (const manager of managers) await cleanup(() => manager.stopAll())
  if (processOwner !== undefined) await cleanup(async () => { await processOwner.terminate(0); assert.equal(await processOwner.isAlive(), false) })
  for (const socket of sockets) socket.destroy()
  for (const server of servers.reverse()) if (server.listening) await cleanup(() => new Promise((done, fail) => {
    server.closeAllConnections?.(); server.close(error => error ? fail(error) : done())
  }))
  for (const db of databases) await cleanup(async () => db.close())
  if (relayFailure !== undefined) errors.push(relayFailure)
  await cleanup(() => rm(root, { recursive: true, force: true }))
  if (errors.length > 0) throw new AggregateError(primaryFailure === undefined ? errors : [primaryFailure, ...errors], 'Start observation fixture cleanup failed')
}
process.stdout.write(transcript.join('\n') + '\n')
