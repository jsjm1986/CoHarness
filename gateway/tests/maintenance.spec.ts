/** Maintenance windows, writer convergence, restore fencing, node status, and the operation ledger. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
import { createExecutionFixture } from './execution-fixture.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
let cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup = [] })
async function fixture() {
  const value = await createExecutionFixture(pool)
  cleanup.push(value.dispose)
  return value
}
const STALE_MS = 60_000

describePg('Gateway maintenance control', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('opens and closes a maintenance window with an operation ledger', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    const entered = await maintenance.enterMaintenance(f.admin.id, 'apply v41')
    expect(entered.mode).toBe('maintenance')
    expect(entered.maintenanceEpoch).toBe('1')
    expect(entered.reason).toBe('apply v41')
    const again = await maintenance.enterMaintenance(f.peer.id, 'other window')
    expect(again.maintenanceEpoch).toBe('1')
    expect(again.reason).toBe('apply v41')
    const exited = await maintenance.exitMaintenance(f.admin.id)
    expect(exited.mode).toBe('serving')
    const operations = await maintenance.listOperations()
    expect(operations.map(op => op.kind)).toEqual(['exit-maintenance', 'enter-maintenance'])
    expect(operations[0]!.createdBy).toBe(f.admin.id)
    await expect(maintenance.exitMaintenance(f.admin.id)).rejects.toMatchObject({ status: 409, message: 'not-in-maintenance' })
  })

  it('gates writes by mode and fences a stale write epoch after restore', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    const baseline = await maintenance.currentWriteEpoch()
    expect((await maintenance.writeGate(baseline)).verdict).toBe('open')
    await maintenance.enterMaintenance(null)
    expect((await maintenance.writeGate(baseline)).verdict).toBe('maintenance')
    await maintenance.beginRestore(null)
    const restored = await maintenance.completeRestore(null, undefined, { dumpPath: '/tmp/dump' })
    expect(BigInt(restored.writeEpoch) > baseline).toBe(true)
    expect((await maintenance.writeGate(baseline)).verdict).toBe('stale-epoch')
    const restarted = await maintenance.currentWriteEpoch()
    expect((await maintenance.writeGate(restarted)).verdict).toBe('maintenance')
    await maintenance.exitMaintenance(null)
    expect((await maintenance.writeGate(restarted)).verdict).toBe('open')
  })

  it('requires every live writer to acknowledge before a restore opens', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    // A live node that has not acknowledged the new epoch still counts as a writer.
    await maintenance.heartbeat(0n, 0)
    await maintenance.enterMaintenance(null)
    const state = await maintenance.state()
    expect(state.writersQuiesced).toBe(false)
    await expect(maintenance.beginRestore(null)).rejects.toMatchObject({ status: 409, message: 'writers-not-quiesced' })
    await maintenance.heartbeat(1n, 0)
    expect((await maintenance.state()).writersQuiesced).toBe(true)
    const restoring = await maintenance.beginRestore(null)
    expect(restoring.mode).toBe('restoring')
    await expect(maintenance.exitMaintenance(null)).rejects.toMatchObject({ status: 409, message: 'restore-in-progress' })
    const failed = await maintenance.failRestore(null, 'pg_restore failed')
    expect(failed.mode).toBe('maintenance')
  })

  it('keeps a live node unquiesced while it reports in-flight writers', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    await maintenance.enterMaintenance(null)
    // The gate is acknowledged but a mutating request or sweep admitted before
    // the window is still running: the node must not read as quiesced.
    await maintenance.heartbeat(1n, 2)
    const busy = await maintenance.state()
    expect(busy.writersQuiesced).toBe(false)
    expect(busy.nodes.find(node => node.nodeId === f.context.nodeId)?.inflightWrites).toBe(2)
    await expect(maintenance.beginRestore(null)).rejects.toMatchObject({ status: 409, message: 'writers-not-quiesced' })
    await maintenance.heartbeat(1n, 0)
    expect((await maintenance.state()).writersQuiesced).toBe(true)
  })

  it('never counts a node that predates inflight reporting as quiesced', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    // An older build heartbeats the epoch without an inflight column update;
    // the column's -1 default keeps it fenced until an operator stops it.
    await pool.query(
      `UPDATE harness.compute_nodes SET last_heartbeat_at=now(), maintenance_applied_epoch=1 WHERE id=$1`,
      [f.context.nodeId],
    )
    await maintenance.enterMaintenance(null)
    const state = await maintenance.state()
    expect(state.writersQuiesced).toBe(false)
    await expect(maintenance.beginRestore(null)).rejects.toMatchObject({ status: 409, message: 'writers-not-quiesced' })
  })

  it('excludes offline nodes from quiesce and resurrects a heartbeating one', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    const otherNode = (await pool.query<{ id: string }>(
      'INSERT INTO harness.compute_nodes(organization_id,name,last_heartbeat_at) VALUES($1,$2,now()) RETURNING id',
      [f.organizationId, randomUUID()],
    )).rows[0]!.id
    await maintenance.enterMaintenance(null)
    await maintenance.heartbeat(1n, 0)
    expect((await maintenance.state()).writersQuiesced).toBe(false)
    const drained = await maintenance.setNodeStatus(f.admin.id, otherNode, 'offline')
    expect(drained.status).toBe('offline')
    expect((await maintenance.state()).writersQuiesced).toBe(true)
    // A node that keeps heartbeating was declared offline prematurely; it
    // rejoins writer accounting instead of silently corrupting the quiesce.
    await pool.query(`UPDATE harness.compute_nodes SET status='active', last_heartbeat_at=now() WHERE id=$1`, [otherNode])
    expect((await maintenance.state()).writersQuiesced).toBe(false)
  })

  it('tracks pending restore requests claimed by the applier', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    const backups = new PostgresBackupService(f.context)
    const backup = await backups.record({
      path: '/tmp/harness-1.dump', migrationVersion: 41, writeEpoch: 1n,
      sizeBytes: 128, sha256: 'a'.repeat(64), managedFiles: [], actor: f.admin.id,
    })
    const request = await maintenance.requestRestore(f.admin.id, backup.id)
    expect(request.status).toBe('pending')
    await expect(maintenance.requestRestore(f.admin.id, backup.id)).rejects.toMatchObject({ status: 409, message: 'restore-already-pending' })
    const claimed = await maintenance.claimRestoreRequest()
    expect(claimed?.id).toBe(request.id)
    expect(claimed?.status).toBe('running')
    expect(await maintenance.claimRestoreRequest()).toBeUndefined()
    await maintenance.finishOperation(request.id, 'completed', { backupId: backup.id })
    const operations = await maintenance.listOperations()
    const finished = operations.find(op => op.id === request.id)
    expect(finished?.status).toBe('completed')
    expect(finished?.finishedAt).not.toBeNull()
  })

  it('registers backups with verification and restore linkage', async () => {
    const f = await fixture()
    const backups = new PostgresBackupService(f.context)
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    const recorded = await backups.record({
      path: '/tmp/harness-2.dump', migrationVersion: 41, writeEpoch: 1n,
      sizeBytes: 64, sha256: 'b'.repeat(64),
      managedFiles: [{ member: '000-key', sourcePath: '/tmp/key', sizeBytes: 32, sha256: 'c'.repeat(64) }],
      actor: f.admin.id,
    })
    expect(recorded.status).toBe('recording')
    expect(recorded.createdBy).toBe(f.admin.id)
    expect(recorded.managedFiles[0]?.sourcePath).toBe('/tmp/key')
    const failed = await backups.setVerified(recorded.id, false, 'pg_restore --list failed')
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('pg_restore --list failed')
    const verified = await backups.setVerified(recorded.id, true)
    expect(verified.status).toBe('verified')
    expect(verified.verifiedAt).not.toBeNull()
    await maintenance.enterMaintenance(null)
    await maintenance.heartbeat(1n, 0)
    await maintenance.beginRestore(null, verified.id)
    const state = await maintenance.completeRestore(null, verified.id, {})
    expect(state.mode).toBe('maintenance')
    expect((await backups.get(verified.id)).status).toBe('restored')
    expect((await backups.list())[0]?.id).toBe(verified.id)
    await expect(backups.get(randomUUID())).rejects.toMatchObject({ status: 404 })
  })

  it('rejects restore while the window is not in maintenance', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    await expect(maintenance.beginRestore(null)).rejects.toMatchObject({ status: 409, message: 'restore-requires-maintenance' })
    await expect(maintenance.completeRestore(null, undefined, {})).rejects.toMatchObject({ status: 409, message: 'restore-complete-conflict' })
    await expect(maintenance.failRestore(null, 'x')).rejects.toMatchObject({ status: 409, message: 'restore-fail-conflict' })
  })

  it('survives pg_restore rewinding the control row mid-restore', async () => {
    const f = await fixture()
    const maintenance = new PostgresMaintenanceService(f.context, STALE_MS)
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    // A restore run without the applier's --exclude-table (a bespoke command
    // line or an unpackaged dump) still rewinds cluster_control mid-restore;
    // the applier re-asserts the window before completing.
    await pool.query(`UPDATE harness.cluster_control SET mode='maintenance', write_epoch=1, reason='dumped', entered_at=now()
      WHERE organization_id=$1`, [f.context.organizationId])
    await maintenance.resumeRestoring()
    const state = await maintenance.completeRestore(null, undefined, {})
    expect(state.mode).toBe('maintenance')
    expect(BigInt(state.writeEpoch)).toBeGreaterThan(1n)
  })
})
