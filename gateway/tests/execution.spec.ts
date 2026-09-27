import { DesktopAccess, desktopPolicyOwner } from '../src/desktop-access.ts'
import { TerminalAccess, terminalPolicyOwner } from '../src/terminal-access.ts'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { verifyExecutionAttribution, type ExecutionIdentityState } from '../src/execution-identity.ts'
import type { GatewayAccessMonitor } from '../src/access-invalidation.ts'
import { barrier } from './barrier.ts'
import { createExecutionFixture, type Receipt } from './execution-fixture.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'
import { PostgresWebhookDeliveryService, type WebhookEndpointId } from '../src/postgres/webhook-delivery-service.ts'

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

  it('reserves each webhook delivery once across Gateway nodes and never replays an unknown result', async () => {
    const f = await fixture()
    const node = await pool.query<{ id: string }>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id', [f.organizationId, randomUUID()])
    const first = new PostgresWebhookDeliveryService(f.context)
    const second = new PostgresWebhookDeliveryService({ ...f.context, nodeId: node.rows[0]!.id })
    const input = { endpointId: randomUUID() as WebhookEndpointId, deliveryId: 'delivery-1', requestHash: hash('body+signed-event'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'user' as const, id: f.admin.id }, limit: 1, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const results = await Promise.all([first.reserve(input), second.reserve(input)])
    expect(results.filter(result => result.dispatch)).toHaveLength(1)
    expect(results[0]!.receipt.id).toBe(results[1]!.receipt.id)
    const winner = results[0]!.dispatch ? first : second, loser = results[0]!.dispatch ? second : first
    await expect(loser.complete(input.endpointId, results[0]!.receipt.id, { state: 'submitted', sessionId: 's' })).rejects.toMatchObject({ status: 404 })
    await winner.complete(input.endpointId, results[0]!.receipt.id, { state: 'unknown', errorCode: 'runtime-timeout' })
    expect(await first.reserve({ ...input, configurationRevision: '2' })).toMatchObject({ dispatch: false, receipt: { state: 'unknown', configurationRevision: '1' } })
    await expect(first.reserve({ ...input, requestHash: hash('other-body') })).rejects.toMatchObject({ status: 409 })
    await expect(winner.complete(input.endpointId, results[0]!.receipt.id, { state: 'submitted', sessionId: 's' })).rejects.toMatchObject({ status: 409 })
    expect((await winner.complete(input.endpointId, results[0]!.receipt.id, { state: 'unknown', errorCode: 'runtime-timeout' })).state).toBe('unknown')
  })

  it('deduplicates a signed body across nodes and retains delivery aliases after the window expires', async () => {
    const f = await fixture()
    const node = await pool.query<{ id: string }>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id', [f.organizationId, randomUUID()])
    const first = new PostgresWebhookDeliveryService(f.context)
    const second = new PostgresWebhookDeliveryService({ ...f.context, nodeId: node.rows[0]!.id })
    const input = { endpointId: randomUUID() as WebhookEndpointId, deliveryId: 'first', requestHash: hash('same signed body'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'user' as const, id: f.admin.id },
      limit: 1, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const results = await Promise.all([first.reserve(input), second.reserve({ ...input, deliveryId: 'second' })])
    expect(results.filter(result => result.dispatch)).toHaveLength(1)
    expect(results[0]!.receipt.id).toBe(results[1]!.receipt.id)
    const owner = results[0]!.dispatch ? first : second
    await owner.complete(input.endpointId, results[0]!.receipt.id, { state: 'ignored' })
    await pool.query("UPDATE harness.webhook_delivery_receipts SET received_at=now()-interval '2 minutes' WHERE id=$1", [results[0]!.receipt.id])
    for (const deliveryId of ['first', 'second']) {
      expect(await second.reserve({ ...input, deliveryId })).toMatchObject({ dispatch: false, receipt: { state: 'ignored' } })
      await expect(second.reserve({ ...input, deliveryId, requestHash: hash('changed body') })).rejects.toMatchObject({ status: 409 })
    }
    const aliases = await pool.query('SELECT receipt_id FROM harness.webhook_delivery_aliases WHERE organization_id=$1 AND endpoint_id=$2', [f.organizationId, input.endpointId])
    expect(aliases.rows).toEqual([{ receipt_id: results[0]!.receipt.id }])
    const budget = await pool.query('SELECT accepted FROM harness.webhook_intake_windows WHERE organization_id=$1 AND endpoint_id=$2', [f.organizationId, input.endpointId])
    expect(budget.rows).toEqual([{ accepted: 1 }])
  })

  it('expires body deduplication independently of the intake budget, preserving unresolved reservations', async () => {
    const f = await fixture(), service = new PostgresWebhookDeliveryService(f.context)
    const input = { endpointId: randomUUID() as WebhookEndpointId, deliveryId: 'first', requestHash: hash('same body'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'user' as const, id: f.admin.id },
      limit: 10, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const first = await service.reserve(input)
    await pool.query("UPDATE harness.webhook_delivery_receipts SET received_at=now()-interval '2 minutes' WHERE id=$1", [first.receipt.id])
    expect((await service.reserve({ ...input, deliveryId: 'still-dispatching' })).dispatch).toBe(false)
    await service.complete(input.endpointId, first.receipt.id, { state: 'unknown', errorCode: 'runtime-timeout' })
    expect((await service.reserve({ ...input, deliveryId: 'unknown' })).dispatch).toBe(false)
    const otherBody = { ...input, deliveryId: 'known', requestHash: hash('completed body') }
    const known = await service.reserve(otherBody)
    await service.complete(input.endpointId, known.receipt.id, { state: 'submitted', sessionId: 'admitted' })
    expect((await service.reserve({ ...otherBody, deliveryId: 'inside-window', configurationRevision: '2' })).dispatch).toBe(false)
    await pool.query("UPDATE harness.webhook_delivery_receipts SET received_at=now()-interval '2 minutes' WHERE id=$1", [known.receipt.id])
    expect((await service.reserve({ ...otherBody, deliveryId: 'outside-window' })).dispatch).toBe(true)
    expect((await service.reserve({ ...otherBody, deliveryId: 'inside-window' })).dispatch).toBe(false)
    expect((await service.reserve({ ...input, endpointId: randomUUID() as WebhookEndpointId })).dispatch).toBe(true)
    await expect(service.reserve({ ...input, replayWindowMs: 0, event: { name: 'push', payload: {} } })).rejects.toMatchObject({ status: 400 })
    await expect(service.reserve({ ...input, replayWindowMs: 1.5 })).rejects.toMatchObject({ status: 400 })
  })

  it('enforces a shared webhook delivery budget without charging duplicates or carrying expired windows', async () => {
    const f = await fixture(), service = new PostgresWebhookDeliveryService(f.context)
    const input = { endpointId: randomUUID() as WebhookEndpointId, deliveryId: 'first', requestHash: hash('body'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'project' as const, id: f.project.id }, limit: 1, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const attempts = await Promise.allSettled([service.reserve(input), service.reserve({ ...input, deliveryId: 'second', requestHash: hash('second body') })])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ status: 429 }) })])
    const accepted = attempts.find(result => result.status === 'fulfilled')!
    if (accepted.status !== 'fulfilled') throw new Error('no accepted delivery')
    expect((await service.reserve({ ...input, deliveryId: accepted.value.receipt.deliveryId,
      requestHash: accepted.value.receipt.deliveryId === 'first' ? input.requestHash : hash('second body') })).dispatch).toBe(false)
    await pool.query("UPDATE harness.webhook_intake_windows SET started_at=now()-interval '2 minutes' WHERE organization_id=$1 AND endpoint_id=$2", [f.organizationId, input.endpointId])
    expect((await service.reserve({ ...input, deliveryId: 'third', requestHash: hash('third body') })).dispatch).toBe(true)
    const count = await pool.query<{ accepted: number }>('SELECT accepted FROM harness.webhook_intake_windows WHERE organization_id=$1 AND endpoint_id=$2', [f.organizationId, input.endpointId])
    expect(count.rows[0]!.accepted).toBe(1)
  })

  it('binds webhook delivery completion to organization and endpoint and records admission separately from success', async () => {
    const f = await fixture(), other = await fixture()
    const service = new PostgresWebhookDeliveryService(f.context)
    const input = { endpointId: randomUUID() as WebhookEndpointId, deliveryId: 'same-id', requestHash: hash('body'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'user' as const, id: f.admin.id }, limit: 1, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const reserved = await service.reserve(input)
    for (const [organizationId, endpointId] of [[other.organizationId, input.endpointId], [f.organizationId, randomUUID()]]) {
      await expect(pool.query(`INSERT INTO harness.webhook_delivery_aliases(organization_id,endpoint_id,delivery_id,receipt_id)
        VALUES($1,$2,'cross-scope',$3)`, [organizationId, endpointId, reserved.receipt.id])).rejects.toMatchObject({ code: '23503' })
    }
    await expect(service.complete(randomUUID() as WebhookEndpointId, reserved.receipt.id, { state: 'submitted', sessionId: 's' })).rejects.toMatchObject({ status: 404 })
    await expect(new PostgresWebhookDeliveryService(other.context).complete(input.endpointId, reserved.receipt.id, { state: 'submitted', sessionId: 's' })).rejects.toMatchObject({ status: 404 })
    await expect(service.complete(input.endpointId, reserved.receipt.id, { state: 'submitted' })).rejects.toMatchObject({ status: 400 })
    await expect(service.complete(input.endpointId, reserved.receipt.id, { state: 'rejected', errorCode: 'raw secret value' })).rejects.toMatchObject({ status: 400 })
    expect(await service.complete(input.endpointId, reserved.receipt.id, { state: 'submitted', sessionId: 's' })).toMatchObject({ state: 'submitted', sessionId: 's', errorCode: null })
    expect((await service.reserve(input)).dispatch).toBe(false)
    await expect(service.complete(input.endpointId, reserved.receipt.id, { state: 'submitted', sessionId: 'another' })).rejects.toMatchObject({ status: 409 })
    expect((await new PostgresWebhookDeliveryService(other.context).reserve({ ...input, executionUserUuid: other.admin.uuid, target: { kind: 'user', id: other.admin.id } })).dispatch).toBe(true)
    const ignoredEndpoint = randomUUID() as WebhookEndpointId
    const ignored = await service.reserve({ ...input, endpointId: ignoredEndpoint })
    expect(await service.complete(ignoredEndpoint, ignored.receipt.id, { state: 'ignored' })).toMatchObject({ state: 'ignored', sessionId: null, errorCode: null })
  })

  it('pages webhook delivery receipts without crossing endpoints or exposing execution payloads', async () => {
    const f = await fixture(), service = new PostgresWebhookDeliveryService(f.context)
    const endpoint = randomUUID() as WebhookEndpointId
    const input = { endpointId: endpoint, deliveryId: 'first', requestHash: hash('private body'),
      configurationRevision: '1', executionUserUuid: f.admin.uuid, target: { kind: 'user' as const, id: f.admin.id }, limit: 10, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
    const first = await service.reserve(input)
    const second = await service.reserve({ ...input, deliveryId: 'second', requestHash: hash('second body') })
    const page = await service.list(endpoint, undefined, 1)
    expect(page).toEqual({ items: [second.receipt], nextCursor: second.receipt.id })
    expect(await service.list(endpoint, page.nextCursor, 1)).toEqual({ items: [first.receipt], nextCursor: null })
    expect(await service.list(randomUUID())).toEqual({ items: [], nextCursor: null })
    await expect(service.list(randomUUID(), first.receipt.id)).rejects.toMatchObject({ status: 400 })
    await expect(service.list(endpoint, undefined, 101)).rejects.toMatchObject({ status: 400 })
    await expect(service.reserve({ ...input, requestHash: 'unhashed' })).rejects.toMatchObject({ status: 400 })
    expect(JSON.stringify(page)).not.toContain(input.requestHash)
    expect(JSON.stringify(page)).not.toContain(input.executionUserUuid)
  })

  it('admits execution input and selection under a webhook-dispatch assertion and refuses it elsewhere', async () => {
    const f = await fixture(), id = await f.session()
    const dispatch = async (action: string, body: unknown) => {
      const assertion = f.principals.issueWebhookDispatch({
        user: f.admin, runtime: { kind: f.project.kind, id: f.project.id, generation: f.project.generation },
        scope: { kind: 'project', projectId: f.project.id, projectName: 'Project', mode: 'ro' },
      }, 60_000)
      const response = await fetch(`${f.base}/internal/runtime/execution/${action}`, { method: 'POST',
        headers: { authorization: `Bearer ${f.project.token}`, 'content-type': 'application/json', [PRINCIPAL_HEADER]: assertion },
        body: JSON.stringify(body) })
      const text = await response.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = text }
      return { status: response.status, body: parsed as Record<string, unknown> }
    }
    const input = await dispatch('input', { sessionId: id, messageId: randomUUID(), kind: 'message', contentHash: hash('dispatch') })
    expect(input).toMatchObject({ status: 200, body: { primaryActorUserId: f.admin.id } })
    expect(await dispatch('selection', { sessionId: id, capability: 'plugin-management' })).toMatchObject({ status: 204 })
    expect((await dispatch('question', { sessionId: id, questionId: 'q', answer: null })).status).toBe(403)
    expect((await dispatch('authorize', { sessionId: id, capability: 'execute' })).status).toBe(403)
    const runtimeApi = await fetch(`${f.base}/internal/runtime/ssh/resolve`, { method: 'POST',
      headers: { authorization: `Bearer ${f.project.token}`, 'content-type': 'application/json',
        [PRINCIPAL_HEADER]: f.principals.issueWebhookDispatch({
          user: f.admin, runtime: { kind: f.project.kind, id: f.project.id, generation: f.project.generation },
          scope: { kind: 'project', projectId: f.project.id, projectName: 'Project', mode: 'ro' },
        }, 60_000) },
      body: JSON.stringify({}) })
    await runtimeApi.body?.cancel()
    expect(runtimeApi.status).toBe(403)
  })

  it.each(['terminal-admin', 'plugin-admin'] as const)('rechecks %s without granting another user execution authority', async kind => {
    const f = await fixture()
    const domain = kind === 'terminal-admin' ? 'terminal-management' : 'plugin-management'
    const request = async (person = f.admin, purpose: 'terminal-admin' | 'plugin-admin' | null = kind, path = domain, runtime = f.peerPersonal) => {
      const assertion = f.principals.issue({ user: person, runtime: { kind: runtime.kind, id: runtime.id, generation: runtime.generation },
        scope: runtime.kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: runtime.id, projectName: 'project', mode: 'ro' },
        ...(purpose === null ? {} : { purpose }) })
      const response = await fetch(`${f.base}/internal/runtime/${path}/authorize`, { method: 'POST',
        headers: { authorization: `Bearer ${runtime.token}`, 'x-dsh-gateway-principal': assertion } })
      await response.body?.cancel()
      return response.status
    }
    expect(await request()).toBe(204)
    expect(await request(f.admin, kind, domain, f.project)).toBe(204)
    expect(await request(f.member)).toBe(400)
    expect(await request(f.admin, null)).toBe(403)
    expect(await request(f.admin, kind, kind === 'terminal-admin' ? 'plugin-management' : 'terminal-management', f.personal)).toBe(403)
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.admin.uuid])
    expect(await request()).toBe(403)
  })

  it('requires both terminal grants and writable membership even for administrators', async () => {
    const f = await fixture(), id = await f.session()
    const policies = new TerminalAccess(f.context)
    const user = { kind: 'user' as const, id: f.admin.id }, project = { kind: 'project' as const, id: f.project.id }
    const authorize = (person = f.admin) => f.call('terminal-authorize', { sessionId: id }, person)
    expect((await f.call('terminal-authorize', { sessionId: id })).status).toBe(403)
    expect((await authorize()).status).toBe(403)
    await policies.set(user, true, '0')
    expect((await authorize()).status).toBe(403)
    await policies.set(project, true, '0')
    expect(await authorize()).toMatchObject({ status: 200, body: { userId: f.admin.id } })
    expect((await authorize(f.member)).status).toBe(403)
    await policies.set({ kind: 'user', id: f.member.id }, true, '0')
    expect((await authorize(f.member)).status).toBe(200)
    await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1 AND user_id=$2", [f.project.uuid, f.admin.uuid])
    expect((await authorize()).status).toBe(403)
    await pool.query("UPDATE harness.project_members SET access_mode='rw' WHERE project_id=$1 AND user_id=$2", [f.project.uuid, f.admin.uuid])
    await pool.query("UPDATE harness.conversation_sessions SET visibility='private' WHERE id=$1", [id])
    expect((await authorize(f.member)).status).toBe(403)
    expect((await authorize()).status).toBe(200)
    await policies.set(user, false, '1')
    expect((await authorize()).status).toBe(403)
    const personalId = await f.session(f.personal)
    await policies.set(user, true, '2')
    await policies.set(project, false, '1')
    expect((await f.call('terminal-authorize', { sessionId: personalId }, f.admin, f.personal)).status).toBe(200)
    expect((await f.call('terminal-authorize', { sessionId: personalId }, f.peer, f.personal)).status).toBe(403)
    expect((await authorize()).status).toBe(403)
    expect(terminalPolicyOwner('user', f.admin.id)).toEqual(user)
    expect(() => terminalPolicyOwner('unknown', 0)).toThrow('invalid terminal policy owner')
    await expect(policies.set(user, true, '0')).rejects.toMatchObject({ status: 409 })
    expect(await new DesktopAccess(f.context).get(user)).toMatchObject({ enabled: false, revision: '0' })
  })

  it('keeps terminal creator grants bound to runtime, Session and qualification revisions', async () => {
    const f = await fixture(), id = await f.session(), otherSession = await f.session()
    const policies = new TerminalAccess(f.context)
    const user = { kind: 'user' as const, id: f.admin.id }
    await policies.set(user, true, '0')
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    const grant = await f.call<{ userId: number; grantId: string }>('terminal-authorize', { sessionId: id }, f.admin)
    expect(grant.status).toBe(200)
    const check = () => f.call('terminal-check', { sessionId: id, grantId: grant.body.grantId })
    expect(await check()).toMatchObject({ status: 200, body: { userId: f.admin.id } })
    expect((await f.call('terminal-authorize', { sessionId: id }, f.admin)).body).toEqual(grant.body)
    expect((await f.call('terminal-check', { sessionId: otherSession, grantId: grant.body.grantId })).status).toBe(403)
    expect((await f.call('terminal-check', { sessionId: id, grantId: grant.body.grantId }, undefined, f.other)).status).toBe(403)
    expect((await f.call('terminal-check', { sessionId: id, grantId: 'invalid' })).status).toBe(400)
    expect((await f.call('terminal-authorize', { sessionId: id, userId: f.peer.id }, f.admin)).status).toBe(400)
    await policies.set(user, false, '1')
    expect((await check()).status).toBe(403)
    await policies.set(user, true, '2')
    expect((await check()).status).toBe(403)
    const replacement = await f.call<{ grantId: string }>('terminal-authorize', { sessionId: id }, f.admin)
    expect(replacement.status).toBe(200)
    expect(replacement.body.grantId).not.toBe(grant.body.grantId)
    expect((await check()).status).toBe(403)
    expect((await f.call('terminal-check', { sessionId: id, grantId: replacement.body.grantId })).status).toBe(200)
    await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.admin.uuid])
    expect((await f.call('terminal-check', { sessionId: id, grantId: replacement.body.grantId })).status).toBe(403)
  })

  it('requires current user and project desktop grants without an administrator or read-only bypass', async () => {
    const f = await fixture(), id = await f.session()
    const policies = new DesktopAccess(f.context)
    const user = { kind: 'user' as const, id: f.admin.id }
    const project = { kind: 'project' as const, id: f.project.id }
    await f.enter(id, await f.admit(id))
    const authorize = () => f.call('authorize', { sessionId: id, capability: 'desktop' })
    expect(await policies.get(user)).toEqual({ ...user, enabled: false, revision: '0' })
    expect((await authorize()).status).toBe(403)
    expect(await policies.set(user, true, '0')).toEqual({ ...user, enabled: true, revision: '1' })
    expect((await authorize()).status).toBe(403)
    await policies.set(project, true, '0')
    expect((await authorize()).status).toBe(200)
    await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1 AND user_id=$2", [f.project.uuid, f.admin.uuid])
    expect((await authorize()).status).toBe(403)
    await pool.query("UPDATE harness.project_members SET access_mode='rw' WHERE project_id=$1 AND user_id=$2", [f.project.uuid, f.admin.uuid])
    expect((await authorize()).status).toBe(200)
    await policies.set(user, false, '1')
    expect((await authorize()).status).toBe(403)
    const personalId = await f.session(f.personal)
    await f.enter(personalId, await f.admit(personalId, f.admin, f.personal), f.personal)
    await policies.set(user, true, '2')
    await policies.set(project, false, '1')
    expect((await f.call('authorize', { sessionId: personalId, capability: 'desktop' }, undefined, f.personal)).status).toBe(200)
    expect((await authorize()).status).toBe(403)
  })

  it('checks every inherited desktop actor and publishes qualification revocation', async () => {
    const f = await fixture(), id = await f.session()
    const policies = new DesktopAccess(f.context)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    await policies.set({ kind: 'user', id: f.admin.id }, true, '0')
    await f.enter(id, await f.admit(id))
    await f.enter(id, await f.admit(id, f.member))
    expect((await f.call('authorize', { sessionId: id, capability: 'desktop' })).status).toBe(403)
    await policies.set({ kind: 'user', id: f.member.id }, true, '0')
    expect((await f.call('authorize', { sessionId: id, capability: 'desktop' })).status).toBe(200)
    await f.accessMonitor.synchronize()
    const invalidated = vi.fn()
    cleanup.push(f.accessMonitor.subscribe(invalidated))
    await policies.set({ kind: 'user', id: f.member.id }, false, '1')
    await f.accessMonitor.synchronize()
    expect(invalidated).toHaveBeenCalledWith({ userId: f.member.id })
    expect((await f.call('authorize', { sessionId: id, capability: 'desktop' })).status).toBe(403)
  })

  it('rejects stale desktop policy revisions and keeps unknown owners and organizations isolated', async () => {
    const f = await fixture(), other = await fixture()
    const policies = new DesktopAccess(f.context)
    const owner = { kind: 'user' as const, id: f.admin.id }
    const changed = await Promise.allSettled([policies.set(owner, true, '0'), policies.set(owner, false, '0')])
    expect(changed.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(changed.filter(result => result.status === 'rejected')).toHaveLength(1)
    const current = await policies.get(owner)
    expect(await policies.set(owner, current.enabled, current.revision)).toEqual(current)
    await expect(policies.set(owner, true, '0')).rejects.toMatchObject({ status: 409 })
    await expect(policies.set(owner, true, '-1')).rejects.toMatchObject({ status: 400 })
    await expect(policies.set(owner, 'true', current.revision)).rejects.toMatchObject({ status: 400 })
    await expect(policies.get({ kind: 'user', id: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ status: 404 })
    await expect(policies.set({ kind: 'project', id: Number.MAX_SAFE_INTEGER }, true, '0')).rejects.toMatchObject({ status: 404 })
    const separate = new DesktopAccess(other.context)
    expect(await separate.get({ kind: 'user', id: other.admin.id })).toMatchObject({ enabled: false, revision: '0' })
    expect(desktopPolicyOwner('project', f.project.id)).toEqual({ kind: 'project', id: f.project.id })
    for (const [kind, id] of [['unknown', 1], ['user', 0], ['user', '1'], ['project', 0.5]]) {
      expect(() => desktopPolicyOwner(kind, id)).toThrow('invalid desktop policy owner')
    }
  })

  it('shows only the interactive user confirmation and refuses stale node saves', async () => {
    const f = await fixture(), id = await f.session()
    const policies = new DesktopAccess(f.context)
    const request = { sessionId: id, desktop: 'display-0' }
    const status = (person = f.admin) => f.call('desktop-confirmation', request, person)
    expect((await f.call('desktop-confirmation', request)).status).toBe(403)
    expect(await status()).toMatchObject({ status: 200, body: { rootSessionId: id, nodeId: f.context.nodeId, desktop: 'display-0',
      userId: f.admin.id, eligible: false, confirmed: false } })
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    for (const person of [f.admin, f.member]) await policies.set({ kind: 'user', id: person.id }, true, '0')
    expect(await status()).toMatchObject({ status: 200, body: { eligible: true, confirmed: false } })
    expect((await f.call('desktop-confirm', { ...request, confirmed: true, expectedNodeId: 'another-node' }, f.admin)).status).toBe(409)
    expect(await status()).toMatchObject({ status: 200, body: { confirmed: false } })
    expect((await f.call('desktop-confirm', { ...request, confirmed: true, expectedNodeId: f.context.nodeId }, f.admin)).status).toBe(200)
    expect(await status()).toMatchObject({ status: 200, body: { confirmed: true } })
    expect(await status(f.member)).toMatchObject({ status: 200, body: { userId: f.member.id, confirmed: false } })
    await policies.set({ kind: 'user', id: f.admin.id }, false, '1')
    expect(await status()).toMatchObject({ status: 200, body: { eligible: false, confirmed: false } })
    await policies.set({ kind: 'user', id: f.admin.id }, true, '2')
    expect(await status()).toMatchObject({ status: 200, body: { eligible: true, confirmed: false } })
    await pool.query('UPDATE harness.execution_sessions SET unverified_history=true WHERE organization_id=$1 AND session_id=$2', [f.organizationId, id])
    expect(await status()).toMatchObject({ status: 200, body: { eligible: false, confirmed: false } })
  })

  it('coordinates a root and its live children without a browser assertion and stops on revoked access', async () => {
    const f = await fixture(), root = await f.session(), child = await f.session(f.project, root), other = await f.session()
    const policies = new DesktopAccess(f.context)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    await policies.set({ kind: 'user', id: f.admin.id }, true, '0')
    const input = await f.admit(root)
    await f.enter(root, input)
    await f.enter(other, await f.admit(other))
    expect((await f.call('inherit', { sessionId: child, parentSessionId: root, inputs: [input.inputId], primaryActorUserId: f.admin.id })).status).toBe(200)
    const rootAddress = { sessionId: root, desktop: 'display-0' }
    const childAddress = { sessionId: child, desktop: 'display-0', ownerSessionIds: [root] }
    const lease = (action: string, value: unknown) => f.call(`/internal/runtime/desktop/${action}`, value)
    expect((await lease('acquire', { ...rootAddress, requestId: 'first' })).status).toBe(403)
    for (const sessionId of [root, other]) expect((await f.call('desktop-confirm', {
      sessionId, desktop: 'display-0', confirmed: true,
    }, f.admin)).status).toBe(200)
    const acquired = await lease('acquire', { ...rootAddress, requestId: 'first' })
    expect(acquired).toMatchObject({ status: 200, body: { status: 'granted' } })
    const grantId = acquired.body.grantId
    expect(await lease('acquire', { ...childAddress, requestId: 'child' }))
      .toMatchObject({ status: 200, body: { status: 'held', grantId } })
    expect(await lease('heartbeat', { ...childAddress, grantId }))
      .toMatchObject({ status: 200, body: { status: 'held' } })
    expect(await lease('status', { ...rootAddress, requestId: 'first' }))
      .toMatchObject({ status: 200, body: { status: 'granted', grantId } })
    expect((await lease('release', { sessionId: other, desktop: 'display-0', grantId })).status).toBe(403)
    expect((await lease('release', { ...rootAddress, desktop: 'different-display', grantId })).status).toBe(403)
    expect((await lease('release', { sessionId: child, desktop: 'display-0', grantId })).status).toBe(403)
    expect((await lease('acquire', { ...rootAddress, requestId: 'forged', node: f.context.nodeId })).status).toBe(400)
    expect((await lease('acquire', { ...rootAddress, requestId: 'forged', runId: other })).status).toBe(400)
    await policies.set({ kind: 'user', id: f.admin.id }, false, '1')
    for (const action of ['acquire', 'status', 'heartbeat']) {
      expect((await lease(action, { ...childAddress, ...(action === 'heartbeat' ? { grantId } : { requestId: 'first' }) })).status).toBe(403)
    }
    expect(await lease('release', { ...childAddress, grantId })).toMatchObject({ status: 200, body: { released: true } })
    const snapshot = await f.desktops.snapshot({ node: f.context.nodeId, desktop: 'display-0' })
    expect(snapshot.grants).toHaveLength(1)
    expect(snapshot.grants[0]).toMatchObject({ state: 'released' })
  })

  it('keeps stopped input exclusive until its exact workflow confirms drainage after revocation', async () => {
    const f = await fixture(), first = await f.session(), second = await f.session()
    const policies = new DesktopAccess(f.context)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    await policies.set({ kind: 'user', id: f.admin.id }, true, '0')
    for (const sessionId of [first, second]) {
      await f.enter(sessionId, await f.admit(sessionId))
      await f.call('desktop-confirm', { sessionId, desktop: 'display-0', confirmed: true }, f.admin)
    }
    const lease = (action: string, sessionId: string, extra: object) =>
      f.call(`/internal/runtime/desktop/${action}`, { sessionId, desktop: 'display-0', ...extra })
    const acquired = await lease('acquire', first, { requestId: 'first' })
    expect(acquired.status).toBe(200)
    const grantId = acquired.body.grantId as string
    expect(await lease('acquire', second, { requestId: 'second' })).toMatchObject({ status: 200, body: { status: 'queued' } })
    expect((await lease('stop', second, { grantId })).status).toBe(403)
    expect(await lease('stop', first, { grantId })).toMatchObject({ status: 200, body: { stopping: true } })
    expect(await lease('stop', first, { grantId })).toMatchObject({ status: 200, body: { stopping: true } })
    expect(await lease('heartbeat', first, { grantId })).toMatchObject({ status: 200, body: { status: 'stopping' } })
    await policies.set({ kind: 'user', id: f.admin.id }, false, '1')
    expect((await lease('confirm-stopped', second, { grantId })).status).toBe(403)
    expect(await lease('cancel', second, { requestId: 'second' })).toMatchObject({ status: 200, body: { cancelled: true } })
    expect(await lease('confirm-stopped', first, { grantId })).toMatchObject({ status: 200, body: { confirmed: true } })
    const snapshot = await f.desktops.snapshot({ node: f.context.nodeId, desktop: 'display-0' })
    expect(snapshot.grants[0]?.state).toBe('released')
    expect(snapshot.queue[0]?.state).toBe('cancelled')
  })

  it('binds desktop confirmation to each real actor, Session, desktop, node, and runtime generation', async () => {
    const f = await fixture(), id = await f.session(), otherSession = await f.session()
    const policies = new DesktopAccess(f.context)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    for (const person of [f.admin, f.member]) await policies.set({ kind: 'user', id: person.id }, true, '0')
    await f.enter(id, await f.admit(id))
    await f.enter(otherSession, await f.admit(otherSession))
    const request = { sessionId: id, desktop: 'display-0' }
    const authorize = () => f.call('desktop-authorize', request)
    expect((await authorize()).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...request, confirmed: true })).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...request, confirmed: true, userId: f.member.id }, f.admin)).status).toBe(400)
    expect((await f.call('desktop-confirm', { ...request, confirmed: true }, f.admin)).status).toBe(200)
    expect((await authorize()).status).toBe(200)
    expect((await f.call('desktop-authorize', { ...request, sessionId: otherSession })).status).toBe(403)
    expect((await f.call('desktop-authorize', { ...request, desktop: 'display-1' })).status).toBe(403)
    expect((await f.call('desktop-authorize', { ...request, nodeId: f.context.nodeId })).status).toBe(400)
    await f.enter(id, await f.admit(id, f.member))
    expect((await authorize()).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...request, confirmed: true }, f.member)).status).toBe(200)
    expect((await authorize()).status).toBe(200)
    await pool.query('UPDATE harness.desktop_session_confirmations SET generation=generation+1 WHERE organization_id=$1', [f.organizationId])
    expect((await authorize()).status).toBe(403)
    for (const person of [f.admin, f.member]) await f.call('desktop-confirm', { ...request, confirmed: true }, person)
    const node = (await pool.query<{ id: string }>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id', [f.organizationId, randomUUID()])).rows[0]!.id
    await pool.query('UPDATE harness.desktop_session_confirmations SET node_id=$2 WHERE organization_id=$1', [f.organizationId, node])
    expect((await authorize()).status).toBe(403)
  })

  it('shares root consent only through the supplied live owner chain and rechecks new child actors', async () => {
    const f = await fixture(), root = await f.session(), child = await f.session(f.project, root), unrelated = await f.session()
    const policies = new DesktopAccess(f.context)
    await policies.set({ kind: 'project', id: f.project.id }, true, '0')
    for (const person of [f.admin, f.member]) await policies.set({ kind: 'user', id: person.id }, true, '0')
    const input = await f.admit(root)
    await f.enter(root, input)
    await f.call('desktop-confirm', { sessionId: root, desktop: 'display-0', confirmed: true }, f.admin)
    const request = { sessionId: child, desktop: 'display-0', ownerSessionIds: [root] }
    expect((await f.call('desktop-authorize', request)).status).toBe(403)
    expect((await f.call('inherit', { sessionId: child, parentSessionId: root, inputs: [input.inputId], primaryActorUserId: f.admin.id })).status).toBe(200)
    expect((await f.call('desktop-authorize', request)).status).toBe(200)
    expect((await f.call('desktop-authorize', { sessionId: child, desktop: 'display-0' })).status).toBe(403)
    expect((await f.call('desktop-authorize', { ...request, ownerSessionIds: [unrelated] })).status).toBe(403)
    expect((await f.call('desktop-authorize', { ...request, ownerSessionIds: [root, child] })).status).toBe(400)
    expect((await f.call('desktop-authorize', { ...request, ownerSessionIds: root })).status).toBe(400)
    await f.enter(child, await f.admit(child, f.member))
    expect((await f.call('desktop-authorize', request)).status).toBe(403)
    expect((await f.call('desktop-confirm', { sessionId: root, desktop: 'display-0', confirmed: true }, f.member)).status).toBe(200)
    expect((await f.call('desktop-authorize', request)).status).toBe(200)
    await f.call('desktop-confirm', { sessionId: root, desktop: 'display-0', confirmed: false }, f.admin)
    expect((await f.call('desktop-authorize', request)).status).toBe(403)
  })

  it('withdraws desktop confirmation immediately and never revives it after a qualification regrant', async () => {
    const f = await fixture(), id = await f.session()
    const policies = new DesktopAccess(f.context)
    const user = { kind: 'user' as const, id: f.admin.id }, project = { kind: 'project' as const, id: f.project.id }
    await policies.set(user, true, '0'); await policies.set(project, true, '0')
    await f.enter(id, await f.admit(id))
    const request = { sessionId: id, desktop: 'display-0' }
    const confirm = () => f.call('desktop-confirm', { ...request, confirmed: true }, f.admin)
    const authorize = () => f.call('desktop-authorize', request)
    expect((await confirm()).status).toBe(200)
    await policies.set(user, false, '1'); await policies.set(user, true, '2')
    expect((await authorize()).status).toBe(403)
    expect((await confirm()).status).toBe(200)
    await policies.set(project, false, '1'); await policies.set(project, true, '2')
    expect((await authorize()).status).toBe(403)
    expect((await confirm()).status).toBe(200)
    await f.accessMonitor.synchronize()
    const invalidated = vi.fn(); cleanup.push(f.accessMonitor.subscribe(invalidated))
    expect((await f.call('desktop-confirm', { ...request, confirmed: false }, f.admin)).status).toBe(200)
    await f.accessMonitor.synchronize()
    expect(invalidated).toHaveBeenCalledWith({ userId: f.admin.id })
    expect((await authorize()).status).toBe(403)
    await policies.set(user, false, '3')
    expect((await confirm()).status).toBe(403)
    expect((await f.call('desktop-confirm', { ...request, confirmed: false }, f.admin)).status).toBe(200)
  })

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
