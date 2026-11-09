/** Real bearer, principal, execution-scope and PostgreSQL admission integration. @module */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeResourceBudgetConfig } from '../src/node-resource-budget.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const config: NodeResourceBudgetConfig = {
  sampleMs: 500, staleMs: 2000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
  maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 30_000,
}
const path = (action: string): string => `/internal/runtime/resources/${action}`
const operation = (sequence: number) => ({ sequence, requestId: randomUUID() })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('Runtime resource HTTP admission', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const f = await createExecutionFixture(pool, { resourceBudget: config })
    cleanups.push(f.dispose)
    for (const runtime of [f.project, f.other, f.personal, f.peerPersonal]) {
      expect(await f.call(path('register'), {}, undefined, runtime)).toEqual({ status: 200, body: { nextSequence: 1, policy: config } })
    }
    const grant = (count: number) => pool.query(`UPDATE harness.node_resource_state SET credits=credits+$3,valid_until='infinity'
      WHERE organization_id=$1 AND node_id=$2`, [f.organizationId, f.context.nodeId, count])
    return { ...f, grant }
  }

  async function stewardFixture() {
    const f = await fixture()
    await pool.query("UPDATE harness.projects SET kind='steward',steward_node_id=$2 WHERE id=$1", [f.project.uuid, f.context.nodeId])
    await pool.query('DELETE FROM harness.project_members WHERE project_id=$1', [f.project.uuid])
    const otherNode = (await pool.query<{ id: string }>(`INSERT INTO harness.compute_nodes(organization_id,name)
      VALUES($1,'Other Steward computer') RETURNING id`, [f.organizationId])).rows[0]!.id
    await pool.query(`INSERT INTO harness.steward_access_policies(organization_id,user_id,node_id,enabled,revision)
      VALUES($1,$2,$3,true,1),($1,$2,$4,true,1)`, [f.organizationId, f.admin.uuid, f.context.nodeId, otherNode])
    const qualify = (enabled: boolean, database: Pool | PoolClient = pool) => database.query(`UPDATE harness.steward_access_policies SET enabled=$4,revision=revision+1
      WHERE organization_id=$1 AND user_id=$2 AND node_id=$3`, [f.organizationId, f.admin.uuid, f.context.nodeId, enabled])
    return { ...f, qualify, collaboration: new PostgresCollaborationService(f.context) }
  }

  it('reports bounded resource contention through HTTP and admits the exact operation after recovery', async () => {
    const boundedPool = createPostgresPool(databaseUrl!, { max: 8, lock_timeout: 40, statement_timeout: 300 })
    cleanups.push(() => boundedPool.end())
    const f = await createExecutionFixture(boundedPool, { resourceBudget: config })
    cleanups.push(f.dispose)
    for (const runtime of [f.project, f.other, f.peerPersonal]) {
      expect((await f.call(path('register'), {}, undefined, runtime)).status).toBe(200)
    }
    const transcript: unknown[] = []
    transcript.push(await f.call(path('register'), {}, undefined, f.personal))
    await pool.query(`UPDATE harness.node_resource_state SET credits=1,valid_until='infinity'
      WHERE organization_id=$1 AND node_id=$2`, [f.organizationId, f.context.nodeId])
    const holder = await pool.connect()
    cleanups.push(async () => { await holder.query('ROLLBACK'); holder.release() })
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
      [f.organizationId, f.context.nodeId])
    const request = { ...operation(1), kind: 'process', origin: { kind: 'runtime' } }
    transcript.push(await f.call(path('request'), request, undefined, f.personal))
    expect((await pool.query('SELECT 1 FROM harness.node_resource_requests WHERE organization_id=$1', [f.organizationId])).rowCount).toBe(0)
    await holder.query('COMMIT')
    transcript.push(await f.call(path('request'), request, undefined, f.personal))
    transcript.push(await f.call(path('request'), request, undefined, f.personal))
    expect((await pool.query('SELECT 1 FROM harness.node_resource_requests WHERE organization_id=$1', [f.organizationId])).rowCount).toBe(1)
    transcript.push(await f.call(path('finish'), { sequence: request.sequence, requestId: request.requestId, outcome: 'quiescent' }, undefined, f.personal))
    expect(transcript).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "nextSequence": 1,
            "policy": {
              "cpuTarget": 0.85,
              "eventLoopTargetMs": 100,
              "linuxMemoryReserveRatio": 0.1,
              "maxQueued": 16,
              "maxQueuedBytes": 65536,
              "maxQueuedPerProject": 8,
              "maxQueuedPerUser": 8,
              "maxWaitMs": 30000,
              "sampleMs": 500,
              "staleMs": 2000,
            },
          },
          "status": 200,
        },
        {
          "body": {
            "error": "resource-database-busy",
          },
          "status": 503,
        },
        {
          "body": {
            "state": "active",
          },
          "status": 200,
        },
        {
          "body": {
            "state": "active",
          },
          "status": 200,
        },
        {
          "body": {},
          "status": 200,
        },
      ]
    `)
  })

  it('derives queue ownership from the entire immutable execution scope and preserves it on retry', async () => {
    const f = await fixture()
    const sessionId = await f.session()
    const input = await f.admit(sessionId, f.member)
    const entered = await f.call<{ scopeId: string }>('enter', { sessionId, inputId: input.inputId,
      messageId: input.messageId, contentHash: input.contentHash, currentScopeId: null })
    expect(entered.status).toBe(200)
    const request = { ...operation(1), kind: 'model', origin: { kind: 'session', sessionId, scopeId: entered.body.scopeId } }
    await f.grant(1)
    expect(await f.call(path('request'), { ...request, actorId: f.admin.id })).toMatchObject({ status: 400 })
    expect(await f.call(path('request'), request)).toEqual({ status: 200, body: { state: 'active' } })
    expect(await f.call(path('request'), request)).toEqual({ status: 200, body: { state: 'active' } })
    const rows = await pool.query<{ actor: string; project: string; total: string }>(`SELECT actor_public_id::text actor,
      project_public_id::text project,count(*)::text total FROM harness.node_resource_requests
      WHERE organization_id=$1 GROUP BY actor_public_id,project_public_id`, [f.organizationId])
    expect(rows.rows).toEqual([{ actor: String(f.member.id), project: String(f.project.id), total: '1' }])
    expect(await f.call(path('request'), { ...request, requestId: randomUUID() })).toEqual({ status: 409, body: { error: 'resource-request-conflict' } })
    expect(await f.call(path('request'), { ...request, sequence: 2 })).toEqual({ status: 409, body: { error: 'resource-operation-conflict' } })
  })

  it('denies a queued origin after any captured participant loses eligibility and permits its exact cancellation', async () => {
    const f = await fixture()
    const sessionId = await f.session()
    for (const person of [f.admin, f.member]) await f.enter(sessionId, await f.admit(sessionId, person))
    const request = { ...operation(1), kind: 'process', origin: { kind: 'session', sessionId } }
    expect(await f.call(path('request'), request)).toEqual({ status: 200, body: { state: 'queued' } })
    await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.member.uuid])
    expect(await f.call(path('request'), request)).toMatchObject({ status: 403, body: { error: 'execution-forbidden' } })
    const next = await f.call(path('register'), {})
    expect(next.body).toMatchObject({ nextSequence: 2 })
    expect(await f.call(path('finish'), { ...request, origin: undefined, kind: undefined, outcome: 'not-started' })).toMatchObject({ status: 200 })
    expect((await f.resourceBudget!.snapshot()).kinds.process.queued).toBe(0)
  })

  it('requires the exact operation identity for polls and completion, including cancellation', async () => {
    const f = await fixture()
    const ref = operation(1)
    await f.grant(1)
    expect(await f.call(path('request'), { ...ref, kind: 'process', origin: { kind: 'runtime' } })).toMatchObject({ status: 200, body: { state: 'active' } })
    const other = { ...ref, requestId: randomUUID() }
    for (const outcome of ['not-started', 'quiescent', 'uncertain']) {
      expect(await f.call(path('finish'), { ...other, outcome })).toEqual({ status: 409, body: { error: 'resource-owner-mismatch' } })
    }
    expect(await f.call(path('statuses'), { operations: [other] })).toEqual({ status: 409, body: { error: 'resource-owner-mismatch' } })
    expect(await f.call(path('statuses'), { operations: [{ ...ref, requestId: ref.requestId.toUpperCase() }] })).toEqual({ status: 200, body: [{ state: 'active' }] })
    expect((await f.resourceBudget!.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 0 })
    expect(await f.call(path('finish'), { ...ref, outcome: 'uncertain' })).toMatchObject({ status: 200 })
    expect((await f.resourceBudget!.snapshot()).kinds.process).toMatchObject({ active: 1, uncertain: 1 })
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' })).toMatchObject({ status: 200 })
    expect((await f.resourceBudget!.snapshot()).kinds.process.active).toBe(0)
  })

  it('accepts exact cleanup after account revocation and while stopping, but no other API access', async () => {
    const f = await fixture()
    const refs = [operation(1), operation(2)]
    await f.grant(2)
    for (const ref of refs) expect(await f.call(path('request'), { ...ref, kind: 'model', origin: { kind: 'runtime' } }, undefined, f.personal)).toMatchObject({ status: 200, body: { state: 'active' } })
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    expect(await f.call(path('register'), {}, undefined, f.personal)).toMatchObject({ status: 401 })
    expect(await f.call(path('finish'), { ...refs[0], outcome: 'quiescent' }, undefined, f.personal)).toMatchObject({ status: 200 })
    await f.instances.markStopping({ kind: 'user', id: f.personal.id }, f.personal.generation)
    expect(await f.call(path('statuses'), { operations: refs }, undefined, f.personal)).toMatchObject({ status: 401 })
    expect(await f.call('capture', { sessionId: randomUUID() }, undefined, f.personal)).toMatchObject({ status: 401 })
    expect(await f.call(path('finish'), { ...refs[1], outcome: 'quiescent' }, undefined, f.personal)).toMatchObject({ status: 200 })
    await f.instances.markStopped({ kind: 'user', id: f.personal.id }, f.personal.generation)
    expect(await f.call(path('finish'), { ...refs[1], outcome: 'quiescent' }, undefined, f.personal)).toMatchObject({ status: 401 })
    expect((await f.resourceBudget!.snapshot()).kinds.model.active).toBe(0)
  })

  it('rejects foreign node tokens, obsolete generations and cross-Runtime operation completion', async () => {
    const f = await fixture()
    const ref = operation(1)
    await f.grant(1)
    expect(await f.call(path('request'), { ...ref, kind: 'process', origin: { kind: 'runtime' } })).toMatchObject({ status: 200 })
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' }, undefined, f.personal)).toEqual({ status: 409, body: { error: 'resource-unknown-operation' } })
    const newToken = randomUUID()
    await f.instances.markStopped({ kind: 'project', id: f.project.id }, f.project.generation)
    await f.instances.beginStart({ kind: 'project', id: f.project.id }, Date.now(), createHash('sha256').update(newToken).digest())
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' })).toMatchObject({ status: 401 })
    const replacement = { ...f.project, token: newToken, generation: f.project.generation + 1 }
    expect(await f.call(path('register'), {}, undefined, replacement)).toMatchObject({ status: 200, body: { nextSequence: 1 } })
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' }, undefined, replacement)).toEqual({ status: 409, body: { error: 'resource-unknown-operation' } })
    const otherNode = (await pool.query<{ id: string }>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id', [f.organizationId, randomUUID()])).rows[0]!.id
    await f.instances.markStopped({ kind: 'project', id: f.project.id }, replacement.generation)
    await pool.query('UPDATE harness.instances SET assigned_node_id=$2 WHERE organization_id=$1 AND project_id=$3', [f.organizationId, otherNode, f.project.uuid])
    const remoteToken = randomUUID()
    const remoteGeneration = await new PostgresInstanceRepository({ ...f.context, nodeId: otherNode }, 48000)
      .beginStart({ kind: 'project', id: f.project.id }, Date.now(), createHash('sha256').update(remoteToken).digest())
    expect(await f.call(path('register'), {}, undefined, { ...f.project, token: remoteToken, generation: remoteGeneration })).toMatchObject({ status: 401 })
    expect((await f.resourceBudget!.snapshot()).kinds.process.active).toBe(1)
  })

  it('denies new work for a disabled organization while retaining exact cleanup', async () => {
    const f = await fixture()
    const ref = operation(1)
    await f.grant(1)
    expect(await f.call(path('request'), { ...ref, kind: 'model', origin: { kind: 'runtime' } })).toMatchObject({ status: 200, body: { state: 'active' } })
    await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
    expect(await f.call(path('register'), {})).toMatchObject({ status: 401 })
    expect(await f.call(path('statuses'), { operations: [ref] })).toMatchObject({ status: 401 })
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' })).toMatchObject({ status: 200 })
    expect((await f.resourceBudget!.snapshot()).kinds.model.active).toBe(0)
  })

  it('withdraws a deleted personal owner without dropping its outstanding cleanup', async () => {
    const f = await fixture()
    const ref = operation(1)
    await f.grant(1)
    expect(await f.call(path('request'), { ...ref, kind: 'process', origin: { kind: 'runtime' } }, undefined, f.personal)).toMatchObject({ status: 200 })
    await pool.query('UPDATE harness.users SET deleted_at=clock_timestamp() WHERE id=$1', [f.admin.uuid])
    expect(await f.call(path('register'), {}, undefined, f.personal)).toMatchObject({ status: 401 })
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' }, undefined, f.personal)).toMatchObject({ status: 200 })
  })

  it('resolves signed agentless actors freshly and rejects forged, restricted or foreign principals', async () => {
    const f = await fixture()
    const request = { ...operation(1), kind: 'process', origin: { kind: 'principal', assertion: f.headers(f.project, f.member)[PRINCIPAL_HEADER]! } }
    for (const assertion of ['invalid', f.headers(f.other, f.member)[PRINCIPAL_HEADER]!]) {
      expect(await f.call(path('request'), { ...request, origin: { kind: 'principal', assertion } })).toMatchObject({ status: 403 })
    }
    const restricted = f.principals.issue({ user: f.admin, runtime: { kind: 'project', id: f.project.id, generation: f.project.generation },
      scope: { kind: 'project', projectId: f.project.id, projectName: 'Project', mode: 'ro' }, purpose: 'archive-read' })
    expect(await f.call(path('request'), { ...request, origin: { kind: 'principal', assertion: restricted } })).toMatchObject({ status: 403 })
    expect(await f.call(path('request'), request)).toMatchObject({ status: 200, body: { state: 'queued' } })
    await pool.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3', [f.organizationId, f.project.uuid, f.member.uuid])
    expect(await f.call(path('request'), request)).toMatchObject({ status: 403 })
    expect(await f.call(path('finish'), { sequence: request.sequence, requestId: request.requestId, outcome: 'not-started' })).toMatchObject({ status: 200 })
  })

  it('requires current Steward qualification on the resource Runtime computer', async () => {
    const f = await stewardFixture()
    expect((await f.collaboration.projectForUser(f.project.id, f.admin.id))?.mode).toBe('rw')
    const ref = operation(1)
    const origin = { kind: 'principal', assertion: f.headers(f.project, f.admin)[PRINCIPAL_HEADER]! }
    const request = { ...ref, kind: 'process', origin }
    const transcript = [await f.call(path('request'), request)]
    await f.qualify(false)
    expect(await f.collaboration.projectForUser(f.project.id, f.admin.id)).toBeNull()
    await f.grant(1)
    transcript.push(await f.call(path('statuses'), { operations: [ref] }))
    transcript.push(await f.call(path('request'), request))
    transcript.push(await f.call(path('request'), { ...request, ...operation(2) }))
    transcript.push(await f.call(path('finish'), { ...ref, outcome: 'not-started' }))
    const snapshot = await f.resourceBudget!.snapshot()
    expect(transcript).toEqual([
      { status: 200, body: { state: 'queued' } },
      { status: 200, body: [{ state: 'refused', reason: 'authority-unavailable' }] },
      { status: 403, body: { error: 'execution-forbidden', message: 'resource principal is no longer eligible' } },
      { status: 403, body: { error: 'execution-forbidden', message: 'resource principal is no longer eligible' } },
      { status: 200, body: {} },
    ])
    expect(snapshot.kinds.process).toMatchObject({ active: 0, queued: 0, uncertain: 0 })
    await f.qualify(true)
    await f.grant(1)
    const restored = operation(2)
    expect(await f.call(path('request'), { ...request, ...restored })).toEqual({ status: 200, body: { state: 'active' } })
    expect(await f.call(path('finish'), { ...restored, outcome: 'quiescent' })).toEqual({ status: 200, body: {} })
  })

  it('withdraws Steward execution scopes and queued model work with the local qualification', async () => {
    const f = await stewardFixture()
    const sessionId = await f.session()
    const input = await f.admit(sessionId, f.admin)
    const entered = await f.call<{ scopeId: string }>('enter', { sessionId, inputId: input.inputId,
      messageId: input.messageId, contentHash: input.contentHash, currentScopeId: null })
    expect(entered.status).toBe(200)
    const authorization = { sessionId, scopeId: entered.body.scopeId, capability: 'execute' }
    expect(await f.call('authorize', authorization)).toMatchObject({ status: 200 })
    const ref = operation(1)
    const request = { ...ref, kind: 'model', origin: { kind: 'session', sessionId, scopeId: authorization.scopeId } }
    expect(await f.call(path('request'), request)).toEqual({ status: 200, body: { state: 'queued' } })

    const writer = await pool.connect()
    let pending: ReturnType<typeof f.call>
    try {
      await writer.query('BEGIN')
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
      await writer.query('SELECT 1 FROM harness.users WHERE id=$1 FOR UPDATE', [f.admin.uuid])
      await f.qualify(false, writer)
      pending = f.call('authorize', authorization)
      void pending.catch(() => { /* The awaited result below reports a failed request. */ })
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity activity WHERE $1::int=ANY(pg_blocking_pids(activity.pid))
        AND activity.query LIKE '%FOR SHARE OF u,m%') waiting`, [pid])).rows[0]!.waiting, { timeout: 5000 }).toBe(true)
      await writer.query('COMMIT')
    } finally {
      try { await writer.query('ROLLBACK') } finally { writer.release() }
    }
    await f.grant(1)
    const denied = [
      await pending,
      await f.call(path('request'), request),
      await f.call(path('statuses'), { operations: [ref] }),
    ]
    expect(denied).toMatchObject([
      { status: 403, body: { error: 'execution-forbidden' } },
      { status: 403, body: { error: 'execution-forbidden' } },
      { status: 200, body: [{ state: 'refused', reason: 'authority-unavailable' }] },
    ])
    expect(await f.call(path('finish'), { ...ref, outcome: 'not-started' })).toEqual({ status: 200, body: {} })
    await f.qualify(true)
    expect(await f.call('authorize', authorization)).toMatchObject({ status: 200 })
  })

  it('bounds malformed messages and batches before database work and isolates the cleanup method', async () => {
    const f = await fixture()
    const invalid = [null, {}, { ...operation(1), kind: 'model', origin: { kind: 'runtime', actorId: f.member.id } },
      { ...operation(1), kind: 'model', origin: { kind: 'session', sessionId: 's', scopeId: 'invalid' } },
      { ...operation(1), sequence: 0, kind: 'model', origin: { kind: 'runtime' } }]
    for (const body of invalid) expect(await f.call(path('request'), body)).toEqual({ status: 400, body: { error: 'resource-message' } })
    expect(await f.call(path('statuses'), { operations: Array.from({ length: 1025 }, () => operation(1)) })).toMatchObject({ status: 413 })
    expect(await f.call(path('statuses'), { operations: Array.from({ length: 513 }, () => operation(1)) })).toEqual({ status: 400, body: { error: 'resource-message' } })
    expect(await f.call(path('register'), { extra: 'x'.repeat(64 * 1024) })).toMatchObject({ status: 413 })
    expect(await f.call(path('no-such-action'), {})).toEqual({ status: 404, body: { error: 'resource-endpoint' } })
    const invalidJson = await fetch(`${f.base}${path('request')}`, { method: 'POST', headers: f.headers(f.project), body: '{' })
    expect(invalidJson.status).toBe(400)
    await invalidJson.arrayBuffer()
    const wrongMethod = await fetch(`${f.base}${path('finish')}`, { headers: f.headers(f.project) })
    expect(wrongMethod.status).toBe(405)
    await wrongMethod.arrayBuffer()
    await f.instances.markStopping({ kind: 'project', id: f.project.id }, f.project.generation)
    const response = await fetch(`${f.base}${path('finish')}`, { headers: f.headers(f.project) })
    expect(response.status).toBe(401)
  })

  it('fences an unstarted registration before accepting a delayed request', async () => {
    const f = await fixture()
    const ref = operation(1)
    expect(await f.call(path('finish'), { ...ref, outcome: 'not-started' })).toMatchObject({ status: 200 })
    await f.grant(1)
    expect(await f.call(path('request'), { ...ref, kind: 'model', origin: { kind: 'runtime' } })).toEqual({ status: 200, body: { state: 'closed' } })
    expect(await f.call(path('register'), {})).toMatchObject({ body: { nextSequence: 2 } })
    expect((await f.resourceBudget!.snapshot()).kinds.model.active).toBe(0)
  })

  it('rechecks every stored scope participant at grant without releasing unconfirmed work', async () => {
    const f = await fixture()
    const sessionId = await f.session()
    let scopeId: string | null = null
    for (const person of [f.admin, f.member]) {
      const input = await f.admit(sessionId, person)
      const entered: { status: number; body: { scopeId: string } } = await f.call<{ scopeId: string }>('enter', { sessionId, inputId: input.inputId,
        messageId: input.messageId, contentHash: input.contentHash, currentScopeId: scopeId })
      expect(entered.status).toBe(200)
      scopeId = entered.body.scopeId
    }
    const ref = operation(1)
    expect(await f.call(path('request'), { ...ref, kind: 'model', origin: { kind: 'session', sessionId, scopeId } }))
      .toMatchObject({ status: 200, body: { state: 'queued' } })
    expect(await f.call(path('request'), { ...operation(2), kind: 'model', origin: { kind: 'session', sessionId } }))
      .toMatchObject({ status: 403 })
    await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.admin.uuid])
    await f.grant(1)
    expect(await f.call(path('statuses'), { operations: [ref] })).toEqual({ status: 200,
      body: [{ state: 'refused', reason: 'authority-unavailable' }] })
    expect((await f.resourceBudget!.snapshot()).kinds.model.active).toBe(1)
    expect(await f.call(path('finish'), { ...ref, outcome: 'not-started' })).toMatchObject({ status: 200 })
    expect((await f.resourceBudget!.snapshot()).kinds.model.active).toBe(0)
  })

  it('uses the accepted principal identity after assertion expiry and still checks current eligibility', async () => {
    const f = await fixture()
    const ref = operation(1)
    const origin = { kind: 'principal', assertion: f.headers(f.project, f.member)[PRINCIPAL_HEADER]! }
    expect(await f.call(path('request'), { ...ref, kind: 'process', origin })).toMatchObject({ status: 200, body: { state: 'queued' } })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 120_000)
      expect(() => f.principals.verify(origin.assertion)).toThrow('expired')
      await f.grant(1)
      expect(await f.call(path('statuses'), { operations: [ref] })).toEqual({ status: 200, body: [{ state: 'active' }] })
      await pool.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3',
        [f.organizationId, f.project.uuid, f.member.uuid])
      expect(await f.call(path('statuses'), { operations: [ref] })).toEqual({ status: 200,
        body: [{ state: 'refused', reason: 'authority-unavailable' }] })
    } finally { vi.useRealTimers() }
    expect(await f.call(path('finish'), { ...ref, outcome: 'quiescent' })).toMatchObject({ status: 200 })
  })

  it('retains administrative requirements through queueing and rejects inconsistent durable origins', async () => {
    const f = await fixture()
    const ref = operation(1)
    const assertion = f.principals.issue({ user: f.admin,
      runtime: { kind: 'project', id: f.project.id, generation: f.project.generation, runtimeId: f.project.runtimeId },
      scope: { kind: 'project', projectId: f.project.id, projectName: 'Project', mode: 'rw' }, purpose: 'plugin-admin' })
    expect(await f.call(path('request'), { ...ref, kind: 'process', origin: { kind: 'principal', assertion } }))
      .toMatchObject({ status: 200, body: { state: 'queued' } })
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.admin.uuid])
    await f.grant(1)
    expect(await f.call(path('statuses'), { operations: [ref] })).toEqual({ status: 200,
      body: [{ state: 'refused', reason: 'authority-unavailable' }] })
    for (const update of ["origin_kind='session'", "origin_kind='runtime'", "origin_kind=NULL"]) {
      await expect(pool.query(`UPDATE harness.node_resource_requests SET ${update} WHERE organization_id=$1`, [f.organizationId]))
        .rejects.toMatchObject({ code: '23514' })
    }
    expect(await f.call(path('finish'), { ...ref, outcome: 'not-started' })).toMatchObject({ status: 200 })
  })
})
