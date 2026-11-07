/** Current webhook configuration and administrator authority at durable admission. @module */
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresWebhookEndpointService, WebhookSecretCipher } from '../src/postgres/webhook-endpoint-service.ts'
import { PostgresWebhookDeliveryService, type WebhookEndpointId } from '../src/postgres/webhook-delivery-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import type { RuntimeId } from '../src/runtime-catalog.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL webhook admission', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const slug = `webhook-admission-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Webhook admission') RETURNING id", [slug])).rows[0]!.id
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local'), accounts = []
      for (const name of ['administrator', 'executor']) {
        const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, name])).rows[0]!
        await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [organizationId, row.id, name === 'administrator' ? 'admin' : 'member'])
        accounts.push({ id: row.id, publicId: Number(row.public_id) })
      }
      const admin = accounts[0]!, executor = accounts[1]!, cipher = new WebhookSecretCipher(Buffer.alloc(32, 9))
      await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
        VALUES($1,$2,$3,48000)`, [organizationId, executor.id, context.nodeId])
      const endpoints = new PostgresWebhookEndpointService(context, cipher), deliveries = new PostgresWebhookDeliveryService(context)
      const fields = { name: 'Fixture endpoint', provider: 'github' as const, source: 'fixture', events: ['push'], actions: [], repositories: [],
        titleTemplate: 'Fixture event', promptTemplate: 'Fixture prompt', workspacePath: '/unused', agentPreset: 'default', permissionPreset: 'default',
        executionUserId: executor.publicId, runtimeKind: 'user' as const, runtimePublicId: executor.publicId, projectVisibility: 'project' as const,
        intakeLimit: 100, intakeWindowMs: 60_000, replayWindowMs: 60_000, maxBodyBytes: 1024 }
      const created = await endpoints.create(admin.publicId, { ...fields, secret: 'fixture-secret' })
      const endpoint = (await endpoints.mutate({ targetId: created.publicId, revision: created.revision, action: 'enable' }, admin.publicId))!
      const config = await endpoints.intake(endpoint.publicId)
      const input = { endpointId: endpoint.id as WebhookEndpointId, deliveryId: randomUUID(), requestHash: createHash('sha256').update('fixture').digest('hex'),
        configurationRevision: config.revision, executionUserUuid: executor.id, target: { kind: 'user' as const, id: executor.publicId,
          ...(config.runtimeId === undefined ? {} : { runtimeId: config.runtimeId }) },
        limit: 100, windowMs: 60_000, replayWindowMs: 60_000, event: { name: 'push', payload: {} } }
      return { context, admin, executor, endpoints, deliveries, fields, endpoint, input, cipher, close: () => removeFixtureOrganization(pool, organizationId) }
    } catch (error) {
      try { await removeFixtureOrganization(pool, organizationId) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Webhook setup and cleanup failed') }
      throw error
    }
  }

  it.each(['disable', 'rotate', 'remove', 'organization'] as const)('rejects captured provider configuration after %s before reservation', async change => {
    const f = await fixture()
    try {
      if (change === 'disable' || change === 'remove') await f.endpoints.mutate({ targetId: f.endpoint.publicId, revision: f.endpoint.revision, action: change }, f.admin.publicId)
      if (change === 'rotate') await f.endpoints.update({ targetId: f.endpoint.publicId, revision: f.endpoint.revision, fields: f.fields, secret: 'fixture-rotated' }, f.admin.publicId)
      if (change === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      await expect(f.deliveries.reserve(f.input)).rejects.toMatchObject({ status: change === 'rotate' ? 409 : 404 })
      expect((await pool.query('SELECT id FROM harness.webhook_delivery_receipts WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([])
      expect((await pool.query('SELECT endpoint_id FROM harness.webhook_intake_windows WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([])
    } finally { await f.close() }
  })

  it('retains the configured Runtime across edits and refuses sibling or wrong-computer reservations', async () => {
    const f = await fixture()
    try {
      const sibling = (await pool.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances
        (organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48001,'isolated') RETURNING runtime_id`,
      [f.context.organizationId, f.executor.id, f.context.nodeId])).rows[0]!.runtime_id
      await expect(f.endpoints.create(f.admin.publicId, { ...f.fields, name: 'Ambiguous target', secret: 'fixture-secret' })).rejects.toMatchObject({ status: 409 })
      const edited = await f.endpoints.update({ targetId: f.endpoint.publicId, revision: f.endpoint.revision, fields: { ...f.fields, name: 'Retained binding' } }, f.admin.publicId)
      expect(edited.runtimeId).toBe(f.endpoint.runtimeId)
      const input = { ...f.input, configurationRevision: edited.revision }
      await expect(f.deliveries.reserve({ ...input, target: { ...input.target, runtimeId: sibling } })).rejects.toMatchObject({ status: 409 })
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other')", [f.context.organizationId])
      const other = await resolvePostgresRuntimeContext(pool, f.context.organizationSlug, 'other')
      await expect(new PostgresWebhookDeliveryService(other).reserve(input)).rejects.toMatchObject({ status: 409 })
      const remote = new PostgresWebhookEndpointService(other, f.cipher)
      expect(await remote.placement(f.endpoint.publicId)).toBe(f.context.nodeId)
      await expect(remote.intake(f.endpoint.publicId)).rejects.toMatchObject({ status: 404 })
      expect((await pool.query('SELECT id FROM harness.webhook_delivery_receipts WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([])
    } finally { await f.close() }
  })

  it('rejects stale administrator redispatch configuration without creating a new receipt', async () => {
    const f = await fixture()
    try {
      const original = await f.deliveries.reserve(f.input)
      await f.deliveries.complete(f.input.endpointId, original.receipt.id, { state: 'ignored' })
      const config = { endpointId: f.endpoint.id, configurationRevision: f.endpoint.revision, executionUserUuid: f.executor.id, target: f.input.target }
      await f.endpoints.update({ targetId: f.endpoint.publicId, revision: f.endpoint.revision, fields: f.fields, secret: 'fixture-rotated' }, f.admin.publicId)
      await expect(f.deliveries.redispatch(original.receipt.id, config, f.admin.publicId)).rejects.toMatchObject({ status: 409 })
      expect((await pool.query('SELECT id FROM harness.webhook_delivery_receipts WHERE organization_id=$1', [f.context.organizationId])).rows).toEqual([{ id: original.receipt.id }])
    } finally { await f.close() }
  })

  it('rechecks the initiating administrator after reading redispatch configuration', async () => {
    const f = await fixture()
    try {
      const original = await f.deliveries.reserve(f.input)
      await f.deliveries.complete(f.input.endpointId, original.receipt.id, { state: 'ignored' })
      await f.endpoints.dispatchConfig(f.endpoint.id, f.admin.publicId)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.admin.id])
      await expect(f.deliveries.redispatch(original.receipt.id, { endpointId: f.endpoint.id, configurationRevision: f.endpoint.revision,
        executionUserUuid: f.executor.id, target: f.input.target }, f.admin.publicId)).rejects.toMatchObject({ code: 'forbidden' })
      expect((await pool.query('SELECT count(*)::int count FROM harness.webhook_delivery_receipts WHERE organization_id=$1', [f.context.organizationId])).rows[0]!.count).toBe(1)
    } finally { await f.close() }
  })

  it('rechecks enabled configuration after an endpoint row-lock wait', async () => {
    const f = await fixture(), name = `webhook-queued-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name }), held = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM harness.webhook_endpoints WHERE organization_id=$1 AND id=$2 FOR UPDATE', [f.context.organizationId, f.endpoint.id])
      pending = new PostgresWebhookDeliveryService({ ...f.context, pool: reader }).reserve(f.input).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name])).rows[0]!.waiting).toBe(true)
      await held.query('UPDATE harness.webhook_endpoints SET enabled=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [f.context.organizationId, f.endpoint.id]); await held.query('COMMIT')
      expect(await pending).toMatchObject({ status: 404 })
    } finally { await held.query('ROLLBACK'); held.release(); await pending; await reader.end(); await f.close() }
  })

  it('retains current administrator authority while an accepted endpoint update waits', async () => {
    const f = await fixture(), readName = `webhook-admin-read-${randomUUID()}`, revokeName = `webhook-admin-revoke-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: readName }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName }), held = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokeSettled = false
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM harness.webhook_endpoints WHERE organization_id=$1 AND id=$2 FOR UPDATE', [f.context.organizationId, f.endpoint.id])
      const service = new PostgresWebhookEndpointService({ ...f.context, pool: reader }, f.cipher)
      pending = service.update({ targetId: f.endpoint.publicId, revision: f.endpoint.revision, fields: { ...f.fields, name: 'Accepted update' } }, f.admin.publicId).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [readName])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.admin.id])
        .then(value => { revokeSettled = true; return value }, (error: unknown) => { revokeSettled = true; return error })
      await expect.poll(async () => revokeSettled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity p ON p.application_name=$1
        WHERE r.application_name=$2 AND p.pid=ANY(pg_blocking_pids(r.pid))) blocked`, [readName, revokeName])).rows[0]!.blocked).toBe(true)
      expect(revokeSettled).toBe(false)
      await held.query('COMMIT'); expect(await pending).toMatchObject({ revision: '3' }); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(service.list(f.admin.publicId)).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.all([pending, revoked]); await reader.end(); await revoker.end(); await f.close() }
  })
})
