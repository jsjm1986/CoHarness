/** Configuration preflight reads real maintenance, node identity and private deployment files. */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeConfigurationHost } from '../src/node-config-host.ts'
import { NODE_CONFIG_FIELDS } from '../src/node-config-fields.ts'
import { NodeConfigurationStore, readNodeConfiguration } from '../src/node-config-store.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig, testEnvironment } from './test-config.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
describe.skipIf(url === undefined || process.platform !== 'darwin' && process.platform !== 'linux')('node configuration host PostgreSQL preflight', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(url!, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'node-config-host-pg-'))
    let organizationId: PostgresRuntimeContext['organizationId'] | undefined
    async function close(): Promise<void> {
      const failures: unknown[] = []
      if (organizationId !== undefined) {
        try { await removeFixtureOrganization(pool, organizationId) } catch (error) { failures.push(error) }
      }
      try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'Configuration preflight fixture cleanup failed')
    }
    try {
      const slug = `preflight-${randomUUID()}`
      organizationId = (await pool.query<{ id: PostgresRuntimeContext['organizationId'] }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Configuration preflight') RETURNING id", [slug])).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const credential = join(root, 'database-url')
      await writeFile(credential, url!, { mode: 0o600 })
      const environment = testEnvironment(root, { HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'local', HGW_DATABASE_URL_FILE: credential })
      const cfg = testConfig(root, environment), authority = nodeConfigurationAuthority(context)
      const store = new NodeConfigurationStore(context, cfg, environment, authority)
      await store.initialize()
      const record = (await readNodeConfiguration(cfg.nodeConfigFile, environment))!
      for (const field of NODE_CONFIG_FIELDS) {
        if (field.kind !== 'file') continue
        const path = record.desired[field.key]
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, randomUUID(), { mode: 0o600 })
      }
      const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
      const lifetime = new AbortController(), host = createNodeConfigurationHost(environment, context, lifetime.signal)
      return { root, context, record, maintenance, lifetime, host, async [Symbol.asyncDispose]() { await close() } }
    } catch (error) {
      try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Configuration preflight setup failed') }
      throw error
    }
  }

  it('requires an explicit quiesced maintenance window before checking candidate files', async () => {
    await using f = await fixture()
    await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: 'configuration-requires-quiesced-maintenance' })
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    await expect(f.host.preflight(f.record)).resolves.toBeUndefined()
  })

  it('rejects configuration owned by another database node', async () => {
    await using f = await fixture()
    await f.context.pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other')", [f.context.organizationId])
    const other = await resolvePostgresRuntimeContext(pool, f.context.organizationSlug, 'other')
    const foreign = { ...f.record, organizationId: other.organizationId, nodeId: other.nodeId }
    await expect(f.host.preflight(foreign)).rejects.toMatchObject({ message: 'node-configuration-identity-mismatch' })
  })

  it('rejects a queued request from an earlier restored database generation', async () => {
    await using f = await fixture()
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    f.record.operation = { id: randomUUID(), revision: 0, writeEpoch: '1', actor: null, status: 'pending', requestedAt: new Date().toISOString(), error: null }
    await pool.query('UPDATE harness.cluster_control SET write_epoch=write_epoch+1 WHERE organization_id=$1', [f.context.organizationId])
    await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: 'node-configuration-request-predates-restored-data' })
  })

  it('rejects a credential file selecting another database before connecting to it', async () => {
    await using f = await fixture()
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    const candidate = join(f.root, 'candidate-url'), target = new URL(url!)
    target.pathname = '/unrelated_database_test'
    await writeFile(candidate, target.href, { mode: 0o600 })
    f.record.desired.HGW_DATABASE_URL_FILE = candidate
    await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: 'database-target-change-requires-coordinated-data-migration' })
  })

  it('rejects an occupied candidate listener while retaining the current configuration', async () => {
    await using f = await fixture()
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    const server = createServer()
    try {
      await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
      const port = (server.address() as AddressInfo).port
      f.record.desired.HGW_PORT = String(port)
      await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: `configuration-port-unavailable:${port}` })
    } finally { if (server.listening) await new Promise<void>(done => { server.close(() => { done() }) }) }
  })

  it.each(['HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE', 'HGW_WEBHOOK_SECRET_KEY_FILE'] as const)('rejects nonprivate credential file %s', async key => {
    await using f = await fixture()
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    await chmod(f.record.desired[key], 0o644)
    await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: `configuration-credential-file-unavailable-or-not-private:${key}` })
  })

  it('rejects a symlink used as a prepared directory', async () => {
    await using f = await fixture()
    await f.maintenance.enterMaintenance(null, 'preflight acceptance')
    const path = join(f.root, 'candidate-projects')
    await symlink(f.root, path)
    f.record.desired.HGW_PROJECTS_ROOT = path
    await expect(f.host.preflight(f.record)).rejects.toMatchObject({ message: `configuration-directory-unavailable:${path}` })
  })

  it('refuses preflight after the deployment lease has been lost', async () => {
    await using f = await fixture()
    const reason = new Error('deployment lease lost')
    f.lifetime.abort(reason)
    await expect(f.host.preflight(f.record)).rejects.toBe(reason)
  })
})
