import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { parseInventoryReport, PostgresPluginInventory } from '../src/plugin-inventory.ts'

const DATABASE_URL = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = DATABASE_URL === undefined ? describe.skip : describe
const MIGRATIONS = resolve(import.meta.dirname, '../deploy/postgres/migrations')

const bundleFixture = {
  name: '@team/collab', version: '1.3.0',
  meta: { title: { en: 'Collab tools', zh: '协作工具' } },
  enabled: true, installed: true, optional: false, removable: true,
  source: 'file:/home/owner/plugins/collab',
  rows: [{ rowId: 'collab-rows', moduleName: '@team/collab/rows', entryId: 'entry-1' }],
  overrides: ['core-row'],
}
const pluginFixture = {
  entryId: 'entry-1', moduleName: '@team/collab/rows', enabled: true, fiberPhase: 'active',
}

describe('plugin inventory report validation', () => {
  it('normalizes a complete report and drops unknown fields', () => {
    const report = parseInventoryReport({
      bundles: [{ ...bundleFixture, noise: 'x' }],
      plugins: [{ ...pluginFixture, extra: 1 }],
      unknown: true,
    })
    expect(report.bundles).toEqual([bundleFixture])
    expect(report.plugins).toEqual([pluginFixture])
  })

  it('rejects malformed reports instead of storing partial compositions', () => {
    expect(() => parseInventoryReport(null)).toThrowError(/must be an object/u)
    expect(() => parseInventoryReport({})).toThrowError(/bundles/u)
    expect(() => parseInventoryReport({ bundles: [], plugins: 'x' })).toThrowError(/plugins/u)
    expect(() => parseInventoryReport({ bundles: [{ name: 7 }], plugins: [] })).toThrowError(/name/u)
    expect(() => parseInventoryReport({
      bundles: [], plugins: [{ entryId: 'e', moduleName: 'm', enabled: 'yes', fiberPhase: null }],
    })).toThrowError(/enabled/u)
    expect(() => parseInventoryReport({
      bundles: [{ ...bundleFixture, rows: [{ rowId: 'r' }] }], plugins: [],
    })).toThrowError(/moduleName/u)
  })

  it('accepts absent optional fields, empty arrays, and null fiber phases', () => {
    const report = parseInventoryReport({
      bundles: [{ name: 'pkg', enabled: false, installed: false, optional: true, removable: false, rows: [], overrides: [] }],
      plugins: [{ entryId: 'e', moduleName: 'm', enabled: false, fiberPhase: null }],
    })
    expect(report.bundles[0]!.name).toBe('pkg')
    expect(report.plugins[0]!.fiberPhase).toBeNull()
  })
})

describePg('PostgreSQL plugin_inventory', () => {
  let pool: Pool
  let inventory: PostgresPluginInventory
  let organizationId: string
  let userPublicId: number
  let projectPublicId: number
  let userInternalId: string
  let projectInternalId: string
  let userRuntimeId: RuntimeId

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!, { max: 4 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, MIGRATIONS)
    const slug = `plugin-inventory-${randomUUID()}`, nodeName = randomUUID()
    organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Plugin inventory') RETURNING id`, [slug])).rows[0]!.id
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, nodeName])
    const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
      organization_id,username,display_name,home_path) VALUES($1,'owner','Owner','/tmp/owner') RETURNING id,public_id`, [organizationId])).rows[0]!
    userInternalId = user.id
    userPublicId = Number(user.public_id)
    const project = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by) VALUES($1,'Inventory project',$2) RETURNING id,public_id`, [organizationId, userInternalId])).rows[0]!
    projectInternalId = project.id
    projectPublicId = Number(project.public_id)
    const nodeId = (await pool.query<{ id: string }>(
      `SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name=$2`, [organizationId, nodeName])).rows[0]!.id
    await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,observed_state)
      VALUES($1,$2,$3,41011,'ready')`, [organizationId, userInternalId, nodeId])
    await pool.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port)
      VALUES($1,$2,$3,41012)`, [organizationId, projectInternalId, nodeId])
    userRuntimeId = (await pool.query<{ runtime_id: RuntimeId }>(
      `SELECT runtime_id FROM harness.instances WHERE organization_id=$1 AND user_id=$2`,
      [organizationId, userInternalId])).rows[0]!.runtime_id
    const context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
    inventory = new PostgresPluginInventory(context)
  }, 60_000)

  afterAll(async () => { await pool?.end() })

  const subject = (generation = 1) => ({
    organizationId, generation,
    target: { kind: 'user' as const, id: userPublicId },
    userInternalId,
  })

  it('stores a runtime report and lists it with liveness and saved-state context', async () => {
    await inventory.report(subject(), { bundles: [bundleFixture], plugins: [pluginFixture] })
    const stored = await pool.query<{ payload: { bundles: unknown[] }; generation: string }>(
      `SELECT payload,generation::text FROM harness.plugin_inventory WHERE organization_id=$1 AND runtime_id=$2`,
      [organizationId, userRuntimeId])
    expect(stored.rows[0]?.generation).toBe('1')
    expect(stored.rows[0]?.payload.bundles).toEqual([bundleFixture])
    const rows = await inventory.list()
    const userRow = rows.find(row => row.target.kind === 'user' && row.target.id === userPublicId)
    expect(userRow?.live).toBe(true)
    expect(userRow?.reportedAt).not.toBeNull()
    expect(userRow?.inventory?.bundles[0]?.source).toBe('file:/home/owner/plugins/collab')
    expect(userRow?.inventory?.plugins[0]?.fiberPhase).toBe('active')
  })

  it('overwrites the last report and rejects reports from a stale generation', async () => {
    await inventory.report(subject(), { bundles: [], plugins: [pluginFixture] })
    await expect(inventory.report({ ...subject(2) }, { bundles: [], plugins: [] }))
      .rejects.toMatchObject({ status: 409 })
    const row = (await inventory.list()).find(item => item.target.kind === 'user' && item.target.id === userPublicId)
    expect(row?.inventory?.plugins).toEqual([pluginFixture])
  })

  it('never lets a resolved-then-delayed write overwrite a newer generation row', async () => {
    // A stale process may resolve its owner while it still owns the instance,
    // then lose the write race to its successor's report; the stored row must
    // keep the higher generation payload.
    await pool.query(
      `INSERT INTO harness.plugin_inventory(organization_id,runtime_id,payload,generation) VALUES($1,$2,'{"bundles":[],"plugins":[]}'::jsonb,9)
       ON CONFLICT(organization_id,runtime_id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation`,
      [organizationId, userRuntimeId])
    await inventory.report(subject(), { bundles: [bundleFixture], plugins: [pluginFixture] })
    const stored = await pool.query<{ generation: string }>(
      `SELECT generation::text FROM harness.plugin_inventory WHERE organization_id=$1 AND runtime_id=$2`,
      [organizationId, userRuntimeId])
    expect(stored.rows[0]?.generation).toBe('9')
  })

  it('lists every instance, including unreported spaces with their saved composition', async () => {
    const projectRuntimeId = (await pool.query<{ runtime_id: RuntimeId }>(
      `SELECT runtime_id FROM harness.instances WHERE organization_id=$1 AND project_id=$2`,
      [organizationId, projectInternalId])).rows[0]!.runtime_id
    await pool.query(`INSERT INTO harness.plugin_states(organization_id,project_id,runtime_id,revision,entries,bundles)
      VALUES($1,$2,$3,4,'[{"id":"row","disabled":false}]'::jsonb,'["@deepseek-ai/dsh-web"]'::jsonb)`,
      [organizationId, projectInternalId, projectRuntimeId])
    const rows = await inventory.list()
    const projectRow = rows.find(row => row.target.kind === 'project' && row.target.id === projectPublicId)
    expect(projectRow?.live).toBe(false)
    expect(projectRow?.reportedAt).toBeNull()
    expect(projectRow?.inventory).toBeNull()
    expect(projectRow?.desired).toEqual({ entries: [{ id: 'row', disabled: false }], bundles: ['@deepseek-ai/dsh-web'] })
  })
})
