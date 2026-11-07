/** Real Runtime credentials preserve independent execution identities for equal Host Session IDs. @module */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
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
    const f = await createExecutionFixture(pool, { resourceBudget })
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
