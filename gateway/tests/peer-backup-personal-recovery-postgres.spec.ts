/** Personal recovery governance state transitions; native file evidence is exercised by the separate personal assembly. */
import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { PeerPersonalRecovery } from '../src/peer-backup-personal-recovery.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { recoveryExecutionDataRoots } from '../src/peer-backup-execution-data.ts'
import { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { TAKEOVER_RESTORE_PREFIX, TAKEOVER_RESTORE_SUFFIX } from '../src/peer-backup-takeover-restore-guard.ts'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const hex=(char:string)=>char.repeat(64)
let pool:Pool
const roots:string[]=[]
async function fixture(){
  const f=await disasterRecoveryFixture(pool,roots)
  const account=(await pool.query<{id:string}>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[f.org,f.adminId])).rows[0]!.id
  const volume=(await pool.query<{volume_id:string}>('SELECT volume_id FROM harness.node_content_volumes WHERE organization_id=$1 AND node_id=$2',[f.org,f.context.nodeId])).rows[0]!.volume_id
  const runtime=randomUUID(),document=randomUUID(),policy=randomUUID(),point=randomUUID()
  await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
    VALUES($1,$2,$3,'linux','x64',$4,1,now()+interval '5 minutes')`,[f.org,f.context.nodeId,randomBytes(32),randomUUID()])
  await pool.query('INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port,generation) VALUES($1,$2,$3,$4,4103,5)',[runtime,f.org,account,f.context.nodeId])
  await pool.query("UPDATE harness.instances SET desired_state='running',observed_state='starting',runtime_token_hash=$2 WHERE runtime_id=$1",[runtime,randomBytes(32)])
  await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE runtime_id=$1",[runtime])
  await pool.query('INSERT INTO harness.personal_directory_placement VALUES($1,$2,$3,$4)',[runtime,f.org,f.context.nodeId,account])
  await pool.query(`INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision)
    VALUES($1,$2,'personal',$3,$4,$5,7,0)`,[f.org,f.context.nodeId,account,document,volume])
  await pool.query(`INSERT INTO harness.peer_backup_policies(id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
    VALUES($1,$2,'personal',$3,$4,$5,'important',true,1,1048576,$6,$7)`,[policy,f.org,runtime,f.context.nodeId,f.target,hex('a'),hex('b')])
  await pool.query(`INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,protected_through)
    VALUES($1,$2,$3,1,3,1,$4,$5,12,0,now())`,[point,f.org,policy,hex('c'),hex('d')])
  await pool.query(`INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status)
    VALUES($1,$2,$3,1,'drill',$4,$5,'confirmed')`,[randomUUID(),f.org,policy,f.target,point])
  const primary=new PeerPersonalRecovery(f.primary),targetContext={...f.context,nodeId:f.target,nodeName:'target'},target=new PeerPersonalRecovery(targetContext,14100)
  return {...f,account,volume,runtime,document,personalPolicy:policy,personalPoint:point,primaryService:primary,targetService:target,targetContext}
}
const suite=url?describe:describe.skip
suite('personal disaster governance',()=>{
  beforeAll(async()=>{pool=createPostgresPool(url!,{max:5});await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))})
  afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
  afterAll(async()=>{await pool?.end()})
  it('requires target preparation, retains the original Runtime and document identity, and keeps all old work gated',async()=>{
    const f=await fixture(),id=randomUUID()
    const input={requestId:id,policyId:f.personalPolicy,pointId:f.personalPoint,targetNode:f.target,targetVolume:f.targetVolume}
    const replacement=randomUUID(),replacementVolume=randomUUID()
    await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'personal-replacement')",[replacement,f.org])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'linux','x64',$4,1,clock_timestamp()+interval '5 minutes')`,[f.org,replacement,randomBytes(32),randomUUID()])
    await pool.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,'7812345678901234567',41001)`,[f.org,replacement,replacementVolume])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[f.org,replacement,f.account])
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:true,personal:false})
    await publishRecoveryProtocol(pool,f.org,replacement,300000,{project:true,personal:false})
    expect((await f.primaryService.choices(f.adminId,f.personalPolicy)).targets).toEqual([])
    for(const target of [{node:f.target,volume:f.targetVolume},{node:replacement,volume:replacementVolume}])
      await expect(f.primaryService.request(f.adminId,{...input,targetNode:target.node,targetVolume:target.volume}))
        .rejects.toMatchObject({code:'peer-backup/recovery-worker-unavailable'})
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:true,personal:true})
    await f.primaryService.request(f.adminId,input)
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:true,personal:false})
    for(const target of [{node:f.target,volume:f.targetVolume},{node:replacement,volume:replacementVolume}])
      await expect(pool.query(`INSERT INTO harness.personal_recovery_operations SELECT (jsonb_populate_record(NULL::harness.personal_recovery_operations,
        to_jsonb(r)||jsonb_build_object('id',$2::uuid,'target_node_id',$3::uuid,'target_volume_id',$4::uuid))).*
        FROM harness.personal_recovery_operations r WHERE r.id=$1`,[id,randomUUID(),target.node,target.volume]))
        .rejects.toMatchObject({code:'23514'})
    expect(await f.primaryService.status(f.adminId,id)).toMatchObject({phase:'preparing',lastError:'peer-backup/recovery-worker-unavailable'})
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:true,personal:true})
    const confirm={confirm:id,sourceNodeId:f.context.nodeId,sourceGeneration:'5',sourceEpoch:'3',pointId:f.personalPoint,policyRevision:1,
      isolationMethod:'power-off',evidenceReference:'test/control-plane',acknowledgeDataLoss:true}
    await expect(f.primaryService.confirmIsolation(f.adminId,id,confirm)).rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    expect((await pool.query('SELECT observed_state,desired_state FROM harness.instances WHERE runtime_id=$1',[f.runtime])).rows[0])
      .toEqual({observed_state:'ready',desired_state:'running'})
    const proof={filesDigest:hex('e'),evidenceDigest:hex('f'),documentDigest:hex('1'),oldSessionCount:2}
    await f.targetService.confirmTarget(id,proof)
    await expect(recoveryExecutionDataRoots(f.targetContext,roots.at(-1)!)).rejects.toMatchObject({code:'peer-backup/personal-recovery-installation-pending'})
    await expect(f.primaryService.confirmIsolation(f.adminId,id,{...confirm,sourceGeneration:'4'})).rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    await f.primaryService.confirmIsolation(f.adminId,id,confirm)
    expect((await pool.query('SELECT observed_state,desired_state,runtime_token_hash FROM harness.instances WHERE runtime_id=$1',[f.runtime])).rows[0])
      .toEqual({observed_state:'ready',desired_state:'stopped',runtime_token_hash:null})
    await expect(f.primaryService.cancel(f.adminId,id)).rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    await expect(pool.query("UPDATE harness.instances SET desired_state='running' WHERE runtime_id=$1",[f.runtime])).rejects.toMatchObject({constraint:'runtime_recovery_review'})
    await f.primaryService.activate(f.adminId,id)
    await f.targetService.publish(id,{...proof,homePath:join(roots.at(-1)!,'replacement','home')})
    expect(await f.primaryService.status(f.adminId,id)).toMatchObject({phase:'published',executionReviewRequired:true,targetEpoch:'6'})
    expect((await pool.query(`SELECT runtime_id,assigned_node_id,generation::text,observed_state,desired_state FROM harness.instances WHERE runtime_id=$1`,[f.runtime])).rows[0])
      .toEqual({runtime_id:f.runtime,assigned_node_id:f.target,generation:'6',observed_state:'stopped',desired_state:'stopped'})
    expect((await pool.query('SELECT root_id,node_id,writer_epoch::text FROM harness.document_scope_placement WHERE organization_id=$1 AND scope_id=$2',[f.org,f.account])).rows[0])
      .toEqual({root_id:f.document,node_id:f.target,writer_epoch:'8'})
    const service=new PeerRecoveryExecution({context:f.primary,personal:{service:f.primaryService,
      paths:async()=>{throw new Error('Control-plane fixture never inspects files')},oldSessions:async()=>{throw new Error('Control-plane fixture never reads Sessions')}}})
    await service.prepare(f.adminId,id,{confirm:id})
    expect(await service.status(f.adminId,id)).toMatchObject({preparationStatus:'queued',sessionsReadOnly:true,tasksSuspended:true})
    const review=randomUUID()
    await pool.query(`INSERT INTO harness.personal_recovery_execution_reviews(id,operation_id,organization_id,runtime_id,target_node_id,target_epoch,point_id,
      policy_digest,composition_digest,old_session_count,items) VALUES($1,$2,$3,$4,$5,6,$6,$7,$7,2,'[]')`,
    [review,id,f.org,f.runtime,f.target,f.personalPoint,hex('2')])
    await pool.query(`UPDATE harness.personal_recovery_execution_requests SET status='ready',review_id=$2 WHERE operation_id=$1`,[id,review])
    await service.enable(f.adminId,id,{confirm:id,reviewRevision:review,mode:'new-conversations-only'})
    expect(await service.status(f.adminId,id)).toMatchObject({status:'new-conversations-enabled',oldSessionCount:2})
    await pool.query("UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=generation+1,runtime_token_hash=$2 WHERE runtime_id=$1",[f.runtime,randomBytes(32)])
    await expect(service.prepare(f.adminId,id,{confirm:id})).rejects.toMatchObject({code:'peer-backup/execution-runtime-busy'})
    await expect(transaction(pool,async tx=>{
      await tx.query(TAKEOVER_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.personal_recovery_execution_approvals DISABLE TRIGGER immutable_personal_execution_approval')
      await tx.query('DELETE FROM harness.personal_recovery_execution_approvals WHERE review_id=$1',[review])
      await tx.query(TAKEOVER_RESTORE_SUFFIX)
    })).rejects.toThrow('personal recovery authority')
  })
  it('moves shared account documents once and accepts another Runtime only for the same document checkpoint',async()=>{
    const f=await fixture(),runtime=randomUUID(),policy=randomUUID(),point=randomUUID()
    await pool.query('UPDATE harness.runtime_allocation_policies SET max_per_node=3,max_total=4 WHERE organization_id=$1 AND user_id IS NULL',[f.org])
    await pool.query("INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port,generation,storage_layout) VALUES($1,$2,$3,$4,4104,5,'isolated')",[runtime,f.org,f.account,f.context.nodeId])
    await pool.query('INSERT INTO harness.personal_directory_placement VALUES($1,$2,$3,$4)',[runtime,f.org,f.context.nodeId,f.account])
    await pool.query(`INSERT INTO harness.peer_backup_policies(id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
      VALUES($1,$2,'personal',$3,$4,$5,'important',true,1,1048576,$6,$7)`,[policy,f.org,runtime,f.context.nodeId,f.target,hex('a'),hex('b')])
    await pool.query(`INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,protected_through)
      VALUES($1,$2,$3,1,3,1,$4,$5,12,0,now())`,[point,f.org,policy,hex('c'),hex('d')])
    await pool.query(`INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status)
      VALUES($1,$2,$3,1,'drill',$4,$5,'confirmed')`,[randomUUID(),f.org,policy,f.target,point])
    const first=await f.primaryService.request(f.adminId,{requestId:randomUUID(),policyId:f.personalPolicy,pointId:f.personalPoint,targetNode:f.target,targetVolume:f.targetVolume})
    const proof={filesDigest:hex('e'),evidenceDigest:hex('f'),documentDigest:hex('1'),oldSessionCount:2}
    await f.targetService.confirmTarget(first,proof)
    const isolation=(id:string,pointId:string)=>({confirm:id,sourceNodeId:f.context.nodeId,sourceGeneration:'5',sourceEpoch:'3',pointId,policyRevision:1,
      isolationMethod:'power-off',evidenceReference:'test/same-source',acknowledgeDataLoss:true})
    await f.primaryService.confirmIsolation(f.adminId,first,isolation(first,f.personalPoint));await f.primaryService.activate(f.adminId,first)
    const homePath=join(roots.at(-1)!,'replacement','home')
    await f.targetService.publish(first,{...proof,homePath})
    const ordinary=randomUUID()
    await pool.query("INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port,generation,storage_layout) VALUES($1,$2,$3,$4,24104,1,'isolated')",[ordinary,f.org,f.account,f.target])
    expect((await pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[f.org,ordinary,f.target])).rows[0].allowed).toBe(true)
    const second=await f.primaryService.request(f.adminId,{requestId:randomUUID(),policyId:policy,pointId:point,targetNode:f.target,targetVolume:f.targetVolume})
    expect((await f.primaryService.get(second)).documentReceiptOperationId).toBe(first)
    await expect(f.targetService.confirmTarget(second,{...proof,documentDigest:hex('2')})).rejects.toMatchObject({code:'peer-backup/personal-document-point-conflict'})
    await f.targetService.confirmTarget(second,proof);await f.primaryService.confirmIsolation(f.adminId,second,isolation(second,point))
    await f.primaryService.activate(f.adminId,second)
    await expect(pool.query("UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=generation+1,runtime_token_hash=$2 WHERE runtime_id=$1",[ordinary,randomBytes(32)]))
      .rejects.toMatchObject({constraint:'runtime_recovery_review'})
    await f.targetService.publish(second,{...proof,homePath})
    expect((await pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[f.org,ordinary,f.target])).rows[0].allowed).toBe(true)
    expect((await pool.query('SELECT operation_id FROM harness.personal_recovery_document_receipts WHERE organization_id=$1',[f.org])).rows).toEqual([{operation_id:first}])
    expect((await pool.query('SELECT writer_epoch::text,node_id FROM harness.document_scope_placement WHERE organization_id=$1 AND scope_id=$2',[f.org,f.account])).rows)
      .toEqual([{writer_epoch:'8',node_id:f.target}])
    expect((await pool.query('SELECT assigned_node_id,generation::text FROM harness.instances WHERE runtime_id=ANY($1::uuid[]) ORDER BY runtime_id',[[runtime,f.runtime]])).rows)
      .toEqual([{assigned_node_id:f.target,generation:'6'},{assigned_node_id:f.target,generation:'6'}])
  })
  it('waits for target lease changes before certifying files and refuses the revoked destination',async()=>{
    const f=await fixture(),id=await f.primaryService.request(f.adminId,{requestId:randomUUID(),policyId:f.personalPolicy,pointId:f.personalPoint,targetNode:f.target,targetVolume:f.targetVolume})
    const changing=await pool.connect()
    let pending:Promise<unknown>|undefined
    try{
      await changing.query('BEGIN')
      const pid=Number((await changing.query('SELECT pg_backend_pid() pid')).rows[0].pid)
      await changing.query('UPDATE harness.node_agents SET revoked_at=now(),credential_hash=NULL,connection_id=NULL,lease_expires_at=NULL,connection_epoch=connection_epoch+1 WHERE organization_id=$1 AND node_id=$2',[f.org,f.target])
      pending=f.targetService.confirmTarget(id,{filesDigest:hex('e'),evidenceDigest:hex('f'),documentDigest:hex('1'),oldSessionCount:2}).then(()=>({accepted:true}),error=>error)
      await expect.poll(async()=>Number((await pool.query('SELECT count(*)::integer count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count),{timeout:5000}).toBeGreaterThan(0)
      await changing.query('COMMIT')
      expect(await pending).toMatchObject({code:'peer-backup/node-not-admitted'})
      expect(await f.primaryService.status(f.adminId,id)).toMatchObject({phase:'preparing'})
    }finally{await changing.query('ROLLBACK');changing.release();await pending}
  })
  it('requires existing target grants and fresh policy approval without widening quotas or reviving a quarantined node',async()=>{
    const f=await fixture(),input={requestId:randomUUID(),policyId:f.personalPolicy,pointId:f.personalPoint,targetNode:f.target,targetVolume:f.targetVolume}
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.org,f.target,f.account])
    await expect(f.primaryService.request(f.adminId,input)).rejects.toMatchObject({code:'peer-backup/personal-owner-unavailable'})
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.org,f.target,f.account])
    await f.primaryService.request(f.adminId,input)
    await f.targetService.confirmTarget(input.requestId,{filesDigest:hex('e'),evidenceDigest:hex('f'),documentDigest:hex('1'),oldSessionCount:0})
    await f.primaryService.confirmIsolation(f.adminId,input.requestId,{confirm:input.requestId,sourceNodeId:f.context.nodeId,sourceGeneration:'5',sourceEpoch:'3',pointId:f.personalPoint,
      policyRevision:1,isolationMethod:'network-isolation',evidenceReference:'test/isolated-source',acknowledgeDataLoss:true})
    // A prior approval can carry a later wall clock; policy revisions remain the ordering authority.
    await pool.query(`INSERT INTO harness.personal_recovery_policy_approvals(id,operation_id,organization_id,policy_revision,phase,approved_by,approved_at)
      VALUES($1,$2,$3,1,'externally-fenced',$4,'2099-01-01T00:00:00Z')`,[randomUUID(),input.requestId,f.org,f.account])
    const governance=new PeerBackupGovernance(f.primary)
    const policy={id:f.personalPolicy,sourceNodeId:f.context.nodeId,targetNodeId:f.target,scopeKind:'personal',scopeId:f.runtime,tier:'important',quotaBytes:1048576,
      appendFingerprint:hex('a'),recoveryFingerprint:hex('b')}
    await governance.configure(f.adminId,{...policy,expectedRevision:1,enabled:false})
    await governance.configure(f.adminId,{...policy,expectedRevision:2,enabled:true})
    await expect(f.primaryService.activate(f.adminId,input.requestId)).rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    await expect(f.primaryService.reapprove(f.adminId,input.requestId,3,'externally-fenced')).rejects.toMatchObject({code:'peer-backup/independent-drill-required'})
    await pool.query(`INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status)
      VALUES($1,$2,$3,3,'drill',$4,$5,'confirmed')`,[randomUUID(),f.org,f.personalPolicy,f.target,f.personalPoint])
    await f.primaryService.reapprove(f.adminId,input.requestId,3,'externally-fenced')
    await f.primaryService.activate(f.adminId,input.requestId)
    expect((await f.primaryService.get(input.requestId)).policyRevision).toBe(3)
    expect((await pool.query('SELECT harness.node_physically_isolated($1,$2) isolated',[f.org,f.context.nodeId])).rows[0]).toEqual({isolated:true})
  })
})
