/** Real PostgreSQL validates operator-attested whole-node isolation without contacting the failed source. */
import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { TAKEOVER_RESTORE_PREFIX, TAKEOVER_RESTORE_SUFFIX } from '../src/peer-backup-takeover-restore-guard.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const digest = (char: string) => char.repeat(64)

describePg('disaster recovery authority', () => {
  let pool: Pool
  const roots: string[] = []

  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })
  afterAll(async () => {
    await pool?.end()
  })

  it('fences the whole source, refuses stale confirmations and keeps recovered execution paused',async()=>{
    const f=await disasterRecoveryFixture(pool,roots), service=new PeerProjectRecovery(f.primary)
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,2,clock_timestamp()+interval '5 minutes')`,[f.org,f.context.nodeId,randomBytes(32),randomUUID()])
    await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=7,runtime_token_hash=$3 WHERE organization_id=$1 AND runtime_id=$2`,[f.org,f.runtimeId,randomBytes(32)])
    await pool.query(`UPDATE harness.instances SET observed_state='ready' WHERE runtime_id=$1`,[f.runtimeId])
    const id=await service.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:f.target,targetVolume:f.targetVolume,recoveryMode:'disaster'})
    const second=await transaction(pool,async tx=>{
      const project=(await tx.query(`INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id)
        SELECT organization_id,'Second protected project',created_by,owner_user_id FROM harness.projects WHERE id=(SELECT project_id FROM harness.project_recovery_operations WHERE id=$1) RETURNING id`,[id])).rows[0].id
      const runtime=randomUUID()
      await tx.query(`INSERT INTO harness.instances(id,organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,$4,4101)`,[runtime,f.org,project,f.context.nodeId])
      await tx.query(`INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch)
        SELECT organization_id,$2,node_id,$3,volume_id,1 FROM harness.project_content_placement WHERE runtime_id=$1`,[f.runtimeId,project,runtime])
      const policy=randomUUID(),point=randomUUID()
      await tx.query(`INSERT INTO harness.peer_backup_policies(id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
        SELECT $2,organization_id,scope_kind,$3,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash FROM harness.peer_backup_policies WHERE id=$1`,[f.policy,policy,project])
      await tx.query(`INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,protected_through)
        SELECT $2,organization_id,$3,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,protected_through FROM harness.peer_backup_points WHERE id=$1`,[f.point,point,policy])
      await tx.query(`INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status) VALUES($1,$2,$3,1,'drill',$4,$5,'confirmed')`,[randomUUID(),f.org,policy,f.target,point])
      return {runtime,policy,point}
    })
    const secondId=await service.request(f.adminId,{requestId:randomUUID(),policyId:second.policy,pointId:second.point,targetNode:f.target,targetVolume:f.targetVolume,recoveryMode:'disaster'})
    const confirm={confirm:id,policyRevision:1,sourceGeneration:'7',sourceEpoch:'1',sourceNodeId:f.context.nodeId,pointId:f.point,
      isolationMethod:'power-off',evidenceReference:'console-ticket/test-42',acknowledgeDataLoss:true}
    await expect(service.confirmIsolation(f.adminId,id,{...confirm,sourceGeneration:'6'})).rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1',[f.org])).rowCount).toBe(0)
    await acceptSyntheticRecoveryCandidate(pool,id)
    await service.confirmIsolation(f.adminId,id,confirm)
    expect(await service.status(f.adminId,id)).toMatchObject({phase:'externally-fenced',recoveryMode:'disaster',sourceNodeId:f.context.nodeId,
      sourceGeneration:'7',sourceEpoch:'1',executionReviewRequired:true,executionBlockers:['execution-review-required'],isolation:{method:'power-off',evidenceReference:'console-ticket/test-42'}})
    expect((await pool.query(`SELECT desired_state,observed_state,runtime_token_hash FROM harness.instances WHERE runtime_id=$1`,[f.runtimeId])).rows[0])
      .toEqual({desired_state:'stopped',observed_state:'ready',runtime_token_hash:null})
    expect((await pool.query(`SELECT harness.node_execution_available($1,$2) source,harness.node_execution_available($1,$3) target`,[f.org,f.context.nodeId,f.target])).rows[0]).toEqual({source:false,target:true})
    await expect(pool.query(`UPDATE harness.compute_nodes SET status='active' WHERE id=$1`,[f.context.nodeId])).rejects.toMatchObject({constraint:'node_recovery_quarantined'})
    await expect(pool.query(`UPDATE harness.node_agents SET credential_hash=$2,revoked_at=NULL WHERE node_id=$1`,[f.context.nodeId,randomBytes(32)])).rejects.toMatchObject({constraint:'node_recovery_quarantined'})
    await expect(pool.query(`UPDATE harness.instances SET desired_state='running',generation=8 WHERE runtime_id=$1`,[f.runtimeId])).rejects.toMatchObject({constraint:'runtime_recovery_review'})
    await expect(pool.query(`DELETE FROM harness.node_recovery_quarantines WHERE node_id=$1`,[f.context.nodeId])).rejects.toThrow('immutable')
    await expect(service.cancel(f.adminId,id)).rejects.toMatchObject({code:'peer-backup/verified-writer-fence-required'})
    await expect(pool.query(`UPDATE harness.project_recovery_operations SET phase='old-fenced',old_fenced_at=now(),source_schedule_digest=$2,source_files_digest=$2 WHERE id=$1`,[id,digest('a')])).rejects.toThrow()
    await pool.query(`UPDATE harness.project_recovery_operations SET phase='disaster-ready',target_schedule_digest=$2,target_files_digest=$3,target_port_base=14100 WHERE id=$1`,[id,digest('e'),digest('f')])
    await service.activate(f.adminId,id)
    expect((await pool.query(`SELECT assigned_node_id,desired_state,observed_state FROM harness.instances WHERE runtime_id=$1`,[f.runtimeId])).rows[0])
      .toEqual({assigned_node_id:f.target,desired_state:'stopped',observed_state:'stopped'})
    expect((await pool.query(`SELECT source_schedule_digest,source_files_digest,old_fenced_at,stopped_generation,stop_operation_id FROM harness.project_recovery_operations WHERE id=$1`,[id])).rows[0])
      .toEqual({source_schedule_digest:null,source_files_digest:null,old_fenced_at:null,stopped_generation:null,stop_operation_id:null})
    await expect(pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=8,runtime_token_hash=$2 WHERE runtime_id=$1`,[f.runtimeId,randomBytes(32)])).rejects.toMatchObject({constraint:'runtime_recovery_review'})
    await expect(transaction(pool,async tx=>{
      await tx.query(TAKEOVER_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.node_recovery_quarantines DISABLE TRIGGER immutable_node_quarantine')
      await tx.query('DELETE FROM harness.node_recovery_quarantines WHERE organization_id=$1',[f.org])
      await tx.query(TAKEOVER_RESTORE_SUFFIX)
    })).rejects.toThrow('Disaster isolation')
    expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1',[f.org])).rowCount).toBe(1)
    await acceptSyntheticRecoveryCandidate(pool,secondId)
    await service.confirmIsolation(f.adminId,secondId,{...confirm,confirm:secondId,pointId:second.point,sourceGeneration:'1'})
    expect((await service.status(f.adminId,secondId)).phase).toBe('externally-fenced')
    expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1',[f.org])).rowCount).toBe(1)
    expect((await pool.query('SELECT FROM harness.project_recovery_isolations WHERE organization_id=$1',[f.org])).rowCount).toBe(2)
  })
  it('requires a current independent drill and refuses isolation of the serving primary',async()=>{
    const f=await disasterRecoveryFixture(pool,roots,true), service=new PeerProjectRecovery(f.primary)
    await expect(service.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:f.target,targetVolume:f.targetVolume,recoveryMode:'disaster'}))
      .rejects.toMatchObject({code:'peer-backup/isolation-primary-forbidden'})
    const g=await disasterRecoveryFixture(pool,roots), remote=new PeerProjectRecovery(g.primary)
    await pool.query(`DELETE FROM harness.peer_backup_work WHERE organization_id=$1`,[g.org])
    await expect(remote.request(g.adminId,{requestId:randomUUID(),policyId:g.policy,pointId:g.point,targetNode:g.target,targetVolume:g.targetVolume,recoveryMode:'disaster'}))
      .rejects.toMatchObject({code:'peer-backup/independent-drill-required'})
  })
  it('waits for a concurrent destination revocation before publishing project ownership',async()=>{
    const f=await disasterRecoveryFixture(pool,roots),service=new PeerProjectRecovery(f.primary)
    const id=await service.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:f.target,targetVolume:f.targetVolume,recoveryMode:'disaster'})
    await acceptSyntheticRecoveryCandidate(pool,id)
    await service.confirmIsolation(f.adminId,id,{confirm:id,policyRevision:1,sourceGeneration:'1',sourceEpoch:'1',sourceNodeId:f.context.nodeId,pointId:f.point,
      isolationMethod:'power-off',evidenceReference:'test/source-console',acknowledgeDataLoss:true})
    await pool.query(`UPDATE harness.project_recovery_operations SET phase='disaster-ready',target_schedule_digest=$2,target_files_digest=$3,target_port_base=14100 WHERE id=$1`,[id,digest('e'),digest('f')])
    const changing=await pool.connect()
    let pending:Promise<unknown>|undefined
    try{
      await changing.query('BEGIN')
      const pid=Number((await changing.query('SELECT pg_backend_pid() pid')).rows[0].pid)
      await changing.query(`UPDATE harness.node_agents SET revoked_at=now(),credential_hash=NULL,connection_id=NULL,lease_expires_at=NULL,
        connection_epoch=connection_epoch+1 WHERE organization_id=$1 AND node_id=$2`,[f.org,f.target])
      pending=service.activate(f.adminId,id).then(()=>({accepted:true}),error=>error)
      await expect.poll(async()=>Number((await pool.query('SELECT count(*)::integer count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count),{timeout:5000}).toBeGreaterThan(0)
      await changing.query('COMMIT')
      expect(await pending).toMatchObject({code:'peer-backup/node-not-admitted'})
      expect((await service.status(f.adminId,id)).phase).toBe('disaster-ready')
      expect((await pool.query('SELECT assigned_node_id FROM harness.instances WHERE runtime_id=$1',[f.runtimeId])).rows[0].assigned_node_id).toBe(f.context.nodeId)
      expect((await pool.query('SELECT node_id FROM harness.project_content_placement WHERE runtime_id=$1',[f.runtimeId])).rows[0].node_id).toBe(f.context.nodeId)
    }finally{await changing.query('ROLLBACK');changing.release();await pending}
  })
})
