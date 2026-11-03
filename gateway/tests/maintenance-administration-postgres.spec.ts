/** Maintenance transitions retain authority, serialize state and commit their ledger atomically. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
describePg('PostgreSQL maintenance administration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, process.env.DSH_AUDIT_MAINTENANCE_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    let organizationId: PostgresRuntimeContext['organizationId'] | undefined
    try {
      const slug = `maintenance-${randomUUID()}`
      organizationId = (await pool.query<{ id: PostgresRuntimeContext['organizationId'] }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Maintenance') RETURNING id", [slug])).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const actors = []
      for (const name of ['administrator', 'other-administrator']) {
        const actor = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,'/unused') RETURNING id,public_id`, [organizationId, name])).rows[0]!
        await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, actor.id])
        actors.push({ uuid: actor.id, id: Number(actor.public_id) })
      }
      const actor = actors[0]!, other = actors[1]!, maintenance = new PostgresMaintenanceService(context, 60_000), backups = new PostgresBackupService(context)
      const backup = await backups.record({ path: '/unused/accepted.dump', migrationVersion: 95, writeEpoch: 1n,
        sizeBytes: 128, sha256: 'a'.repeat(64), managedSnapshot: { version: 1, roots: [], directories: [], absent: [], files: [] }, actor: actor.id })
      await backups.setVerified(backup.id, true)
      return { context, actor, other, maintenance, backups, backup,
        async [Symbol.asyncDispose]() { await removeFixtureOrganization(pool, context.organizationId) } }
    } catch (error) {
      if (organizationId !== undefined) {
        try { await removeFixtureOrganization(pool, organizationId) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Maintenance setup and cleanup failed') }
      }
      throw error
    }
  }

  it('refuses foreign actors through every administrator executor', async () => {
    await using f = await fixture(), other = await fixture()
    await expect(f.maintenance.administration(other.actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.maintenance.enterMaintenance(other.actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    await f.maintenance.enterMaintenance(f.actor.id)
    await expect(f.maintenance.exitMaintenance(other.actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.maintenance.setNodeStatus(other.actor.id, f.context.nodeId, 'offline')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.maintenance.requestRestore(other.actor.id, f.backup.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await f.maintenance.listOperations()).map(operation => operation.kind)).toEqual(['enter-maintenance'])
  })

  it('retains administrator eligibility while a transition waits for another control-row writer', async () => {
    await using f = await fixture()
    const name = `maintenance-owner-${randomUUID()}`, revokeName = `maintenance-revoke-${randomUUID()}`
    const worker = createPostgresPool(databaseUrl!, { max: 1, application_name: name }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName })
    const blocker = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, settled = false
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM harness.cluster_control WHERE organization_id=$1 FOR UPDATE', [f.context.organizationId])
      pending = new PostgresMaintenanceService({ ...f.context, pool: worker }, 60_000).enterMaintenance(f.actor.id).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=\'Lock\') waiting', [name])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.uuid])
        .then(value => { settled = true; return value }, (error: unknown) => { settled = true; return error })
      await expect.poll(async () => settled || (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity w
        ON w.pid=ANY(pg_blocking_pids(r.pid)) WHERE r.application_name=$1 AND w.application_name=$2) waiting`, [revokeName, name])).rows[0]!.waiting).toBe(true)
      expect(settled).toBe(false)
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ mode: 'maintenance' }); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(f.maintenance.administration(f.actor.id)).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([pending, revoked]); await Promise.all([worker.end(), revoker.end()])
    }
  })

  it('records one entry when two administrators concurrently open the same maintenance window', async () => {
    await using f = await fixture()
    const names = [0, 1].map(() => `maintenance-enter-${randomUUID()}`)
    const workers = names.map(application_name => createPostgresPool(databaseUrl!, { max: 1, application_name }))
    const blocker = await pool.connect(), pending: Array<Promise<unknown>> = []
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM harness.cluster_control WHERE organization_id=$1 FOR UPDATE', [f.context.organizationId])
      for (const [index, worker] of workers.entries()) pending.push(new PostgresMaintenanceService({ ...f.context, pool: worker }, 60_000)
        .enterMaintenance(index === 0 ? f.actor.id : f.other.id, `window-${index}`).catch((error: unknown) => error))
      await expect.poll(async () => (await pool.query<{ count: number }>("SELECT count(*)::integer count FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND wait_event_type='Lock'", [names])).rows[0]!.count).toBe(2)
      await blocker.query('COMMIT')
      for (const result of await Promise.all(pending)) expect(result).toMatchObject({ mode: 'maintenance', maintenanceEpoch: '1' })
      expect((await f.maintenance.listOperations()).filter(operation => operation.kind === 'enter-maintenance')).toHaveLength(1)
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all(pending); await Promise.all(workers.map(worker => worker.end())) }
  })

  it.each(['enter', 'exit', 'node-status'] as const)('rolls back %s when its operation row cannot commit', async operation => {
    await using f = await fixture()
    if (operation === 'exit') await f.maintenance.enterMaintenance(null)
    const before = await f.maintenance.state(), operations = await f.maintenance.listOperations()
    const name = `maintenance_failure_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected maintenance ledger failure'; END $$`)
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON harness.deployment_operations FOR EACH ROW
        WHEN (NEW.organization_id='${f.context.organizationId}'::uuid) EXECUTE FUNCTION harness.${name}()`)
      const pending = operation === 'enter' ? f.maintenance.enterMaintenance(f.actor.id)
        : operation === 'exit' ? f.maintenance.exitMaintenance(f.actor.id) : f.maintenance.setNodeStatus(f.actor.id, f.context.nodeId, 'offline')
      const failure = await pending.catch((error: unknown) => error)
      const after = await f.maintenance.state()
      expect(after.mode).toBe(before.mode); expect(after.maintenanceEpoch).toBe(before.maintenanceEpoch)
      expect(after.nodes[0]!.status).toBe(before.nodes[0]!.status)
      expect(await f.maintenance.listOperations()).toEqual(operations)
      expect(failure).toMatchObject({ status: 503, message: 'deployment-unavailable' })
    } finally { await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.deployment_operations`); await pool.query(`DROP FUNCTION harness.${name}()`) }
  })

  it('uses one available checkout for the complete administrative read and transition', async () => {
    await using f = await fixture()
    const worker = createPostgresPool(databaseUrl!, { max: 1, connectionTimeoutMillis: 1000 })
    try {
      const maintenance = new PostgresMaintenanceService({ ...f.context, pool: worker }, 60_000)
      expect((await maintenance.administration(f.actor.id)).mode).toBe('serving')
      expect((await maintenance.enterMaintenance(f.actor.id)).mode).toBe('maintenance')
      expect((await maintenance.setNodeStatus(f.actor.id, f.context.nodeId, 'draining')).status).toBe('draining')
      expect((await maintenance.exitMaintenance(f.actor.id)).mode).toBe('serving')
      expect((await maintenance.requestRestore(f.actor.id, f.backup.id)).createdBy).toBe(f.actor.id)
    } finally { await worker.end() }
  })

  it('requires a currently verified complete backup owned by this organization', async () => {
    await using f = await fixture(), other = await fixture()
    await expect(f.maintenance.requestRestore(f.actor.id, other.backup.id)).rejects.toMatchObject({ status: 404, message: 'backup-not-found' })
    await expect(f.maintenance.requestRestore(f.actor.id, 'invalid')).rejects.toMatchObject({ status: 400, message: 'invalid-backup-id' })
    await expect(f.maintenance.setNodeStatus(f.actor.id, 'invalid', 'offline')).rejects.toMatchObject({ status: 400, message: 'invalid-node-id' })
    await f.backups.setVerified(f.backup.id, false)
    await expect(f.maintenance.requestRestore(f.actor.id, f.backup.id)).rejects.toMatchObject({ status: 409, message: 'backup-not-verified' })
    await f.backups.setVerified(f.backup.id, true)
    await pool.query("UPDATE harness.backup_records SET managed_files='[]'::jsonb WHERE id=$1", [f.backup.id])
    await expect(f.maintenance.requestRestore(f.actor.id, f.backup.id)).rejects.toMatchObject({ status: 409, message: 'backup-lacks-complete-managed-data-manifest' })
    expect(await f.maintenance.listOperations()).toEqual([])
  })
})
