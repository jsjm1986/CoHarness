/** Real Runtime credentials preserve independent execution identities for equal Host Session IDs. @module */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresMaintenanceService, type WriteGateVerdict } from '../src/postgres/maintenance-service.ts'
import { PostgresModelGovernanceService, projectProviderCredentialRef } from '../src/postgres/model-governance-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { InstanceManager } from '../src/instances.ts'
import { OperationTimings } from '../src/operation-timing.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'
import { runtimeBearerToken } from '../src/runtime-api.ts'
import { RUNTIME_MODEL_CREDENTIAL_PATH } from '../src/runtime-request-path.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'
import { GatewayExecutionIdentity, verifyExecutionAttribution, type ExecutionIdentityState } from '../src/execution-identity.ts'
import { DesktopAccess } from '../src/desktop-access.ts'
import { NodeResourceBudget, type NodeResourceBudgetConfig } from '../src/node-resource-budget.ts'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('execution Runtime identity isolation', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(resourceBudget?: NodeResourceBudgetConfig) {
    const f = await createExecutionFixture(pool, { resourceBudget, executionWriteEpoch: 1n })
    cleanups.push(f.dispose)
    const created = await pool.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances
      (organization_id,user_id,assigned_node_id,port,storage_layout)
      SELECT $1,$2,$3,max(port)+1,'isolated' FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$3
      RETURNING runtime_id`, [f.organizationId, f.admin.uuid, f.context.nodeId])
    const runtimeId = created.rows[0]!.runtime_id
    const target = { kind: 'user' as const, id: f.admin.id, runtimeId }, token = randomUUID()
    const generation = await f.instances.beginStart(target, Date.now(), createHash('sha256').update(token).digest())
    await f.instances.markReady(target, generation)
    return { ...f, sibling: { ...f.personal, runtimeId, generation, token } }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  type Runtime = Fixture['personal']

  async function register(f: Fixture, runtime: Runtime, sessionId: string, parentSessionId?: string) {
    expect(await f.call('register-session', { sessionId, parentSessionId }, undefined, runtime)).toMatchObject({ status: 200 })
  }

  async function enter(f: Fixture, runtime: Runtime, sessionId: string, messageId = 'same-human-message') {
    const receipt = await f.admit(sessionId, f.admin, runtime, messageId)
    const result = await f.call<ExecutionIdentityState>('enter', { sessionId, inputId: receipt.inputId,
      messageId: receipt.messageId, contentHash: receipt.contentHash, currentScopeId: null }, undefined, runtime)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 200 })
    return { receipt, state: result.body }
  }

  it('registers a prepared root and its first input atomically across a retry', async () => {
    const f = await fixture(), sessionId = randomUUID(), messageId = randomUUID()
    const payload = { sessionId, messageId, kind: 'message', registerRoot: true,
      contentHash: createHash('sha256').update(messageId).digest('hex') }
    const signed = f.principals.issue({ user: f.admin, scope: { kind: 'personal' },
      runtime: { kind: 'user', id: f.personal.id, runtimeId: f.personal.runtimeId, generation: f.personal.generation },
      personalDraft: 'admit-input' })
    const call = async (value: typeof payload, runtime = f.personal) => {
      const response = await fetch(`${f.base}/internal/runtime/execution/input`, { method: 'POST',
        headers: { ...f.headers(runtime), [PRINCIPAL_HEADER]: signed }, body: JSON.stringify(value) })
      const body: unknown = await response.json()
      return { status: response.status, body }
    }
    const roots = async (id: string) => (await pool.query(`SELECT runtime_id FROM harness.execution_sessions
      WHERE organization_id=$1 AND session_id=$2`, [f.organizationId, id])).rows
    expect(await f.call('input', payload, f.admin, f.personal)).toMatchObject({ status: 403 })
    expect(await call(payload, f.sibling)).toMatchObject({ status: 403 })
    expect(await roots(sessionId)).toEqual([])
    const first = await call(payload)
    expect(first).toMatchObject({ status: 200, body: { inputId: expect.any(String) } })
    expect(await call(payload)).toEqual(first)
    expect(await roots(sessionId)).toEqual([{ runtime_id: f.personal.runtimeId }])
    expect((await pool.query('SELECT id FROM harness.execution_inputs WHERE organization_id=$1 AND session_id=$2',
      [f.organizationId, sessionId])).rowCount).toBe(1)
    const child = randomUUID()
    await register(f, f.personal, child, sessionId)
    expect(await call({ ...payload, sessionId: child })).toMatchObject({ status: 409 })
    await pool.query("INSERT INTO harness.cluster_control(organization_id,mode,write_epoch) VALUES($1,'serving',2)", [f.organizationId])
    const refused = randomUUID()
    expect(await call({ ...payload, sessionId: refused })).toMatchObject({ status: 503 })
    expect(await roots(refused)).toEqual([])
  })

  it('registers equal Session IDs independently in sibling personal Runtimes without changing their Host IDs', async () => {
    const f = await fixture(), sessionId = 'same-host-session'
    expect(f.sibling.runtimeId).not.toBe(f.personal.runtimeId)
    expect(f.sibling.generation).toBeGreaterThan(f.personal.generation)
    expect((await f.call('register-session', { sessionId }, undefined, f.personal)).status).toBe(200)
    const second = await f.call('register-session', { sessionId }, undefined, f.sibling)
    expect(second, JSON.stringify(second)).toMatchObject({ status: 200 })
    const rows = await pool.query('SELECT runtime_id,session_id FROM harness.execution_sessions WHERE organization_id=$1 ORDER BY runtime_id',
      [f.organizationId])
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.map(row => row.session_id)).toEqual([sessionId, sessionId])
  })

  it('keeps repeated input identities idempotent within one Runtime and refuses foreign inputs, edits and scopes', async () => {
    const f = await fixture(), sessionId = 'same-session'
    for (const runtime of [f.personal, f.sibling]) await register(f, runtime, sessionId)
    const a = await enter(f, f.personal, sessionId), b = await enter(f, f.sibling, sessionId)
    expect(a.receipt.inputId).not.toBe(b.receipt.inputId)
    expect(a.state.scopeId).not.toBe(b.state.scopeId)
    expect((await f.admit(sessionId, f.admin, f.personal, a.receipt.messageId)).inputId).toBe(a.receipt.inputId)
    expect((await f.call('input', { sessionId, messageId: a.receipt.messageId, kind: 'message',
      contentHash: createHash('sha256').update('different').digest('hex') }, f.admin, f.personal)).status).toBe(409)
    expect((await f.call('enter', { sessionId, inputId: a.receipt.inputId, messageId: a.receipt.messageId,
      contentHash: a.receipt.contentHash }, undefined, f.sibling)).status).toBe(403)
    expect((await f.call('input', { sessionId, messageId: a.receipt.messageId, kind: 'message',
      contentHash: a.receipt.contentHash, previousInputId: a.receipt.inputId }, f.admin, f.sibling)).status).toBe(403)
    for (const action of ['capture', 'authorize', 'combine']) {
      const value = action === 'combine' ? { scopeIds: [a.state.scopeId], unverified: false }
        : { scopeId: a.state.scopeId, ...(action === 'authorize' ? { capability: 'execute' } : {}) }
      expect((await f.call(action, { sessionId, ...value }, undefined, f.sibling)).status).toBe(403)
    }
    expect((await f.call('authorize', { sessionId, scopeId: b.state.scopeId, capability: 'execute' }, undefined, f.sibling)).status).toBe(200)
  })

  it('checks the computer grant again after waiting for the account lock and commits no receipt on revocation', async () => {
    const f = await fixture(), sessionId = await f.session(f.personal), messageId = randomUUID()
    const lease = await pool.connect()
    let pending: ReturnType<typeof f.call> | undefined
    try {
      await lease.query('BEGIN')
      await lease.query('SELECT id FROM harness.users WHERE id=$1 FOR UPDATE', [f.admin.uuid])
      const holder = Number((await lease.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      pending = f.call('input', { sessionId, messageId, kind: 'message',
        contentHash: createHash('sha256').update(messageId).digest('hex') }, f.admin, f.personal)
      void pending.catch(() => { /* The request is joined when the lock is released. */ })
      const stopAt = performance.now() + 3000
      for (;;) {
        const { rows: [block] } = await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
          SELECT FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
            AND query LIKE '%FROM harness.admit_personal_execution_input(%') AS waiting`, [holder])
        if (block?.waiting === true) break
        if (performance.now() >= stopAt) throw new Error('Personal input did not wait for the account grant change')
        await delay(10)
      }
      await lease.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE (organization_id,node_id,user_id)=($1,$2,$3)',
        [f.organizationId, f.context.nodeId, f.admin.uuid])
      await lease.query('COMMIT')
      expect(await pending).toMatchObject({ status: 403 })
      const result = await pool.query('SELECT id FROM harness.execution_inputs WHERE organization_id=$1 AND message_id=$2', [f.organizationId, messageId])
      expect(result.rows).toHaveLength(0)
    } finally {
      await lease.query('ROLLBACK')
      lease.release()
      await pending?.catch(() => { /* Preserve the test's failure after releasing the lock. */ })
    }
  })

  it('rejects a stale serving epoch and rolls back an uncommitted root and input', async () => {
    const f = await fixture(), sessionId = await f.session(f.personal)
    const { organizationId, personal } = f
    const root = randomUUID(), messageId = randomUUID()
    const p = { sessionId, messageId, kind: 'message', contentHash: createHash('sha256').update(messageId).digest('hex') }
    await pool.query("INSERT INTO harness.cluster_control(organization_id,mode,write_epoch) VALUES($1,'serving',2)", [organizationId])
    expect(await f.call('input', p, f.admin, personal)).toMatchObject({ status: 503 })
    expect(await f.call('register-session', { sessionId: root }, undefined, personal)).toMatchObject({ status: 503 })
    expect((await pool.query('SELECT id FROM harness.execution_inputs WHERE organization_id=$1 AND message_id=$2', [organizationId, messageId])).rows).toHaveLength(0)
    expect((await pool.query('SELECT session_id FROM harness.execution_sessions WHERE organization_id=$1 AND session_id=$2', [organizationId, root])).rows).toHaveLength(0)
  })

  it('admits ordinary personal execution in one statement while retaining write, bearer and epoch fences', async () => {
    const f = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'hgw-execution-admission-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const cfg = testConfig(root, { HGW_RUNTIME_API_BODY_LIMIT_BYTES: '512' })
    const credentials = new PostgresInstanceRepository(f.context, cfg.instancePortBase)
    expect(credentials.personalExecutionCandidate(f.personal.token)).toBeNull()
    const running = await credentials.authenticateRuntimeControlToken(f.personal.token, pool, 1n)
    expect(running?.generation).toBe(f.personal.generation)
    await credentials.authenticateRuntimeControlToken(f.project.token, pool, 1n)
    expect(credentials.personalExecutionCandidate(f.project.token)).toBeNull()
    credentials.invalidateRuntimeTokenCache()
    expect(credentials.personalExecutionCandidate(f.personal.token)).toEqual(running)
    const maintenance = new PostgresMaintenanceService(f.context, cfg.nodeStaleMs)
    const instances = new InstanceManager(f.instances, cfg)
    await instances.portOf(f.personal)
    let stopping = false, writers = 0
    const writerArrival: number[] = []
    const maintenanceGate = vi.fn(async () => (await maintenance.writeGate(1n)).verdict)
    const timings = new OperationTimings(8)
    const handler = Object.assign((...args: Parameters<typeof f.handler>) =>
      timings.run(args[0], args[1], () => f.handler(...args)), f.handler)
    const deps: GatewayDeps = { cfg, maintenanceGate, writerSpan: () => {
      writers++
      writerArrival.push(writers)
      return () => { writers-- }
    }, users: new PostgresUserService(f.context, cfg), auth: new PostgresAuthService(f.context, cfg),
    projects: new PostgresProjectService(f.context, cfg), audit: new PostgresAuditService(f.context), instances }
    const listen = async (stopGate?: () => WriteGateVerdict, useCandidate = true) => {
      const server = createGatewayServer(deps, { runtime: handler, runtimeAuthorize: async req =>
        await f.instances.authenticateRuntimeToken(req.headers.authorization?.slice('Bearer '.length) ?? '') ?? false,
      runtimePersonalExecutionCandidate: req => useCandidate
        ? credentials.personalExecutionCandidate(req.headers.authorization?.slice('Bearer '.length) ?? '') : null,
      runtimePersonalExecutionStopGate: stopGate })
      cleanups.push(() => new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      }))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    const baseline = await listen()
    const unrecognized = await listen(() => 'open', false)
    const candidate = await listen(() => stopping ? 'maintenance' : 'open')
    const call = (base: string, action: string, value: unknown, headers = f.headers(f.personal, f.admin)) =>
      fetch(`${base}/internal/runtime/execution/${action}`, { method: 'POST', headers, body: JSON.stringify(value) })
    const sessionId = randomUUID(), messageId = randomUUID()
    const message = { sessionId, messageId, kind: 'message', contentHash: createHash('sha256').update(messageId).digest('hex') }
    await register(f, f.personal, sessionId)
    const receipt = await f.admit(sessionId, f.admin, f.personal, messageId)
    const inputOperation = randomUUID()
    const observedInput = await call(candidate, 'input', message, {
      ...f.headers(f.personal, f.admin), 'x-dsh-operation-id': inputOperation,
    })
    expect(observedInput.status).toBe(200)
    expect(await observedInput.json()).toMatchObject({ inputId: receipt.inputId })
    expect(timings.samples(inputOperation)[0]).toMatchObject({
      sql: { governance: { count: 1 } },
      phases: { executionInputServer: expect.any(Number) },
    })
    const enterBody = { sessionId, messageId, inputId: receipt.inputId, contentHash: receipt.contentHash, currentScopeId: null }
    const enterOnce = async () => {
      const id = randomUUID()
      const response = await call(candidate, 'enter', enterBody, { ...f.headers(f.personal), 'x-dsh-operation-id': id })
      expect(response.status).toBe(200)
      const state = await response.json() as ExecutionIdentityState
      const count = timings.samples(id)[0]?.sql.governance.count
      return { state, count }
    }
    const entries = await Promise.all([enterOnce(), enterOnce()])
    expect(entries.map(entry => entry.count)).toContain(1)
    expect(entries[0]!.state).toEqual(entries[1]!.state)
    expect(entries[0]!.state).toMatchObject({ revision: '2', inputs: [receipt.inputId] })
    const authorize = { sessionId, capability: 'execute', scopeId: entries[0]!.state.scopeId, unverifiedHistory: false }
    expect(authorize.scopeId).toBeDefined()
    maintenanceGate.mockClear()
    writerArrival.length = 0
    const query = vi.spyOn(pool, 'query')
    try {
      const firstRoot = { sessionId: randomUUID() }
      const withLookup = await call(unrecognized, 'register-session', firstRoot)
      expect(withLookup.status).toBe(200)
      const registration: unknown = await withLookup.json()
      expect(query, 'root registration with an unknown bearer lookup').toHaveBeenCalledTimes(2)
      query.mockClear()
      const fromControl = await call(candidate, 'register-session', firstRoot)
      expect(fromControl.status).toBe(200)
      expect(await fromControl.json()).toEqual(registration)
      expect(query, 'root registration after the control route qualified the bearer').toHaveBeenCalledTimes(1)
      query.mockClear()
      for (const [action, payload] of [['register-session', { sessionId }], ['input', message], ['enter', enterBody], ['authorize', authorize]] as const) {
        const before = await call(baseline, action, payload)
        expect(before.status).toBe(200)
        const accepted: unknown = await before.json()
        expect(query, `${action} with the shared HTTP gate`).toHaveBeenCalledTimes(4)
        expect(maintenanceGate).toHaveBeenCalledOnce()
        query.mockClear()
        maintenanceGate.mockClear()
        const after = await call(candidate, action, payload)
        expect(after.status).toBe(200)
        expect(await after.json()).toEqual(accepted)
        expect(query, `${action} with the transaction's write fence`).toHaveBeenCalledTimes(1)
        expect(maintenanceGate).not.toHaveBeenCalled()
        query.mockClear()
      }
      expect(writerArrival).toEqual(Array<number>(10).fill(1))
      expect(writers).toBe(0)
      const oversized = 'x'.repeat(513)
      const badToken = await call(candidate, 'input', oversized, { ...f.headers(f.personal), authorization: 'Bearer invalid' })
      expect(badToken.status).toBe(401)
      await badToken.json()
      const oversizedAuthorized = await call(candidate, 'input', oversized)
      expect(oversizedAuthorized.status).toBe(413)
      await oversizedAuthorized.json()
      const unsigned = await call(candidate, 'input', message, f.headers(f.personal))
      expect(unsigned.status).toBe(403)
      await unsigned.json()
      stopping = true
      const stopped = await call(candidate, 'input', { ...message, messageId: randomUUID() })
      expect(stopped.status).toBe(503)
      expect(await stopped.json()).toEqual({ error: 'maintenance' })
      expect(maintenanceGate).not.toHaveBeenCalled()
      stopping = false
      const wrongReceipt = await call(candidate, 'enter', { ...enterBody, contentHash: 'f'.repeat(64) })
      expect(wrongReceipt.status).toBe(403)
      await wrongReceipt.json()
      expect(maintenanceGate).toHaveBeenCalledOnce()
      maintenanceGate.mockClear()
      const seeded = await call(candidate, 'register-session', { sessionId: randomUUID(), parentSessionId: sessionId, isSeeded: true })
      expect(seeded.status).toBe(200)
      await seeded.json()
      expect(maintenanceGate).toHaveBeenCalledOnce()
      maintenanceGate.mockClear()
      const unverified = await call(candidate, 'authorize', { ...authorize, unverifiedHistory: true })
      expect(unverified.status).toBe(200)
      await unverified.json()
      expect(maintenanceGate).toHaveBeenCalledOnce()
    } finally { query.mockRestore() }
    const refusedSession = randomUUID(), refusedMessage = randomUUID()
    const untouchedRoot = await f.session(f.personal)
    const untouched = await f.admit(untouchedRoot, f.admin, f.personal, randomUUID())
    const untouchedEntry = { sessionId: untouchedRoot, inputId: untouched.inputId,
      messageId: untouched.messageId, contentHash: untouched.contentHash, currentScopeId: null }
    await pool.query("INSERT INTO harness.cluster_control(organization_id,mode,write_epoch) VALUES($1,'serving',2)", [f.organizationId])
    for (const [action, payload] of [['register-session', { sessionId: refusedSession }],
      ['input', { ...message, messageId: refusedMessage }], ['enter', untouchedEntry], ['authorize', authorize]] as const) {
      const response = await call(candidate, action, payload)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: 'execution-writes-unavailable' })
    }
    expect((await pool.query('SELECT id FROM harness.execution_inputs WHERE organization_id=$1 AND message_id=$2', [f.organizationId, refusedMessage])).rows).toHaveLength(0)
    expect((await pool.query('SELECT entered_at FROM harness.execution_inputs WHERE id=$1', [untouched.inputId])).rows)
      .toEqual([{ entered_at: null }])
    expect((await pool.query('SELECT session_id FROM harness.execution_sessions WHERE organization_id=$1 AND session_id=$2', [f.organizationId, refusedSession])).rows).toHaveLength(0)

    expect(credentials.personalExecutionCandidate(f.personal.token)).not.toBeNull()
    await pool.query('UPDATE harness.cluster_control SET write_epoch=1 WHERE organization_id=$1', [f.organizationId])
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE (organization_id,node_id,user_id)=($1,$2,$3)',
      [f.organizationId, f.context.nodeId, f.admin.uuid])
    credentials.invalidateRuntimeTokenCache()
    expect(credentials.personalExecutionCandidate(f.personal.token)).toEqual(running)
    for (const [action, payload] of [['register-session', { sessionId: refusedSession }],
      ['input', { ...message, messageId: refusedMessage }], ['enter', untouchedEntry], ['authorize', authorize]] as const) {
      const response = await call(candidate, action, payload)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid-runtime-token' })
    }
    expect((await pool.query('SELECT id FROM harness.execution_inputs WHERE organization_id=$1 AND message_id=$2', [f.organizationId, refusedMessage])).rows).toHaveLength(0)
    expect((await pool.query('SELECT session_id FROM harness.execution_sessions WHERE organization_id=$1 AND session_id=$2', [f.organizationId, refusedSession])).rows).toHaveLength(0)
  })

  it('resolves credentials for the exact Runtime in one statement and confines project candidates to the model route', async () => {
    const cipher = new OrganizationModelCredentialCipher(randomBytes(32))
    const f = await createExecutionFixture(pool, { executionWriteEpoch: 1n,
      governance: context => new PostgresModelGovernanceService(context, cipher) })
    cleanups.push(f.dispose)
    const root = await mkdtemp(join(tmpdir(), 'hgw-model-credential-admission-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const cfg = testConfig(root)
    const governance = new PostgresModelGovernanceService(f.context, cipher)
    const provider = { provider: 'org-company', displayName: 'Company', driver: 'pi-ai' as const,
      protocol: 'anthropic-messages' as const, baseURL: 'https://models.example/v1/', authMode: 'api-key' as const }
    await governance.upsertProvider({ ...provider, status: 'draft', credential: 'company-key' })
    await governance.upsertModel({ provider: provider.provider, model: 'reply', displayName: 'Reply', enabled: true,
      inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
    await governance.upsertProvider({ ...provider, status: 'enabled' })
    await governance.setUserAccess(f.admin.id, provider.provider, 'reply', true)
    await governance.setProjectAccess(f.project.id, provider.provider, 'reply', true)
    const { rows: [company] } = await pool.query<{ credential_ref: string }>(`SELECT credential_ref
      FROM harness.model_providers WHERE organization_id=$1 AND provider_key=$2`, [f.organizationId, provider.provider])
    const projectRef = projectProviderCredentialRef(f.project.id, 'local')
    await governance.mutateProjectModelSettings(f.project.id, [{ op: 'set', path: ['providers', 'local'],
      value: { api: 'anthropic-messages', baseURL: 'https://models.example/v1/', apiKeyEnv: projectRef,
        models: [{ id: 'reply', name: 'Reply' }] } }])
    await governance.setProjectCredential(f.project.id, projectRef, 'project-key')

    const repo = f.instances
    const personal = await repo.authenticateRuntimeControlToken(f.personal.token, pool, 1n)
    const project = await repo.authenticateRuntimeControlToken(f.project.token, pool, 1n)
    await repo.authenticateRuntimeControlToken(f.other.token, pool, 1n)
    expect(personal?.target.runtimeId).toBe(f.personal.runtimeId)
    expect(project?.target.runtimeId).toBe(f.project.runtimeId)
    repo.invalidateRuntimeTokenCache()
    expect(repo.personalExecutionCandidate(f.personal.token)).toEqual(personal)
    expect(repo.personalExecutionCandidate(f.project.token)).toBeNull()
    expect(repo.modelCredentialCandidate(f.personal.token)).toEqual(personal)
    expect(repo.modelCredentialCandidate(f.project.token)).toEqual(project)

    const timings = new OperationTimings(8)
    const runtime = Object.assign((...args: Parameters<typeof f.handler>) =>
      timings.run(args[0], args[1], () => f.handler(...args)), f.handler)
    const maintenanceGate = vi.fn(async (): Promise<WriteGateVerdict> => 'open')
    const runtimeAuthorize = vi.fn(async (req: Parameters<typeof runtimeBearerToken>[0]) =>
      await repo.authenticateRuntimeToken(runtimeBearerToken(req) ?? '') ?? false)
    const runtimeModelCredentialCandidate = vi.fn((req: Parameters<typeof runtimeBearerToken>[0]) =>
      repo.modelCredentialCandidate(runtimeBearerToken(req) ?? ''))
    const server = createGatewayServer({ cfg, maintenanceGate, users: new PostgresUserService(f.context, cfg),
      auth: new PostgresAuthService(f.context, cfg), projects: new PostgresProjectService(f.context, cfg),
      audit: new PostgresAuditService(f.context), instances: new InstanceManager(repo, cfg) }, {
      runtime, runtimeAuthorize, runtimeModelCredentialCandidate,
      runtimePersonalExecutionCandidate: req => repo.personalExecutionCandidate(runtimeBearerToken(req) ?? ''),
      runtimePersonalExecutionStopGate: () => 'open',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    }))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const credential = async (owner: typeof f.project, ref: string, status = 200) => {
      const id = randomUUID()
      const response = await fetch(base + RUNTIME_MODEL_CREDENTIAL_PATH, { method: 'POST',
        headers: { ...f.headers(owner), 'x-dsh-operation-id': id }, body: JSON.stringify({ ref }) })
      const body: unknown = await response.json()
      expect(response.status).toBe(status)
      if (response.ok) expect(response.headers.get('cache-control')).toBe('no-store')
      expect(timings.samples(id)[0]?.sql.governance.count).toBe(1)
      return body
    }
    expect(await credential(f.personal, company!.credential_ref)).toEqual({ configured: true, value: 'company-key' })
    expect(await credential(f.project, company!.credential_ref)).toEqual({ configured: true, value: 'company-key' })
    expect(await credential(f.project, projectRef)).toEqual({ configured: true, value: 'project-key' })
    expect(await credential(f.personal, projectRef)).toEqual({ configured: false })
    expect(await credential(f.other, projectRef)).toEqual({ configured: false })
    await governance.setProjectAccess(f.project.id, provider.provider, 'reply', false)
    expect(await credential(f.project, company!.credential_ref)).toEqual({ configured: false })
    await pool.query(`INSERT INTO harness.cluster_control(organization_id,mode,write_epoch) VALUES($1,'serving',2)`, [f.organizationId])
    expect(await credential(f.project, projectRef, 503)).toEqual({ error: 'stale-epoch' })
    expect(runtimeAuthorize).not.toHaveBeenCalled()
    expect(maintenanceGate).not.toHaveBeenCalled()

    await pool.query(`UPDATE harness.cluster_control SET write_epoch=1 WHERE organization_id=$1`, [f.organizationId])
    const sessionId = await f.session(f.project)
    runtimeModelCredentialCandidate.mockClear()
    const registered = await fetch(base + '/internal/runtime/execution/register-session', { method: 'POST',
      headers: f.headers(f.project), body: JSON.stringify({ sessionId }) })
    expect(registered.status).toBe(200)
    await registered.arrayBuffer()
    expect(runtimeAuthorize).toHaveBeenCalledOnce()
    expect(runtimeModelCredentialCandidate).not.toHaveBeenCalled()

    await pool.query('UPDATE harness.instances SET runtime_token_hash=$2 WHERE runtime_id=$1', [f.project.runtimeId, randomBytes(32)])
    expect(await credential(f.project, projectRef, 401)).toEqual({ error: 'invalid-runtime-token' })
    expect(runtimeAuthorize).toHaveBeenCalledOnce()
  })

  it('keeps parent admission, inheritance and identical relay message IDs in their originating Runtime', async () => {
    const f = await fixture(), parent = 'same-parent', child = 'same-child'
    const aOnly = 'only-first-parent'
    await register(f, f.personal, aOnly)
    expect((await f.call('register-session', { sessionId: 'foreign-child', parentSessionId: aOnly }, undefined, f.sibling)).status).toBe(404)
    const states: ExecutionIdentityState[] = []
    for (const runtime of [f.personal, f.sibling]) {
      await register(f, runtime, parent)
      await register(f, runtime, child, parent)
      const { state } = await enter(f, runtime, parent)
      const inherited = await f.call<ExecutionIdentityState>('inherit', { sessionId: child, parentSessionId: parent,
        inputs: state.inputs, scopeId: state.scopeId, primaryActorUserId: state.primaryActorUserId, unverifiedHistory: false }, undefined, runtime)
      expect(inherited).toMatchObject({ status: 200 })
      const relay = { sessionId: parent, senderSessionId: child, messageId: 'same-relay',
        inputs: inherited.body.inputs, scopeId: inherited.body.scopeId,
        primaryActorUserId: inherited.body.primaryActorUserId, unverifiedHistory: false }
      expect((await f.call('relay', relay, undefined, runtime)).status).toBe(200)
      expect((await f.call('relay', relay, undefined, runtime)).status).toBe(200)
      states.push(state)
    }
    expect((await f.call('inherit', { sessionId: child, parentSessionId: parent, inputs: states[0]!.inputs,
      scopeId: states[0]!.scopeId, primaryActorUserId: f.admin.id, unverifiedHistory: false }, undefined, f.sibling)).status).toBe(409)
    await register(f, f.sibling, 'fresh-child', parent)
    expect((await f.call('inherit', { sessionId: 'fresh-child', parentSessionId: parent, inputs: states[0]!.inputs,
      scopeId: states[0]!.scopeId, primaryActorUserId: f.admin.id, unverifiedHistory: false }, undefined, f.sibling)).status).toBe(403)
    expect((await pool.query('SELECT runtime_id FROM harness.execution_relays WHERE organization_id=$1', [f.organizationId])).rows).toHaveLength(2)
  })

  it('does not spread irreversible uncertainty or revisions to a sibling Session', async () => {
    const f = await fixture(), sessionId = 'same-session'
    for (const runtime of [f.personal, f.sibling]) { await register(f, runtime, sessionId); await enter(f, runtime, sessionId) }
    const before = await f.call('capture', { sessionId }, undefined, f.sibling)
    expect((await f.call('authorize', { sessionId, capability: 'auto-review', unverifiedHistory: true }, undefined, f.personal)).status).toBe(403)
    expect((await f.call('authorize', { sessionId, capability: 'auto-review' }, undefined, f.sibling)).status).toBe(200)
    expect(await f.call('capture', { sessionId }, undefined, f.sibling)).toEqual(before)
    expect(await f.call('capture', { sessionId }, undefined, f.personal)).toMatchObject({ status: 200, body: { unverifiedHistory: true } })
  })

  it('resolves legacy owner selectors by the exact node and disjoint generation and refuses a missing assignment', async () => {
    const f = await fixture(), sessionId = 'same-session', service = new GatewayExecutionIdentity(pool, f.context.nodeId)
    for (const runtime of [f.personal, f.sibling]) {
      await register(f, runtime, sessionId)
      const { state } = await enter(f, runtime, sessionId)
      const subject = { organizationId: f.organizationId, target: { kind: runtime.kind, id: runtime.id },
        generation: runtime.generation, userInternalId: runtime.uuid }
      await service.register(subject, { sessionId })
      expect(await service.capture(subject, { sessionId, scopeId: state.scopeId })).toEqual(state)
      await expect(service.capture({ ...subject, generation: f.sibling.generation + 999 }, { sessionId })).rejects.toMatchObject({ status: 409 })
      await expect(new GatewayExecutionIdentity(pool, randomUUID()).capture(subject, { sessionId })).rejects.toMatchObject({ status: 409 })
    }
  })

  it('records answers to equal question IDs independently and rejects another Runtime question scope', async () => {
    const f = await fixture(), sessionId = 'same-session'
    const states: ExecutionIdentityState[] = []
    for (const runtime of [f.personal, f.sibling]) {
      await register(f, runtime, sessionId)
      const { state } = await enter(f, runtime, sessionId)
      states.push(state)
      const answer = { sessionId, questionId: 'same-question', answer: { selected: ['yes'] }, scopeId: state.scopeId }
      const result = await f.call('question', answer, f.admin, runtime)
      expect(result).toMatchObject({ status: 200 })
      expect(await f.call('question', answer, f.admin, runtime)).toEqual(result)
    }
    expect((await f.call('question', { sessionId, questionId: 'another-question', answer: 'yes',
      scopeId: states[0]!.scopeId }, f.admin, f.sibling)).status).toBe(403)
    const rows = await pool.query("SELECT runtime_id FROM harness.execution_inputs WHERE organization_id=$1 AND kind='question'", [f.organizationId])
    expect(rows.rows).toHaveLength(2)
    expect(new Set(rows.rows.map(row => row.runtime_id)).size).toBe(2)
  })

  it('binds desktop confirmations to the Runtime while retaining a shared physical desktop lease', async () => {
    const f = await fixture(), sessionId = 'same-session', desktop = 'display-0'
    await new DesktopAccess(f.context).set({ kind: 'user', id: f.admin.id }, true, '0')
    const scopes = new Map<RuntimeId, string>()
    for (const runtime of [f.personal, f.sibling]) {
      await register(f, runtime, sessionId)
      scopes.set(runtime.runtimeId, (await enter(f, runtime, sessionId)).state.scopeId!)
    }
    const address = { sessionId, desktop }
    expect((await f.call('desktop-confirm', { ...address, confirmed: true }, f.admin, f.personal)).status).toBe(200)
    expect(await f.call('desktop-confirmation', address, f.admin, f.sibling)).toMatchObject({ status: 200, body: { confirmed: false } })
    expect((await f.call('desktop-authorize', address, undefined, f.sibling)).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...address, confirmed: true }, f.admin, f.sibling)).status).toBe(200)
    expect((await f.call('desktop-authorize', { ...address, scopeId: scopes.get(f.sibling.runtimeId) }, undefined, f.sibling)).status).toBe(200)
    expect((await f.call('desktop-authorize', { ...address, scopeId: scopes.get(f.personal.runtimeId) }, undefined, f.sibling)).status).toBe(403)
    const acquired = await f.call('/internal/runtime/desktop/acquire', { ...address,
      scopeId: scopes.get(f.personal.runtimeId), requestId: 'same-desktop-request' }, undefined, f.personal)
    expect(acquired).toMatchObject({ status: 200, body: { status: 'granted' } })
    expect(await f.call('/internal/runtime/desktop/acquire', { ...address, requestId: 'same-desktop-request' }, undefined, f.sibling))
      .toMatchObject({ status: 200, body: { status: 'queued' } })
    expect(await f.call('desktop-confirmation', address, f.admin, f.sibling))
      .toMatchObject({ status: 200, body: { confirmed: true, occupancy: { inUse: true, heldByThisSession: false } } })
    expect((await f.call('/internal/runtime/desktop/release', { ...address, grantId: acquired.body.grantId }, undefined, f.sibling)).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...address, confirmed: false }, f.admin, f.personal)).status).toBe(200)
    expect(await f.call('desktop-confirmation', address, f.admin, f.sibling)).toMatchObject({ status: 200, body: { confirmed: true } })
  })

  it('requires an immutable resource scope only when the requesting Runtime has one', async () => {
    const config: NodeResourceBudgetConfig = { sampleMs: 500, staleMs: 2_000, cpuTarget: 0.85, eventLoopTargetMs: 100,
      linuxMemoryReserveRatio: 0.1, maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65_536, maxWaitMs: 30_000 }
    const f = await fixture(config), sessionId = 'same-resource-session'
    for (const runtime of [f.personal, f.sibling, f.project, f.other, f.peerPersonal]) {
      expect(await f.call('/internal/runtime/resources/register', {}, undefined, runtime)).toMatchObject({ status: 200 })
    }
    for (const runtime of [f.personal, f.sibling]) await register(f, runtime, sessionId)
    const receipt = await f.admit(sessionId, f.admin, f.sibling)
    expect(await f.enter(sessionId, receipt, f.sibling)).toMatchObject({ status: 200 })
    const operation = (sequence: number) => ({ sequence, requestId: randomUUID(), kind: 'model', origin: { kind: 'session', sessionId } })
    const before = operation(1)
    expect(await f.call('/internal/runtime/resources/request', before, undefined, f.sibling)).toMatchObject({ status: 200, body: { state: 'queued' } })
    const scoped = await enter(f, f.personal, sessionId)
    const execution = new GatewayExecutionIdentity(pool, f.context.nodeId)
    for (const [runtime, expected] of [[f.personal, true], [f.sibling, false]] as const) {
      for (const explicit of [true, false]) {
        expect(await execution.hasScopes({ organizationId: f.organizationId, generation: runtime.generation,
          target: { kind: runtime.kind, id: runtime.id, ...(explicit ? { runtimeId: runtime.runtimeId } : {}) },
          userInternalId: runtime.uuid }, sessionId)).toBe(expected)
      }
    }
    const after = operation(2)
    expect(await f.call('/internal/runtime/resources/request', after, undefined, f.sibling)).toMatchObject({ status: 200, body: { state: 'queued' } })
    expect(await f.call('/internal/runtime/resources/statuses', { operations: [before, after].map(({ sequence, requestId }) => ({ sequence, requestId })) }, undefined, f.sibling))
      .toEqual({ status: 200, body: [{ state: 'queued' }, { state: 'queued' }] })
    expect((await f.call('/internal/runtime/resources/request', operation(1), undefined, f.personal)).status).toBe(403)
    expect((await f.call('/internal/runtime/resources/request', { ...operation(3), origin: { kind: 'session', sessionId, scopeId: scoped.state.scopeId } }, undefined, f.sibling)).status).toBe(403)
    for (const { sequence, requestId } of [before, after]) {
      expect(await f.call('/internal/runtime/resources/finish', { sequence, requestId, outcome: 'not-started' }, undefined, f.sibling)).toMatchObject({ status: 200 })
    }
  })

  it('resolves delayed legacy accounting from immutable witnesses and refuses mixed or foreign Runtime witnesses', async () => {
    const f = await fixture(), sessionId = 'same-session', records: Array<Awaited<ReturnType<typeof enter>>> = []
    for (const runtime of [f.personal, f.sibling]) { await register(f, runtime, sessionId); records.push(await enter(f, runtime, sessionId)) }
    const attribution = (record: typeof records[number], runtime: { kind: 'user' | 'project'; id: number; runtimeId?: RuntimeId }) => ({
      organizationId: f.organizationId, sessionId, runtime, inputIds: record.state.inputs, primaryActorUserId: f.admin.id,
    })
    for (const [index, runtime] of [f.personal, f.sibling].entries()) {
      await expect(verifyExecutionAttribution(pool, attribution(records[index]!, runtime))).resolves.toBeUndefined()
      await expect(verifyExecutionAttribution(pool, attribution(records[index]!, { kind: 'user', id: f.admin.id }))).resolves.toBeUndefined()
    }
    await expect(verifyExecutionAttribution(pool, attribution(records[0]!, f.sibling))).rejects.toMatchObject({ status: 403 })
    await expect(verifyExecutionAttribution(pool, { ...attribution(records[0]!, { kind: 'user', id: f.admin.id }),
      inputIds: records.flatMap(record => record.state.inputs) })).rejects.toMatchObject({ status: 403 })
    const unentered = await f.admit(sessionId, f.admin, f.sibling, 'not-entered')
    await expect(verifyExecutionAttribution(pool, { ...attribution(records[1]!, f.sibling), inputIds: [unentered.inputId] })).rejects.toMatchObject({ status: 403 })
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    await expect(verifyExecutionAttribution(pool, attribution(records[0]!, f.personal))).resolves.toBeUndefined()
  })

  it('rejects persisted child records that name a Session registered only in another Runtime', async () => {
    const f = await fixture(), sessionId = 'only-first-session'
    await register(f, f.personal, sessionId)
    const coordinates = [f.organizationId, f.admin.id, sessionId, f.sibling.runtimeId]
    await expect(pool.query(`INSERT INTO harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,parent_session_id)
      VALUES($1,'user',$2,'foreign-child',$4,$3)`, coordinates)).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`INSERT INTO harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,
      message_id,kind,content_hash,created_by_user_id,actor_user_ids) VALUES($1,'user',$2,$3,$4,'foreign','message',$5,$6,ARRAY[$6::uuid])`,
    [...coordinates, 'a'.repeat(64), f.admin.uuid])).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`INSERT INTO harness.execution_relays(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,request_hash)
      VALUES($1,'user',$2,$3,$4,'foreign',$5)`, [...coordinates, 'a'.repeat(64)])).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`INSERT INTO harness.execution_scopes(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,fingerprint,revision,input_ids,unverified)
      VALUES($1,'user',$2,$3,$4,'foreign',1,'{}',true)`, coordinates)).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(`INSERT INTO harness.desktop_session_confirmations(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,
      node_id,generation,desktop,user_id,user_policy_revision,project_policy_revision) VALUES($1,'user',$2,$3,$4,$5,1,'display-0',$6,1,0)`,
    [...coordinates, f.context.nodeId, f.admin.uuid])).rejects.toMatchObject({ code: '23503' })
  })

  it('bounds nested admission to one Runtime when independent Session lineages share reversed IDs', async () => {
    const config: NodeResourceBudgetConfig = { sampleMs: 500, staleMs: 2_000, cpuTarget: 0.85, eventLoopTargetMs: 100,
      linuxMemoryReserveRatio: 0.1, maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 65_536, maxWaitMs: 30_000 }
    const f = await fixture(config)
    await register(f, f.personal, 'a'); await register(f, f.personal, 'b', 'a')
    await register(f, f.sibling, 'b'); await register(f, f.sibling, 'a', 'b')
    const bounded = createPostgresPool(databaseUrl!, { max: 2, options: '-c statement_timeout=2000' })
    cleanups.push(() => bounded.end())
    const budget = new NodeResourceBudget(bounded, f.organizationId, f.context.nodeId, config)
    const subject = (runtime: Runtime) => ({ organizationId: f.organizationId, target: { kind: runtime.kind, id: runtime.id, runtimeId: runtime.runtimeId },
      generation: runtime.generation, ...(runtime.kind === 'user' ? { userInternalId: runtime.uuid } : { projectInternalId: runtime.uuid }) })
    for (const runtime of [f.personal, f.sibling, f.project, f.other, f.peerPersonal]) await budget.register(subject(runtime))
    await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2", [f.organizationId, f.context.nodeId])
    const request = (sequence: number, sessionId: string) => ({ requestId: randomUUID() as ResourceOperationId,
      sequence, sessionId, kind: 'model' as const, actorId: f.admin.id, projectId: 0 })
    expect(await budget.request(subject(f.personal), request(1, 'a'))).toEqual({ state: 'active' })
    expect(await budget.request(subject(f.personal), request(2, 'b'))).toMatchObject({ state: 'refused', reason: 'nested-capacity' })
    expect(await budget.request(subject(f.sibling), request(1, 'a'))).toEqual({ state: 'queued' })
  })
})
