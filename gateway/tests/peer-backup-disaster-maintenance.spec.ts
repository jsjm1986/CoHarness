/** A full maintenance SQL restore preserves physical isolation and unusable enrollment history. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { disasterRecoveryFixture, acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
function command(value: string | undefined, executable: string): string[] {
  if (value === undefined) return [executable]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(arg => typeof arg !== 'string'))
    throw new Error('Invalid fixture PostgreSQL client command')
  return parsed as string[]
}

it.skipIf(databaseUrl === undefined)('restores a quarantined computer without reviving credentials or fabricating Runtime stops', async () => {
  const database = `hgw_disaster_restore_${randomUUID().replaceAll('-', '')}_test`
  const admin = createPostgresPool(databaseUrl!, { max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'hgw-disaster-restore-')), roots = [root]
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const target = new URL(databaseUrl!); target.pathname = `/${database}`
    pool = createPostgresPool(target.href, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const f = await disasterRecoveryFixture(pool, roots), service = new PeerProjectRecovery(f.primary)
    const oldCredential = randomBytes(32), personal = randomUUID()
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,revision,credential_hash,platform,architecture,
      connection_id,connection_epoch,lease_expires_at) VALUES($1,$2,2,$3,'linux','x64',$4,2,clock_timestamp()+interval '5 minutes')`,
    [f.org, f.context.nodeId, oldCredential, randomUUID()])
    await pool.query(`INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port)
      SELECT $1,$2,id,$3,4102 FROM harness.users WHERE organization_id=$2 AND public_id=$4`,
    [personal, f.org, f.context.nodeId, f.adminId])
    await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=7,
      runtime_token_hash=$2 WHERE runtime_id=$1`, [personal, randomBytes(32)])
    await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE runtime_id=$1", [personal])
    for (const revision of [1, 2]) {
      await pool.query(`INSERT INTO harness.node_agent_enrollments
        (id,organization_id,node_id,revision,token_hash,created_by,expires_at,consumed_at)
        SELECT $1,$2,$3,$4::bigint,$5,id,clock_timestamp()+interval '1 hour',
          CASE WHEN $4::bigint=1 THEN clock_timestamp()-interval '1 minute' END
        FROM harness.users WHERE organization_id=$2 AND public_id=$6`,
      [randomUUID(), f.org, f.context.nodeId, revision, randomBytes(32), f.adminId])
    }
    const enrollments = () => pool!.query(`SELECT id,revision::text,token_hash,consumed_at FROM harness.node_agent_enrollments
      WHERE organization_id=$1 AND node_id=$2 ORDER BY revision`, [f.org, f.context.nodeId])
    const before = (await enrollments()).rows
    expect(before[0].consumed_at).toBeInstanceOf(Date)
    expect(before[1].consumed_at).toBeNull()
    const id = await service.request(f.adminId, { requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume, recoveryMode: 'disaster' })
    await acceptSyntheticRecoveryCandidate(pool, id)
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const oldDump = await commands.backup(root, target.href, [])
    const maintenance = new PostgresMaintenanceService(f.primary, 60000)
    expect((await maintenance.state()).writersQuiesced).toBe(false)
    const status = await service.status(f.adminId, id)
    await service.confirmIsolation(f.adminId, id, { confirm: id, policyRevision: status.policyRevision,
      sourceGeneration: status.sourceGeneration, sourceEpoch: status.sourceEpoch, sourceNodeId: f.context.nodeId,
      pointId: f.point, isolationMethod: 'power-off', evidenceReference: 'test-console/isolation', acknowledgeDataLoss: true })
    const savedEnrollments = (await enrollments()).rows
    expect(savedEnrollments).toHaveLength(2)
    expect(savedEnrollments[0]).toEqual(before[0])
    expect(savedEnrollments[1]).toEqual({ ...before[1], consumed_at: expect.any(Date) })
    const source = (await maintenance.state()).nodes.find(node => node.nodeId === f.context.nodeId)
    expect(source).toMatchObject({ status: 'offline', activeRuntimes: 1, quiesced: true })
    const currentDump = await commands.backup(root, target.href, [])
    await pool.query("UPDATE harness.organizations SET display_name='after backup' WHERE id=$1", [f.org])
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    await expect(commands.restoreDump(oldDump.dumpPath, target.href, lease, oldDump.sha256))
      .rejects.toThrow(/project writer epoch|recovery authority|Disaster isolation/iu)
    expect((await enrollments()).rows).toEqual(savedEnrollments)
    await commands.restoreDump(currentDump.dumpPath, target.href, lease, currentDump.sha256)
    expect((await pool.query('SELECT display_name FROM harness.organizations WHERE id=$1', [f.org])).rows)
      .toEqual([{ display_name: 'Retreat' }])
    expect((await enrollments()).rows).toEqual(savedEnrollments)
    expect((await pool.query(`SELECT credential_hash,revoked_at,connection_id,lease_expires_at,revision::text,connection_epoch::text
      FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2`, [f.org, f.context.nodeId])).rows)
      .toEqual([{ credential_hash: null, revoked_at: expect.any(Date), connection_id: null, lease_expires_at: null,
        revision: '3', connection_epoch: '4' }])
    expect((await pool.query(`SELECT generation::text,observed_state,desired_state,runtime_token_hash
      FROM harness.instances WHERE runtime_id=$1`, [personal])).rows)
      .toEqual([{ generation: '7', observed_state: 'ready', desired_state: 'stopped', runtime_token_hash: null }])
    expect((await pool.query('SELECT operation_id FROM harness.node_recovery_quarantines WHERE organization_id=$1', [f.org])).rows)
      .toEqual([{ operation_id: id }])
    expect((await pool.query('SELECT operation_id FROM harness.project_recovery_execution_holds WHERE organization_id=$1', [f.org])).rows)
      .toEqual([{ operation_id: id }])
    expect((await pool.query(`SELECT source_schedule_digest,source_files_digest,old_fenced_at,stopped_generation,stop_operation_id
      FROM harness.project_recovery_operations WHERE id=$1`, [id])).rows)
      .toEqual([{ source_schedule_digest: null, source_files_digest: null, old_fenced_at: null, stopped_generation: null, stop_operation_id: null }])
    await expect(pool.query(`UPDATE harness.node_agents SET credential_hash=$3,revoked_at=NULL
      WHERE organization_id=$1 AND node_id=$2`, [f.org, f.context.nodeId, oldCredential]))
      .rejects.toMatchObject({ constraint: 'node_recovery_quarantined' })
    await expect(pool.query('UPDATE harness.node_agent_enrollments SET consumed_at=NULL WHERE id=$1', [savedEnrollments[1].id]))
      .rejects.toMatchObject({ constraint: 'node_recovery_quarantined' })
    expect((await maintenance.state()).mode).toBe('restoring')
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
    finally { await admin.end(); await Promise.all(roots.map(path => rm(path, { recursive: true, force: true }))) }
  }
})
