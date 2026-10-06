/** Immutable request participants over real Gateway HTTP and PostgreSQL. */
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { verifyExecutionAttribution, type ExecutionIdentityState } from '../src/execution-identity.ts'
import { createExecutionFixture, type Receipt } from './execution-fixture.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const f = await createExecutionFixture(pool)
  cleanup.push(f.dispose)
  const enter = async (sessionId: string, receipt: Receipt & { messageId: string; contentHash: string }, currentScopeId: string | null = null) => {
    const response = await f.call<ExecutionIdentityState>('enter', { sessionId, inputId: receipt.inputId,
      messageId: receipt.messageId, contentHash: receipt.contentHash, currentScopeId, unverifiedHistory: false })
    expect(response.status).toBe(200)
    expect(response.body.scopeId).toMatch(/^[0-9a-f-]{36}$/u)
    return response.body
  }
  const authorize = (sessionId: string, state: ExecutionIdentityState) => f.call('authorize', {
    sessionId, scopeId: state.scopeId, capability: 'auto-review', unverifiedHistory: state.unverifiedHistory,
  })
  const inherit = async (parentSessionId: string, state: ExecutionIdentityState) => {
    const sessionId = await f.session(f.project, parentSessionId)
    const response = await f.call<ExecutionIdentityState>('inherit', { sessionId, parentSessionId,
      scopeId: state.scopeId, inputs: state.inputs, primaryActorUserId: state.primaryActorUserId, unverifiedHistory: state.unverifiedHistory })
    expect(response.status).toBe(200)
    return { id: sessionId, state: response.body }
  }
  return { ...f, enter, authorize, inherit }
}

describePg('current execution scopes', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('allows a new qualified initiator after an ordinary historical participant and retains both audit witnesses', async () => {
    const f = await fixture(), id = await f.session()
    const old = await f.enter(id, await f.admit(id, f.member))
    expect((await f.authorize(id, old)).status).toBe(403)
    const current = await f.enter(id, await f.admit(id, f.admin))
    expect(current.actors).toEqual([{ userId: f.admin.id }])
    expect((await f.authorize(id, current)).status).toBe(200)
    expect((await f.call('selection', { sessionId: id, capability: 'auto-review' }, f.admin)).status).toBe(204)
    expect((await f.call('selection', { sessionId: id, capability: 'auto-review' }, f.member)).status).toBe(403)
    const audit = await f.call<ExecutionIdentityState>('capture', { sessionId: id })
    expect(audit.body.actors).toEqual([{ userId: f.admin.id }, { userId: f.member.id }].sort((a,b) => a.userId-b.userId))
    for (const state of [old, current]) await expect(verifyExecutionAttribution(pool, {
      organizationId: f.organizationId, runtime: f.project, sessionId: id,
      inputIds: state.inputs, primaryActorUserId: state.primaryActorUserId!,
    })).resolves.toBeUndefined()
    expect((await f.call('capture', { sessionId: id, scopeId: current.scopeId }, undefined, f.other)).status).toBe(403)
  })

  it('retains every current input and editor while rejecting removal from captured inheritance', async () => {
    const f = await fixture(), id = await f.session()
    const a = await f.admit(id, f.member), first = await f.enter(id, a)
    const b = await f.admit(id, f.admin), both = await f.enter(id, b, first.scopeId!)
    expect(both.actors).toHaveLength(2)
    expect((await f.authorize(id, both)).status).toBe(403)
    const child = await f.session(f.project, id)
    expect((await f.call('inherit', { sessionId: child, parentSessionId: id, scopeId: both.scopeId,
      inputs: [b.inputId], primaryActorUserId: f.admin.id, unverifiedHistory: false })).status).toBe(403)
    const edited = await f.call<Receipt>('input', { sessionId: id, messageId: a.messageId, kind: 'message',
      contentHash: b.contentHash, previousInputId: a.inputId }, f.admin)
    expect(edited.status).toBe(200)
    const editing = await f.enter(id, { ...edited.body, messageId: a.messageId, contentHash: b.contentHash })
    expect(editing.actors).toHaveLength(2)
    expect((await f.authorize(id, editing)).status).toBe(403)
    await expect(pool.query('UPDATE harness.execution_scopes SET unverified=false WHERE id=$1', [both.scopeId])).rejects.toThrow(/immutable/u)
  })

  it('keeps delayed children and relays bound to their original initiator after a newer turn', async () => {
    const f = await fixture(), id = await f.session()
    const old = await f.enter(id, await f.admit(id, f.member))
    const child = await f.inherit(id, old)
    const current = await f.enter(id, await f.admit(id, f.admin))
    expect((await f.authorize(id, current)).status).toBe(200)
    expect((await f.authorize(child.id, child.state)).status).toBe(403)
    const late = await f.call<ExecutionIdentityState>('relay', { sessionId: id, senderSessionId: child.id,
      messageId: 'late-child-result', scopeId: child.state.scopeId, inputs: child.state.inputs,
      primaryActorUserId: child.state.primaryActorUserId, unverifiedHistory: false })
    expect(late.status).toBe(200)
    expect((await f.authorize(id, late.body)).status).toBe(403)
    expect((await f.authorize(id, current)).status).toBe(200)
    const joined = await f.call<ExecutionIdentityState>('combine', { sessionId: id,
      scopeIds: [current.scopeId, late.body.scopeId], unverified: false })
    expect(joined.status).toBe(200)
    expect((await f.authorize(id, joined.body)).status).toBe(403)
    await pool.query('UPDATE harness.users SET auto_review_eligible=false WHERE id=$1', [f.admin.uuid])
    expect((await f.authorize(id, current)).status).toBe(403)
  })

  it('converts legacy captured work without importing a newer recipient request', async () => {
    const f = await fixture(), id = await f.session()
    const oldInput = await f.admit(id, f.member)
    const old = (await f.call<ExecutionIdentityState>('enter', { sessionId: id, inputId: oldInput.inputId,
      messageId: oldInput.messageId, contentHash: oldInput.contentHash })).body
    expect(old.scopeId).toBeUndefined()
    const child = await f.session(f.project, id)
    const inheritance = { sessionId: child, parentSessionId: id, inputs: old.inputs,
      primaryActorUserId: old.primaryActorUserId, unverifiedHistory: false }
    expect((await f.call('inherit', inheritance)).status).toBe(200)
    const imported = await f.call<ExecutionIdentityState>('inherit', { ...inheritance, scoped: true })
    expect(imported.status).toBe(200)
    expect(imported.body.scopeId).toBeDefined()
    const current = await f.enter(id, await f.admit(id, f.admin))
    const relay = { sessionId: id, senderSessionId: child, messageId: 'legacy-child-completion',
      inputs: old.inputs, primaryActorUserId: old.primaryActorUserId, unverifiedHistory: false, scoped: true }
    const result = await f.call<ExecutionIdentityState>('relay', relay)
    expect(result.status).toBe(200)
    expect(result.body.actors).toEqual([{ userId: f.member.id }])
    expect((await f.authorize(id, result.body)).status).toBe(403)
    expect((await f.authorize(id, current)).status).toBe(200)
    expect((await f.call<ExecutionIdentityState>('relay', relay)).body.scopeId).toBe(result.body.scopeId)
    expect((await f.call('relay', { ...relay, scoped: false })).status).toBe(400)
  })

  it('adds an answerer to the original question execution without replacing a newer request', async () => {
    const f = await fixture(), id = await f.session()
    const old = await f.enter(id, await f.admit(id, f.member))
    const current = await f.enter(id, await f.admit(id, f.admin))
    const answered = await f.call<ExecutionIdentityState>('question', { sessionId: id,
      questionId: 'original-question', answer: { selected: ['yes'] }, scopeId: old.scopeId }, f.admin)
    expect(answered.status).toBe(200)
    expect(answered.body.actors).toHaveLength(2)
    expect((await f.authorize(id, answered.body)).status).toBe(403)
    expect((await f.authorize(id, current)).status).toBe(200)
    const retry = await f.call<ExecutionIdentityState>('question', { sessionId: id,
      questionId: 'original-question', answer: { selected: ['yes'] }, scopeId: old.scopeId }, f.admin)
    expect(retry.body.scopeId).toBe(answered.body.scopeId)
    expect((await f.call('question', { sessionId: id, questionId: 'original-question', answer: { selected: ['yes'] },
      scopeId: current.scopeId }, f.admin)).status).toBe(409)
    const unknown = await f.call<ExecutionIdentityState>('combine', { sessionId: id, scopeIds: [], unverified: true })
    expect(unknown.status).toBe(200)
    expect((await f.authorize(id, unknown.body)).status).toBe(403)
  })
})
