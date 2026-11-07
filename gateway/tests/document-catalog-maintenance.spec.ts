/** Real PostgreSQL and HTTP ownership of catalog writes that outlive document reads. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOCUMENT_STORE_UNAVAILABLE_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import { createGatewayDocumentScopeHandler } from '../src/document-transfer.ts'
import { LocalDocumentBroker } from '../src/documents-local.ts'
import { InstanceManager } from '../src/instances.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { createGatewayServer } from '../src/server.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { testConfig } from './test-config.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describePg('PostgreSQL document catalog maintenance', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('keeps a read-driven catalog writer in real maintenance quiescence and refuses new reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-catalog-maintenance-'))
    const slug = `catalog-${randomUUID()}`
    const entered = barrier(), release = barrier(), finished = barrier()
    let server: Server | undefined, local: LocalDocumentBroker | undefined, instances: InstanceManager | undefined
    let organizationId: string | undefined
    let failure: unknown
    try {
      organizationId = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Catalog maintenance') RETURNING id", [slug],
      )).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'catalog-node')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'catalog-node')
      const cfg = testConfig(root), users = new PostgresUserService(context, cfg)
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      const user = await users.create({ username: 'reader', password: 'fixture-password' })
      await users.changeOwnPassword(user.id, 'fixture-password')
      const projects = new PostgresProjectService(context, cfg), collaboration = new PostgresCollaborationService(context)
      const auth = new PostgresAuthService(context, cfg), audit = new PostgresAuditService(context)
      const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
      await repository.initialize()
      instances = new InstanceManager(repository, cfg)
      const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
      const baseline = await maintenance.currentWriteEpoch()
      let writers = 0, calls = 0
      const retain = async (operation: () => Promise<void>): Promise<void> => {
        writers += 1
        try { await operation() } finally { writers -= 1 }
      }
      const admit = (operation: () => Promise<void>): Promise<void> => retain(async () => {
        if ((await maintenance.writeGate(baseline)).verdict !== 'open') throw new UserDocError('Fixture maintenance admission', DOCUMENT_STORE_UNAVAILABLE_CODE)
        await operation()
      })
      const catalogService = new PostgresDocumentCatalogService(context)
      const real = createDocumentCatalogHandlers(catalogService, audit)
      const catalog = { ...real, projection: async (input: Parameters<typeof real.projection>[0]) => {
        if (typeof input.payload !== 'object' || input.payload === null || !('batch' in input.payload)) {
          return real.projection(input)
        }
        calls += 1
        entered.resolve()
        await release.promise
        try { return await real.projection(input) } finally { finished.resolve() }
      } }
      const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 60_000)
      const dependencies = { cfg, users, projects, collaboration, instances, principals, organizationId, catalog }
      local = new LocalDocumentBroker({ ...dependencies, writes: { retain, admit } })
      server = createGatewayServer({ cfg, users, projects, collaboration, instances, auth, audit,
        maintenanceGate: async () => (await maintenance.writeGate(baseline)).verdict,
        writerSpan: () => { writers += 1; return () => { writers -= 1 } },
      }, { documentScope: createGatewayDocumentScopeHandler({ ...dependencies, catalog: catalogService, local }) })
      await new Promise<void>((done, reject) => {
        server!.once('error', reject)
        server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); done() })
      })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: user.username, password: 'fixture-password' }) })
      await login.arrayBuffer()
      expect(login.status).toBe(302)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (cookie === undefined) throw new Error('Catalog fixture login did not issue a cookie')
      const directory = join(user.homePath, 'documents')
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'owned.txt'), 'owned catalog data')
      const list = () => fetch(`${base}/api/documents/scope?scope=personal`, { headers: { cookie, origin: base } })
      const response = await list()
      expect(response.status).toBe(200); await response.arrayBuffer()
      await entered.promise
      expect(writers).toBe(1)
      await maintenance.enterMaintenance(null)
      const gate = await maintenance.writeGate(baseline)
      await maintenance.heartbeat(gate.maintenanceEpoch, writers)
      expect((await maintenance.state()).writersQuiesced).toBe(false)
      const whileClosed = await list()
      expect(whileClosed.status).toBe(200); await whileClosed.arrayBuffer()
      expect(calls).toBe(1)
      await writeFile(join(directory, 'owned.txt'), 'external changes while maintenance is closed')
      const changedWhileClosed = await list()
      expect(changedWhileClosed.status).toBe(503); await changedWhileClosed.arrayBuffer()
      expect(calls).toBe(1)
      release.resolve(); await finished.promise
      await local.dispose()
      expect(writers).toBe(0)
      await maintenance.heartbeat(gate.maintenanceEpoch, writers)
      expect((await maintenance.state()).writersQuiesced).toBe(true)
      const rows = await pool.query<{ runtime_doc_id: string; state: string; username: string }>(
        `SELECT d.runtime_doc_id,d.state,u.username FROM harness.document_catalog d
         JOIN harness.users u ON u.id=d.owner_user_id AND u.organization_id=d.organization_id
         WHERE d.organization_id=$1`, [organizationId],
      )
      expect(rows.rows).toEqual([{ runtime_doc_id: 'owned.txt', state: 'active', username: user.username }])
    } catch (error) {
      failure = error
      throw error
    } finally {
      release.resolve()
      server?.closeAllConnections()
      const cleanup = await Promise.allSettled([
        ...(server === undefined ? [] : [new Promise<void>((done, reject) => {
          server!.close(error => { if (error) reject(error); else done() })
        })]),
        local?.dispose(),
      ])
      cleanup.push(...await Promise.allSettled([instances?.stopAll()]))
      const errors = cleanup.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      try {
        if (organizationId !== undefined) await removeFixtureOrganization(pool, organizationId)
      } catch (error) { errors.push(error) }
      try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Catalog maintenance fixture cleanup failed')
    }
  })
})
