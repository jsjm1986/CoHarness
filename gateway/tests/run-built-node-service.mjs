import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
/** Two ordinary-Node Gateways and the shipped Web Runtime through one outbound node agent. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac, createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createPostgresPool, runMigrations } from '../lib/postgres/database.js'
import { resolvePostgresRuntimeContext } from '../lib/postgres/runtime-context.js'
import { PostgresUserService } from '../lib/postgres/user-service.js'
import { PostgresNodeAccessService } from '../lib/postgres/node-access-service.js'
import { loadConfig } from '../lib/config.js'
import { topologyBrowser } from './fixtures/topology-browser.mjs'
import { computerWorkspaceClient } from './fixtures/computer-workspace-client.mjs'
import {verifyEarlyClose} from './fixtures/node-service-early-close.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(databaseUrl, 'HGW_TEST_DATABASE_URL must select a disposable test database')
const pool = createPostgresPool(databaseUrl, { max: 3 })
const operationsOnly=Boolean(process.env.HGW_TEST_VERSIONED_OPERATIONS)
if(operationsOnly){
  const marker=process.env.HGW_TEST_OWNED_OPERATIONS_DATABASE
  const owned=await pool.query(`SELECT current_database()='hgw_governance_test' AND shobj_description(oid,'pg_database')=$1 AS authorized
    FROM pg_database WHERE datname=current_database()`,[marker??null])
  if(!marker||owned.rows[0]?.authorized!==true){await pool.end();throw new Error('Real execution inputs require the private --operations cluster lifecycle.')}
}
const { InProcessApiClient } = await import(createRequire(new URL('../../packages/host/apiproxy/package.json', import.meta.url))
  .resolve('@deepseek-ai/dsh-host-apiproxy/client'))
await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations', import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'hgw-node-service-built-'))
const slug = `node-service-${randomUUID()}`
const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node service acceptance') RETURNING id", [slug])).rows[0].id
const children = [], transcript = []
let agent, primaryFailure, browserCheck

function ownedChild(file, environment, ipc = true) {
  const child = spawn(process.execPath, [fileURLToPath(file)], { stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    env: { ...process.env, ...environment, NODE_OPTIONS: undefined, NODE_PATH: undefined } })
  const waiting = new Map(), messages = new Map()
  let diagnostics = '', exited
  const closed = new Promise(resolve => { child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited) }) })
  const fail = error => { for (const pending of waiting.values()) pending.reject(error); waiting.clear() }
  child.once('error', fail)
  child.once('close', () => fail(new Error(`Node-service fixture exited before its reply: ${diagnostics}`)))
  child.stderr.on('data', bytes => { diagnostics = `${diagnostics}${bytes}`.slice(-16000) })
  let output = ''
  const receive = value => {
    const kind = value.kind ?? value.status
    if (kind === 'failure' || kind === 'failed') { fail(new Error(`Node-service fixture failure: ${JSON.stringify(value)}`)); return }
    const pending = waiting.get(kind)
    if (pending) { waiting.delete(kind); pending.resolve(value) }
    else messages.set(kind, value)
  }
  child.on('message', receive)
  child.stdout.on('data', bytes => {
    if (ipc) { diagnostics = `${diagnostics}${bytes}`.slice(-16000); return }
    output += bytes.toString()
    let end
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1)
      try { receive(JSON.parse(line)) } catch { diagnostics = `${diagnostics}${line}\n`.slice(-16000) }
    }
  })
  const wait = (kind, timeout = 60000) => {
    if (messages.has(kind)) { const value = messages.get(kind); messages.delete(kind); return Promise.resolve(value) }
    if (exited) return Promise.reject(new Error(`Fixture is already closed: ${diagnostics}`))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(kind); reject(new Error(`Fixture ${kind} deadline: ${diagnostics}`)) }, timeout)
      timer.unref()
      waiting.set(kind, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    })
  }
  const owned = { child, closed, wait, diagnostics: () => diagnostics,
    async command(kind, fields = {}) { const reply = wait(kind === 'stop' ? 'stopped' : kind); child.send({ kind, ...fields }); return reply },
    async stop() {
      const timeout = setTimeout(() => { child.kill('SIGKILL') }, 30000)
      timeout.unref()
      try {
        if (!exited) {
          if (ipc && child.connected) {
            try { await owned.command('stop') } catch { child.kill('SIGTERM') }
          } else child.kill('SIGTERM')
        }
        const result = await closed
        assert.equal(result.signal, null, 'Fixture shutdown must finish without a signal'); assert.equal(result.code, 0, diagnostics)
      }
      finally { clearTimeout(timeout) }
    },
  }
  children.push(owned)
  return owned
}

async function login(base, username, returnTo = '/') {
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
    body: new URLSearchParams({ username, password: 'node-service-fixture-password', returnTo }) })
  assert.equal(response.status, 302); await response.arrayBuffer()
  assert.equal(response.headers.get('location'), returnTo)
  return response.headers.get('set-cookie').split(';')[0]
}

async function uploadDocument(base, cookie, nodeId, name, bytes, diagnostics) {
  const query = `?scope=personal&dshNode=${nodeId}`
  const root = `${base}/api/documents/transfer/uploads`
  const headers = { cookie, origin: base, 'content-type': 'application/json' }
  const hash = createHash('sha256').update(bytes).digest('hex')
  const created = await fetch(`${root}${query}`, { method: 'POST', headers,
    body: JSON.stringify({ version: 1, name, directory: '', bytes: bytes.length, fingerprint: hash }) })
  const createdText = await created.text(); assert.equal(created.status, 200, `${createdText}\n${diagnostics()}`)
  const upload = JSON.parse(createdText)
  const chunk = await fetch(`${root}/${upload.uploadId}/chunks/0${query}`, { method: 'PUT', headers: { ...headers,
    'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'x-dsh-chunk-sha256': hash }, body: bytes })
  assert.equal(chunk.status, 200, await chunk.text())
  const complete = await fetch(`${root}/${upload.uploadId}/complete${query}`, { method: 'POST', headers, body: JSON.stringify({ version: 1, sha256: hash }) })
  let result = await complete.json(); assert.ok(complete.ok, JSON.stringify(result))
  for (let tries = 0; result.state === 'verifying' && tries < 100; tries++) {
    await delay(25)
    const status = await fetch(`${root}/${upload.uploadId}${query}`, { headers }); result = await status.json()
    assert.ok(status.ok, JSON.stringify(result))
  }
  assert.equal(result.state, 'complete', JSON.stringify(result)); return result.ref
}

async function verify(){
  await verifyEarlyClose()
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'center')", [organization])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'center')
  await enableFixtureTopology(context)
  const cfg = loadConfig({ HGW_STATE_ROOT: join(root, 'center/state'), HGW_USERS_ROOT: join(root, 'center/users'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'center/project-runtimes'), HGW_PROJECTS_ROOT: join(root, 'center/projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'center/user-projects'), HGW_DEFAULT_ENV_FILE: '' })
  const users = new PostgresUserService(context, cfg)
  const admin = await users.create({ username: 'center-owner', password: 'node-service-fixture-password', role: 'admin' })
  await users.changeOwnPassword(admin.id, 'node-service-fixture-password')
  const access = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
  const ticket = await access.issue(admin, { name: 'computer-b', requestId: randomUUID() })
  // The existing local Gateway requires an active compute-node registration before startup.
  await pool.query("UPDATE harness.compute_nodes SET status='active' WHERE organization_id=$1 AND id=$2", [organization, ticket.nodeId])
  const entry = new URL('./fixtures/node-service-gateway.mjs', import.meta.url)
  const center = ownedChild(entry, { NODE_SERVICE_FIXTURE_ROOT: join(root, 'center'), NODE_SERVICE_FIXTURE_ORGANIZATION: slug, NODE_SERVICE_FIXTURE_NODE: 'center' })
  const a = await center.wait('ready')
  const node = ownedChild(entry, { NODE_SERVICE_FIXTURE_ROOT: join(root, 'remote'), NODE_SERVICE_FIXTURE_ORGANIZATION: slug, NODE_SERVICE_FIXTURE_NODE: 'computer-b' })
  const b = await node.wait('ready')
  await node.command('origins', { values: [a.base] })
  agent = ownedChild(new URL('../lib/node-agent-main.js', import.meta.url), {
    HGW_NODE_CENTER_URL: a.base, HGW_NODE_AGENT_STATE_FILE: join(root, 'agent/access.json'),
    HGW_NODE_ENROLLMENT_TOKEN: ticket.token, HGW_NODE_LOCAL_GATEWAY_URL: b.base,
  }, false)
  await agent.wait('channel-ready')
  const cookie = await login(a.base, 'remote-owner')
  const directory = await fetch(`${a.base}/account/api/runtimes`, { headers: { cookie } })
  assert.equal(directory.status, 200)
  const environment = (await directory.json()).items.find(item => item.owner.id === b.userId && item.node.id === b.nodeId)
  assert.ok(environment)
  if(operationsOnly){
    const {verifyVersionedNodeService}=await import('./fixtures/versioned-node-service.mjs')
    const localCookie=await login(a.base,'center-owner')
    const localDirectory=await fetch(a.base+'/account/api/runtimes',{headers:{cookie:localCookie}})
    assert.equal(localDirectory.status,200)
    const localEnvironment=(await localDirectory.json()).items.find(item=>item.owner.id===a.userId&&item.node.id===a.nodeId)
    assert.ok(localEnvironment)
    await verifyVersionedNodeService({pool,org:organization,base:a.base,secondary:b.base,
      local:{id:localEnvironment.id,node:a.nodeId,cookie:localCookie},remote:{id:environment.id,node:b.nodeId,cookie},
      count:Number(process.env.HGW_TEST_VERSIONED_OPERATIONS)})
    return
  }
  transcript.push('One center login discovers the account runtime on computer B.')
  const address = `/?dshRuntime=${environment.id}`
  const anonymous = await fetch(`${a.base}${address}`, { redirect: 'manual', headers: { accept: 'text/html' } })
  assert.equal(anonymous.status, 302)
  assert.equal(anonymous.headers.get('location'), `/login?returnTo=${encodeURIComponent(address)}`)
  await anonymous.arrayBuffer()
  await login(a.base, 'remote-owner', address)
  transcript.push('Signing in from an exact environment link preserves that tab’s destination without changing other tabs.')
  const selected = await fetch(`${a.base}/account/api/scope`, { method: 'POST',
    headers: { cookie, origin: a.base, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'personal' }) })
  assert.equal(selected.status, 204, `${await selected.text()}\nCenter: ${center.diagnostics()}\nNode: ${node.diagnostics()}`)
  assert.equal(selected.headers.get('set-cookie'), null)
  assert.equal(selected.headers.get('location'), `/?dshRuntime=${environment.id}`)
  assert.equal((await center.command('status')).resident, 0)
  transcript.push('The existing personal-space switch reaches computer B without starting a center runtime.')
  const browserPage = await fetch(`${a.base}${address}`, { headers: { cookie } })
  assert.equal(browserPage.status, 200)
  const browserHtml = await browserPage.text()
  assert.match(browserHtml, /"generationReadyTimeoutMs"\s*:\s*120000/u)
  assert.match(browserHtml, /"streamOpenTimeoutMs"\s*:\s*60000/u)
  assert.match(browserHtml, /__DSH_CONNECTION_RPC_TIMEOUT_MS__[\s\S]{0,8}120000/u)
  const bootstrapScripts = [...browserHtml.matchAll(/<script[^>]*src="([^"]+)"/gu)].map(match => match[1].replaceAll('&amp;', '&'))
  assert.ok(bootstrapScripts.some(path => path.startsWith('plugins/combo.js?')))
  for (const path of bootstrapScripts) {
    const script = await fetch(new URL(path, a.base), { headers: { cookie, referer: `${a.base}${address}` } })
    assert.equal(script.status, 200, `Initial browser script unavailable: ${path}`)
    assert.equal(new URL(script.url).searchParams.get('dshRuntime'), environment.id)
    assert.match(script.headers.get('content-type') ?? '', /javascript/u)
    assert.ok((await script.arrayBuffer()).byteLength > 0)
  }
  const channelReader = await pool.connect()
  try {
    await channelReader.query('BEGIN')
    await channelReader.query('SELECT node_id FROM harness.node_agents WHERE node_id=$1 FOR SHARE', [b.nodeId])
    const contexts = await Promise.all([1, 2].map(async () => {
      const response = await fetch(`${a.base}/account/api/context?dshRuntime=${environment.id}`, {
        headers: { cookie }, signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
      })
      assert.equal(response.status, 200, await response.clone().text())
      return response.json()
    }))
    for (const context of contexts) assert.equal(context.environment.id, environment.id)
    assert.equal((await center.command('status')).resident, 0)
  } finally {
    try { await channelReader.query('ROLLBACK') } finally { channelReader.release() }
  }
  transcript.push('Concurrent authorized browser reads share node access without launching another Runtime.')
  const createdProject = await fetch(`${a.base}/account/api/projects?dshNode=${b.nodeId}`, { method: 'POST',
    headers: { cookie, origin: a.base, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Managed project directory' }) })
  assert.equal(createdProject.status, 201, await createdProject.clone().text())
  const managedProject = await createdProject.json()
  const beforeProjectDocuments = (await node.command('status')).resident
  const directoryOrigin = await node.command('directory-policy', { systemd: true, projectId: managedProject.id })
  assert.equal(directoryOrigin.origin, 'user')
  try {
    const documents = await fetch(`${a.base}/api/documents/scope?scope=project:${managedProject.id}&dshNode=${b.nodeId}`, { headers: { cookie } })
    assert.equal(documents.status, 200, await documents.clone().text())
    await documents.arrayBuffer()
    assert.equal((await node.command('status')).resident, beforeProjectDocuments)
  } finally { await node.command('directory-policy', { systemd: false, projectId: managedProject.id }) }
  const removedProject = await fetch(`${a.base}/admin/api/projects/${managedProject.id}?dshNode=${b.nodeId}`, {
    method: 'DELETE', headers: { cookie, origin: a.base },
  })
  const removalText = await removedProject.text()
  if (removedProject.status === 409) assert.equal(JSON.parse(removalText).error, 'node-service/cancelled')
  else assert.equal(removedProject.status, 204, removalText)
  const retainedProject = await pool.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [organization, managedProject.id])
  assert.equal(retainedProject.rowCount, 0, 'An interrupted response cannot prove that project removal committed')
  transcript.push('User-created project documents retain their stored origin under Linux directory policy without starting a Runtime.')
  const adminResponse = await fetch(`${a.base}/admin/api/users?dshNode=${b.nodeId}`, { headers: { cookie } })
  const adminBody = await adminResponse.text()
  assert.equal(adminResponse.status, 200, `${adminBody}\nCenter: ${center.diagnostics()}\nNode: ${node.diagnostics()}`)
  assert.equal(adminResponse.headers.get('x-dsh-target-node'), b.nodeId)
  assert.ok(JSON.parse(adminBody).some(user => user.username === 'remote-owner'))
  transcript.push('The existing Admin user API runs on the explicitly selected computer.')
  const centralAdminCookie = await login(a.base, 'center-owner')
  const crossAdmin = await fetch(`${a.base}/admin/api/users?dshNode=${b.nodeId}`, { headers: { cookie: centralAdminCookie } })
  assert.equal(crossAdmin.status, 200, `${await crossAdmin.text()}\nNode: ${node.diagnostics()}`)
  assert.equal((await center.command('status')).resident, 0)
  transcript.push('Organization administration on B does not require a personal runtime on B.')
  const exactAdmin = await fetch(`${a.base}/admin/api/users?dshRuntime=${environment.id}`, { headers: { cookie: centralAdminCookie } })
  assert.equal(exactAdmin.status, 200, `${await exactAdmin.text()}\nNode: ${node.diagnostics()}`)
  assert.equal(exactAdmin.headers.get('x-dsh-target-node'), b.nodeId)
  assert.equal((await center.command('status')).resident, 0)
  transcript.push("The administrator selects another user's exact runtime without borrowing its personal access.")
  const deadline = performance.now() + 60000
  let description
  while (performance.now() < deadline) {
    const response = await fetch(`${a.base}/api/host.describe?dshTarget=personal`, { method: 'POST',
      headers: { cookie, origin: a.base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }) })
    const value = await response.json()
    if (response.status === 200) { description = value; break }
    assert.equal(response.status, 503, JSON.stringify(value))
    await delay(25)
  }
  assert.equal(description?.result?.ok, true, `The real Web profile must answer host.describe: ${node.diagnostics()}`)
  assert.equal(description.result.value.runtimeTarget.kind, 'personal')
  assert.equal((await center.command('status')).resident, 0)
  assert.equal((await node.command('status')).resident, 1)
  transcript.push('The shipped Web profile starts on computer B; the center starts no local runtime.')
  const workbench = await fetch(`${a.base}/`, { headers: { cookie } })
  assert.equal(workbench.status, 200); assert.match(workbench.headers.get('content-type'), /text\/html/u)
  assert.match(await workbench.text(), /<html/u)
  transcript.push('Existing workbench HTML and owner selectors resolve to the actual computer.')
  const events = new WebSocket(`${a.base.replace('http:', 'ws:')}/api/events.host?dshTarget=personal`,
    { headers: { cookie, origin: a.base } })
  const eventsClosed = new Promise(resolve => { events.once('close', resolve) })
  const eventRequest = new AbortController()
  let workspaceRequest = Promise.resolve()
  try {
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('The existing Runtime event stream did not deliver the workspace change')) }, 10000)
      timer.unref()
      events.once('error', error => { clearTimeout(timer); reject(error) })
      events.once('message', bytes => { clearTimeout(timer); resolve(JSON.parse(bytes.toString())) })
      events.once('close', () => { clearTimeout(timer); reject(new Error('The Runtime event stream closed before its workspace change')) })
      events.once('open', () => {
        workspaceRequest = fetch(`${a.base}/api/workspace.create?dshTarget=personal`, { method: 'POST', signal: eventRequest.signal,
          headers: { cookie, origin: a.base, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace.create', payload: { path: description.result.value.cwd } }),
        }).then(async response => {
          assert.equal(response.status, 200)
          assert.equal((await response.json()).result.ok, true)
        }).catch(reject)
      })
    })
    await workspaceRequest
    assert.equal(frame.type, 'server-request')
    assert.equal(frame.payload.type, 'host/workspace-changed')
  } finally { eventRequest.abort(); events.terminate(); await Promise.allSettled([eventsClosed, workspaceRequest]) }
  transcript.push('The existing runtime event stream reaches the browser through the center.')
  const runtimeCall = async (method, payload) => {
    const response = await fetch(`${a.base}/api/${method}?dshRuntime=${environment.id}`, { method: 'POST',
      headers: { cookie, origin: a.base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const desktopSession = await runtimeCall('session.create', { cwd: description.result.value.cwd, sessionId: 'node-desktop-availability' })
  assert.ok(['headless', 'disabled'].includes(description.result.value.computerUseUnavailableReason),
    `Host summary must report a missing desktop driver: ${JSON.stringify(description.result.value)}`)
  const discoveryClient = new InProcessApiClient({ fetch: (input, init) => {
    const requested = new URL(input)
    const selected = new URL(requested.pathname + requested.search, a.base)
    selected.searchParams.set('dshRuntime', environment.id)
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie); headers.set('origin', a.base)
    return fetch(selected, { ...init, headers })
  } })
  const typedDescription = await discoveryClient.host.describe({})
  assert.equal(typedDescription.result.ok, true)
  assert.equal(typedDescription.result.value.computerUseUnavailableReason, description.result.value.computerUseUnavailableReason,
    'Typed Host discovery must retain the known desktop limitation')
  transcript.push('Typed Host discovery preserves the desktop limitation through response decoding.')
  assert.equal(desktopSession.result.ok, true, JSON.stringify(desktopSession))
  const desktopSessionId = desktopSession.result.value.sessionId
  const noDesktop = await runtimeCall('desktop.status', { sessionId: desktopSessionId })
  assert.equal(noDesktop.result.ok, true, JSON.stringify(noDesktop))
  assert.ok(['headless', 'disabled'].includes(noDesktop.result.value?.unavailableReason),
    `A runtime without a desktop driver must return a known unavailable reason: ${JSON.stringify(noDesktop)}`)
  assert.equal(noDesktop.result.value.unavailableReason, description.result.value.computerUseUnavailableReason)
  const consent = await runtimeCall('desktop.confirm', { sessionId: desktopSessionId, rootSessionId: desktopSessionId,
    nodeId: b.nodeId, desktop: 'not-configured', confirmed: true })
  assert.equal(consent.result.ok, false)
  assert.equal(consent.result.error.code, 'desktop-unavailable')
  assert.equal(consent.result.error.details.reason, noDesktop.result.value.unavailableReason)
  assert.equal((await center.command('status')).resident, 0)
  assert.equal((await node.command('status')).resident, 1)
  transcript.push('Without a desktop driver, environment status explains unavailability and refuses consent without launching desktop effects.')
  const adminRequest = (path, payload) => fetch(`${a.base}${path}`, { method: 'POST',
    headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const requestId = randomUUID()
  const allocationResponse = await adminRequest(`/admin/api/users/${b.userId}/runtimes?dshNode=${b.nodeId}`, { requestId })
  const allocated = await allocationResponse.json()
  assert.equal(allocationResponse.status, 201, JSON.stringify(allocated))
  assert.equal(allocated.nodeId, b.nodeId); assert.equal(allocated.status, 'allocated'); assert.notEqual(allocated.runtimeId, environment.id)
  const recovered = await adminRequest(`/admin/api/users/${b.userId}/runtimes?dshNode=${b.nodeId}`, { requestId })
  assert.equal(recovered.status, 201); assert.deepEqual(await recovered.json(), allocated)
  const ownerPage = await fetch(`${a.base}/admin/api/users/${b.userId}/runtimes`, { headers: { cookie: centralAdminCookie } })
  assert.equal(ownerPage.status, 200); assert.equal((await ownerPage.json()).items.length, 2)
  const ambiguous = await fetch(`${a.base}/api/host.describe?dshTarget=personal`, { headers: { cookie } })
  assert.equal(ambiguous.status, 409); await ambiguous.arrayBuffer()
  transcript.push('Admin allocates a second private runtime on B; retries retain its identity and owner selectors require a choice.')
  await node.command('relay', { runtimeId: allocated.runtimeId })
  const startedResponse = await adminRequest(`/admin/api/runtimes/${allocated.runtimeId}/start`, {})
  const started = await startedResponse.json()
  assert.equal(startedResponse.status, 200, `${JSON.stringify(started)}\nNode: ${node.diagnostics()}`)
  assert.equal((await node.command('status')).resident, 2); assert.equal((await center.command('status')).resident, 0)
  const selectedContext = await fetch(`${a.base}/account/api/context?dshRuntime=${allocated.runtimeId}`, { headers: { cookie } })
  assert.equal(selectedContext.status, 200, `${await selectedContext.clone().text()}\nNode: ${node.diagnostics()}`)
  assert.deepEqual((await selectedContext.json()).environment, { id: allocated.runtimeId, nodeId: b.nodeId, nodeName: 'computer-b' })
  transcript.push('Two independent Web runtime processes for one account coexist on B and report the selected environment.')
  const preferences = await fetch(`${a.base}/account/api/preferences`, { headers: { cookie } })
  assert.equal(preferences.status, 501); await preferences.arrayBuffer()
  const projects = await fetch(`${a.base}/account/api/projects`, { headers: { cookie } })
  assert.equal(projects.status, 200); await projects.arrayBuffer()
  const selectedWorkbench = await fetch(`${a.base}/account/api/workbench/catalog?dshRuntime=${allocated.runtimeId}`, { headers: { cookie } })
  assert.equal(selectedWorkbench.status, 200)
  assert.deepEqual((await selectedWorkbench.json()).environment, { id: allocated.runtimeId, nodeId: b.nodeId, nodeName: 'computer-b' })
  const icon = await fetch(`${a.base}/favicon.svg`, { headers: { cookie, referer: `${a.base}/?dshRuntime=${allocated.runtimeId}` } })
  assert.equal(icon.status, 200); assert.match(icon.headers.get('content-type'), /image\/svg\+xml/u)
  assert.match(await icon.text(), /<svg/u)
  transcript.push('Account metadata and the remote workbench remain accessible; the browser icon follows its own tab.')
  const policyHomes = [join(root, 'remote/users/remote-owner/dsh'), join(root, 'remote/users/remote-owner/runtimes', allocated.runtimeId, 'dsh')]
  const policies = await Promise.all(policyHomes.map(async home => JSON.parse(await readFile(join(home, 'model-governance.json'), 'utf8'))))
  assert.ok(policies[0].intakeToken !== policies[1].intakeToken, 'Independent Runtimes must not rotate one shared reporting credential')
  const usageIds = []
  for (const policy of policies) {
    const eventId = randomUUID(); usageIds.push(eventId)
    const response = await fetch(policy.intakeUrl, { method: 'POST',
      headers: { authorization: `Bearer ${policy.intakeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, occurredAt: Date.now(), provider: 'fixture', model: 'reply', purpose: 'chat', sessionId: 'node-service-reporting',
        credentialSource: 'organization', credentialClass: 'company', status: 'succeeded', usage: { inputTokens: 1, outputTokens: 2 } }) })
    assert.equal(response.status, 200, await response.text())
  }
  const usage = (await pool.query(`SELECT count(*)::integer calls,count(DISTINCT user_id)::integer accounts,
    sum(input_tokens+output_tokens)::integer tokens FROM harness.model_usage WHERE organization_id=$1 AND event_id=ANY($2::text[])`, [organization, usageIds])).rows[0]
  assert.deepEqual(usage, { calls: 2, accounts: 1, tokens: 6 })
  transcript.push('Both live runtimes retain independent reporting credentials and contribute to the same account usage ledger.')
  const hookResponse = await adminRequest(`/admin/api/webhook-endpoints?dshRuntime=${allocated.runtimeId}`, {
    name: 'Exact Runtime hook', provider: 'github', source: 'fixture', events: ['push'], actions: [], repositories: [],
    titleTemplate: 'Fixture event', promptTemplate: 'Fixture prompt', workspacePath: description.result.value.cwd,
    agentPreset: 'default', permissionPreset: 'default', executionUserId: b.userId, runtimeKind: 'user', runtimePublicId: b.userId,
    runtimeId: allocated.runtimeId, intakeLimit: 10, intakeWindowMs: 60000, replayWindowMs: 60000, maxBodyBytes: 4096, secret: 'node-service-hook-secret',
  })
  const hook = await hookResponse.json()
  assert.equal(hookResponse.status, 200, JSON.stringify(hook))
  const enabled = await adminRequest(`/admin/api/webhook-endpoints/mutate?dshRuntime=${allocated.runtimeId}`, { targetId: hook.publicId, revision: hook.revision, action: 'enable' })
  assert.equal(enabled.status, 200, await enabled.text())
  const payload = JSON.stringify({ action: 'opened' })
  const hookHeaders = { 'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-github-event': 'pull_request',
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'node-service-hook-secret').update(payload).digest('hex')}` }
  const delivery = await fetch(`${a.base}/webhook/${hook.publicId}`, { method: 'POST', headers: hookHeaders, body: payload })
  assert.equal(delivery.status, 202, `${await delivery.text()}\nCenter: ${center.diagnostics()}\nNode: ${node.diagnostics()}`)
  const receipt = (await pool.query('SELECT runtime_id,node_id,state FROM harness.webhook_delivery_receipts WHERE organization_id=$1 AND endpoint_id=$2', [organization, hook.id])).rows
  assert.deepEqual(receipt, [{ runtime_id: allocated.runtimeId, node_id: b.nodeId, state: 'ignored' }])
  const invalidHook = await fetch(`${a.base}/webhook/${hook.publicId}`, { method: 'POST', headers: { ...hookHeaders, 'x-github-delivery': randomUUID() }, body: '{}' })
  assert.equal(invalidHook.status, 401); await invalidHook.arrayBuffer()
  transcript.push('Public webhook ingress reaches its exact runtime computer; B verifies the original signature and records the identity.')
  const staleStop = await adminRequest(`/admin/api/runtimes/${allocated.runtimeId}/stop`, { generation: started.generation + 1 })
  assert.equal(staleStop.status, 409); await staleStop.arrayBuffer(); assert.equal((await node.command('status')).resident, 2)
  const stopResponse = await adminRequest(`/admin/api/runtimes/${allocated.runtimeId}/stop`, { generation: started.generation })
  assert.equal(stopResponse.status, 200, await stopResponse.text()); assert.equal((await node.command('status')).resident, 1)
  const restartResponse = await adminRequest(`/admin/api/runtimes/${allocated.runtimeId}/restart`, { generation: started.generation })
  const restarted = await restartResponse.json()
  assert.equal(restartResponse.status, 200, `${JSON.stringify(restarted)}\nNode: ${node.diagnostics()}`)
  assert.ok(restarted.generation > started.generation); assert.equal((await node.command('status')).resident, 2)
  const retireResponse = await adminRequest(`/admin/api/runtimes/${allocated.runtimeId}/retire`, { generation: restarted.generation })
  assert.equal(retireResponse.status, 200, await retireResponse.text()); assert.equal((await node.command('status')).resident, 1)
  const allocationReceipt = await fetch(`${a.base}/admin/api/runtime-allocations/${requestId}`, { headers: { cookie: centralAdminCookie } })
  assert.equal(allocationReceipt.status, 200); assert.equal((await allocationReceipt.json()).status, 'retired')
  await readFile(join(root, 'remote/users/remote-owner/runtimes', allocated.runtimeId, 'dsh/managed-data.jsonl'), 'utf8')
  const controls = await pool.query(`SELECT action FROM harness.audit_events WHERE organization_id=$1 AND detail->'detail'->>'runtimeId'=$2
    AND action IN ('admin.instances.start','admin.instances.stop','admin.instances.restart') ORDER BY action`, [organization, allocated.runtimeId])
  assert.deepEqual(controls.rows.map(row => row.action), ['admin.instances.restart', 'admin.instances.start', 'admin.instances.stop'])
  transcript.push('Generation-checked stop, restart and retirement affect only the selected runtime and retain its data and receipt.')
  const remoteAccount = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, b.userId])).rows[0].id
  await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)
    ON CONFLICT(organization_id,node_id,user_id) DO UPDATE SET enabled=true`, [organization, a.nodeId, remoteAccount])
  const missingHome = await fetch(`${a.base}/api/documents/scope?scope=personal&dshNode=${a.nodeId}`, { headers: { cookie, origin: a.base } })
  assert.equal(missingHome.status, 403, await missingHome.text())
  transcript.push('Computer permission alone cannot borrow another computer’s personal home.')
  const localAllocation = await adminRequest(`/admin/api/users/${b.userId}/runtimes?dshNode=${a.nodeId}`, { requestId: randomUUID() })
  const localReceipt = await localAllocation.json(); assert.equal(localAllocation.status, 201, JSON.stringify(localReceipt))
  const defaultLoginCookie = await login(a.base, 'remote-owner')
  const defaultLanding = await fetch(`${a.base}/`, { headers: { cookie: defaultLoginCookie }, redirect: 'manual' })
  assert.equal(defaultLanding.status, 302, await defaultLanding.clone().text())
  assert.equal(defaultLanding.headers.get('location'), `/?dshRuntime=${localReceipt.runtimeId}`)
  assert.equal(defaultLanding.headers.get('set-cookie'), null)
  await defaultLanding.arrayBuffer()
  assert.equal((await center.command('status')).resident, 0)
  assert.equal((await node.command('status')).resident, 1)
  await center.command('relay', { runtimeId: localReceipt.runtimeId, userId: b.userId })
  const defaultStart = await adminRequest(`/admin/api/runtimes/${localReceipt.runtimeId}/start`, {})
  const defaultStarted = await defaultStart.json()
  assert.equal(defaultStart.status, 200, JSON.stringify(defaultStarted))
  const defaultWorkbench = await fetch(`${a.base}/?dshRuntime=${localReceipt.runtimeId}`, { headers: { cookie: defaultLoginCookie } })
  assert.equal(defaultWorkbench.status, 200)
  assert.match(await defaultWorkbench.text(), /<script[^>]*type="module"/u)
  const retainedWorkbench = await fetch(`${a.base}${address}`, { headers: { cookie } })
  assert.equal(retainedWorkbench.status, 200); await retainedWorkbench.arrayBuffer()
  assert.equal((await center.command('status')).resident, 1)
  const defaultStop = await adminRequest(`/admin/api/runtimes/${localReceipt.runtimeId}/stop`, { generation: defaultStarted.generation })
  assert.equal(defaultStop.status, 200, await defaultStop.text())
  assert.equal((await center.command('status')).resident, 0)
  assert.equal((await node.command('status')).resident, 1)
  transcript.push('Normal login opens the original Harness workbench with its authorized local personal default; exact links and other runtimes stay unchanged.')
  const browserHeaders = { cookie, origin: a.base, 'content-type': 'application/json' }
  const locationsResponse = await fetch(`${a.base}/account/api/document-locations`, { headers: browserHeaders })
  const locations = await locationsResponse.json(); assert.equal(locationsResponse.status, 200, JSON.stringify(locations))
  assert.deepEqual(new Set(locations.items.filter(item => item.scope.kind === 'personal').map(item => item.scope.nodeId)), new Set([a.nodeId, b.nodeId]))
  const bytes = Buffer.from('computer B document snapshot')
  const original = await uploadDocument(a.base, cookie, b.nodeId, 'computer-b.txt', bytes, () => `${center.diagnostics()}\n${node.diagnostics()}`)
  const folderResponse = await fetch(`${a.base}/account/api/documents/transfer/directories/create`, { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ version: 1, scope: { kind: 'personal', nodeId: a.nodeId }, directory: '', name: 'copied-documents' }) })
  const folder = await folderResponse.json(); assert.equal(folderResponse.status, 200, JSON.stringify(folder)); assert.equal(folder.name, 'copied-documents')
  const directoriesResponse = await fetch(`${a.base}/account/api/documents/transfer/directories`, { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ version: 1, scope: { kind: 'personal', nodeId: a.nodeId } }) })
  const folders = await directoriesResponse.json(); assert.equal(directoriesResponse.status, 200, JSON.stringify(folders)); assert.ok(folders.directories.some(item => item.directoryId === folder.directoryId))
  const request = { version: 1, source: { kind: 'personal', nodeId: b.nodeId }, target: { kind: 'personal', nodeId: a.nodeId }, directory: folder.directoryId, documents: [{ docId: original.docId }] }
  const planResponse = await fetch(`${a.base}/account/api/documents/transfer/plan`, { method: 'POST', headers: browserHeaders, body: JSON.stringify(request) })
  const plan = await planResponse.json(); assert.equal(planResponse.status, 200, JSON.stringify(plan))
  const copiedResponse = await fetch(`${a.base}/account/api/documents/transfer/commit`, { method: 'POST', headers: browserHeaders, body: JSON.stringify({ ...request, planId: plan.planId }) })
  const copied = await copiedResponse.json(); assert.equal(copiedResponse.status, 200, JSON.stringify(copied)); assert.equal(copied.items[0].status, 'copied', JSON.stringify(copied))
  const content = await fetch(`${a.base}/api/documents/scope/content?scope=personal&dshNode=${a.nodeId}&id=${encodeURIComponent(copied.items[0].target.docId)}`, { headers: browserHeaders })
  assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes)
  const overviewResponse = await fetch(`${a.base}/account/api/documents/overview`, { headers: browserHeaders })
  const overview = await overviewResponse.json(); assert.equal(overviewResponse.status, 200, JSON.stringify(overview));
  assert.deepEqual(new Set(overview.documents.map(document => document.scope.nodeId)), new Set([a.nodeId, b.nodeId]))
  const sourceCatalog = overview.documents.find(document => document.scope.nodeId === b.nodeId)
  const targetCatalog = overview.documents.find(document => document.scope.nodeId === a.nodeId)
  assert.equal(targetCatalog.lineageRootId, sourceCatalog.catalogId, JSON.stringify(overview))
  const nestedPlan = await fetch(`${a.base}/account/api/documents/transfer/plan`, { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ version: 1, source: { kind: 'personal', nodeId: a.nodeId }, target: { kind: 'personal', nodeId: b.nodeId }, documents: [{ docId: copied.items[0].target.docId }] }) })
  const nested = await nestedPlan.json(); assert.equal(nestedPlan.status, 200, JSON.stringify(nested)); assert.equal(nested.documents[0].name, original.name)

  assert.equal((await center.command('status')).resident, 0)
  transcript.push('Documents retain computer ownership; a planned verified snapshot copies through the center without starting a Runtime.')
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organization, a.nodeId, remoteAccount])
  const revokedDocument = await fetch(`${a.base}/api/documents/scope/content?scope=personal&dshNode=${a.nodeId}&id=${encodeURIComponent(copied.items[0].target.docId)}`, { headers: browserHeaders })
  assert.equal(revokedDocument.status, 403); await revokedDocument.arrayBuffer()
  const visibleOverview = await fetch(`${a.base}/account/api/documents/overview`, { headers: browserHeaders })
  assert.deepEqual(new Set((await visibleOverview.json()).documents.map(document => document.scope.nodeId)), new Set([b.nodeId]))
  transcript.push('Revoking computer access hides its document metadata and denies direct content without retargeting the active Runtime.')
  if (process.env.DSH_UI_REVIEW_FILE !== undefined) {
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organization, a.nodeId, remoteAccount])
    await center.command('relay', { runtimeId: localReceipt.runtimeId, userId: b.userId })
    const startLocal = await adminRequest(`/admin/api/runtimes/${localReceipt.runtimeId}/start`, {})
    const localStarted = await startLocal.json(); assert.equal(startLocal.status, 200, JSON.stringify(localStarted))
    const additional = await adminRequest(`/admin/api/users/${b.userId}/runtimes?dshNode=${b.nodeId}`, { requestId: randomUUID() })
    const additionalRuntime = await additional.json(); assert.equal(additional.status, 201, JSON.stringify(additionalRuntime))
    await node.command('relay', { runtimeId: additionalRuntime.runtimeId, userId: b.userId })
    await writeFile(process.env.DSH_UI_REVIEW_FILE, JSON.stringify({ base: a.base, runtimeA: localReceipt.runtimeId, runtimeB: environment.id,
      runtimeB2: additionalRuntime.runtimeId, nodeA: a.nodeId, nodeB: b.nodeId, username: 'remote-owner', userId: b.userId, root }))
    console.log('UI_REVIEW_READY')
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
    const localStopped = await adminRequest(`/admin/api/runtimes/${localReceipt.runtimeId}/stop`, { generation: localStarted.generation })
    assert.equal(localStopped.status, 200, await localStopped.text())
  }
  const previousGeneration = (await pool.query('SELECT generation::text FROM harness.instances WHERE runtime_id=$1', [environment.id])).rows[0].generation
  assert.ok((await node.command('credential-status', { runtimeId: environment.id })).issued.some(value => String(value.generation) === previousGeneration && value.accepted))
  await agent.stop()
  const unavailable = await fetch(`${a.base}/api/host.describe?dshRuntime=${environment.id}`, { headers: { cookie } })
  assert.equal(unavailable.status, 503); await unavailable.arrayBuffer()
  assert.equal((await center.command('status')).resident, 0)
  transcript.push('A disconnected computer returns unavailable without starting a replacement on the center.')
  for (const path of ['/admin/api/models', `/admin/api/quotas?subjectType=user&subjectId=${b.userId}`]) {
    const shared = await fetch(`${a.base}${path}`, { headers: { cookie: centralAdminCookie } })
    assert.equal(shared.status, 200, await shared.text())
  }
  transcript.push('Organization model and quota management remain available while the execution computer is disconnected.')
  agent = ownedChild(new URL('../lib/node-agent-main.js', import.meta.url), {
    HGW_NODE_CENTER_URL: a.base, HGW_NODE_AGENT_STATE_FILE: join(root, 'agent/access.json'),
    HGW_NODE_LOCAL_GATEWAY_URL: b.base,
  }, false)
  await agent.wait('channel-ready')
  const stale = await fetch(`${a.base}/api/host.describe?dshRuntime=${environment.id}`, { method: 'POST',
    headers: { cookie, origin: a.base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }) })
  assert.equal(stale.status, 200, `${await stale.clone().text()}\nNode: ${node.diagnostics()}`)
  assert.equal((await stale.json()).result?.ok, true)
  const leaseRecoveredAssignment = (await pool.query('SELECT runtime_id,generation::text FROM harness.instances WHERE runtime_id=$1', [environment.id])).rows[0]
  assert.equal(leaseRecoveredAssignment.runtime_id, environment.id)
  assert.ok(BigInt(leaseRecoveredAssignment.generation) > BigInt(previousGeneration))
  const credentialStatus = (await node.command('credential-status', { runtimeId: environment.id })).issued
  assert.equal(credentialStatus.find(value => String(value.generation) === previousGeneration)?.accepted, false)
  assert.equal(credentialStatus.find(value => String(value.generation) === leaseRecoveredAssignment.generation)?.accepted, true)
  assert.equal((await center.command('status')).resident, 0)
  transcript.push('A renewed node connection rejects old credentials and resumes the same Runtime only after confirmed stop in a fresh generation.')
  const entryPolicy = async (base, session) => {
    const result = await fetch(`${base}/account/api/deployment/context`, { headers: { cookie: session } })
    assert.equal(result.status, 200, await result.clone().text()); return result.json()
  }
  assert.equal((await entryPolicy(a.base, centralAdminCookie)).scope, 'organization')
  const secondaryCookie = await login(b.base, 'remote-owner')
  const secondaryLanding = await fetch(`${b.base}/`, { headers: { cookie: secondaryCookie }, redirect: 'manual' })
  assert.equal(secondaryLanding.status, 302)
  assert.equal(secondaryLanding.headers.get('location'), `/?dshRuntime=${environment.id}`)
  await secondaryLanding.arrayBuffer()
  assert.deepEqual(((value) => [value.mode, value.scope, value.entry.nodeId])(await entryPolicy(b.base, secondaryCookie)), ['multi', 'local', b.nodeId])
  const reverse = await fetch(`${b.base}/admin/api/users?dshNode=${a.nodeId}`, { headers: { cookie: secondaryCookie } })
  assert.equal(reverse.status, 409, await reverse.text())
  const localCatalog = await fetch(`${b.base}/admin/api/runtimes`, { headers: { cookie: secondaryCookie } })
  assert.ok((await localCatalog.json()).items.every(item => item.node.id === b.nodeId))
  transcript.push('Entry-owned policy keeps direct secondary access local and rejects reverse computer selection.')

  const allAtPrimary = await fetch(`${a.base}/admin/api/runtimes`, { headers: { cookie: centralAdminCookie } })
  const localEnvironment = (await allAtPrimary.json()).items.find(item => item.node.id === a.nodeId && item.owner.kind === 'personal' && item.owner.id === a.userId)
  assert.ok(localEnvironment)
  const startedPrimary = await adminRequest(`/admin/api/runtimes/${localEnvironment.id}/start`, {})
  assert.equal(startedPrimary.status, 200, await startedPrimary.clone().text()); await startedPrimary.arrayBuffer()
  const primaryPage = await fetch(`${a.base}/?dshRuntime=${localEnvironment.id}`, { headers: { cookie: centralAdminCookie } })
  assert.equal(primaryPage.status, 200)
  const primaryHtml = await primaryPage.text()
  assert.match(primaryHtml, /"generationReadyTimeoutMs"\s*:\s*15000/u)
  assert.match(primaryHtml, /"streamOpenTimeoutMs"\s*:\s*3000/u)
  assert.match(primaryHtml, /__DSH_CONNECTION_RPC_TIMEOUT_MS__[\s\S]{0,8}30000/u)
  transcript.push('Browser recovery deadlines follow computer B’s configuration while primary-local defaults remain unchanged.')
  const stoppedRemote = await adminRequest(`/admin/api/runtimes/${environment.id}/stop`, { generation: Number((await pool.query('SELECT generation FROM harness.instances WHERE runtime_id=$1', [environment.id])).rows[0].generation) })
  assert.equal(stoppedRemote.status, 200, await stoppedRemote.text())
  const startedRemote = await adminRequest(`/admin/api/runtimes/${environment.id}/start`, {})
  assert.equal(startedRemote.status, 200, await startedRemote.clone().text()); await startedRemote.arrayBuffer()
  const describePrimary = await fetch(`${a.base}/api/host.describe?dshRuntime=${localEnvironment.id}`, { method: 'POST', headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }) })
  const primaryDescription = await describePrimary.json(); assert.equal(primaryDescription.result?.ok, true)
  assert.equal(primaryDescription.result.value.executionAuthorityRequired, true, 'Managed Runtime must advertise execution authority')
  const workspacePrimary = await fetch(`${a.base}/api/workspace.create?dshRuntime=${localEnvironment.id}`, { method: 'POST', headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace.create', payload: { path: primaryDescription.result.value.cwd } }) })
  assert.equal(workspacePrimary.status, 200, await workspacePrimary.clone().text())
  const primaryWorkspace = (await workspacePrimary.json()).result.value.workspace
  const grantUnified = await fetch(`${a.base}/admin/api/users/${a.userId}/computers/${b.nodeId}`, {
    method: 'PUT', headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, revision: '0' }),
  })
  assert.equal(grantUnified.status, 200, await grantUnified.clone().text()); await grantUnified.arrayBuffer()
  const unifiedAllocation = await adminRequest(`/admin/api/users/${a.userId}/runtimes?dshNode=${b.nodeId}`, { requestId: randomUUID() })
  assert.equal(unifiedAllocation.status, 201, await unifiedAllocation.clone().text())
  const unifiedRuntime = (await unifiedAllocation.json()).runtimeId
  await node.command('relay', { runtimeId: unifiedRuntime, userId: a.userId })
  const unifiedStart = await adminRequest(`/admin/api/runtimes/${unifiedRuntime}/start`, {})
  assert.equal(unifiedStart.status, 200, await unifiedStart.clone().text()); await unifiedStart.arrayBuffer()
  const unifiedHeaders = { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' }
  const unifiedDescribe = await fetch(`${a.base}/api/host.describe?dshRuntime=${unifiedRuntime}`, { method: 'POST', headers: unifiedHeaders,
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }) })
  const unifiedDescription = await unifiedDescribe.json(); assert.equal(unifiedDescription.result?.ok, true)
  const unifiedCreate = await fetch(`${a.base}/api/workspace.create?dshRuntime=${unifiedRuntime}`, { method: 'POST', headers: unifiedHeaders,
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace.create', payload: { path: unifiedDescription.result.value.cwd } }) })
  const unifiedWorkspace = await unifiedCreate.json(); assert.equal(unifiedWorkspace.result?.ok, true)
  const directoryDeadline = Date.now() + 20000
  for (;;) {
    const response = await fetch(`${a.base}/account/api/workbench/catalog?dshRuntime=${localEnvironment.id}`, { headers: { cookie: centralAdminCookie } })
    assert.equal(response.status, 200, await response.clone().text())
    const directory = await response.json()
    if (directory.personalWorkspaces?.some(group => group.runtime.runtimeId === unifiedRuntime && group.items.length > 0)) break
    assert.ok(Date.now() < directoryDeadline, 'Runtime must publish its Workspace metadata before it stops')
    await delay(100)
  }
  const unifiedState = async () => (await pool.query('SELECT observed_state AS state,generation FROM harness.instances WHERE runtime_id=$1', [unifiedRuntime])).rows[0]
  await computerWorkspaceClient(a.base, centralAdminCookie,
    { kind: 'personal', runtimeId: localEnvironment.id, nodeId: a.nodeId },
    { kind: 'personal', runtimeId: unifiedRuntime, nodeId: b.nodeId })
  transcript.push('Computer conversation creation attaches the selected Runtime Workspace, registers its default directory, and keeps other computers separate.')
  transcript.push('Captured Client Remote calls retain their Runtime, reject foreign Sessions, and stop sending after namespace withdrawal.')
  transcript.push('Composer-owned blank conversations remain observable without opening another Runtime.')
  transcript.push('Command catalog invalidations coalesce while a real remote RPC is pending; the replacement remains Session-bound.')
  transcript.push('Initial Session readiness follows its replacement history through two real Gateways before the workbench can navigate.')
  const concurrentDescriptions = await Promise.all(Array.from({ length: 32 }, async () => {
    const response = await fetch(`${a.base}/api/host.describe?dshRuntime=${unifiedRuntime}`, { method: 'POST',
      headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'host.describe', payload: {} }) })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.runtimeTarget.runtimeId, unifiedRuntime)
  }))
  assert.equal(concurrentDescriptions.length, 32)
  transcript.push('Concurrent metadata requests wait for HTTP ownership without exceeding service limits or replaying operations.')
  const unifiedGeneration = Number((await unifiedState()).generation)
  const unifiedStop = await adminRequest(`/admin/api/runtimes/${unifiedRuntime}/stop`, { generation: unifiedGeneration })
  assert.equal(unifiedStop.status, 200, await unifiedStop.clone().text()); await unifiedStop.arrayBuffer()
  const verifyUnifiedPassive = async () => { assert.equal((await unifiedState()).state, 'stopped'); assert.equal(Number((await unifiedState()).generation), unifiedGeneration) }
  const verifyUnifiedStarted = async () => { assert.equal((await unifiedState()).state, 'ready'); assert.equal(Number((await unifiedState()).generation), unifiedGeneration + 1) }
  const adminProjectBaselines = new Map()
  const verifyAdminProjectPassive = async projectId => {
    const rows = (await pool.query(`SELECT i.runtime_id,i.observed_state,i.desired_state,i.generation::text,
      i.started_at,i.runtime_token_hash IS NOT NULL has_credential
      FROM harness.instances i JOIN harness.projects p ON p.organization_id=i.organization_id AND p.id=i.project_id
      WHERE i.organization_id=$1 AND p.public_id=$2 AND i.assigned_node_id=$3`, [organization, projectId, b.nodeId])).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].observed_state, 'stopped'); assert.equal(rows[0].desired_state, 'stopped')
    assert.equal(rows[0].started_at, null); assert.equal(rows[0].has_credential, false)
    const baseline = adminProjectBaselines.get(projectId)
    if (baseline === undefined) adminProjectBaselines.set(projectId, rows[0])
    else assert.deepEqual(rows[0], baseline)
  }
  browserCheck = await topologyBrowser({ primary: a.base, secondary: b.base, primaryCookie: centralAdminCookie, remoteCookie: cookie, secondaryCookie,
    localRuntime: localEnvironment.id, remoteRuntime: environment.id, workspaceName: primaryWorkspace.title,
    unifiedRuntime, unifiedWorkspace: unifiedWorkspace.result.value.workspace.title, verifyUnifiedPassive, verifyUnifiedStarted, verifyAdminProjectPassive })
  if (process.env.HGW_TOPOLOGY_BROWSER_MODULE === undefined) {
    await verifyUnifiedPassive()
    const prepared = await fetch(`${a.base}/account/api/scope?dshRuntime=${unifiedRuntime}`, { method: 'POST', headers: unifiedHeaders,
      body: JSON.stringify({ kind: 'personal' }), redirect: 'manual' })
    assert.equal(prepared.status, 204, await prepared.text()); assert.equal(prepared.headers.get('location'), `/?dshRuntime=${unifiedRuntime}`)
    assert.equal(prepared.headers.get('set-cookie'), null); await verifyUnifiedStarted()
  }
  transcript.push('Explicit entry starts only its captured stopped Runtime without changing shared browser scope.')
  const beforeDisableDocuments = await fetch(`${a.base}/account/api/documents/overview`, { headers: { cookie } })
  assert.equal(beforeDisableDocuments.status, 200, await beforeDisableDocuments.clone().text())
  assert.ok((await beforeDisableDocuments.json()).documents.some(document => document.scope.nodeId === b.nodeId))
  await node.command('quiesce'); await agent.stop()
  const accessPage = await fetch(`${a.base}/admin/api/deployment/nodes/access`, { headers: { cookie: centralAdminCookie } })
  const attached = (await accessPage.json()).items.find(item => item.nodeId === b.nodeId)
  assert.ok(attached)
  const detached = await adminRequest(`/admin/api/deployment/nodes/access/${b.nodeId}`, { action: 'detach', revision: attached.revision })
  assert.equal(detached.status, 200, await detached.clone().text()); await detached.arrayBuffer()
  const current = await entryPolicy(a.base, centralAdminCookie)
  const disable = await fetch(`${a.base}/admin/api/deployment/topology`, { method: 'PUT', headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' }, body: JSON.stringify({ revision: current.revision, enabled: false }) })
  assert.equal(disable.status, 200, await disable.clone().text()); await disable.arrayBuffer()
  assert.equal((await center.command('status')).resident, 1)
  const localDocumentsAfterDisable = await fetch(`${a.base}/account/api/documents/overview`, { headers: { cookie } })
  assert.equal(localDocumentsAfterDisable.status, 200, await localDocumentsAfterDisable.clone().text())
  const filteredDocuments = await localDocumentsAfterDisable.json(); assert.equal(filteredDocuments.documents.length, 0); assert.equal(filteredDocuments.metrics.total, 0)
  const oldTarget = await fetch(`${a.base}/api/host.describe?dshRuntime=${environment.id}`, { headers: { cookie } })
  assert.ok([404, 409].includes(oldTarget.status), await oldTarget.text())
  transcript.push('Confirmed stop and explicit detachment allow single-computer mode without stopping primary-local work.')
  await browserCheck.afterDisable(); await browserCheck.close(); browserCheck = undefined
  const retained = (await pool.query('SELECT runtime_id,generation FROM harness.instances WHERE runtime_id=$1', [environment.id])).rows[0]
  await node.stop()
  const independent = ownedChild(entry, { NODE_SERVICE_FIXTURE_ROOT: join(root, 'remote'), NODE_SERVICE_FIXTURE_ORGANIZATION: slug, NODE_SERVICE_FIXTURE_NODE: 'computer-b' })
  const independentReady = await independent.wait('ready')
  assert.equal(independentReady.nodeId, b.nodeId)
  const independentCookie = await login(independentReady.base, 'remote-owner')
  assert.equal((await entryPolicy(independentReady.base, independentCookie)).mode, 'single')
  const independentStart = await fetch(`${independentReady.base}/admin/api/runtimes/${environment.id}/start`, { method: 'POST', headers: { cookie: independentCookie, origin: independentReady.base, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(independentStart.status, 200, await independentStart.clone().text()); await independentStart.arrayBuffer()
  const independentState = (await pool.query('SELECT runtime_id,generation,node_connection_id FROM harness.instances WHERE runtime_id=$1', [environment.id])).rows[0]
  assert.equal(independentState.runtime_id, retained.runtime_id); assert.ok(independentState.generation > retained.generation); assert.equal(independentState.node_connection_id, null)
  transcript.push('The detached computer restarts independently with the same Runtime and files in a fresh local generation.')
  const off = await entryPolicy(a.base, centralAdminCookie)
  const reenable = await fetch(`${a.base}/admin/api/deployment/topology`, { method: 'PUT', headers: { cookie: centralAdminCookie, origin: a.base, 'content-type': 'application/json' }, body: JSON.stringify({ revision: off.revision, enabled: true, primaryOrigin: a.base }) })
  assert.equal(reenable.status, 200, await reenable.clone().text()); await reenable.arrayBuffer()
  const credential = JSON.parse(await readFile(join(root, 'agent/access.json'), 'utf8')).credential
  const oldConnection = await fetch(`${a.base}/internal/nodes/connect`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: randomUUID() }) })
  assert.equal(oldConnection.status, 409); assert.equal((await oldConnection.json()).error, 'node-access/detached')
  const afterReenable = await fetch(`${a.base}/admin/api/runtimes`, { headers: { cookie: centralAdminCookie } })
  assert.ok((await afterReenable.json()).items.every(item => item.node.id === a.nodeId))
  assert.equal((await independent.command('status')).resident, 1)
  transcript.push('Re-enabling aggregation neither reconnects detached computers nor revives old managed credentials.')
  assert.equal(`${transcript.join('\n')}\n`, await readFile(new URL('./expected/node-service.txt', import.meta.url), 'utf8'))
  console.log(transcript.join('\n'))
}
try { await verify() } catch (error) { primaryFailure = error; throw error } finally {
  const failures = []
  if (primaryFailure !== undefined && process.env.HGW_TOPOLOGY_SCREENSHOTS !== undefined) {
    const traces = []
    const scan = async path => { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.name === 'runtime.log') traces.push((await readFile(file, 'utf8')).slice(-12000)) } }
    await scan(root); await writeFile(join(process.env.HGW_TOPOLOGY_SCREENSHOTS, '../runtime-failure.log'), traces.join('\n'))
  }
  try { await browserCheck?.close() } catch (error) { failures.push(error) }
  for (const child of children.reverse()) { try { await child.stop() } catch (error) { failures.push(error) } }
  if(!operationsOnly){
    await pool.query('DELETE FROM harness.model_prices WHERE model_id IN (SELECT id FROM harness.model_catalog WHERE organization_id=$1)', [organization])
    const tables = (await pool.query(`SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
      WHERE c.table_schema='harness' AND c.column_name='organization_id' AND t.table_type='BASE TABLE'`)).rows.map(row => row.table_name)
    let removed = false
    for (let round = 0; round <= tables.length && !removed; round++) {
      for (const table of tables) {
        assert.match(table, /^[a-z][a-z0-9_]+$/u)
        try { await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organization]) }
        catch (error) { if (error.code !== '23503') throw error }
      }
      try { await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organization]); removed = true }
      catch (error) { if (error.code !== '23503') throw error }
    }
    if (!removed) failures.push(new Error('Node-service organization cleanup did not settle'))
  }
  await pool.end(); await rm(root, { recursive: true, force: true })
  if (failures.length) throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...failures], 'Node-service verification or cleanup failed')
}
