/** Detached project creation cleanup against a real content volume. */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { NodeContentStore } from '../src/node-content-store.ts'
import { peerProjectTables } from '../src/node-content-project-tables.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const controlUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const contentUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL)
const dataDirectory = process.env.HGW_TEST_NODE_CONTENT_PGDATA
const skip = !controlUrl || !contentUrl || !dataDirectory

describe.skipIf(skip)('detached project creation discard', () => {
  it('removes every project-scoped child before the orphaned space row and refuses committed projects', async () => {
    const control = createPostgresPool(controlUrl!, { max: 3 })
    // Other volume suites provision their own identities onto the shared
    // content database; take a dedicated disposable database on the same
    // server so this spec composes with them in one vitest run.
    const adminUrl = new URL(contentUrl!)
    adminUrl.pathname = '/postgres'
    const admin = createPostgresPool(adminUrl.href, { max: 1 })
    const name = 'hgw_discard_' + randomUUID().replaceAll('-', '').slice(0, 12) + '_test'
    const selfUrl = new URL(contentUrl!)
    selfUrl.pathname = '/' + name
    let content: Pool | undefined
    try {
      if (new URL(controlUrl!).pathname === selfUrl.pathname) throw new Error('This fixture requires two separate disposable databases.')
      await admin.query(`CREATE DATABASE "${name}"`)
      content = createPostgresPool(selfUrl.href, { max: 3 })
      await runMigrations(control, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
      const organizationId = randomUUID(), nodeId = randomUUID()
      const options = { pool: content, organizationId, nodeId, volumeId: randomUUID(), dataDirectory: dataDirectory!, proofTimeoutMs: 5000 }
      await migrateNodeContent(options, resolve(import.meta.dirname, '../deploy/node-content/migrations'))
      const store = await NodeContentStore.open(options)
      const seed = async (pool: Pool, projectId: string, runtimeId: string, epoch: number) => {
        await pool.query(`INSERT INTO node_content.spaces(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch,runtime_generation,name,root_path)
          VALUES($1,$2,$3,$4,$5,$6,0,'orphan','/x')`, [organizationId, projectId, nodeId, runtimeId, options.volumeId, epoch])
        // bindNewProject populates children beyond spaces; the non-cascading
        // anchors/states rows are what a spaces-only delete trips over, and the
        // journal row exercises project-keyed rather than runtime-keyed deletion.
        await pool.query(`INSERT INTO node_content.project_file_anchors(organization_id,project_id,runtime_id,owner,path,anchor_path,device,inode,missing)
          VALUES($1,$2,$3,'workspace','/x','/x/.anchor','dev','1',false)`, [organizationId, projectId, runtimeId])
        await pool.query(`INSERT INTO node_content.plugin_states(organization_id,project_id,runtime_id,user_id,entries,bundles,revision)
          VALUES($1,$2,$3,NULL,'[]','[]',1)`, [organizationId, projectId, runtimeId])
        await pool.query(`INSERT INTO node_content.project_journal(organization_id,project_id,kind,content)
          VALUES($1,$2,'current','{"summary":"x","sections":{}}')`, [organizationId, projectId])
      }
      const projectId = randomUUID(), runtimeId = randomUUID() as RuntimeId
      await seed(content, projectId, runtimeId, 1)
      expect(await store.discardDetachedCreation(control, projectId, runtimeId)).toBe(true)
      for (const table of peerProjectTables) {
        const count = await content!.query(`SELECT count(*)::int n FROM node_content."${table}" WHERE organization_id=$1`, [organizationId])
        expect(count.rows[0].n, table).toBe(0)
      }
      // A committed generation is not a detached creation: epoch>1 stays put.
      const keptProject = randomUUID(), keptRuntime = randomUUID() as RuntimeId
      await seed(content, keptProject, keptRuntime, 2)
      expect(await store.discardDetachedCreation(control, keptProject, keptRuntime)).toBe(false)
      const left = await content!.query('SELECT count(*)::int n FROM node_content.spaces WHERE organization_id=$1', [organizationId])
      expect(left.rows[0].n).toBe(1)
    } finally {
      await control.end().catch(() => undefined)
      await content?.end().catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    }
  })
})
