/** Exact Runtime resource scope selection through two computer identities and private Gateway HTTP APIs. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === '-' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresInstanceRepository },
  { PostgresConversationStore }, { PostgresCollaborationService }, { GatewayPrincipalSigner, PRINCIPAL_HEADER },
  { createRuntimeApiHandler }, { NodeResourceBudget }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/instance-repository', 'postgres/conversation-repository',
  'postgres/collaboration-service', 'principal', 'runtime-api', 'node-resource-budget',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const pool = createPostgresPool(databaseUrl, { max: 4, application_name: `resource-scope-${randomUUID()}` })
const servers = [], pendingResources = new Map()
// Immutable execution witnesses remain in the caller-owned disposable database until its disposal.
let organizationId, primaryError
try {
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = `resource-scope-${randomUUID()}`
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Resource scopes') RETURNING id", [slug])).rows[0].id
  const user = (await pool.query(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
    VALUES($1,'actor','Actor',$2) RETURNING id,public_id`, [organizationId, `/tmp/${slug}/actor`])).rows[0]
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, user.id])
  const person = { id: Number(user.public_id), username: 'actor', displayName: 'Actor', role: 'admin',
    status: 'active', mustChangePassword: false, autoReviewEligible: false }
  const key = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(key.privateKey, slug, 60_000)
  const computers = []
  const policy = { sampleMs: 500, staleMs: 2_000, cpuTarget: 0.85, eventLoopTargetMs: 100,
    linuxMemoryReserveRatio: 0.1, maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65_536, maxWaitMs: 30_000 }
  for (const name of ['computer-a', 'computer-b']) {
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, name)
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, user.id])
    await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)',
      [organizationId, context.nodeId, user.id, `/tmp/${slug}/${name}/actor`])
    const instances = new PostgresInstanceRepository(context, 48_000)
    await instances.initialize()
    if (name === 'computer-b') await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
      VALUES($1,$2,$3,48000,'isolated')`, [organizationId, user.id, context.nodeId])
    const target = await instances.resolveTarget({ kind: 'user', id: person.id }), token = randomUUID()
    const generation = await instances.beginStart(target, Date.now(), createHash('sha256').update(token).digest())
    await instances.markReady(target, generation)
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, policy)
    await budget.configure()
    const handler = createRuntimeApiHandler({ context, instances, principals, resourceBudget: budget,
      conversations: new PostgresConversationStore(pool), collaboration: new PostgresCollaborationService(context),
      governance: { resolveOrganizationCredential: async () => null } })
    const server = createServer((req, res) => {
      void (async () => {
        const chunks = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        if (!await handler(req, res, new URL(req.url ?? '/', 'http://runtime').pathname, Buffer.concat(chunks).toString('utf8'))) {
          res.writeHead(404); res.end()
        }
      })().catch(error => { if (res.headersSent) res.destroy(error); else { res.writeHead(500); res.end(String(error)) } })
    })
    servers.push(server)
    await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const endpoint = `http://127.0.0.1:${server.address().port}`
    const call = async (action, body, interactive = false, credential = token) => {
      const response = await fetch(`${endpoint}${action.startsWith('/') ? action : `/internal/runtime/execution/${action}`}`, {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json',
          ...(interactive ? { [PRINCIPAL_HEADER]: principals.issue({ user: person,
            runtime: { ...target, generation }, scope: { kind: 'personal' } }) } : {}) }, body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    computers.push({ target, token, call, budget })
  }
  const [a, b] = computers, sessionId = 'same-host-session'
  assert.notEqual(a.target.runtimeId, b.target.runtimeId)
  const show = (label, reply, status, state) => {
    assert.equal(reply.status, status, `${label}: ${JSON.stringify(reply)}`)
    if (state !== undefined) assert.equal(reply.body.state, state, label)
    console.log(JSON.stringify({ label, status: reply.status, state: reply.body.state ?? null, error: reply.body.error ?? null }))
  }
  const resource = action => `/internal/runtime/resources/${action}`
  const request = async (computer, operation) => {
    const reply = await computer.call(resource('request'), operation)
    if (reply.status === 200 && (reply.body.state === 'queued' || reply.body.state === 'active')) {
      pendingResources.set(operation.requestId, { computer, operation })
    }
    return reply
  }
  const finish = async (computer, { sequence, requestId }) => {
    assert.equal((await computer.call(resource('finish'), { sequence, requestId, outcome: 'not-started' })).status, 200)
    pendingResources.delete(requestId)
  }
  for (const computer of computers) {
    assert.equal((await computer.call(resource('register'), {})).status, 200)
    assert.equal((await computer.call('register-session', { sessionId })).status, 200)
  }
  const enter = async (computer, scoped) => {
    const messageId = randomUUID(), contentHash = createHash('sha256').update(messageId).digest('hex')
    const admitted = await computer.call('input', { sessionId, messageId, contentHash, kind: 'message' }, true)
    assert.equal(admitted.status, 200, JSON.stringify(admitted))
    const entered = await computer.call('enter', { sessionId, inputId: admitted.body.inputId, messageId, contentHash,
      ...(scoped ? { currentScopeId: null } : {}) })
    assert.equal(entered.status, 200, JSON.stringify(entered))
    return entered.body
  }
  await enter(b, false)
  const operation = (sequence, scopeId) => ({ sequence, requestId: randomUUID(), kind: 'model',
    origin: { kind: 'session', sessionId, ...(scopeId === undefined ? {} : { scopeId }) } })
  const before = operation(1)
  show('legacy-before-foreign-scope', await request(b, before), 200, 'queued')
  const scopedA = await enter(a, true), after = operation(2)
  show('legacy-after-foreign-scope', await request(b, after), 200, 'queued')
  const references = [before, after].map(({ sequence, requestId }) => ({ sequence, requestId }))
  assert.deepEqual(await b.call(resource('statuses'), { operations: references }), { status: 200, body: [{ state: 'queued' }, { state: 'queued' }] })
  console.log(JSON.stringify({ label: 'legacy-queued-poll', states: ['queued', 'queued'] }))
  show('own-scoped-session-omits-scope', await request(a, operation(1)), 403)
  show('foreign-immutable-scope', await request(b, operation(3, scopedA.scopeId)), 403)
  show('foreign-computer-credential', await b.call(resource('register'), {}, false, a.token), 401)
  const scopedB = await enter(b, true), ownA = operation(1, scopedA.scopeId), ownB = operation(3, scopedB.scopeId)
  show('own-immutable-scope-a', await request(a, ownA), 200, 'queued')
  show('own-immutable-scope-b', await request(b, ownB), 200, 'queued')
  assert.deepEqual(await b.call(resource('statuses'), { operations: references }), { status: 200,
    body: [{ state: 'refused', reason: 'authority-unavailable' }, { state: 'refused', reason: 'authority-unavailable' }] })
  console.log(JSON.stringify({ label: 'own-scoped-transition-refuses-legacy', states: ['refused', 'refused'] }))
  for (const [computer, operations] of [[a, [ownA]], [b, [...references, ownB]]]) {
    for (const operation of operations) await finish(computer, operation)
    assert.equal((await computer.budget.snapshot()).kinds.model.queued, 0)
  }
  console.log(JSON.stringify({ label: 'quiescent-node-queues', queued: [0, 0] }))
} catch (error) { primaryError = error; throw error }
finally {
  const errors = [], close = async operation => { try { await operation() } catch (error) { errors.push(error) } }
  for (const { computer, operation: { sequence, requestId } } of pendingResources.values()) {
    await close(async () => { assert.equal((await computer.call('/internal/runtime/resources/finish', { sequence, requestId, outcome: 'not-started' })).status, 200) })
  }
  for (const server of servers.reverse()) {
    if (server.listening) await close(() => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  }
  await close(() => pool.end())
  // oxlint-disable-next-line no-unsafe-finally -- Preserve the primary failure together with cleanup failures.
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Resource scope fixture cleanup failed')
}
