import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import type { UserRow } from '../src/auth.ts'
import type { ProjectDetail } from '../src/projects.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { PostgresWebhookEndpointService, WebhookEndpointError, WebhookSecretCipher } from '../src/postgres/webhook-endpoint-service.ts'
import { PostgresWebhookDeliveryService, type WebhookEndpointId } from '../src/postgres/webhook-delivery-service.ts'
import { GatewayWebhookIntake, WEBHOOK_DISPATCH_PATH } from '../src/webhook-intake.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
let cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup = [] })

const SECRET = 'whsec-test-signing-key'
const cipher = new WebhookSecretCipher(randomBytes(32))
const endpointInput = (f: Awaited<ReturnType<typeof createExecutionFixture>>) => ({
  name: `hook-${randomUUID().slice(0, 8)}`, provider: 'github', source: 'acme',
  events: ['push'], actions: [], repositories: [],
  titleTemplate: 'Push {{payload.ref}}', promptTemplate: 'Review {{payload.after}} on {{payload.ref}}',
  workspacePath: '/tmp/workspace', agentPreset: 'default', permissionPreset: 'default',
  executionUserId: f.member.id,
  runtimeKind: 'project', runtimePublicId: f.project.id,
  intakeLimit: 100, intakeWindowMs: 60_000, replayWindowMs: 86_400_000, maxBodyBytes: 1_048_576,
  secret: SECRET,
})

function githubRequest(body: string, secret = SECRET, headers: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`,
    'x-github-delivery': randomUUID(),
    'x-github-event': 'push',
    ...headers,
  }
}

/** Minimal runtime dispatch stub capturing the request and answering sessionId. */
async function stubRuntime(answer: (body: string, assertion: string | undefined) => { status: number; body?: unknown }) {
  const requests: Array<{ body: string; assertion: string | undefined }> = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ body, assertion: req.headers[PRINCIPAL_HEADER] as string | undefined })
      const reply = answer(body, req.headers[PRINCIPAL_HEADER] as string | undefined)
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body ?? {}))
    })().catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise<void>(ready => { server.listen(0, '127.0.0.1', ready) })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((closed, reject) => { server.close(error => { if (error) reject(error); else closed() }) })
  })
  return { requests, port: (server.address() as AddressInfo).port }
}

async function intakeFor(f: Awaited<ReturnType<typeof createExecutionFixture>>, port: number | null) {
  const endpoints = new PostgresWebhookEndpointService(f.context, cipher)
  const deliveries = new PostgresWebhookDeliveryService(f.context)
  const instances = {
    isLive: async () => port !== null,
    generationOf: async () => f.project.generation,
    portOf: async () => port ?? 0,
    operationRef: async () => {},
  }
  const users = { getById: async (id: number) => (id === f.member.id ? f.member as UserRow : null) }
  const projects = { getById: async (id: number) => (id === f.project.id ? { name: 'Project' } as ProjectDetail : null) }
  const intake = new GatewayWebhookIntake(
    { cfg: { upstreamTimeoutMs: 5_000 }, users, projects, instances }, endpoints, deliveries, f.principals)
  const server = createServer((req, res) => { void intake.handle(req, res) })
  await new Promise<void>(ready => { server.listen(0, '127.0.0.1', ready) })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((closed, reject) => { server.close(error => { if (error) reject(error); else closed() }) })
  })
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { endpoints, deliveries, intake, base }
}

const post = (base: string, path: string, headers: Record<string, string>, body: string) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body })

describePg('Gateway webhook endpoints and intake', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  const fixture = async () => {
    const value = await createExecutionFixture(pool)
    cleanup.push(value.dispose)
    return value
  }

  it('registers, updates, and mutates endpoints with revision checks and a write-only secret', async () => {
    const f = await fixture()
    const service = new PostgresWebhookEndpointService(f.context, cipher)
    const created = await service.create(f.admin.id, endpointInput(f))
    expect(created).toMatchObject({ name: expect.any(String), provider: 'github', source: 'acme', enabled: false, revision: '1' })
    expect(created).not.toHaveProperty('secret')
    expect(await service.list()).toHaveLength(1)

    await expect(service.intake(created.publicId)).rejects.toMatchObject({ status: 404 })
    const enabled = await service.mutate({ targetId: created.publicId, revision: created.revision, action: 'enable' })
    expect(enabled?.enabled).toBe(true)
    const resolved = await service.intake(created.publicId)
    expect(resolved.secret).toBe(SECRET)
    expect(resolved.endpointId).toBe(created.id)

    await expect(service.create(f.admin.id, { ...endpointInput(f), name: '' })).rejects.toMatchObject({ status: 400 })
    await expect(service.create(f.admin.id, { ...endpointInput(f), secret: '' })).rejects.toMatchObject({ status: 400 })
    await expect(service.create(f.admin.id, { ...endpointInput(f), name: created.name })).rejects.toMatchObject({ status: 409 })
    const { secret: _secret, ...fields } = endpointInput(f)
    await expect(service.update({ targetId: created.publicId, revision: '0', fields }))
      .rejects.toMatchObject({ status: 409 })

    const renamed = await service.update({
      targetId: created.publicId, revision: enabled!.revision,
      fields: { ...fields, name: 'renamed', events: ['push', 'pull_request'], repositories: ['acme/widget'] },
    })
    expect(renamed).toMatchObject({ name: 'renamed', revision: '3', events: ['push', 'pull_request'],
      repositories: ['acme/widget'] })
    await expect(service.intake(created.publicId).then(config => config.events)).resolves.toEqual(['push', 'pull_request'])
    await expect(service.intake(created.publicId).then(config => config.repositories)).resolves.toEqual(['acme/widget'])
    await expect(service.update({ targetId: created.publicId, revision: renamed.revision,
      fields: { ...fields, repositories: ['no-slash'] } })).rejects.toMatchObject({ status: 400 })

    const rotated = await service.update({
      targetId: created.publicId, revision: renamed.revision, fields, secret: 'whsec-rotated',
    })
    expect((await service.intake(created.publicId)).secret).toBe('whsec-rotated')

    const disabled = await service.mutate({ targetId: created.publicId, revision: rotated.revision, action: 'disable' })
    expect(disabled?.enabled).toBe(false)
    await expect(service.intake(created.publicId)).rejects.toMatchObject({ status: 404 })
    expect(await service.mutate({ targetId: created.publicId, revision: disabled!.revision, action: 'remove' })).toBeNull()
    await expect(service.dispatchConfig(created.id)).rejects.toBeInstanceOf(WebhookEndpointError)
  })

  it('verifies signatures, deduplicates, filters events, and records ignored receipts', async () => {
    const f = await fixture()
    const runtime = await stubRuntime(() => ({ status: 200, body: { sessionId: `webhook-${randomUUID()}` } }))
    const { endpoints, deliveries, base } = await intakeFor(f, runtime.port)
    const endpoint = await endpoints.create(f.admin.id, endpointInput(f))
    await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'enable' })

    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' })
    const headers = githubRequest(body)
    const accepted = await post(base, `/webhook/${String(endpoint.publicId)}`, headers, body)
    expect(accepted.status).toBe(202)
    expect(runtime.requests).toHaveLength(1)
    const dispatched = JSON.parse(runtime.requests[0]!.body) as {
      ruleId: string; delivery: { kind: string; event: { name: string; payload: { ref: string } } }
      request: { title: string; prompt: string; agentPreset: string }
    }
    expect(dispatched.ruleId).toBe(`endpoint:${String(endpoint.publicId)}`)
    expect(dispatched.delivery.kind).toBe('github')
    expect(dispatched.delivery.event.name).toBe('push')
    expect(dispatched.request.title).toBe('Push refs/heads/main')
    expect(dispatched.request.prompt).toBe('Review abc123 on refs/heads/main')
    assert.ok(dispatched.delivery.event.payload.ref === 'refs/heads/main')
    expect(typeof runtime.requests[0]!.assertion).toBe('string')
    const claims = JSON.parse(Buffer.from(runtime.requests[0]!.assertion!.split('.')[0]!, 'base64url').toString()) as {
      purpose?: string; user: { id: number }; runtime: { kind: string; id: number } }
    expect(claims.purpose).toBe('webhook-dispatch')
    expect(claims.user.id).toBe(f.member.id)
    expect(claims.runtime).toMatchObject({ kind: 'project', id: f.project.id })

    const listed = await deliveries.list(endpoint.id)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({ state: 'submitted', sessionId: expect.stringMatching(/^webhook-/) })

    const duplicate = await post(base, `/webhook/${String(endpoint.publicId)}`, headers, body)
    expect(duplicate.status).toBe(202)
    expect(runtime.requests).toHaveLength(1)
    expect((await deliveries.list(endpoint.id)).items).toHaveLength(1)

    const filteredBody = JSON.stringify({ ref: 'refs/heads/main', after: 'def456' })
    const filtered = await post(base, `/webhook/${String(endpoint.publicId)}`,
      githubRequest(filteredBody, SECRET, { 'x-github-event': 'issues' }), filteredBody)
    expect(filtered.status).toBe(202)
    expect(runtime.requests).toHaveLength(1)
    const ignored = (await deliveries.list(endpoint.id)).items
    expect(ignored.find(row => row.state === 'ignored' && row.errorCode === 'event-unmatched')).toBeDefined()

    const forged = await post(base, `/webhook/${String(endpoint.publicId)}`,
      githubRequest(body, 'whsec-wrong'), body)
    expect(forged.status).toBe(401)
    expect(await post(base, `/webhook/${String(endpoint.publicId)}`, {
      ...githubRequest(body), 'content-type': 'text/plain',
    }, body).then(r => r.status)).toBe(415)
    expect((await post(base, '/webhook/999999', githubRequest(body), body)).status).toBe(404)
    expect((await post(base, `/webhook/${String(endpoint.publicId)}`,
      githubRequest('not json'), 'not json')).status).toBe(400)
  })

  it('applies the structured repository filter before dispatch', async () => {
    const f = await fixture()
    const runtime = await stubRuntime(() => ({ status: 200, body: { sessionId: `webhook-${randomUUID()}` } }))
    const { endpoints, deliveries, base } = await intakeFor(f, runtime.port)
    const endpoint = await endpoints.create(f.admin.id, { ...endpointInput(f), repositories: ['acme/widget'] })
    await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'enable' })

    const postDelivery = (body: string) => post(base, `/webhook/${String(endpoint.publicId)}`, githubRequest(body), body)
    const matching = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { full_name: 'acme/widget' } })
    expect((await postDelivery(matching)).status).toBe(202)
    expect(runtime.requests).toHaveLength(1)

    const other = JSON.stringify({ ref: 'refs/heads/main', after: 'def', repository: { full_name: 'acme/other' } })
    expect((await postDelivery(other)).status).toBe(202)
    const missing = JSON.stringify({ ref: 'refs/heads/main', after: 'ghi' })
    expect((await postDelivery(missing)).status).toBe(202)
    expect(runtime.requests).toHaveLength(1)

    const casing = JSON.stringify({ ref: 'refs/heads/main', after: 'jkl', repository: { full_name: 'ACME/Widget' } })
    expect((await postDelivery(casing)).status).toBe(202)
    expect(runtime.requests).toHaveLength(2)

    const rows = (await deliveries.list(endpoint.id)).items
    expect(rows.filter(row => row.state === 'submitted')).toHaveLength(2)
    expect(rows.filter(row => row.state === 'ignored' && row.errorCode === 'repository-unmatched')).toHaveLength(2)
  })

  it('records rejected when the runtime is offline and unknown on runtime failure', async () => {
    const f = await fixture()
    const offline = await intakeFor(f, null)
    const endpoint = await offline.endpoints.create(f.admin.id, endpointInput(f))
    await offline.endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'enable' })
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc' })
    expect((await post(offline.base, `/webhook/${String(endpoint.publicId)}`, githubRequest(body), body)).status).toBe(202)
    const rows = await offline.deliveries.list(endpoint.id)
    expect(rows.items[0]).toMatchObject({ state: 'rejected', errorCode: 'runtime-offline' })

    const failing = await stubRuntime(() => ({ status: 500 }))
    const second = await intakeFor(f, failing.port)
    const other = await second.endpoints.create(f.admin.id, { ...endpointInput(f), name: 'other-endpoint' })
    await second.endpoints.mutate({ targetId: other.publicId, revision: other.revision, action: 'enable' })
    expect((await post(second.base, `/webhook/${String(other.publicId)}`, githubRequest(body), body)).status).toBe(202)
    expect((await second.deliveries.list(other.id)).items[0]).toMatchObject({ state: 'unknown', errorCode: 'dispatch-failed' })
  })

  it('redispatches a settled receipt under current configuration with audit-safe unique identity', async () => {
    const f = await fixture()
    const runtime = await stubRuntime(() => ({ status: 200, body: { sessionId: `webhook-${randomUUID()}` } }))
    const { endpoints, deliveries, intake, base } = await intakeFor(f, runtime.port)
    const endpoint = await endpoints.create(f.admin.id, endpointInput(f))
    await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'enable' })
    const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123' })
    await post(base, `/webhook/${String(endpoint.publicId)}`, githubRequest(body), body)
    const original = (await deliveries.list(endpoint.id)).items[0]!
    expect(original.state).toBe('submitted')

    const rerun = await intake.redispatch(original.id)
    expect(rerun.state).toBe('submitted')
    expect(rerun.deliveryId).toMatch(/^rerun:/u)
    expect(runtime.requests).toHaveLength(2)
    const again = await intake.redispatch(original.id)
    expect(again.state).toBe('submitted')
    expect((await deliveries.list(endpoint.id)).items).toHaveLength(3)

    const dispatching = await deliveries.reserve({
      endpointId: endpoint.id as WebhookEndpointId, deliveryId: 'stuck', requestHash: createHash('sha256').update('x').digest('hex'),
      configurationRevision: '1', executionUserUuid: f.member.uuid, target: { kind: 'project', id: f.project.id },
      limit: 100, windowMs: 60_000, replayWindowMs: 86_400_000, event: { name: 'push', payload: {} },
    })
    await expect(intake.redispatch(dispatching.receipt.id)).rejects.toMatchObject({ status: 409 })
    await expect(intake.redispatch(randomUUID())).rejects.toMatchObject({ status: 404 })
  })
})
