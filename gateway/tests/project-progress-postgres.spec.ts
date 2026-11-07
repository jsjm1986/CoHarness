/** Real Gateway HTTP/PostgreSQL digest admission, policy changes, publication fencing and billing. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { sessionLogicalFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { InstanceManager } from '../src/instances.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { PostgresProgressService, type ProgressConfig } from '../src/postgres/progress-service.ts'
import { PostgresProgressUsage } from '../src/postgres/progress-usage.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer } from '../src/server.ts'
import { testConfig } from './test-config.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

function reply(res: ServerResponse, summary = 'Ready', usage: unknown = { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary }) } }], usage }))
}

describePg('project digest governed model path', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(respond: (res: ServerResponse, index: number) => void | Promise<void> = res => { reply(res) }, profile?: Record<string, unknown>, progressOverrides: Partial<ProgressConfig> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-progress-admission-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const requests: string[] = [], responses: ServerResponse[] = [], headers: IncomingHttpHeaders[] = []
    const upstream = createServer((req, res) => {
      void (async () => {
        const parts: Buffer[] = []
        for await (const chunk of req) parts.push(Buffer.from(chunk))
        requests.push(Buffer.concat(parts).toString('utf8')); responses.push(res); headers.push(req.headers)
        await respond(res, requests.length)
      })().catch(error => { res.destroy(error instanceof Error ? error : new Error(String(error))) })
    })
    await new Promise<void>(ready => upstream.listen(0, '127.0.0.1', ready))
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(ready => upstream.close(() => { ready() })) })
    const slug = `progress-${randomUUID()}`
    await pool.query(`WITH organization AS (INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Progress audit') RETURNING id)
      INSERT INTO harness.compute_nodes(organization_id,name) SELECT id,'progress-node' FROM organization`, [slug])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'progress-node'), cfg = testConfig(root)
    cfg.progress = { ...cfg.progress, ...progressOverrides }
    const users = new PostgresUserService(context, cfg), member = await users.create({ username: 'member', password: 'pw-12345678' })
    await users.changeOwnPassword(member.id, 'pw-12345678')
    const projects = new PostgresProjectService(context, cfg)
    const creator = await users.create({ username: 'owner', password: 'pw-12345678' })
    const project = await projects.createManaged({ name: 'Progress', ownerUserId: creator.id })
    await projects.setMember(project.id, member.id, 'rw')
    const ids = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id FROM harness.users u
      JOIN harness.projects p ON p.organization_id=u.organization_id WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`,
    [context.organizationId, member.id, project.id])).rows[0]!
    const runtime = await new PostgresInstanceRepository(context, cfg.instancePortBase).resolveTarget({ kind: 'project', id: project.id })
    const runtimeId = runtime.runtimeId!
    const collaboration = new PostgresCollaborationService(context), sessions = new ConversationRepository(pool, { organizationId: context.organizationId, runtimeId })
    const sessionId = `progress-${randomUUID()}`
    await sessions.create({ id: sessionId, organizationId: context.organizationId, runtimeId, creatorUserId: ids.user_id, projectId: ids.project_id,
      visibility: 'project', sessionFormatVersion: 0, createdAt: Date.now() - 60_000, cwd: project.path })
    await sessions.append(sessionId, randomUUID(), [{ type: 'user/message', seq: 0, time: Date.now() - 30_000, surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'Prepare the release.' }], source: { kind: 'user', participant: {
        userId: member.id, username: member.username, displayName: member.displayName, role: 'user',
        scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' },
      } } } }])
    const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 31)))
    const provider = { provider: 'org-digest', displayName: 'Digest', driver: 'pi-ai' as const, protocol: 'openai-completions' as const,
      baseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, authMode: 'none' as const,
      ...(profile === undefined ? {} : { profile }) }
    await governance.upsertProvider({ ...provider, status: 'draft' })
    await governance.upsertModel({ provider: 'org-digest', model: 'chat', displayName: 'Chat', enabled: true,
      inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cacheReadMicrosPerMillion: 500_000, cacheWriteMicrosPerMillion: 0 })
    await governance.upsertProvider({ ...provider, status: 'enabled' })
    await governance.setProjectAccess(project.id, 'org-digest', 'chat', true)
    const accessMonitor = new PostgresAccessMonitor(context, cfg.accessInvalidationPollMs)
    cleanups.push(() => accessMonitor.close())
    const budget = new NodeResourceBudget(pool, context.organizationId, context.nodeId, { ...cfg.resourceBudget, sampleMs: 10 })
    await budget.configure()
    const owner = await GatewayModelBudget.open(budget, join(root, 'model-locks'))
    cleanups.push(() => owner.close())
    const usage = new PostgresProgressUsage(context, governance, cfg.progress.usageReplayBatchSize)
    let paused = false
    const makeService = (options: { assertDataEpoch?: () => Promise<void> } = {}) => {
      const service = new PostgresProgressService(context, { collaboration, governance, budget: owner, usage, accessMonitor,
        beforeDispatch: async () => { if (paused) throw new Error('maintenance') },
        assertDataEpoch: options.assertDataEpoch,
      }, cfg.progress)
      cleanups.push(() => service.close())
      return service
    }
    const progress = makeService()
    const instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
    cleanups.push(() => instances.stopAll())
    const server = createGatewayServer({ cfg, users, projects, collaboration, governance, progress, instances,
      auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(ready => server.close(() => { ready() })) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cfg.publicOrigins.push(base)
    const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: member.username, password: 'pw-12345678' }) })
    const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
    await signedIn.arrayBuffer()
    expect(signedIn.status).toBe(302)
    if (cookie === undefined) throw new Error('Missing fixture login cookie')
    const generate = async () => {
      const result = await fetch(`${base}/account/api/progress/generate?dshTarget=project:${project.id}`, { method: 'POST', headers: { cookie, origin: base } })
      expect(result.status).toBe(200)
      return result.json()
    }
    const grant = () => pool.query(`UPDATE harness.node_resource_state SET credits=credits+1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2`,
      [context.organizationId, context.nodeId])
    const state = async () => (await pool.query<{ generating: boolean; last_error: string | null }>(`SELECT generating_since IS NOT NULL generating,last_error
      FROM harness.project_journal_state WHERE project_id=$1`, [ids.project_id])).rows[0]
    return { context, project, runtimeId, creator, member, projects, ids, sessionId, sessions, collaboration, progress, governance, budget, owner, usage, accessMonitor,
      requests, responses, headers, provider, generate, grant, state, makeService, pause: () => { paused = true } }
  }

  it('keeps the HTTP-triggered model queued, then stores exact inputs and disjoint usage before releasing capacity', async () => {
    const f = await fixture()
    expect(await f.generate()).toMatchObject({ started: true })
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    expect(f.requests).toHaveLength(0)
    await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    const summary = await f.governance.summary({ kind: 'project', id: f.project.id })
    expect(summary).toMatchObject({ calls: 1, inputTokens: 8, outputTokens: 5, cacheReadTokens: 4, totalTokens: 17, companyCostMicros: 20 })
    const evidence = (await pool.query<{ request: unknown; response: string; delivered: boolean }>(`SELECT request,response,delivered_at IS NOT NULL delivered
      FROM harness.project_journal_requests WHERE organization_id=$1`, [f.context.organizationId])).rows[0]!
    expect(evidence.request).toEqual(JSON.parse(f.requests[0]!))
    expect(evidence.response).toContain('Ready')
    expect(evidence.delivered).toBe(true)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
    const page = await f.progress.progressForUser(f.project.id, f.member.id)
    expect(page.current?.content.summary).toBe('Ready')
    await expect('# Project digest model admission\n\nqueuedBeforeDispatch=true\nrequests=1\ninput=8\noutput=5\ncacheRead=4\ntotal=17\ncompanyCostMicros=20\nrequestEvidence=exact\nusageDelivered=true\nactiveAfter=0\nsummary=Ready\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-progress/admission.expected.md'))
  })

  it('reconstructs the exact utility request from its durable current-format Session', async () => {
    let organizationId = '', recordedAtDispatch = false
    const f = await fixture(async res => {
      recordedAtDispatch = Boolean((await pool.query("SELECT request_session session FROM harness.project_journal_requests r WHERE organization_id=$1",
        [organizationId])).rows[0]?.session)
      reply(res)
    })
    organizationId = f.context.organizationId
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(recordedAtDispatch).toBe(true)
    const row = (await pool.query<{ session: SessionFormatArtifact | null; request_id: string; request: unknown }>(
      "SELECT request_session session,request_id,request FROM harness.project_journal_requests r WHERE organization_id=$1",
      [f.context.organizationId],
    )).rows[0]!
    expect(row.session).toMatchObject({ header: { id: row.request_id, isSeeded: false }, inheritedEventCount: 0 })
    const artifact = sessionLogicalFormatCatalog.migrate(row.session!.header, row.session!.events, row.session!.inheritedEventCount)
    const header = artifact.events.find(event => event.type === 'request/header')!.data as { header: { config: { model: string; maxTokens: number; temperature: number } } }
    const messages = artifact.events.filter(event => event.type === 'user/message').map(event => {
      const message = event.data as { role: string; content: Array<{ type: string; text: string }>; source: { kind: string } }
      expect(message.source).toEqual({ kind: 'gateway-project-progress' })
      return { role: message.role, content: message.content.map(block => block.text).join('') }
    })
    const reconstructed = { model: header.header.config.model, messages, max_tokens: header.header.config.maxTokens,
      temperature: header.header.config.temperature, stream: false }
    expect(reconstructed).toEqual(row.request)
    expect(reconstructed).toEqual(JSON.parse(f.requests[0]!))
    expect((await pool.query('SELECT id FROM harness.conversation_sessions WHERE organization_id=$1', [organizationId])).rowCount).toBe(1)
    const changed = { ...row.session!, events: [...row.session!.events, { seq: row.session!.events.length, type: 'state', time: 1, data: {} }] }
    await expect(pool.query('UPDATE harness.project_journal_requests SET request_session=$2::json WHERE request_id=$1',
      [row.request_id, JSON.stringify(changed)])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO harness.project_journal_requests
      (organization_id,node_id,project_id,project_public_id,request_id,operation_id,actor_public_id,occurred_at,provider,model,credential_source,request,request_session)
      SELECT organization_id,node_id,project_id,project_public_id,gen_random_uuid(),gen_random_uuid(),actor_public_id,occurred_at,provider,model,credential_source,request,'{}'::json
      FROM harness.project_journal_requests WHERE request_id=$1`, [row.request_id])).rejects.toMatchObject({ code: '23514' })
    await expect('# Project progress model evidence\n\nsessionFormat=current\nrequestReconstructed=exact\nparticipant=infrastructure\nconversationRegistered=false\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-progress/session-evidence.expected.md'))
  })

  it('permanently deletes completed progress evidence with its owning project', async () => {
    const f = await fixture()
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await pool.query('SELECT request_id FROM harness.project_journal_requests WHERE project_id=$1', [f.ids.project_id])).rowCount).toBe(1)
    await expect(f.projects.remove(f.project.id)).resolves.toContain(f.member.id)
    for (const table of ['projects', 'conversation_sessions', 'project_journal', 'project_journal_state', 'project_journal_materials', 'project_journal_requests', 'model_usage']) {
      expect((await pool.query(`SELECT 1 FROM harness.${table} WHERE organization_id=$1`, [f.context.organizationId])).rowCount, table).toBe(0)
    }
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
    await expect('# Project progress permanent deletion\n\nprojectDeleted=true\nprogressEvidenceDeleted=true\nactiveModelRequests=0\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-progress/project-deleted.expected.md'))
  })

  it('cancels a deleted project request and joins its dispatched HTTP work', async () => {
    const f = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders() })
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await f.projects.remove(f.project.id)
    await f.accessMonitor.synchronize()
    await expect.poll(() => f.responses[0]!.destroyed).toBe(true)
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.active).toBe(0)
    await f.progress.close()
    expect((await pool.query('SELECT 1 FROM harness.project_journal WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(0)
  })

  it.each(['writer-revoked', 'organization-disabled', 'source-private', 'monitor-closed'] as const)('cancels dispatched utility inference on %s', async kind => {
    const f = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders() })
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    if (kind === 'writer-revoked') await f.projects.setMember(f.project.id, f.member.id, 'ro')
    if (kind === 'organization-disabled') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    if (kind === 'source-private') await f.collaboration.setVisibility(f.member.id, f.runtimeId, f.sessionId, 'private')
    if (kind === 'monitor-closed') await f.accessMonitor.close()
    else if (kind === 'organization-disabled') await expect(f.accessMonitor.synchronize()).rejects.toThrow('access organization is not active')
    else await f.accessMonitor.synchronize()
    await expect.poll(() => f.responses[0]!.destroyed).toBe(true)
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.active).toBe(0)
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect((await pool.query('SELECT status FROM harness.project_journal_requests WHERE organization_id=$1', [f.context.organizationId])).rows)
      .toEqual([{ status: 'cancelled' }])
    expect((await pool.query('SELECT 1 FROM harness.project_journal WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(0)
    await expect(`# Project progress live access\n\nchange=${kind}\nrequests=1\nhttpCancelled=true\nusageStatus=cancelled\nactive=0\npublished=false\n`)
      .toMatchFileSnapshot(join(import.meta.dirname, `snapshots/project-progress/live-${kind}.expected.md`))
  })

  it('preserves an active pass when another account changes', async () => {
    const f = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders() })
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    await pool.query("UPDATE harness.users SET status='disabled' WHERE organization_id=$1 AND public_id=$2", [f.context.organizationId, f.creator.id])
    await f.accessMonitor.synchronize()
    expect(f.responses[0]!.destroyed).toBe(false)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    f.responses[0]!.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"Unaffected"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).current?.content.summary).toBe('Unaffected')
  })

  it('retains access cancellation through publication after HTTP has completed', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const service = f.makeService({ assertDataEpoch: async () => { entered(); await held } })
    try {
      await service.generateNow(f.project.id, f.member.id); await f.grant()
      await reached
      await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.ids.project_id])
      await f.accessMonitor.synchronize()
    } finally { release() }
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await pool.query('SELECT 1 FROM harness.project_journal WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM harness.project_journal_materials WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(0)
    expect((await f.governance.summary({ kind: 'project', id: f.project.id })).totalTokens).toBe(17)
  })

  it.for(['writer-revoked', 'organization-disabled', 'project-archived', 'model-revoked', 'source-private', 'maintenance'] as const)(
    'rechecks %s after a queued grant', async kind => {
      const f = await fixture()
      expect(await f.generate()).toMatchObject({ started: true })
      await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
      if (kind === 'writer-revoked') await f.projects.setMember(f.project.id, f.member.id, 'ro')
      if (kind === 'organization-disabled') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      if (kind === 'project-archived') await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.ids.project_id])
      if (kind === 'model-revoked') await f.governance.setProjectAccess(f.project.id, 'org-digest', 'chat', false)
      if (kind === 'source-private') await f.collaboration.setVisibility(f.member.id, f.runtimeId, f.sessionId, 'private')
      if (kind === 'maintenance') f.pause()
      await f.grant()
      await expect.poll(async () => (await f.state())?.generating).toBe(false)
      await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(0)
      expect(f.requests).toHaveLength(0)
      expect((await f.state())?.last_error !== null).toBe(kind !== 'source-private')
      expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 0, queued: 0 })
      expect((await pool.query('SELECT 1 FROM harness.model_usage WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(0)
      await expect(`# Project digest queued policy\n\nchange=${kind}\nrequests=0\nusageCalls=0\nactive=0\nqueued=0\ngenerating=false\nerrorRecorded=${kind !== 'source-private'}\n`)
        .toMatchFileSnapshot(join(import.meta.dirname, `snapshots/project-progress/${kind}.expected.md`))
    },
  )

  it('cancels an in-flight HTTP response and joins the background pass on shutdown', async () => {
    const f = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders() })
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await f.progress.close()
    await expect.poll(() => f.responses[0]?.destroyed).toBe(true)
    expect((await f.state())?.generating).toBe(false)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
    const result = (await pool.query<{ status: string }>('SELECT status FROM harness.project_journal_requests WHERE organization_id=$1', [f.context.organizationId])).rows[0]
    expect(result?.status).toBe('cancelled')
  })

  it('prevents a recovered lease predecessor from replacing its successor or clearing its state', async () => {
    const f = await fixture((res, index) => { if (index !== 1) reply(res, 'Successor') })
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    await pool.query("UPDATE harness.project_journal_state SET generating_since='-infinity' WHERE project_id=$1", [f.ids.project_id])
    const successor = f.makeService()
    expect(await successor.generateNow(f.project.id, f.member.id)).toMatchObject({ started: true })
    await f.grant()
    await expect.poll(async () => (await successor.progressForUser(f.project.id, f.member.id)).current?.content.summary).toBe('Successor')
    reply(f.responses[0]!, 'Predecessor')
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.active).toBe(0)
    await f.progress.close()
    expect((await successor.progressForUser(f.project.id, f.member.id)).current?.content.summary).toBe('Successor')
    expect((await f.state())?.last_error).toBeNull()
  })

  it('replays a committed billing result after acknowledgement loss without double charging', async () => {
    const f = await fixture(), ingest = f.governance.ingest.bind(f.governance)
    vi.spyOn(f.governance, 'ingest').mockImplementationOnce(async (subject, event) => {
      await ingest(subject, event)
      throw new Error('lost usage acknowledgement')
    })
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.state())?.last_error).toContain('pending delivery')
    expect((await f.governance.summary({ kind: 'project', id: f.project.id })).calls).toBe(1)
    await f.progress.sweep()
    expect(f.requests).toHaveLength(1)
    expect((await f.governance.summary({ kind: 'project', id: f.project.id })).calls).toBe(1)
    expect((await pool.query('SELECT 1 FROM harness.project_journal_requests WHERE organization_id=$1 AND delivered_at IS NULL', [f.context.organizationId])).rowCount).toBe(0)
  })

  it('retains billing when a project is archived while its model request is running', async () => {
    const f = await fixture(() => {})
    await f.generate(); await f.grant()
    await expect.poll(() => f.responses.length).toBe(1)
    await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.ids.project_id])
    try {
      reply(f.responses[0]!)
      await expect.poll(async () => (await pool.query('SELECT 1 FROM harness.model_usage WHERE organization_id=$1', [f.context.organizationId])).rowCount).toBe(1)
    } finally {
      await pool.query("UPDATE harness.projects SET status='active' WHERE id=$1", [f.ids.project_id])
    }
  })

  it('rebuilds derived journal entries when shared source visibility changes', async () => {
    const f = await fixture()
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).current?.content.summary).toBe('Ready')
    await f.collaboration.setVisibility(f.member.id, f.runtimeId, f.sessionId, 'private')
    const hidden = await f.progress.progressForUser(f.project.id, f.member.id)
    expect(hidden.current).toBeUndefined()
    expect(hidden.periods).toEqual([])
    await f.collaboration.setVisibility(f.member.id, f.runtimeId, f.sessionId, 'project')
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(1)
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(f.requests).toHaveLength(2)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).current?.content.summary).toBe('Ready')
    await expect('# Project progress source visibility\n\nprivateSource=currentAndPeriodsHidden\nsharedAgain=pendingMaterialRebuilt\nrequests=2\nsummary=Ready\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-progress/source-rebuild.expected.md'))
  })

  it('refreshes deployment headers after waiting and retains Harness application attribution', async () => {
    const f = await fixture(undefined, { headers: { 'x-deployment-route': 'initial', 'User-Agent': 'spoofed' } })
    await f.generate()
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    await f.governance.upsertProvider({ ...f.provider, status: 'enabled',
      profile: { headers: { 'x-deployment-route': 'updated', 'User-Agent': 'spoofed' } } })
    await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(f.headers[0]?.['x-deployment-route']).toBe('updated')
    expect(f.headers[0]?.['user-agent']).toMatch(/^deepseek-harness\//)
  })

  it('consumes a microsecond question answer exactly once', async () => {
    const f = await fixture()
    await f.collaboration.claimInteraction(f.member.id, f.runtimeId, f.sessionId, 'question', 'microsecond-answer', { answers: [{ selected: ['Friday'] }] })
    const time = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, '.123456Z')
    await pool.query('UPDATE harness.conversation_interaction_responses SET responded_at=$2 WHERE conversation_id=$1', [f.sessionId, time])
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(0)
  })

  it('consumes distinct unanchored answers with identical timestamps across capped passes', async () => {
    const f = await fixture(undefined, undefined, { maxMaterialRows: 1 })
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    for (const label of ['Choice A', 'Choice B']) await f.collaboration.claimInteraction(f.member.id, f.runtimeId, f.sessionId, 'question', label, { answers: [{ selected: [label] }] })
    const time = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, '.123000Z')
    await pool.query('UPDATE harness.conversation_interaction_responses SET responded_at=$2 WHERE conversation_id=$1', [f.sessionId, time])
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(1)
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(0)
    for (const label of ['Choice A', 'Choice B']) expect(f.requests.filter(request => request.includes(label))).toHaveLength(1)
  })

  it('includes an older message that reaches the Gateway after a later message was digested', async () => {
    const f = await fixture()
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    const sessionId = `late-${randomUUID()}`
    await f.sessions.create({ id: sessionId, organizationId: f.context.organizationId, creatorUserId: f.ids.user_id,
      projectId: f.ids.project_id, visibility: 'project', sessionFormatVersion: 0, cwd: f.project.path, createdAt: Date.now() - 90_000 })
    await f.sessions.append(sessionId, randomUUID(), [{ type: 'user/message', seq: 0, time: Date.now() - 60_000, surfaceOp: 'append', data: {
      role: 'user', content: [{ type: 'text', text: 'Older input delivered later.' }], source: { kind: 'user', participant: {
        userId: f.member.id, username: f.member.username, displayName: f.member.displayName, role: 'user',
        scope: { kind: 'project', projectId: f.project.id, projectName: f.project.name, mode: 'rw' },
      } },
    } }])
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(1)
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(f.requests[1]).toContain('Older input delivered later.')
    await expect('# Project progress delayed source\n\nolderInputAfterCommit=pending\nrequests=2\nolderInputIncluded=true\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-progress/delayed-source.expected.md'))
  })

  it('uses the database order for a capped prefix containing equal-time member and assistant rows', async () => {
    const f = await fixture(undefined, undefined, { maxMaterialRows: 1, maxAssistantRows: 1 })
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    const prefix = `ordering-${randomUUID()}`, time = Date.now() - 1000
    for (const [suffix, type, text] of [['-a', 'user/message', 'same-time member'], ['_a', 'assistant/message', 'later assistant context']] as const) {
      const sessionId = prefix + suffix
      await f.sessions.create({ id: sessionId, organizationId: f.context.organizationId, creatorUserId: f.ids.user_id,
        projectId: f.ids.project_id, visibility: 'project', sessionFormatVersion: 0, cwd: f.project.path, createdAt: time - 1000 })
      const content = [{ type: 'text', text }]
      const data = type === 'assistant/message' ? { message: { role: 'assistant', content } } : {
        role: 'user', content, source: { kind: 'user', participant: { userId: f.member.id, username: f.member.username,
          displayName: f.member.displayName, role: 'user', scope: { kind: 'project', projectId: f.project.id, projectName: f.project.name, mode: 'rw' } } },
      }
      await f.sessions.append(sessionId, randomUUID(), [{ type, seq: 0, time, surfaceOp: 'append', data }])
    }
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect(f.requests[1]).toContain('same-time member')
    expect(f.requests[1]).not.toContain('later assistant context')
  })

  it('rejects a malformed source receipt instead of hiding unread material', async () => {
    const f = await fixture()
    await expect(pool.query(`INSERT INTO harness.project_journal_materials(organization_id,project_id,session_id,entry_id,receipt)
      VALUES($1,$2,$3,'message:0',$4)`, [f.context.organizationId, f.ids.project_id, f.sessionId, Buffer.alloc(32)]))
      .rejects.toMatchObject({ code: '23514' })
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(1)
  })

  it('rolls back material receipts together with a failed journal publication', async () => {
    const f = await fixture(), name = `audit_journal_${randomUUID().replaceAll('-', '')}`
    // PostgreSQL UUID output and the generated identifier contain no SQL quoting characters.
    await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic publication interruption'; END; $$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON harness.project_journal_state FOR EACH ROW
      WHEN (NEW.project_id='${f.ids.project_id}'::uuid AND NEW.watermark_ts IS DISTINCT FROM OLD.watermark_ts)
      EXECUTE FUNCTION harness.${name}()`)
    cleanups.push(async () => {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.project_journal_state`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${name}()`)
    })
    await f.generate(); await f.grant()
    await expect.poll(async () => (await f.state())?.generating).toBe(false)
    expect((await f.state())?.last_error).toContain('synthetic publication interruption')
    expect((await pool.query('SELECT 1 FROM harness.project_journal_materials WHERE project_id=$1', [f.ids.project_id])).rowCount).toBe(0)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).status.pending).toBe(1)
    expect((await f.progress.progressForUser(f.project.id, f.member.id)).current).toBeUndefined()
    expect((await f.governance.summary({ kind: 'project', id: f.project.id })).calls).toBe(1)
  })
})
