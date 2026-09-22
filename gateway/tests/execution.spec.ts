import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { verifyExecutionAttribution, type ExecutionIdentityState } from '../src/execution-identity.ts'
import type { GatewayAccessMonitor } from '../src/access-invalidation.ts'
import { barrier } from './barrier.ts'
import { createExecutionFixture, type Receipt } from './execution-fixture.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
let cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup = [] })
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
async function fixture(options: { executionWatchHeartbeatMs?: number } = {}) {
  const value = await createExecutionFixture(pool, options)
  cleanup.push(value.dispose)
  return value
}

describePg('Gateway execution identities', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('materializes an authorized header-only project flush before immutable registration', async () => {
    const f = await fixture(), id = randomUUID()
    const created = await f.call<{ authorization: string }>('/internal/runtime/session/create', {
      header: { id, version: 3, createdAt: Date.now() }, visibility: 'project',
    }, f.admin)
    expect(created.status).toBe(200)
    const append = { sessionId: id, batchId: randomUUID(), events: [], creationAuthorization: created.body.authorization }
    expect((await f.call('/internal/runtime/session/append', append)).status).toBe(200)
    expect(await f.conversations.readHeader(id)).toMatchObject({ id, projectId: f.project.uuid })
    expect((await f.call('/internal/runtime/session/append', append)).status).toBe(200)
    expect((await f.call('register-session', { sessionId: id })).status).toBe(200)
    expect((await f.call('register-session', { sessionId: id })).status).toBe(200)
    expect((await f.call('register-session', { sessionId: id }, undefined, f.other)).status).toBe(403)
    expect((await f.call('register-session', { sessionId: id, isSeeded: true })).status).toBe(403)
    expect((await f.call('/internal/runtime/session/append', { ...append, sessionId: randomUUID() })).status).toBe(400)
  })

  it('rejects caller actors, wrong bindings, and unverified historical participant fields', async () => {
    const f = await fixture(), id = await f.session(), otherId = await f.session()
    await f.conversations.append(id, randomUUID(), [{ seq: 0, time: Date.now(), type: 'user/message',
      data: { content: [{ type: 'text', text: 'unverified source' }], source: { kind: 'user', participant: { userId: f.admin.id, role: 'admin' } } },
      surfaceOp: 'append' }])
    expect((await f.call('authorize', { sessionId: id, capability: 'plugin-management' })).status).toBe(403)
    const receipt = await f.admit(id)
    const bound = { sessionId: id, inputId: receipt.inputId, messageId: receipt.messageId, contentHash: receipt.contentHash }
    expect((await f.call('input', { sessionId: id, messageId: 'fake', kind: 'message', contentHash: hash('fake'), actors: [{ userId: f.admin.id }] }, f.member)).status).toBe(400)
    expect((await f.call('input', { sessionId: id, messageId: 'q', kind: 'question', contentHash: hash('q') }, f.admin)).status).toBe(400)
    expect((await f.call('enter', { ...bound, contentHash: hash('changed') })).status).toBe(403)
    expect((await f.call('enter', { ...bound, messageId: 'other' })).status).toBe(403)
    expect((await f.call('enter', { ...bound, sessionId: otherId })).status).toBe(403)
    expect((await f.call('enter', bound, undefined, f.other)).status).not.toBe(200)
    expect((await f.call('authorize', { sessionId: id, capability: 'execute', actors: [{ userId: f.admin.id }] })).status).toBe(400)
    expect((await f.enter(id, receipt)).status).toBe(200)
    expect((await f.call('authorize', { sessionId: id, capability: 'plugin-management' })).status).toBe(200)
    await expect(pool.query('UPDATE harness.execution_inputs SET content_hash=$2 WHERE id=$1', [receipt.inputId, hash('mutation')])).rejects.toThrow('immutable')
  })

  it('preserves A and B after queue edits and refuses fresh privileges after revocation', async () => {
    const f = await fixture(), id = await f.session()
    const first = await f.admit(id)
    expect((await f.enter(id, first)).status).toBe(200)
    const editBody = { sessionId: id, messageId: first.messageId, kind: 'message', contentHash: hash('B edit'), previousInputId: first.inputId }
    const second = await f.call<Receipt>('input', editBody, f.member)
    expect(second.status).toBe(200)
    expect(second.body.actors).toEqual([{ userId: f.admin.id }, { userId: f.member.id }])
    expect((await f.call<Receipt>('input', editBody, f.member)).body.inputId).toBe(second.body.inputId)
    expect((await f.call('input', { ...editBody, previousInputId: undefined }, f.member)).status).toBe(409)
    const entered = await f.enter(id, { ...second.body, messageId: first.messageId, contentHash: editBody.contentHash })
    expect(entered.body.actors).toHaveLength(2)
    expect(entered.body.primaryActorUserId).toBe(f.member.id)
    const repeated = await f.enter(id, first)
    expect(repeated.body.revision).toBe(entered.body.revision)
    expect(repeated.body.primaryActorUserId).toBe(f.member.id)
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(200)
    expect((await f.call('authorize', { sessionId: id, capability: 'plugin-management' })).status).toBe(403)
    expect((await f.call('authorize', { sessionId: id, capability: 'auto-review' })).status).toBe(403)
    await pool.query('UPDATE harness.users SET auto_review_eligible=true WHERE id=$1', [f.member.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'auto-review' })).status).toBe(200)
    await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1 AND user_id=$2", [f.project.uuid, f.member.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(403)
    expect((await f.call('input', { ...editBody, messageId: 'revoked', previousInputId: undefined }, f.member)).status).toBe(403)
  })

  it('atomically unions concurrent inputs with bounded witnesses and irreversible history uncertainty', async () => {
    const f = await fixture(), id = await f.session()
    const receipts = await Promise.all(Array.from({ length: 12 }, (_, i) => f.admit(id, i % 2 === 0 ? f.admin : f.member)))
    expect((await Promise.all(receipts.map(receipt => f.enter(id, receipt)))).every(result => result.status === 200)).toBe(true)
    const state = await f.call<ExecutionIdentityState>('authorize', { sessionId: id, capability: 'execute' })
    expect(state.status).toBe(200)
    expect(state.body.inputs).toHaveLength(2)
    expect(state.body.actors).toEqual([{ userId: f.admin.id }, { userId: f.member.id }])
    const single = await f.session(), adminInput = await f.admit(single)
    expect((await f.enter(single, adminInput, f.project, true)).body.unverifiedHistory).toBe(true)
    expect((await f.enter(single, adminInput, f.project, false)).body.unverifiedHistory).toBe(true)
    expect((await f.call('authorize', { sessionId: single, capability: 'execute' })).status).toBe(200)
    expect((await f.call('authorize', { sessionId: single, capability: 'plugin-management' })).status).toBe(403)
    expect((await f.call('authorize', { sessionId: single, capability: 'auto-review' })).status).toBe(403)
    const reported = await f.session(), receipt = await f.admit(reported)
    await f.enter(reported, receipt)
    expect((await f.call('authorize', { sessionId: reported, capability: 'plugin-management', unverifiedHistory: true })).status).toBe(403)
    expect((await f.call<ExecutionIdentityState>('authorize', { sessionId: reported, capability: 'execute', unverifiedHistory: false })).body.unverifiedHistory).toBe(true)
  })

  it('checks explicit selections without creating actors and rechecks current account eligibility', async () => {
    const f = await fixture(), id = await f.session()
    expect((await f.call('selection', { sessionId: id, capability: 'plugin-management' }, f.admin)).status).toBe(204)
    expect((await f.call('selection', { sessionId: id, capability: 'auto-review' }, f.member)).status).toBe(403)
    expect((await f.call('selection', { sessionId: id, capability: 'plugin-management' }, f.member)).status).toBe(403)
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(403)
    const receipt = await f.admit(id)
    await f.enter(id, receipt)
    expect((await f.call('authorize', { sessionId: id, capability: 'auto-review' })).status).toBe(200)
    await pool.query('UPDATE harness.users SET auto_review_eligible=false WHERE id=$1', [f.admin.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'auto-review' })).status).toBe(403)
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.admin.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'plugin-management' })).status).toBe(403)
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(200)
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(403)
  })

  it('validates delayed attribution from inherited facts after eligibility is revoked', async () => {
    const f = await fixture(), parent = await f.session(), receipt = await f.admit(parent)
    const state = (await f.enter(parent, receipt)).body
    const child = await f.session(f.project, parent)
    await f.call('inherit', { sessionId: child, parentSessionId: parent, inputs: state.inputs, primaryActorUserId: state.primaryActorUserId })
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    const attribution = { organizationId: f.organizationId, runtime: { kind: 'project' as const, id: f.project.id },
      sessionId: child, inputIds: state.inputs, primaryActorUserId: f.admin.id }
    await expect(verifyExecutionAttribution(pool, attribution)).resolves.toBeUndefined()
    await expect(verifyExecutionAttribution(pool, { ...attribution, primaryActorUserId: f.member.id })).rejects.toThrow('unrelated primary')
    await expect(verifyExecutionAttribution(pool, { ...attribution, inputIds: [randomUUID()] })).rejects.toThrow('unentered')
    await expect(verifyExecutionAttribution(pool, { ...attribution, sessionId: randomUUID() })).rejects.toThrow('unentered')
    await expect(verifyExecutionAttribution(pool, { ...attribution, runtime: { kind: 'project', id: f.other.id } })).rejects.toThrow('unentered')
    await expect(verifyExecutionAttribution(pool, { ...attribution, inputIds: [] })).rejects.toThrow('requires witnesses')
  })

  it('inherits only real parent witnesses, including fresh non-seeded children and restored personal scopes', async () => {
    const f = await fixture(), parent = await f.session()
    const pending = await f.admit(parent)
    const child = await f.session(f.project, parent)
    expect((await f.call('inherit', { sessionId: child, parentSessionId: parent, inputs: [pending.inputId], primaryActorUserId: f.admin.id })).status).toBe(403)
    const entered = await f.enter(parent, pending, f.project, true)
    const inherited = await f.call<ExecutionIdentityState>('inherit', { sessionId: child, parentSessionId: parent,
      inputs: entered.body.inputs, primaryActorUserId: entered.body.primaryActorUserId })
    expect(inherited.status).toBe(200)
    expect(inherited.body.actors).toEqual(entered.body.actors)
    expect(inherited.body.unverifiedHistory).toBe(true)
    expect((await f.call('authorize', { sessionId: child, capability: 'plugin-management' })).status).toBe(403)
    const stranger = await f.session()
    expect((await f.call('inherit', { sessionId: stranger, parentSessionId: parent,
      inputs: entered.body.inputs, primaryActorUserId: entered.body.primaryActorUserId })).status).toBe(403)
    const personal = await f.session(f.personal), input = await f.admit(personal, f.admin, f.personal)
    await f.enter(personal, input, f.personal)
    const localChild = await f.session(f.personal, personal)
    expect((await f.call('inherit', { sessionId: localChild, parentSessionId: personal,
      inputs: [input.inputId], primaryActorUserId: f.admin.id }, undefined, f.personal)).status).toBe(200)
    expect((await f.call('register-session', { sessionId: localChild, parentSessionId: 'changed' }, undefined, f.personal)).status).not.toBe(200)
    expect((await f.call('authorize', { sessionId: localChild, capability: 'plugin-management' }, undefined, f.personal)).status).toBe(200)
    expect((await f.call('register-session', { sessionId: 'foreign-child', parentSessionId: personal }, undefined, f.peerPersonal)).status).toBe(404)
  })

  it('merges adjacent child replies into the parent and refuses unrelated borrowing', async () => {
    const f = await fixture(), parent = await f.session(), child = await f.session(f.project, parent)
    const first = await f.admit(parent), second = await f.admit(child, f.member)
    const parentState = (await f.enter(parent, first)).body
    const childState = (await f.enter(child, second)).body
    const merged = await f.call<ExecutionIdentityState>('relay', { sessionId: parent, senderSessionId: child, messageId: randomUUID(),
      inputs: childState.inputs, primaryActorUserId: childState.primaryActorUserId })
    expect(merged.status).toBe(200)
    expect(merged.body.actors).toEqual([{ userId: f.admin.id }, { userId: f.member.id }])
    expect(BigInt(merged.body.revision)).toBeGreaterThan(BigInt(parentState.revision))
    expect((await f.call('authorize', { sessionId: parent, capability: 'plugin-management' })).status).toBe(403)
    const stranger = await f.session()
    expect((await f.call('relay', { sessionId: stranger, senderSessionId: child, messageId: randomUUID(),
      inputs: childState.inputs, primaryActorUserId: childState.primaryActorUserId })).status).toBe(403)
    expect((await f.call('relay', { sessionId: parent, senderSessionId: child, messageId: randomUUID(),
      inputs: [first.inputId], primaryActorUserId: f.admin.id })).status).toBe(403)
    const both = await Promise.all([
      f.call<ExecutionIdentityState>('relay', { sessionId: parent, senderSessionId: child, messageId: randomUUID(),
        inputs: childState.inputs, primaryActorUserId: childState.primaryActorUserId }),
      f.call<ExecutionIdentityState>('relay', { sessionId: child, senderSessionId: parent, messageId: randomUUID(),
        inputs: parentState.inputs, primaryActorUserId: parentState.primaryActorUserId, unverifiedHistory: true }),
    ])
    expect(both.map(result => result.status)).toEqual([200, 200])
    expect(both[1]!.body.unverifiedHistory).toBe(true)
  })

  it('retains captured attribution when a sender changes primary without changing its actors', async () => {
    const f = await fixture(), parent = await f.session(), child = await f.session(f.project, parent)
    await f.enter(parent, await f.admit(parent))
    const captured = (await f.enter(parent, await f.admit(parent, f.member))).body
    const later = (await f.enter(parent, await f.admit(parent))).body
    expect(later.inputs).toEqual(captured.inputs)
    expect(later.primaryActorUserId).toBe(f.admin.id)
    expect(captured.primaryActorUserId).toBe(f.member.id)
    const request = { sessionId: child, parentSessionId: parent, inputs: captured.inputs, primaryActorUserId: captured.primaryActorUserId }
    expect((await f.call('inherit', { ...request, primaryActorUserId: undefined })).status).toBe(400)
    expect((await f.call('inherit', { ...request, primaryActorUserId: f.peer.id })).status).toBe(403)
    const inherited = await f.call<ExecutionIdentityState>('inherit', request)
    expect(inherited.status).toBe(200)
    expect(inherited.body.primaryActorUserId).toBe(f.member.id)
    await f.enter(child, await f.admit(child))
    const returned = await f.call<ExecutionIdentityState>('relay', { sessionId: parent, senderSessionId: child, messageId: randomUUID(),
      inputs: inherited.body.inputs, primaryActorUserId: inherited.body.primaryActorUserId })
    expect(returned.status).toBe(200)
    expect(returned.body.primaryActorUserId).toBe(f.member.id)
    expect((await f.call('authorize', { sessionId: parent, capability: 'plugin-management' })).status).toBe(403)
  })

  it('captures origins after revocation without granting execution or borrowing another runtime', async () => {
    const f = await fixture(), id = await f.session()
    expect((await f.call<ExecutionIdentityState>('capture', { sessionId: id })).body).toEqual({
      revision: '0', inputs: [], actors: [], unverifiedHistory: false,
    })
    const receipt = await f.admit(id), entered = await f.enter(id, receipt)
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    expect((await f.call('authorize', { sessionId: id, capability: 'execute' })).status).toBe(403)
    expect((await f.call('capture', { sessionId: id })).body).toEqual(entered.body)
    expect((await f.call('capture', { sessionId: id }, undefined, f.other)).status).toBe(404)
    expect((await f.call('capture', { sessionId: randomUUID() })).status).toBe(404)
    expect((await f.call('capture', { sessionId: id, actors: [] })).status).toBe(400)
  })

  it('inherits and relays empty unknown history only from a sender without recorded actors', async () => {
    const f = await fixture(), parent = await f.session(), child = await f.session(f.project, parent)
    const inheritance = { sessionId: child, parentSessionId: parent, inputs: [], unverifiedHistory: true }
    expect((await f.call('inherit', { ...inheritance, unverifiedHistory: false })).status).toBe(400)
    const inherited = await f.call<ExecutionIdentityState>('inherit', inheritance)
    expect(inherited.status).toBe(200)
    expect(inherited.body).toMatchObject({ inputs: [], actors: [], unverifiedHistory: true })
    expect(inherited.body.primaryActorUserId).toBeUndefined()
    expect((await f.call('authorize', { sessionId: child, capability: 'execute' })).status).toBe(403)
    await f.enter(child, await f.admit(child))
    expect((await f.call('authorize', { sessionId: child, capability: 'execute' })).status).toBe(200)
    expect((await f.call('authorize', { sessionId: child, capability: 'plugin-management' })).status).toBe(403)
    const relay = await f.call<ExecutionIdentityState>('relay', { sessionId: child, senderSessionId: parent,
      messageId: randomUUID(), inputs: [], unverifiedHistory: true })
    expect(relay.status).toBe(200)
    expect(relay.body.primaryActorUserId).toBe(f.admin.id)
    expect(relay.body.actors).toEqual([{ userId: f.admin.id }])
    await f.enter(parent, await f.admit(parent))
    const freshChild = await f.session(f.project, parent)
    expect((await f.call('inherit', { ...inheritance, sessionId: freshChild })).status).toBe(403)
    expect((await f.call('relay', { sessionId: freshChild, senderSessionId: parent,
      messageId: randomUUID(), inputs: [], unverifiedHistory: true })).status).toBe(403)
    expect((await f.call('inherit', inheritance)).status).toBe(200)
  })

  it('keeps later attribution across inherited setup and relay message retries', async () => {
    const f = await fixture(), parent = await f.session(), child = await f.session(f.project, parent)
    await f.enter(parent, await f.admit(parent))
    const captured = (await f.enter(parent, await f.admit(parent, f.member))).body
    const inheritance = { sessionId: child, parentSessionId: parent,
      inputs: captured.inputs, primaryActorUserId: captured.primaryActorUserId }
    expect((await f.call('inherit', inheritance)).status).toBe(200)
    const laterChild = (await f.enter(child, await f.admit(child))).body
    const restored = await f.call<ExecutionIdentityState>('inherit', inheritance)
    expect(restored.body).toEqual(laterChild)
    expect((await f.call('inherit', { ...inheritance, primaryActorUserId: f.admin.id })).status).toBe(409)
    const relay = { sessionId: parent, senderSessionId: child, messageId: randomUUID(),
      inputs: laterChild.inputs, primaryActorUserId: laterChild.primaryActorUserId }
    expect((await f.call('relay', relay)).status).toBe(200)
    const laterParent = (await f.enter(parent, await f.admit(parent, f.member))).body
    expect(laterParent.primaryActorUserId).toBe(f.member.id)
    expect((await f.call('relay', relay)).body).toEqual(laterParent)
    expect((await f.call('relay', { ...relay, primaryActorUserId: f.member.id })).status).toBe(409)
    expect((await f.call('relay', { ...relay, messageId: undefined })).status).toBe(400)
  })

  it.each(['project', 'personal'] as const)('atomically claims %s human answers and recovers an identical retry', async (kind) => {
    const f = await fixture(), runtime = kind === 'project' ? f.project : f.personal
    const id = await f.session(runtime), questionId = randomUUID(), answer = { answers: [{ id: 'q', selected: [], custom: 'do work' }] }
    const actor = kind === 'project' ? f.member : f.admin
    const result = await f.call<ExecutionIdentityState & { claimed: boolean }>('question', { sessionId: id, questionId, answer }, actor, runtime)
    expect(result.status).toBe(200)
    expect(result.body.claimed).toBe(true)
    expect(result.body.actors).toEqual([{ userId: actor.id }])
    const retry = await f.call<ExecutionIdentityState>('question', { sessionId: id, questionId, answer }, actor, runtime)
    expect(retry.body.inputs).toEqual(result.body.inputs)
    expect(retry.body.revision).toBe(result.body.revision)
    if (kind === 'project') {
      const later = (await f.enter(id, await f.admit(id))).body
      const repeated = await f.call<ExecutionIdentityState>('question', { sessionId: id, questionId, answer }, actor)
      expect(repeated.body.revision).toBe(later.revision)
      expect(repeated.body.primaryActorUserId).toBe(f.admin.id)
    }
    expect((await f.call('question', { sessionId: id, questionId, answer: { different: true } }, actor, runtime)).status).toBe(409)
    if (kind === 'project') expect((await f.call('question', { sessionId: id, questionId, answer }, f.admin)).status).toBe(409)
    expect((await f.call('authorize', { sessionId: id, capability: 'plugin-management' }, undefined, runtime)).status).toBe(kind === 'project' ? 403 : 200)
  })

  it('streams ready and revocation hints without a principal or runtime acknowledgment', async () => {
    const f = await fixture()
    const response = await fetch(`${f.base}/internal/runtime/execution/watch`, { headers: f.headers(f.project) })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"ready"}\n')
      await pool.query('UPDATE harness.users SET auto_review_eligible=true WHERE id=$1', [f.member.uuid])
      await f.accessMonitor.synchronize()
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(JSON.parse(text)).toMatchObject({ type: 'invalidate', userId: f.member.id })
      expect(text).not.toContain(f.project.token)
    } finally { await reader.cancel(); reader.releaseLock() }
    expect((await fetch(`${f.base}/internal/runtime/execution/watch`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('closes watches on listener loss and rejects readiness until cancellation and catch-up finish', async () => {
    const f = await fixture()
    const response = await fetch(`${f.base}/internal/runtime/execution/watch`, {
      headers: f.headers(f.project), signal: AbortSignal.timeout(5_000),
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"ready"}\n')
    const disconnected = barrier(), release = barrier()
    const unsubscribe = f.accessMonitor.subscribe(async (subject) => {
      if (subject.userId === undefined && subject.projectId === undefined) {
        disconnected.resolve()
        await release.promise
      }
    })
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ended = reader.read().then(chunk => chunk.done, () => true)
      const stopped = await pool.query<{ stopped: boolean }>(
        'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE application_name=$1',
        [`hgw-access:${f.context.nodeName}`],
      )
      expect(stopped.rows).toEqual([{ stopped: true }])
      await disconnected.promise
      expect((await pool.query('SELECT 1')).rowCount).toBe(1)
      expect(await ended).toBe(true)
      const unavailable = await fetch(`${f.base}/internal/runtime/execution/watch`, { headers: f.headers(f.project) })
      try { expect(unavailable.status).toBe(503) } finally { await unavailable.body?.cancel() }
      release.resolve()
      unsubscribe()
      await f.accessMonitor.synchronize()
      const recovered = await fetch(`${f.base}/internal/runtime/execution/watch`, { headers: f.headers(f.project) })
      const restored = recovered.body!.getReader()
      try {
        expect(recovered.status).toBe(200)
        expect(new TextDecoder().decode((await restored.read()).value)).toBe('{"type":"ready"}\n')
      } finally { await restored.cancel(); restored.releaseLock() }
    } finally {
      release.resolve()
      unsubscribe()
      await reader.cancel().catch(() => { /* listener termination deliberately errors the HTTP stream */ })
      reader.releaseLock()
      diagnostics.mockRestore()
    }
  })

  it.each(['client close', 'backpressure'] as const)('streams heartbeats and releases its timer and subscription on %s', async (ending) => {
    const f = await fixture({ executionWatchHeartbeatMs: 5 })
    const closed = barrier()
    let listener!: Parameters<GatewayAccessMonitor['subscribe']>[0]
    const subscribe = f.accessMonitor.subscribe.bind(f.accessMonitor)
    f.accessMonitor.subscribe = (callback) => {
      listener = callback
      const dispose = subscribe(callback)
      return () => { dispose(); closed.resolve() }
    }
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    const response = await fetch(`${f.base}/internal/runtime/execution/watch`, {
      headers: f.headers(f.project), signal: AbortSignal.timeout(5_000),
    })
    const reader = response.body!.getReader()
    try {
      let buffer = ''
      const events: Array<{ type: string }> = []
      while (!events.some(event => event.type === 'heartbeat')) {
        const next = await reader.read()
        expect(next.done).toBe(false)
        buffer += new TextDecoder().decode(next.value)
        const lines = buffer.split('\n')
        buffer = lines.pop()!
        for (const line of lines) events.push(JSON.parse(line) as { type: string })
      }
      expect(events[0]?.type).toBe('ready')
      const timerIndex = intervals.mock.calls.findIndex(call => call[1] === 5)
      expect(timerIndex).toBeGreaterThanOrEqual(0)
      const timer = intervals.mock.results[timerIndex]!.value as NodeJS.Timeout
      if (ending === 'client close') await reader.cancel()
      else {
        // Synchronous delivery fills the actual HTTP writable buffer before
        // socket drain can run; the monitor callback must never await that drain.
        for (let index = 0; index < 10_000; index++) void listener({ userId: f.member.id })
      }
      await closed.promise
      expect(cleared).toHaveBeenCalledWith(timer)
    } finally {
      // Backpressure deliberately destroys this response before reader cleanup.
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      intervals.mockRestore()
      cleared.mockRestore()
    }
  })
})
