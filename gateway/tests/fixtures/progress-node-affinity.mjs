/** Two logical computers retain project digest admission, requests and usage on their owning node. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const moduleRoot = process.env.DSH_PROGRESS_NODE_GATEWAY_ROOT ?? fileURLToPath(new URL('../../src/', import.meta.url))
const extension = moduleRoot.endsWith('/lib') || moduleRoot.endsWith('/lib/') ? '.js' : '.ts'
const load = name => import(pathToFileURL(join(moduleRoot, name + extension)).href)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresInstanceRepository },
  { ConversationRepository }, { PostgresCollaborationService }, { NodeResourceBudget }, { GatewayModelBudget },
  { PostgresModelGovernanceService }, { OrganizationModelCredentialCipher }, { PostgresProgressUsage },
  { PostgresProgressService, DEFAULT_PROGRESS_CONFIG }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/instance-repository', 'postgres/conversation-repository',
  'postgres/collaboration-service', 'node-resource-budget', 'gateway-model-budget', 'postgres/model-governance-service',
  'organization-model-credentials', 'postgres/progress-usage', 'postgres/progress-service',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('A disposable PostgreSQL test database is required')
const administration = createPostgresPool(databaseUrl, { max: 1 }), database = `progress_node_${randomUUID().replaceAll('-', '')}_test`
let databaseCreated = false, pool, root, upstream, upstreamStarted = false
const computers = [], requests = [], transcript = [], failures = []
const show = (scenario, facts) => { const entry = { scenario, ...facts }; transcript.push(entry); console.log(JSON.stringify(entry)) }
try {
  await administration.query(`CREATE DATABASE ${database}`); databaseCreated = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`; pool = createPostgresPool(url.toString(), { max: 2 })
  root = await mkdtemp(join(tmpdir(), 'hgw-progress-node-'))
  await runMigrations(pool, process.env.DSH_PROGRESS_NODE_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations/', import.meta.url)))
  upstream = createServer((req, res) => {
    void (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const label = ['computer-a', 'computer-b'].find(name => body.messages?.[0]?.content.includes(`"${name}"`))
      assert.ok(label, 'request names its source project')
      requests.push({ label, body })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: `Digest ${label}` + (body.messages[0].content.includes('\u0000') ? '\u0000complete' : ''), done: [{ text: body.messages[0].content.includes('\u0000') ? 'Recorded\u0000value' : 'Recorded', refs: [1] }] }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }))
    })().catch(error => res.destroy(error))
  })
  await new Promise((ready, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', ready) }); upstreamStarted = true
  const slug = `progress-node-${randomUUID()}`
  const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node-owned project digest') RETURNING id", [slug])).rows[0].id
  const user = (await pool.query("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'member','Member',$2) RETURNING id,public_id", [organizationId, root])).rows[0]
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, user.id])
  const provider = { provider: 'org-node-digest', displayName: 'Node digest', driver: 'pi-ai', protocol: 'openai-completions', authMode: 'none', baseURL: `http://127.0.0.1:${upstream.address().port}/v1` }
  let governance
  for (const [index, name] of ['computer-a', 'computer-b'].entries()) {
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, name)
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, user.id])
    await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)', [organizationId, context.nodeId, user.id, join(root, name, 'member')])
    const project = (await pool.query('INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id,public_id', [organizationId, name, user.id])).rows[0]
    await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')", [organizationId, project.id, user.id])
    await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)', [organizationId, project.id, context.nodeId, join(root, name, 'project')])
    await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,$4)', [organizationId, project.id, context.nodeId, 49000 + index])
    const instances = new PostgresInstanceRepository(context, 48000), target = await instances.resolveTarget({ kind: 'project', id: Number(project.public_id) })
    const repository = new ConversationRepository(pool, { organizationId, runtimeId: target.runtimeId }), sessionId = randomUUID()
    await repository.append(sessionId, randomUUID(), [{ seq: 0, type: 'user/message', time: Date.now() - 1000, data: {
      source: { kind: 'user', participant: { userId: Number(user.public_id), username: 'member', displayName: 'Member' } }, content: [{ type: 'text', text: `Activity from ${name}` }],
    } }], { id: sessionId, organizationId, runtimeId: target.runtimeId, creatorUserId: user.id, projectId: project.id, visibility: 'project', sessionFormatVersion: 1, createdAt: Date.now() - 1000 })
    if (governance === undefined) {
      governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 41)))
      await governance.upsertProvider({ ...provider, status: 'draft' })
      await governance.upsertModel({ provider: provider.provider, model: 'chat', displayName: 'Chat', enabled: true, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
      await governance.upsertProvider({ ...provider, status: 'enabled' })
    }
    await governance.setProjectAccess(Number(project.public_id), provider.provider, 'chat', true)
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, { sampleMs: 10, staleMs: 60000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65536, maxWaitMs: 15000 })
    await budget.configure()
    const computer = { name, context, project, budget, repository, target }; computers.push(computer)
    computer.owner = await GatewayModelBudget.open(budget, join(root, name, 'model-locks'))
    computer.progress = new PostgresProgressService(context, { collaboration: new PostgresCollaborationService(context), governance, budget: computer.owner, usage: new PostgresProgressUsage(context, governance, 4) },
      { ...DEFAULT_PROGRESS_CONFIG, minActivity: 1, idleMs: 0, intervalMs: 0, sweepMaxProjects: 4, requestTimeoutMs: 10000, maxOutputTokens: 128 })
    await pool.query("UPDATE harness.node_resource_state SET credits=4,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [organizationId, context.nodeId])
  }
  const [a, b] = computers
  await a.progress.sweep()
  assert.deepEqual(requests.map(row => row.label), ['computer-a'], 'computer A must not dispatch the project fixed to computer B')
  const foreignState = (await pool.query('SELECT last_error,generating_since,generation_id FROM harness.project_journal_state WHERE organization_id=$1 AND project_id=$2', [organizationId, b.project.id])).rows
  assert.deepEqual(foreignState, [], `foreign project receives no lease or error state; requests=${JSON.stringify(requests.map(row => row.label))}`)
  show('local-sweep-only', { localRequests: 1, foreignRequests: 0, foreignLeaseRows: 0 })
  await b.progress.sweep()
  assert.deepEqual(requests.map(row => row.label), ['computer-a', 'computer-b'])
  const journal = (await pool.query('SELECT node_id,project_id,status,delivered_at IS NOT NULL delivered FROM harness.project_journal_requests WHERE organization_id=$1', [organizationId])).rows
  assert.equal(journal.length, 2)
  for (const computer of computers) {
    assert.deepEqual(journal.find(row => row.project_id === computer.project.id), { node_id: computer.context.nodeId, project_id: computer.project.id, status: 'succeeded', delivered: true })
    assert.equal((await governance.summary({ kind: 'project', id: Number(computer.project.public_id) })).totalTokens, 17)
    assert.equal((await computer.budget.snapshot()).kinds.model.active, 0)
    assert.equal((await computer.budget.snapshot()).kinds.model.queued, 0)
  }
  show('owning-node-request-and-usage', { projects: 2, requests: 2, requestNodesMatchProjects: true, deliveredUsagePerProject: 17, activeAfterCompletion: 0 })
  await Promise.all(computers.map(computer => computer.progress.sweep()))
  assert.equal(requests.length, 2)
  show('source-receipt-replay', { repeatedSweeps: 2, extraRequests: 0 })
  const nulId=randomUUID(), nulText='NUL\u0000source %_\\尾巴', now=Date.now()
  const callId='question\\u0000literal', interaction=randomUUID()
  const nulEvents=[
    {seq:0,type:'turn/start',time:now,data:{turn:1,scopeKey:'turn\u0000scope'}},
    {seq:1,type:'user/message',time:now+1,data:{source:{kind:'user',participant:{userId:Number(user.public_id),displayName:'Member\u0000尾巴'}},content:[{type:'text',text:nulText}]}},
    {seq:2,type:'assistant/message',time:now+2,data:{message:{content:[{type:'text',text:'Assistant\u0000detail'}]}}},
    {seq:3,type:'tool/call',time:now+3,data:{callId,scopeKey:'tool\u0000scope',arguments:JSON.stringify({questions:[{question:'Question\u0000text'}]})}},
    {seq:4,type:'tool/result',time:now+4,data:{callId,scopeKey:'result\u0000scope'}},
  ]
  await a.repository.append(nulId,randomUUID(),nulEvents,{id:nulId,organizationId,runtimeId:a.target.runtimeId,creatorUserId:user.id,projectId:a.project.id,visibility:'project',sessionFormatVersion:1,createdAt:now})
  const collaboration=new PostgresCollaborationService(a.context)
  assert.equal(await collaboration.claimInteraction(Number(user.public_id),a.target.runtimeId,nulId,'question',interaction,{answers:[{selected:['Chosen']}]},callId),true)
  const activity=(await collaboration.listActivity(Number(user.public_id),a.target.runtimeId,Number(a.project.public_id),{limit:100})).items.filter(row=>row.sessionId===nulId)
  assert.equal(activity.length,2)
  assert.ok(activity.some(row=>row.text===nulText&&row.actorLabel==='Member\u0000尾巴'))
  assert.ok(activity.some(row=>row.questionText==='Question\u0000text'))
  assert.equal((await a.progress.progressForUser(Number(a.project.public_id),Number(user.public_id))).status.pending,2)
  await a.progress.sweep()
  assert.equal(requests.length,3)
  const input=requests.at(-1).body
  assert.ok(input.messages[0].content.includes(nulText));assert.ok(input.messages[0].content.includes('Assistant\u0000detail'));assert.ok(input.messages[0].content.includes('Question\u0000text'))
  const evidence=(await pool.query('SELECT request,request_session FROM harness.project_journal_requests WHERE organization_id=$1 AND project_id=$2 ORDER BY occurred_at DESC LIMIT 1',[organizationId,a.project.id])).rows[0]
  assert.deepEqual(evidence.request,input)
  const logged=evidence.request_session.events.filter(event=>event.type==='user/message').map(event=>({role:'user',content:event.data.content.map(block=>block.text).join('')}))
  assert.deepEqual(logged,input.messages)
  const page=await a.progress.progressForUser(Number(a.project.public_id),Number(user.public_id))
  assert.equal(page.current.content.summary,'Digest computer-a\u0000complete')
  assert.equal(page.current.content.sections.done[0].text,'Recorded\u0000value')
  assert.equal(page.current.content.sections.done[0].sessionTitle,nulText)
  assert.equal(page.current.content.sections.done[0].runtimeId,a.target.runtimeId)
  assert.equal(page.status.pending,0)
  assert.deepEqual((await a.repository.load(nulId)).events,nulEvents)
  assert.equal((await governance.summary({kind:'project',id:Number(a.project.public_id)})).totalTokens,34)
  await a.progress.sweep();assert.equal(requests.length,3)
  assert.equal((await a.budget.snapshot()).kinds.model.active,0)
  show('nul-source-and-progress',{originalEvents:true,activityRows:2,questionCorrelated:true,pendingConsumed:2,exactRequestAndSession:true,citedTitleOriginal:true,summaryContainsNul:true,projectUsageTokens:34,extraReplayRequests:0,activeAfter:0})

} catch (error) { failures.push(error) } finally {
  const close = async action => { try { await action() } catch (error) { failures.push(error) } }
  for (const computer of [...computers].reverse()) {
    await close(() => computer.progress?.close()); await close(() => computer.owner?.close())
  }
  if (upstreamStarted) await close(async () => { upstream.closeAllConnections(); await new Promise((ready, reject) => upstream.close(error => error ? reject(error) : ready())) })
  if (pool !== undefined) await close(() => pool.end())
  if (databaseCreated) await close(() => administration.query(`DROP DATABASE ${database}`))
  await close(() => administration.end())
  if (root !== undefined) await close(() => rm(root, { recursive: true, force: true }))
}
if (failures.length > 0) throw new AggregateError(failures, 'Project digest computer ownership verification failed')
