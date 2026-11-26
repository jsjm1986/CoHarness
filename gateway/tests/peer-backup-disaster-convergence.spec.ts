/** Physical isolation permits maintenance without rewriting unknown process observations. */
import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('disaster isolation and maintenance convergence', () => {
  let pool: Pool
  const roots: string[] = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => {
    try { await pool?.end() }
    finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) }
  })

  it('retains project and personal observations while admitting maintenance only after whole-computer isolation', async () => {
    const f = await disasterRecoveryFixture(pool, roots)
    const personal = randomUUID()
    await pool.query(`INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port)
      SELECT $1,$2,id,$3,4102 FROM harness.users WHERE organization_id=$2 AND public_id=$4`,
      [personal, f.org, f.context.nodeId, f.adminId])
    await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=7,runtime_token_hash=$3
      WHERE organization_id=$1 AND assigned_node_id=$2`, [f.org, f.context.nodeId, randomBytes(32)])
    await pool.query(`UPDATE harness.instances SET observed_state='ready' WHERE organization_id=$1 AND assigned_node_id=$2`, [f.org, f.context.nodeId])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,2,clock_timestamp()+interval '5 minutes')`, [f.org, f.context.nodeId, randomBytes(32), randomUUID()])
    await pool.query(`UPDATE harness.compute_nodes SET status='offline',last_heartbeat_at=clock_timestamp(),inflight_writes=3 WHERE id=$1`, [f.context.nodeId])
    const maintenance = new PostgresMaintenanceService(f.primary, 60_000)
    const before = await maintenance.state()
    expect(before.writersQuiesced).toBe(false)
    expect(before.nodes.find(n => n.nodeId === f.context.nodeId)).toMatchObject({ activeRuntimes: 2, quiesced: false })
    expect(before.nodes.find(n => n.nodeId === f.context.nodeId)?.externallyFenced).toBeUndefined()
    const recovery = new PeerProjectRecovery(f.primary)
    const id = await recovery.request(f.adminId, { requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume, recoveryMode: 'disaster' })
    await acceptSyntheticRecoveryCandidate(pool,id)
    await recovery.confirmIsolation(f.adminId, id, { confirm: id, policyRevision: 1, sourceGeneration: '7', sourceEpoch: '1',
      sourceNodeId: f.context.nodeId, pointId: f.point, isolationMethod: 'power-off', evidenceReference: 'console/isolated-test-source', acknowledgeDataLoss: true })
    const after = await maintenance.enterMaintenance(null)
    expect(after.writersQuiesced).toBe(true)
    expect(after.nodes.find(n => n.nodeId === f.context.nodeId)).toMatchObject({
      activeRuntimes: 2, inflightWrites: 3, quiesced: true, externallyFenced: true,
    })
    await maintenance.beginRestore(null)
    expect((await maintenance.state()).mode).toBe('restoring')
    expect((await pool.query(`SELECT observed_state,desired_state,runtime_token_hash FROM harness.instances
      WHERE organization_id=$1 AND assigned_node_id=$2 ORDER BY runtime_id`, [f.org, f.context.nodeId])).rows).toEqual([
      { observed_state: 'ready', desired_state: 'stopped', runtime_token_hash: null },
      { observed_state: 'ready', desired_state: 'stopped', runtime_token_hash: null },
    ])
    await expect(new PostgresMaintenanceService(f.context, 60_000).heartbeat(1n, 0))
      .rejects.toMatchObject({ constraint: 'node_recovery_quarantined' })
  })
})
