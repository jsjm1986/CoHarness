/** Plain Node acceptance of compiled Gateway-owned model admission and durable usage. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Session, SessionId, SessionLogOffset, foldRequestHeader } from '@deepseek-ai/dsh-session'
import { sessionLogicalFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { GatewayModelBudget } from '../../lib/gateway-model-budget.js'
import { NodeResourceBudget } from '../../lib/node-resource-budget.js'
import { PostgresAccessMonitor } from '../../lib/access-invalidation.js'
import { OrganizationModelCredentialCipher } from '../../lib/organization-model-credentials.js'
import { PostgresCollaborationService } from '../../lib/postgres/collaboration-service.js'
import { ConversationRepository } from '../../lib/postgres/conversation-repository.js'
import { createPostgresPool, runMigrations } from '../../lib/postgres/database.js'
import { PostgresModelGovernanceService } from '../../lib/postgres/model-governance-service.js'
import { DEFAULT_PROGRESS_CONFIG, PostgresProgressService } from '../../lib/postgres/progress-service.js'
import { PostgresProgressUsage } from '../../lib/postgres/progress-usage.js'
import { resolvePostgresRuntimeContext } from '../../lib/postgres/runtime-context.js'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('A disposable test database is required')
const pool = createPostgresPool(databaseUrl, { max: 4 }), root = await mkdtemp(join(tmpdir(), 'hgw-built-progress-'))
let owner, progress, accessMonitor, requestBody, headers, heldResponse, failure
let calls = 0, holdNext = false
const upstream = createServer((req, res) => {
  void (async () => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); headers = req.headers; calls++
    if (holdNext) { heldResponse = res; res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); return }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: '{"summary":"Built request complete"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, prompt_cache_hit_tokens: 4 },
    }))
  })().catch(error => { res.destroy(error) })
})
try {
  await new Promise(ready => upstream.listen(0, '127.0.0.1', ready))
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations/', import.meta.url)))
  const slug = `built-progress-${randomUUID()}`
  const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Built progress') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organization])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  const user = (await pool.query("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'member','Member',$2) RETURNING id,public_id", [organization, root])).rows[0]
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organization, user.id])
  const project = (await pool.query("INSERT INTO harness.projects(organization_id,name) VALUES($1,'Built progress') RETURNING id,public_id", [organization])).rows[0]
  await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')", [organization, project.id, user.id])
  await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)', [organization, project.id, context.nodeId, root])
  await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organization, context.nodeId, user.id])
  const runtimeId = (await pool.query("INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48000,'legacy') RETURNING runtime_id", [organization, project.id, context.nodeId])).rows[0].runtime_id
  const userId = Number(user.public_id), projectId = Number(project.public_id), sessions = new ConversationRepository(pool, { organizationId: organization, runtimeId }), sessionId = `built-${randomUUID()}`
  const participant = { userId, username: 'member', displayName: 'Member', role: 'user',
    scope: { kind: 'project', projectId, projectName: 'Built progress', mode: 'rw' } }
  await sessions.create({ id: sessionId, organizationId: organization, runtimeId, creatorUserId: user.id, projectId: project.id, visibility: 'project', sessionFormatVersion: 0, cwd: root, createdAt: Date.now() - 1000 })
  await sessions.append(sessionId, randomUUID(), [{ type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append', data: {
    role: 'user', content: [{ type: 'text', text: 'Synthetic compiled-model request.' }], source: { kind: 'user', participant },
  } }])
  const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 37)))
  const provider = { provider: 'org-built', displayName: 'Built', driver: 'pi-ai', protocol: 'openai-completions',
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, authMode: 'none', profile: { headers: { 'x-built-route': 'compiled', 'User-Agent': 'spoofed' } } }
  await governance.upsertProvider({ ...provider, status: 'draft' })
  await governance.upsertModel({ provider: 'org-built', model: 'chat', displayName: 'Chat', enabled: true,
    inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 500_000, cacheWriteMicrosPerMillion: 0 })
  await governance.upsertProvider({ ...provider, status: 'enabled' }); await governance.setProjectAccess(projectId, 'org-built', 'chat', true)
  const budget = new NodeResourceBudget(pool, organization, context.nodeId, {
    sampleMs: 10, staleMs: 60000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
    maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65536, maxWaitMs: 15000,
  })
  await budget.configure(); owner = await GatewayModelBudget.open(budget, join(root, 'model-locks'))
  accessMonitor = new PostgresAccessMonitor(context, 100)
  progress = new PostgresProgressService(context, { collaboration: new PostgresCollaborationService(context), governance, budget: owner, accessMonitor,
    usage: new PostgresProgressUsage(context, governance, 4),
  }, { ...DEFAULT_PROGRESS_CONFIG, requestTimeoutMs: 10000, maxOutputTokens: 128 })
  async function waitFor(read, expected) {
    const deadline = performance.now() + 15000
    while (await read() !== expected) { assert.ok(performance.now() < deadline, 'compiled digest did not settle'); await delay(10) }
  }
  assert.deepEqual(await progress.generateNow(projectId, userId), { started: true })
  await waitFor(async () => (await budget.snapshot()).kinds.model.queued, 1)
  assert.equal(calls, 0)
  await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [organization, context.nodeId])
  await waitFor(async () => (await progress.progressForUser(projectId, userId)).status.generating, false)
  const page = await progress.progressForUser(projectId, userId)
  assert.equal(page.status.lastError, undefined)
  assert.equal(page.current.content.summary, 'Built request complete')
  assert.equal(headers['x-built-route'], 'compiled'); assert.match(headers['user-agent'], /^deepseek-harness\//)
  assert.equal(requestBody.max_tokens, 128)
  const evidence = (await pool.query('SELECT request,request_session,delivered_at FROM harness.project_journal_requests WHERE organization_id=$1', [organization])).rows[0]
  assert.deepEqual(evidence.request, requestBody); assert.ok(evidence.delivered_at)
  const stored = evidence.request_session
  const artifact = sessionLogicalFormatCatalog.migrate(stored.header, stored.events, stored.inheritedEventCount)
  const session = Session.fromRestore(SessionId(artifact.header.id), artifact.events, artifact.header,
    SessionLogOffset(artifact.inheritedEventCount), 'detached')
  const config = foldRequestHeader(session.events).config
  const messages = session.deriveMessages().map(message => ({ role: message.role, content: message.content.map(block => block.text).join('') }))
  assert.deepEqual({ model: config.model, messages, max_tokens: config.maxTokens, temperature: config.temperature, stream: false }, requestBody)
  assert.equal((await governance.summary({ kind: 'project', id: projectId })).totalTokens, 17)
  assert.equal((await budget.snapshot()).kinds.model.active, 0)
  await sessions.append(sessionId, randomUUID(), [{ type: 'user/message', seq: 1, time: Date.now(), surfaceOp: 'append', data: {
    role: 'user', content: [{ type: 'text', text: 'Synthetic update for active cancellation.' }], source: { kind: 'user', participant },
  } }])
  holdNext = true
  assert.deepEqual(await progress.generateNow(projectId, userId), { started: true })
  await waitFor(async () => (await budget.snapshot()).kinds.model.queued, 1)
  await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [organization, context.nodeId])
  await waitFor(async () => calls, 2)
  await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [project.id])
  await accessMonitor.synchronize()
  await waitFor(async () => heldResponse?.destroyed, true)
  await waitFor(async () => (await budget.snapshot()).kinds.model.active, 0)
  assert.equal((await pool.query("SELECT count(*)::int count FROM harness.project_journal_requests WHERE organization_id=$1 AND status='cancelled'", [organization])).rows[0].count, 1)
  assert.equal((await governance.summary({ kind: 'project', id: projectId })).totalTokens, 17)
  console.log(JSON.stringify({ compiledGatewayModel: true, kernelOwnerLoaded: true, waitedForNodeGrant: true, exactRequestEvidence: true,
    sessionFormatReconstruction: true, liveAccessCancellation: true, deploymentHeaders: true, harnessAttribution: true, disjointTokenTotal: 17, releasedAfterCompletion: true }))
} catch (error) { failure = error } finally {
  const failures = failure === undefined ? [] : [failure]
  for (const dispose of [() => progress?.close(), () => owner?.close(), () => accessMonitor?.close(), async () => {
    upstream.closeAllConnections(); await new Promise(ready => upstream.close(() => { ready() }))
  }, () => pool.end(), () => rm(root, { recursive: true, force: true })]) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
  if (failures.length > 0) throw new AggregateError(failures, 'Compiled progress acceptance failed')
}
