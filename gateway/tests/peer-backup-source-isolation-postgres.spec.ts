/** Generic physical isolation preserves exact project evidence across scope-independent quarantine and maintenance. */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { TAKEOVER_RESTORE_PREFIX, TAKEOVER_RESTORE_SUFFIX } from '../src/peer-backup-takeover-restore-guard.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('mirrors exact project isolation, rejects fabricated scopes, and preserves the receipt on restore', async () => {
  const pool = createPostgresPool(databaseUrl!), roots: string[] = []
  try {
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const f = await disasterRecoveryFixture(pool, roots), service = new PeerProjectRecovery(f.primary)
    const id = await service.request(f.adminId, { requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume, recoveryMode: 'disaster' })
    const status = await service.status(f.adminId, id)
    await acceptSyntheticRecoveryCandidate(pool,id)
    await service.confirmIsolation(f.adminId, id, { confirm: id, policyRevision: status.policyRevision,
      sourceGeneration: status.sourceGeneration, sourceEpoch: status.sourceEpoch, sourceNodeId: f.context.nodeId,
      pointId: f.point, isolationMethod: 'network-isolation', evidenceReference: 'owned-fixture/isolation', acknowledgeDataLoss: true })
    const saved = (await pool.query('SELECT * FROM harness.recovery_source_isolations WHERE operation_id=$1', [id])).rows[0]
    expect(saved).toMatchObject({ operation_id: id, organization_id: f.org, scope_kind: 'project', runtime_id: f.runtimeId,
      source_node_id: f.context.nodeId, project_isolation_id: id, evidence_reference: 'owned-fixture/isolation', acknowledge_data_loss: true })
    expect((await pool.query('SELECT harness.node_physically_isolated($1,$2) isolated', [f.org, f.context.nodeId])).rows)
      .toEqual([{ isolated: true }])
    expect((await pool.query('INSERT INTO harness.recovery_source_isolations SELECT * FROM harness.recovery_source_isolations WHERE operation_id=$1', [id])).rowCount).toBe(0)
    await expect(pool.query(`INSERT INTO harness.recovery_source_isolations
      SELECT $2,organization_id,'personal',scope_id,runtime_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,
        method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss,NULL
      FROM harness.recovery_source_isolations WHERE operation_id=$1`, [id, randomUUID()])).rejects.toThrow()
    await expect(pool.query('UPDATE harness.recovery_source_isolations SET evidence_reference=$2 WHERE operation_id=$1', [id, 'changed']))
      .rejects.toThrow('immutable')
    await expect(transaction(pool, async tx => {
      await tx.query(TAKEOVER_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.recovery_source_isolations DISABLE TRIGGER immutable_recovery_source_isolation')
      await tx.query('UPDATE harness.recovery_source_isolations SET evidence_reference=$2 WHERE operation_id=$1', [id, 'changed'])
      await tx.query(TAKEOVER_RESTORE_SUFFIX)
    })).rejects.toThrow('Physical isolation authority differs')
    expect((await pool.query('SELECT * FROM harness.recovery_source_isolations WHERE operation_id=$1', [id])).rows[0]).toEqual(saved)
  } finally { await pool.end(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) }
})
