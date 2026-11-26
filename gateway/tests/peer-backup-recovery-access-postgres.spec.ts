/** A third computer reads a fixed peer point only through its own current, explicitly approved credential. */
import { createHash,randomBytes,randomUUID } from 'node:crypto'
import { realpath,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { expect,it,vi } from 'vitest'
import { createPostgresPool,runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'

const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
it.skipIf(!url)('retains source and repository identity while independently fencing third-node read approvals',async()=>{
  const pool=createPostgresPool(url!,{max:4}),roots:string[]=[]
  try{
    await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    const f=await disasterRecoveryFixture(pool,roots),reader=randomUUID(),volume=randomUUID()
    await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'replacement')",[reader,f.org])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'win32','x64',$4,1,clock_timestamp()+interval '5 minutes')`,[f.org,reader,randomBytes(32),randomUUID()])
    await pool.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,'7812345678901234567',40001)`,[f.org,reader,volume])
    const account=(await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[f.org,f.adminId])).rows[0].id
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[f.org,reader,account])
    const service=new PeerBackupGovernance(f.primary,60000,300000),recovery=new PeerProjectRecovery(f.primary)
    await pool.query('DELETE FROM harness.peer_recovery_node_protocols WHERE organization_id=$1',[f.org])
    await expect(recovery.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:f.target,targetVolume:f.targetVolume,recoveryMode:'disaster'}))
      .rejects.toMatchObject({code:'peer-backup/recovery-protocol-upgrade-required'})
    const token=randomUUID(),input={id:randomUUID(),expectedRevision:1,pointId:f.point,recoveryNodeId:reader,fingerprint:hash(token),expiresAt:new Date(Date.now()+120000).toISOString()}
    await expect(service.approveRead(f.adminId,f.policy,input)).rejects.toMatchObject({code:'peer-backup/recovery-protocol-upgrade-required'})
    expect((await recovery.choices(f.adminId,f.policy)).targets.some(row=>row.nodeId===reader)).toBe(false)
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:false,personal:false})
    await publishRecoveryProtocol(pool,f.org,reader,300000,{project:false,personal:false})
    await service.approveRead(f.adminId,f.policy,input)
    const context=await resolvePostgresRuntimeContext(pool,f.context.organizationSlug,'replacement'),worker=new PeerBackupGovernance(context)
    const isolatedId=await service.enqueue(f.adminId,f.policy,'drill',f.point,reader),isolated=await worker.claim()
    expect(isolated?.id).toBe(isolatedId);await worker.finish(isolated!,{recoveryMs:1})
    expect((await recovery.choices(f.adminId,f.policy)).targets.some(row=>row.nodeId===reader)).toBe(false)
    for(const target of [{node:reader,volume},{node:f.target,volume:f.targetVolume}])for(const recoveryMode of ['planned','disaster'] as const)
      await expect(recovery.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:target.node,targetVolume:target.volume,recoveryMode}))
        .rejects.toMatchObject({code:'peer-backup/recovery-worker-unavailable'})
    await publishRecoveryProtocol(pool,f.org,reader,300000,{project:true,personal:false})
    const choices=await recovery.choices(f.adminId,f.policy)
    expect(choices.repositoryNodeId).toBe(f.target)
    expect(choices.targets).toContainEqual({nodeId:reader,volumeId:volume})
    await expect(service.approveRead(f.adminId,f.policy,{...input,expiresAt:'2000-01-01T00:00:00Z'})).rejects.toMatchObject({code:'peer-backup/recovery-access-changed'})
    await expect(service.approveRead(f.adminId,f.policy,{...input,expiresAt:new Date(Date.now()+600000).toISOString()})).rejects.toMatchObject({code:'peer-backup/recovery-access-changed'})
    await service.approveRead(f.adminId,f.policy,input)
    await expect(service.approveRead(f.adminId,f.policy,input)).resolves.toBe(input.id)
    await expect(service.approveRead(f.adminId,f.policy,{...input,id:randomUUID()})).rejects.toMatchObject({code:'peer-backup/recovery-access-changed'})
    const grant=await service.grant(f.policy,reader,token)
    expect(grant).toMatchObject({sourceNodeId:f.context.nodeId,targetNodeId:f.target,mode:'recover',recoveryPointId:f.point})
    await expect(service.grant(f.policy,reader,randomUUID())).rejects.toMatchObject({code:'peer-backup/recovery-access-required'})
    await expect(service.grant(f.policy,f.context.nodeId,token)).rejects.toMatchObject({code:'peer-backup/pair-denied'})
    await expect(service.enqueue(f.adminId,f.policy,'drill',randomUUID(),reader)).rejects.toMatchObject({code:'peer-backup/independent-drill-required'})
    const jobId=await service.enqueue(f.adminId,f.policy,'drill',f.point,reader)
    const job=await worker.claim();expect(job?.id).toBe(jobId)
    await worker.finish(job!,{recoveryMs:1})
    const id=await recovery.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:reader,targetVolume:volume,recoveryMode:'disaster'})
    expect(await recovery.status(f.adminId,id)).toMatchObject({repositoryNodeId:f.target,targetNodeId:reader,sourceNodeId:f.context.nodeId,phase:'preparing'})
    await pool.query('DELETE FROM harness.peer_recovery_node_protocols WHERE organization_id=$1 AND node_id=$2',[f.org,reader])
    expect(await recovery.status(f.adminId,id)).toMatchObject({phase:'preparing',lastError:'peer-backup/recovery-worker-unavailable'})
    for(const target of [{node:reader,volume},{node:f.target,volume:f.targetVolume}])for(const recoveryMode of ['planned','disaster'] as const)
      await expect(pool.query(`INSERT INTO harness.project_recovery_operations SELECT (jsonb_populate_record(NULL::harness.project_recovery_operations,
        to_jsonb(r)||jsonb_build_object('id',$2::uuid,'target_node_id',$3::uuid,'target_volume_id',$4::uuid,'recovery_mode',$5::text,
          'phase',CASE WHEN $5='disaster' THEN 'preparing' ELSE 'prepared' END))).*
        FROM harness.project_recovery_operations r WHERE r.id=$1`,[id,randomUUID(),target.node,target.volume,recoveryMode]))
        .rejects.toMatchObject({code:'23514'})
    await publishRecoveryProtocol(pool,f.org,reader,300000,{project:true,personal:false})
    const state=await recovery.status(f.adminId,id)
    await expect(recovery.confirmIsolation(f.adminId,id,{confirm:id,policyRevision:1,sourceGeneration:state.sourceGeneration,sourceEpoch:state.sourceEpoch,
      sourceNodeId:f.context.nodeId,pointId:f.point,isolationMethod:'network-isolation',evidenceReference:'fixture/no-proof',acknowledgeDataLoss:true}))
      .rejects.toMatchObject({code:'peer-backup/recovery-approval-changed'})
    expect((await pool.query('SELECT FROM harness.node_recovery_quarantines WHERE organization_id=$1',[f.org])).rowCount).toBe(0)
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.org,reader,account])
    await expect(grant.revalidate()).rejects.toMatchObject({code:'peer-backup/recovery-reader-owner-unavailable'})
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[f.org,reader,account])
    await pool.query('UPDATE harness.node_agents SET connection_epoch=connection_epoch+1 WHERE organization_id=$1 AND node_id=$2',[f.org,reader])
    await expect(grant.revalidate()).rejects.toMatchObject({code:'peer-backup/recovery-protocol-upgrade-required'})
    await publishRecoveryProtocol(pool,f.org,reader,300000,{project:true,personal:false})
    await expect(grant.revalidate()).rejects.toMatchObject({code:'peer-backup/recovery-access-required'})
    await expect(service.approveRead(f.adminId,f.policy,input)).rejects.toMatchObject({code:'peer-backup/recovery-access-changed'})
    const nextToken=randomUUID(),nextApproval={...input,id:randomUUID(),fingerprint:hash(nextToken)}
    await service.approveRead(f.adminId,f.policy,nextApproval)
    const nextJobId=await service.enqueue(f.adminId,f.policy,'drill',f.point,reader),nextJob=await worker.claim()
    expect(nextJob?.id).toBe(nextJobId)
    const barrier=await pool.connect(),order:string[]=[]
    let finishing:Promise<unknown>|undefined,revoking:Promise<unknown>|undefined
    try{
      await barrier.query('BEGIN');const pid=(await barrier.query('SELECT pg_backend_pid() pid')).rows[0].pid
      await barrier.query('SELECT FROM harness.peer_backup_work WHERE id=$1 FOR UPDATE',[nextJobId])
      finishing=worker.finish(nextJob!,{recoveryMs:1}).then(()=>order.push('finished'))
      await expect.poll(async()=>Number((await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)).toBeGreaterThan(0)
      revoking=service.revokeRead(f.adminId,f.policy,nextApproval.id).then(()=>order.push('revoked'))
      await expect.poll(async()=>Number((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database() AND pid<>pg_backend_pid()")).rows[0].n)).toBe(2)
      expect(order).toEqual([])
      await barrier.query('COMMIT');await finishing;await revoking
      expect(order).toEqual(['finished','revoked'])
      const deniedJob=await service.enqueue(f.adminId,f.policy,'drill',f.point,reader).then(()=>null,error=>error)
      expect(deniedJob).toMatchObject({code:'peer-backup/recovery-access-required'})
    }finally{await barrier.query('ROLLBACK');barrier.release();await Promise.allSettled([finishing,revoking])}
    await service.revokeRead(f.adminId,f.policy,input.id)
    expect((await service.reads(f.adminId,f.policy))[0].revokedAt).toBeTruthy()
    expect((await pool.query('SELECT target_node_id FROM harness.peer_backup_policies WHERE id=$1',[f.policy])).rows[0].target_node_id).toBe(f.target)
    expect((await pool.query('SELECT manifest_digest FROM harness.peer_backup_points WHERE id=$1',[f.point])).rows[0].manifest_digest).toBe('d'.repeat(64))
  }finally{await pool.end();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))}
})

it.skipIf(!url)('advertises only installed workers and renews receiver capability while a backup job remains active',async()=>{
  const pool=createPostgresPool(url!,{max:4}),roots:string[]=[]
  let release!:()=>void,entered!:()=>void
  const held=new Promise<void>(accept=>{release=accept}),started=new Promise<void>(accept=>{entered=accept})
  let gateway:Awaited<ReturnType<typeof createPeerBackupGateway>>|undefined
  try{
    await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    const f=await disasterRecoveryFixture(pool,roots),root=await realpath(roots[0]!)
    const target=await resolvePostgresRuntimeContext(pool,f.context.organizationSlug,'target')
    await pool.query('DELETE FROM harness.peer_recovery_node_protocols WHERE organization_id=$1 AND node_id=$2',[f.org,f.target])
    const configFile=join(root,'receiver.json')
    await writeFile(configFile,JSON.stringify({version:1,directory:join(root,'ciphertext'),stagingDirectory:join(root,'staging'),
      resticExecutable:process.execPath,capacityBytes:1048576,maxExportBytes:1048576,reserveBytes:1,
      pollMs:1000,uploadKiBps:1024,downloadKiBps:1024,routes:[]}),{mode:0o600})
    gateway=await createPeerBackupGateway({context:target,configFile})
    const job=vi.spyOn(PeerBackupGovernance.prototype,'claim').mockImplementation(async()=>{entered();await held;return null})
    await expect.poll(()=>job.mock.calls.length,{timeout:5000}).toBe(1)
    await started
    const capability=async()=>(await pool.query(`SELECT protocol,project_ready,personal_ready,expires_at,
      harness.peer_recovery_worker_supported(organization_id,node_id,'project') project_supported
      FROM harness.peer_recovery_node_protocols WHERE organization_id=$1 AND node_id=$2`,[f.org,f.target])).rows[0]
    await expect.poll(capability).toMatchObject({protocol:2,project_ready:false,personal_ready:false,project_supported:false})
    const first=(await capability()).expires_at as Date
    await expect.poll(async()=>Number((await capability()).expires_at),{timeout:5000}).toBeGreaterThan(first.getTime())
    let closed=false
    const closing=gateway.close().then(()=>{closed=true})
    await Promise.resolve();expect(closed).toBe(false)
    release();await closing;expect(closed).toBe(true)
  }finally{release();await gateway?.close();vi.restoreAllMocks();await pool.end();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))}
})
