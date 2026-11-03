/** Separate catalogs and projection receipts for one account's computer-local working documents. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresDocumentLocations } from '../src/postgres/document-locations.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('computer-local document metadata', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('isolates equal paths, versions, browsing, mutations and projection roots on two computers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-document-computers-')), slug = `documents-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Documents') RETURNING id", [slug])).rows[0]!.id
    try {
      for (const name of ['computer-a', 'computer-b']) await pool.query(
        'INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
      const a = await resolvePostgresRuntimeContext(pool, slug, 'computer-a'), b = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
      const owner = await new PostgresUserService(a, testConfig(root)).create({ username: 'owner', password: 'fixture-password', role: 'admin' })
      const account = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
        [organizationId, owner.id])).rows[0]!.id
      await pool.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
        VALUES($1,$2,$3,$4)`, [organizationId, b.nodeId, account, join(root, 'computer-b-home')])
      await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
        VALUES($1,$2,$3,true)`, [organizationId, b.nodeId, account])
      const catalogA = new PostgresDocumentCatalogService(a), catalogB = new PostgresDocumentCatalogService(b)
      const scope = { kind: 'personal' as const, userId: owner.id }, incarnation = randomUUID()
      for (const [catalog, bytes] of [[catalogA, 4], [catalogB, 8]] as const) await catalog.sync({ actorUserId: owner.id, scope,
        documents: [{ docId: 'same.txt', name: 'same.txt', bytes, mediaType: 'text/plain', modifiedAt: Date.now(),
          identity: { incarnationId: incarnation, revision: 1, origin: 'upload', createdBy: `user:${owner.id}` } }] })
      const locations = new PostgresDocumentLocations(a, { pageSize: 1, maxBytes: 4096 })
      const pageOne = await locations.page(owner.id, {})
      expect(pageOne.items).toHaveLength(1)
      expect(pageOne.nextCursor).not.toBeNull()
      const pageTwo = await locations.page(owner.id, { cursor: pageOne.nextCursor! })
      expect(pageTwo.items).toHaveLength(1)
      expect(new Set([...pageOne.items, ...pageTwo.items].map(item => item.scope.nodeId))).toEqual(new Set([a.nodeId, b.nodeId]))
      expect(pageTwo.nextCursor).toBeNull()
      await expect(locations.page(owner.id + 1, { cursor: pageOne.nextCursor! })).rejects.toMatchObject({ status: 400 })
      await expect(new PostgresDocumentLocations(a, { pageSize: 1, maxBytes: 32 }).page(owner.id, {})).rejects.toMatchObject({ status: 413 })
      await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, b.nodeId, account])
      await expect(locations.resolve(owner.id, { kind: 'personal', nodeId: b.nodeId as RuntimeNodeId }, 'read')).rejects.toMatchObject({ status: 403 })
      expect((await catalogA.overview(owner.id, {}, true)).documents).toHaveLength(1)
      await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3', [organizationId, b.nodeId, account])
      await expect(locations.resolve(owner.id, { kind: 'personal', nodeId: b.nodeId as RuntimeNodeId }, 'write')).resolves.toMatchObject({ mode: 'rw', scope: { nodeId: b.nodeId } })
      expect((await catalogA.overview(owner.id, {}, true)).documents).toHaveLength(2)
      const [first] = await catalogA.adminList(), [second] = await catalogB.adminList()
      expect(first).toMatchObject({ bytes: 4, scope: { nodeId: a.nodeId } })
      expect(second).toMatchObject({ bytes: 8, scope: { nodeId: b.nodeId } })
      expect(first!.catalogId).not.toBe(second!.catalogId)
      expect(await catalogA.detail(second!.catalogId)).toBeNull()
      expect(await catalogB.detail(first!.catalogId)).toBeNull()
      await expect(catalogA.adminTrash(owner.id, second!.catalogId)).rejects.toMatchObject({ status: 404 })
      await catalogB.adminTrash(owner.id, second!.catalogId)
      expect((await catalogA.detail(first!.catalogId))?.document.state).toBe('active')
      expect((await catalogB.detail(second!.catalogId))?.document.state).toBe('trash')
      const rootA = randomUUID(), rootB = randomUUID()
      expect(await catalogA.projectionCursor(owner.id, scope, rootA)).toEqual({ sequence: 0, ordinal: 0 })
      expect(await catalogB.projectionCursor(owner.id, scope, rootB)).toEqual({ sequence: 0, ordinal: 0 })
      await expect(catalogB.projectionCursor(owner.id, scope, rootA)).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_PROJECTION_CONFLICT' })
      expect((await catalogA.overview(owner.id)).documents).toHaveLength(1)
      expect((await catalogB.overview(owner.id)).documents).toHaveLength(0)
      expect(await catalogA.adminMetrics()).toMatchObject({ active: 1, trash: 0 })
      expect(await catalogB.adminMetrics()).toMatchObject({ active: 0, trash: 1 })
    } finally { await removeFixtureOrganization(pool, organizationId); await rm(root, { recursive: true, force: true }) }
  })
})
