/** Real PostgreSQL registry, durable claims and JPush HTTP transport against an isolated local provider. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { PostgresPushService, JpushRestSender }, { loadConfig }] = await Promise.all([
  'postgres/database', 'push-notifications', 'config',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 1 })
async function removeOrganization(organizationId) {
  const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
  for (let pass = 0; pass < 12; pass += 1) {
    let blocked = false
    for (const { table_name: table } of tables) {
      try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
      catch (error) { if (error.code === '23503') blocked = true; else throw error }
    }
    if (!blocked) break
  }
  await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId]); await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
}

async function personalComputerPermissions() {
  const { ConversationRepository } = await import(new URL(`postgres/conversation-repository.${mode === 'src' ? 'ts' : 'js'}`, base))
  let organizationId, provider, primaryError
  const received = []
  try {
    organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Personal push computers') RETURNING id", [`push-computers-${randomUUID()}`])).rows[0].id
    const accounts = []
    for (const username of ['creator', 'other']) {
      const row = (await pool.query(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, username])).rows[0]
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, row.id])
      accounts.push({ id: row.id, publicId: Number(row.public_id) })
    }
    const [creator, other] = accounts
    const source = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'source') RETURNING id", [organizationId])).rows[0].id
    const second = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'second') RETURNING id", [organizationId])).rows[0].id
    const runtimeId = (await pool.query('INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,42001) RETURNING runtime_id', [organizationId, creator.id, source])).rows[0].runtime_id
    await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/second')", [organizationId, second, creator.id])
    await pool.query("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,42001,'isolated')", [organizationId, creator.id, second])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, second, creator.id])
    const rootId = `push-root-${randomUUID()}`, childId = `push-child-${randomUUID()}`, conversations = new ConversationRepository(pool, { organizationId, runtimeId })
    await conversations.create({ id: rootId, organizationId, creatorUserId: creator.id, runtimeId, sessionFormatVersion: 0, createdAt: 0, visibility: 'personal' })
    await conversations.create({ id: childId, organizationId, creatorUserId: creator.id, runtimeId, parentSessionId: rootId, sessionFormatVersion: 0, createdAt: 0, visibility: 'personal' })
    for (const [sessionId, count] of [[rootId, 6], [childId, 1]]) await conversations.append(sessionId, randomUUID(),
      Array.from({ length: count }, (_, seq) => ({ type: 'turn/end', seq, time: seq, data: { turn: seq + 1, reason: { kind: 'completed' } } })))
    provider = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v3/push'); assert.equal(request.method, 'POST')
        assert.equal(request.headers.authorization, `Basic ${Buffer.from('fixture-app:fixture-secret').toString('base64')}`)
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), { sessionId, eventSeq } = body.notification.android.extras
        assert.deepEqual(body.audience.registration_id, ['creator-registration'])
        const event = (await pool.query('SELECT event FROM harness.conversation_events WHERE session_id=$1 AND seq=$2', [sessionId, Number(eventSeq)])).rows[0]?.event
        assert.equal(event?.type, 'turn/end'); assert.equal(event?.data.reason.kind, 'completed')
        received.push({ sessionId, eventSeq: Number(eventSeq) })
        response.writeHead(200).end('{}')
      } catch (error) { response.writeHead(500).end(String(error)) }
    })
    await new Promise((done, fail) => { provider.once('error', fail); provider.listen(0, '127.0.0.1', done) })
    const service = new PostgresPushService({ pool, organizationId }, loadConfig({}), fetch,
      new JpushRestSender('fixture-app', 'fixture-secret', fetch, `http://127.0.0.1:${provider.address().port}/v3/push`))
    await service.registerDevice(creator.publicId, { token: 'creator-registration', platform: 'android', provider: 'jpush' })
    await service.registerDevice(other.publicId, { token: 'other-registration', platform: 'android', provider: 'jpush' })
    async function complete(scenario, sessionId, eventSeq, expected) {
      const before = received.length
      await service.notifyCompleted(runtimeId, sessionId, eventSeq)
      assert.equal(received.length - before, expected)
      const rows = (await pool.query('SELECT status FROM harness.push_deliveries WHERE organization_id=$1 AND session_id=$2 AND event_seq=$3', [organizationId, sessionId, eventSeq])).rows
      assert.deepEqual(rows.map(row => row.status), expected === 0 ? [] : ['sent'])
      const secondAllowed = (await pool.query('SELECT enabled FROM harness.computer_use_permissions WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, second, creator.id])).rows[0].enabled
      assert.equal(secondAllowed, true)
      console.log(JSON.stringify({ scenario, secondComputerAllowed: secondAllowed, outgoingCalls: received.length - before, claimed: rows.length }))
    }
    await complete('personal-source-current', rootId, 0, 1)
    await complete('personal-child-current', childId, 0, 1)
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, source, creator.id])
    await complete('personal-source-revoked', rootId, 1, 0)
    await pool.query('DELETE FROM harness.computer_use_permissions WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, source, creator.id])
    await complete('personal-source-grant-missing', rootId, 2, 0)
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, source, creator.id])
    await complete('personal-source-restored', rootId, 3, 1)
    const beforeRecovery = received.length
    await new PostgresPushService({ pool, organizationId }, loadConfig({})).notifyCompleted(runtimeId, rootId, 4)
    assert.equal(received.length, beforeRecovery)
    assert.deepEqual((await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1 AND session_id=$2 AND event_seq=4', [organizationId, rootId])).rows, [{ status: 'failed', attempts: 1 }])
    const registrationPreserved = (await pool.query("SELECT 1 FROM harness.push_devices WHERE organization_id=$1 AND token='creator-registration'", [organizationId])).rowCount === 1
    assert.equal(registrationPreserved, true)
    await service.notifyCompleted(runtimeId, rootId, 4)
    assert.equal(received.length - beforeRecovery, 1)
    const recovered = (await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1 AND session_id=$2 AND event_seq=4', [organizationId, rootId])).rows[0]
    assert.deepEqual(recovered, { status: 'sent', attempts: 2 })
    console.log(JSON.stringify({ scenario: 'personal-provider-restored', outgoingCalls: 1, ...recovered, registrationPreserved }))
    await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2', [organizationId, runtimeId])
    await complete('personal-source-runtime-retired', rootId, 5, 0)
  } catch (error) { primaryError = error; throw error }
  finally {
    const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
    if (provider?.listening) await close(() => new Promise((done, fail) => { provider.closeAllConnections(); provider.close(error => error ? fail(error) : done()) }))
    if (organizationId !== undefined) await close(() => removeOrganization(organizationId))
    // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
    if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Personal push computer cleanup failed')
  }
}

async function gatewayCompletion() {
  const [{ resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService }, { PostgresAuthService },
    { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
    { createRuntimeApiHandler }, { PostgresConversationStore }, { GatewayPrincipalSigner }, { PostgresCollaborationService },
    { PostgresModelGovernanceService }, { OrganizationModelCredentialCipher }] = await Promise.all([
    'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service', 'postgres/audit-service',
    'postgres/instance-repository', 'instances', 'server', 'runtime-api', 'postgres/conversation-repository', 'principal',
    'postgres/collaboration-service', 'postgres/model-governance-service', 'organization-model-credentials',
  ].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
  const root = await mkdtemp(join(tmpdir(), 'push-runtime-http-'))
  let organizationId, gateway, provider, primaryError
  const deliveries = []
  try {
    const slug = `push-runtime-${randomUUID()}`
    organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Push runtime') RETURNING id", [slug])).rows[0].id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
      HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
      HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
    const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
    const actor = await users.create({ username: 'creator', password: 'pw-12345678' })
    const creator = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
    const instances = new PostgresInstanceRepository(context, cfg.instancePortBase), manager = new InstanceManager(instances, cfg)
    await manager.stopAll()
    const token = randomUUID(), runtimeId = (await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='ready',
      runtime_token_hash=$3 WHERE organization_id=$1 AND user_id=$2 RETURNING runtime_id`, [organizationId, creator, createHash('sha256').update(token).digest()])).rows[0].runtime_id
    const sessionId = `push-runtime-session-${randomUUID()}`, conversationStore = new PostgresConversationStore(pool), conversations = conversationStore.forRuntime({ organizationId, runtimeId })
    await conversations.create({ id: sessionId, organizationId, creatorUserId: creator, runtimeId, sessionFormatVersion: 0, createdAt: 0, visibility: 'personal' })
    let calls = 0, committed = false
    provider = createServer(async (request, response) => {
      try {
        for await (const _ of request) { /* Consume the provider request before acknowledging acceptance. */ }
        calls += 1
        const event = (await pool.query('SELECT event FROM harness.conversation_events WHERE session_id=$1 AND seq=1', [sessionId])).rows[0]?.event
        committed = event?.type === 'turn/end' && event.data.reason.kind === 'completed'
        assert.equal(committed, true)
        response.writeHead(200).end('{}')
      } catch (error) { response.writeHead(500).end(String(error)) }
    })
    await new Promise((done, fail) => { provider.once('error', fail); provider.listen(0, '127.0.0.1', done) })
    const push = new PostgresPushService(context, cfg, fetch, new JpushRestSender('fixture-app', 'fixture-secret', fetch, `http://127.0.0.1:${provider.address().port}/v3/push`))
    await push.registerDevice(actor.id, { token: 'fixture-registration', platform: 'android', provider: 'jpush' })
    const notify = push.notifyCompleted.bind(push)
    push.notifyCompleted = (...args) => { const pending = notify(...args); deliveries.push(pending); return pending }
    const { privateKey } = generateKeyPairSync('ed25519')
    const runtime = createRuntimeApiHandler({ context, instances, conversations: conversationStore, push,
      principals: new GatewayPrincipalSigner(privateKey, slug, 60_000), collaboration: new PostgresCollaborationService(context),
      governance: new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9))),
    })
    gateway = createGatewayServer({ cfg, users, projects, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context), instances: manager },
      { runtime, runtimeAuthorize: async request => request.headers.authorization === `Bearer ${token}` && await instances.authenticateRuntimeToken(token) !== null })
    await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
    const origin = `http://127.0.0.1:${gateway.address().port}`
    const append = async (batchId, seq, kind, credential = token) => {
      const response = await fetch(`${origin}/internal/runtime/session/append`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, batchId, events: [{ type: 'turn/end', seq, time: seq, data: { turn: seq, reason: { kind } } }] }) })
      return { status: response.status, value: await response.json() }
    }
    const aborted = await append(randomUUID(), 0, 'aborted'); assert.deepEqual(aborted, { status: 200, value: { result: 'inserted' } }); assert.equal(deliveries.length, 0)
    const batchId = randomUUID(), completed = await append(batchId, 1, 'completed'); assert.equal(completed.value.result, 'inserted'); assert.equal(completed.status, 200)
    await Promise.all(deliveries)
    const duplicate = await append(batchId, 1, 'completed'); assert.deepEqual(duplicate, { status: 200, value: { result: 'duplicate' } }); assert.equal(deliveries.length, 1)
    const denied = await append(randomUUID(), 2, 'completed', 'invalid-runtime-token'); assert.equal(denied.status, 401)
    assert.equal(calls, 1)
    const delivery = (await pool.query('SELECT status FROM harness.push_deliveries WHERE organization_id=$1', [organizationId])).rows[0]
    assert.equal(delivery.status, 'sent')
    assert.equal((await conversations.load(sessionId)).events.length, 2)
    console.log(JSON.stringify({ scenario: 'gateway-completion', aborted: aborted.value.result, completed: completed.value.result,
      duplicate: duplicate.value.result, invalidCredentialStatus: denied.status, outgoingCalls: calls, completedEventCommittedBeforeSend: committed, status: delivery.status }))
  } catch (error) { primaryError = error; throw error }
  finally {
    const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
    if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
    await close(async () => { await Promise.all(deliveries) })
    if (provider?.listening) await close(() => new Promise((done, fail) => { provider.closeAllConnections(); provider.close(error => error ? fail(error) : done()) }))
    if (organizationId !== undefined) await close(() => removeOrganization(organizationId))
    await close(() => rm(root, { recursive: true, force: true }))
    // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
    if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Push runtime HTTP cleanup failed')
  }
}

try {
  await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const scenario of ['current', 'concurrent', 'disabled-account', 'reassigned-before-claim', 'expired-claim', 'invalid-after-reassign', 'timeout']) {
    let organizationId, provider, pending, second, release, primaryError
    let calls = 0, signal, heldResponse, received
    const observed = new Promise(done => { received = done })
    try {
      const slug = `push-http-${randomUUID()}`
      organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Push HTTP') RETURNING id", [slug])).rows[0].id
      const users = []
      for (const username of ['creator', 'other']) {
        const row = (await pool.query(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, username])).rows[0]
        await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, row.id])
        users.push({ id: row.id, publicId: Number(row.public_id) })
      }
      const [creator, other] = users, sessionId = `push-http-session-${randomUUID()}`, token = `fixture-registration-${randomUUID()}`
      const nodeId = (await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id", [organizationId])).rows[0].id
      const runtimeId = (await pool.query('INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,42001) RETURNING runtime_id', [organizationId, creator.id, nodeId])).rows[0].runtime_id
      await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,session_format_version,
        created_at,updated_at,visibility,root_session_id,runtime_id) VALUES($1,$2,$3,0,now(),now(),'personal',$1,$4)`, [sessionId, organizationId, creator.id, runtimeId])
      provider = createServer(async (request, response) => {
        try {
          assert.equal(request.headers.authorization, `Basic ${Buffer.from('fixture-app:fixture-secret').toString('base64')}`)
          const chunks = []; for await (const chunk of request) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          assert.deepEqual(body.audience.registration_id, [token]); assert.equal(body.notification.android.extras.sessionId, sessionId)
          assert.equal(body.notification.android.extras.eventSeq, '17'); assert.equal(body.notification.android.extras.runtimeId, runtimeId)
          await pool.query('SELECT 1')
          if (scenario === 'concurrent' || scenario === 'invalid-after-reassign' || scenario === 'timeout') {
            heldResponse = response; received()
          } else response.writeHead(200).end('{}')
        } catch (error) { response.writeHead(500).end(String(error)) }
      })
      await new Promise((done, fail) => { provider.once('error', fail); provider.listen(0, '127.0.0.1', done) })
      const cfg = loadConfig(scenario === 'timeout' ? { HGW_PUSH_DELIVERY_TIMEOUT_MS: '100', HGW_PUSH_DELIVERY_LEASE_MS: '1000' } : {})
      const request = (...args) => { calls += 1; signal = args[1]?.signal; return fetch(...args) }
      const sender = new JpushRestSender('fixture-app', 'fixture-secret', request, `http://127.0.0.1:${provider.address().port}/v3/push`)
      const context = { pool, organizationId }, service = new PostgresPushService(context, cfg, fetch, sender)
      const device = await service.registerDevice(creator.publicId, { token, platform: 'android', provider: 'jpush' })
      release = () => { if (heldResponse !== undefined && !heldResponse.writableEnded) heldResponse.writeHead(scenario === 'invalid-after-reassign' ? 400 : 200).end(scenario === 'invalid-after-reassign' ? 'invalid registration id' : '{}') }
      if (scenario === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [creator.id])
      if (scenario === 'expired-claim') await pool.query(`INSERT INTO harness.push_deliveries(organization_id,session_id,event_seq,device_id,status,attempts,updated_at,runtime_id)
        VALUES($1,$2,17,$3,'pending',1,clock_timestamp()-($4+1)*interval '1 millisecond',$5)`, [organizationId, sessionId, device.id, cfg.pushDeliveryLeaseMs, runtimeId])
      if (scenario === 'reassigned-before-claim') {
        let captured = false
        const lane = new Proxy(pool, { get(target, key) {
          if (key === 'query') return async (text, values) => {
            const result = await target.query(text, values)
            if (!captured && text.includes('FROM harness.push_devices')) {
              captured = true
              await service.registerDevice(other.publicId, { token, platform: 'android', provider: 'jpush' })
            }
            return result
          }
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
        } })
        await new PostgresPushService({ ...context, pool: lane }, cfg, fetch, sender).notifyCompleted(runtimeId, sessionId, 17)
      } else {
        pending = service.notifyCompleted(runtimeId, sessionId, 17)
        if (scenario === 'concurrent' || scenario === 'invalid-after-reassign') {
          await observed
          if (scenario === 'concurrent') { second = service.notifyCompleted(runtimeId, sessionId, 17); await second; assert.equal(calls, 1) }
          else await service.registerDevice(other.publicId, { token, platform: 'android', provider: 'jpush' })
          release()
        }
        await pending
      }
      const delivery = (await pool.query('SELECT status,attempts FROM harness.push_deliveries WHERE organization_id=$1', [organizationId])).rows[0]
      const currentOwner = (await pool.query('SELECT user_id FROM harness.push_devices WHERE id=$1', [device.id])).rows[0]?.user_id
      const expectedStatus = scenario === 'disabled-account' || scenario === 'reassigned-before-claim' ? null
        : scenario === 'timeout' || scenario === 'invalid-after-reassign' ? 'failed' : 'sent'
      assert.equal(delivery?.status ?? null, expectedStatus)
      assert.equal(calls, expectedStatus === null ? 0 : 1)
      assert.equal(currentOwner, scenario === 'reassigned-before-claim' || scenario === 'invalid-after-reassign' ? other.id : creator.id)
      if (scenario === 'timeout') assert.equal(signal.aborted, true)
      console.log(JSON.stringify({ scenario, outgoingCalls: calls, status: delivery?.status ?? null, attempts: delivery?.attempts ?? 0,
        currentOwner: currentOwner === creator.id ? 'creator' : 'other', transportAborted: scenario === 'timeout' ? signal.aborted : null }))
    } catch (error) { primaryError = error; throw error }
    finally {
      const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
      release?.(); await close(async () => { await Promise.all([pending, second]) })
      if (provider?.listening) await close(() => new Promise((done, fail) => { provider.closeAllConnections(); provider.close(error => error ? fail(error) : done()) }))
      if (organizationId !== undefined) await close(() => removeOrganization(organizationId))
      // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
      if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Push HTTP cleanup failed')
    }
  }
  await gatewayCompletion()
  await personalComputerPermissions()
} finally { await pool.end() }
