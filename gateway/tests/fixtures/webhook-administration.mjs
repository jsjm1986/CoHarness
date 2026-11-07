/** Current webhook administrator authority through real PostgreSQL and authenticated Gateway HTTP. */
import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { PostgresWebhookEndpointService, WebhookSecretCipher },
  { PostgresWebhookDeliveryService }, { GatewayWebhookIntake }, { GatewayPrincipalSigner }, { PostgresCollaborationService }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config',
  'postgres/webhook-endpoint-service', 'postgres/webhook-delivery-service', 'webhook-intake', 'principal', 'postgres/collaboration-service',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 1 })
try {
  await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['create', 'update', 'enable', 'disable', 'remove', 'list', 'receipts', 'redispatch', 'intake']) {
    for (const change of operation === 'intake' ? ['disable', 'rotate', 'remove', 'disabled-organization', 'current', 'nonfinite-payload', 'finite-payload'] : ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', ...(operation === 'redispatch' ? ['disabled-intake'] : [])]) {
      const root = await mkdtemp(join(tmpdir(), 'webhook-admin-http-'))
      let organizationId, gateway, manager, pending, release, primaryError
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `webhook-admin-${randomUUID()}`
        organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Webhook administration') RETURNING id", [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
        const actor = await users.create({ username: 'administrator', role: 'admin', password: 'pw-12345678' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const executor = await users.create({ username: 'executor', password: 'pw-12345678' })
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const executorId = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, executor.id])).rows[0].id
        const audit = new PostgresAuditService(context), endpoints = new PostgresWebhookEndpointService(context, new WebhookSecretCipher(Buffer.alloc(32, 7)))
        const deliveries = new PostgresWebhookDeliveryService(context)
        const fields = { name: 'existing', provider: 'github', source: 'fixture', events: ['push'], actions: [], repositories: [],
          titleTemplate: 'Fixture event', promptTemplate: 'Review fixture event', workspacePath: '/unused', agentPreset: 'default', permissionPreset: 'default',
          executionUserId: executor.id, runtimeKind: 'user', runtimePublicId: executor.id, projectVisibility: 'project', intakeLimit: 100,
          intakeWindowMs: 60000, replayWindowMs: 86400000, maxBodyBytes: 1048576 }
        let endpoint = await endpoints.create(actor.id, { ...fields, secret: 'fixture-signing-secret' })
        if (operation === 'disable' || operation === 'redispatch' || operation === 'intake') endpoint = await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'enable' }, actor.id)
        let receipt
        if (operation === 'redispatch') {
          const reserved = await deliveries.reserve({ endpointId: endpoint.id, deliveryId: randomUUID(), requestHash: createHash('sha256').update('fixture').digest('hex'),
            configurationRevision: endpoint.revision, executionUserUuid: executorId,
            target: { kind: 'user', id: executor.id, ...(endpoint.runtimeId === undefined ? {} : { runtimeId: endpoint.runtimeId }) }, limit: 100,
            windowMs: 60000, replayWindowMs: 86400000, event: { name: 'pull_request', payload: {} } })
          receipt = await deliveries.complete(endpoint.id, reserved.receipt.id, { state: 'ignored', errorCode: 'event-unmatched' })
        }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
        await manager.stopAll()
        const { privateKey } = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(privateKey, slug, 60000)
        const deps = { cfg, users, projects, audit, instances: manager, auth: new PostgresAuthService(context, cfg),
          webhookEndpoints: endpoints, webhookDeliveries: deliveries, collaboration: new PostgresCollaborationService(context) }
        deps.webhookIntake = new GatewayWebhookIntake(deps, endpoints, deliveries, principals)
        const earlyVerification = operation === 'intake' && change.endsWith('-payload')
        const owner = earlyVerification ? endpoints : operation === 'intake' || operation === 'receipts' ? deliveries : operation === 'redispatch' ? deps.webhookIntake : endpoints
        const method = earlyVerification ? 'intake' : operation === 'intake' ? 'reserve' : ['enable', 'disable', 'remove'].includes(operation) ? 'mutate' : operation === 'receipts' ? 'list' : operation
        const original = owner[method].bind(owner)
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        owner[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const isGet = operation === 'list' || operation === 'receipts'
        const path = operation === 'intake' ? `/webhook/${endpoint.publicId}` : operation === 'receipts' ? `/admin/api/webhook-deliveries?endpointId=${endpoint.id}`
          : operation === 'redispatch' ? '/admin/api/webhook-deliveries/redispatch'
            : `/admin/api/webhook-endpoints${isGet || operation === 'create' ? '' : operation === 'update' ? '/update' : '/mutate'}`
        const body = operation === 'intake' ? { ref: 'fixture' } : operation === 'create' ? { ...fields, name: 'created', secret: 'fixture-new-secret' }
          : operation === 'update' ? { targetId: endpoint.publicId, revision: endpoint.revision, fields: { ...fields, name: 'updated' }, secret: 'fixture-rotated-secret' }
            : operation === 'redispatch' ? { receiptId: receipt.id } : { targetId: endpoint.publicId, revision: endpoint.revision, action: operation }
        const payload = earlyVerification ? (change === 'nonfinite-payload' ? '{"value":1e400}' : '{"value":1e3}') : JSON.stringify(body)
        const headers = { origin, cookie, 'content-type': 'application/json', ...(operation === 'intake' ? {
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-signing-secret').update(payload).digest('hex')}`,
          'x-github-delivery': randomUUID(), 'x-github-event': 'pull_request',
        } : {}) }
        pending = fetch(`${origin}${path}`, { method: isGet ? 'GET' : 'POST', headers, ...(isGet ? {} : { body: payload }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        await observed
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        if ((operation === 'intake' && change === 'disable') || change === 'disabled-intake') await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'disable' }, actor.id)
        if (operation === 'intake' && change === 'remove') await endpoints.mutate({ targetId: endpoint.publicId, revision: endpoint.revision, action: 'remove' }, actor.id)
        if (operation === 'intake' && change === 'rotate') await endpoints.update({ targetId: endpoint.publicId, revision: endpoint.revision, fields, secret: 'fixture-rotated-secret' }, actor.id)
        release()
        const response = await pending
        const rows = (await pool.query('SELECT name,revision::text,enabled FROM harness.webhook_endpoints WHERE organization_id=$1 ORDER BY public_id', [organizationId])).rows
        const existing = rows.find(row => row.name !== 'created')
        const receipts = (await pool.query('SELECT count(*)::int count FROM harness.webhook_delivery_receipts WHERE organization_id=$1', [organizationId])).rows[0].count
        const action = operation === 'redispatch' ? 'admin.webhook-deliveries.redispatch' : `admin.webhook-endpoints.${operation === 'create' || operation === 'update' ? operation : 'mutate'}`
        const successAudit = (await audit.query({ action })).length
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null,
          endpointRows: rows.length, revision: existing?.revision ?? null, enabled: existing?.enabled ?? null, receipts, successfulAudit: successAudit }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.(); await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (manager !== undefined) await close(() => manager.stopAll())
        if (organizationId !== undefined) await close(async () => {
          const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
          for (let pass = 0; pass < 12; pass += 1) {
            let blocked = false
            for (const { table_name: table } of tables) {
              try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
              catch (error) { if (error.code === '23503') blocked = true; else throw error }
            }
            if (!blocked) break
          }
          await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId]); await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        })
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Webhook administration cleanup failed')
      }
    }
  }
} finally { await pool.end() }
