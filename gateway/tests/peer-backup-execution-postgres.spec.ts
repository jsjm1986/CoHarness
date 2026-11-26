/** PostgreSQL execution-review authorization; full file restoration is covered by the separate restic assembly. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { TAKEOVER_RESTORE_PREFIX, TAKEOVER_RESTORE_SUFFIX } from '../src/peer-backup-takeover-restore-guard.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { disasterRecoveryFixture,acceptSyntheticRecoveryCandidate } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
describe.skipIf(!databaseUrl)('disaster execution permits', () => {
  let pool: Pool
  const roots: string[] = []
  beforeAll(async () => { pool = createPostgresPool(databaseUrl!); await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations')) })
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))) })
  afterAll(async () => { await pool?.end() })

  it('reads an empty local recovery directory before backup or maintenance setup without admitting unauthorized entries', async () => {
    const slug = 'fresh-recovery-' + randomUUID()
    const org = (await pool.query<{id: string}>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Fresh recovery') RETURNING id`, [slug])).rows[0]!.id
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local'),($1,'other')`, [org])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const actors: number[] = []
    for (const role of ['admin', 'member']) {
      const user = (await pool.query<{id: string; publicId: number}>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id::float8 "publicId"`, [org, role, 'fixture-unused-home'])).rows[0]!
      await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [org,user.id,role])
      await pool.query(`INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password)
        VALUES($1,'fixture-unusable-password',false)`, [user.id])
      actors.push(user.publicId)
    }
    const service = new PeerRecoveryExecution({ context })
    await expect(service.listLocal(actors[1]!)).rejects.toMatchObject({ message: 'forbidden' })
    expect((await pool.query('SELECT FROM harness.cluster_control WHERE organization_id=$1', [org])).rowCount).toBe(0)
    const gateway = await createPeerBackupGateway({ context })
    onTestFinished(() => gateway.close())
    const server = createServer((req,res) => { void gateway.admin(req,res,actors[0]!).catch(() => res.writeHead(500).end()) })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()))
    })
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Recovery HTTP fixture did not listen')
    const url = `http://127.0.0.1:${address.port}/admin/api/peer-backups/recoveries/local-execution`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
    expect((await pool.query('SELECT mode FROM harness.cluster_control WHERE organization_id=$1', [org])).rows).toEqual([{mode:'serving'}])
    expect((await pool.query('SELECT FROM harness.instances WHERE organization_id=$1', [org])).rowCount).toBe(0)
    await pool.query("UPDATE harness.cluster_control SET mode='maintenance' WHERE organization_id=$1", [org])
    expect((await fetch(url)).status).toBe(409)
    expect((await pool.query('SELECT mode FROM harness.cluster_control WHERE organization_id=$1', [org])).rows[0].mode).toBe('maintenance')
    await pool.query("UPDATE harness.cluster_control SET mode='serving' WHERE organization_id=$1", [org])
    await pool.query(`UPDATE harness.deployment_topology SET enabled=true,
      primary_node_id=(SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name='other'),
      primary_origin='https://other.test' WHERE organization_id=$1`, [org])
    expect((await fetch(url)).status).toBe(409)
    await expect(service.listLocal(actors[1]!)).rejects.toMatchObject({message:'forbidden'})
  })

  it('keeps holds immutable, checks current review and refuses preparation while a new task is running', async () => {
    const f = await disasterRecoveryFixture(pool, roots), recovery = new PeerProjectRecovery(f.primary)
    const service = new PeerRecoveryExecution({ context: f.primary })
    const id = await recovery.request(f.adminId, {requestId: randomUUID(), policyId: f.policy, pointId: f.point,
      targetNode: f.target, targetVolume: f.targetVolume, recoveryMode: 'disaster'})
    await expect(service.prepare(f.adminId,id,{confirm:id})).rejects.toMatchObject({code:'peer-backup/execution-not-published'})
    await acceptSyntheticRecoveryCandidate(pool,id,'f'.repeat(64),'f'.repeat(64))
    await recovery.confirmIsolation(f.adminId,id,{confirm:id,policyRevision:1,sourceGeneration:'1',sourceEpoch:'1',sourceNodeId:f.context.nodeId,
      pointId:f.point,isolationMethod:'power-off',evidenceReference:'console/recovery-execution-test',acknowledgeDataLoss:true})
    // These rows represent the separately tested target worker's verified file and Schedule evidence.
    await pool.query(`UPDATE harness.project_recovery_operations SET phase='disaster-ready',
      target_files_digest=$2,target_schedule_digest=$2,target_port_base=14100 WHERE id=$1`,[id,'f'.repeat(64)])
    await recovery.activate(f.adminId,id)
    await pool.query(`UPDATE harness.project_recovery_operations SET target_activated_at=now() WHERE id=$1`,[id])
    const directTarget=new PeerRecoveryExecution({context:{...f.primary,nodeId:f.target}})
    await expect(directTarget.status(f.adminId,id)).rejects.toMatchObject({code:'peer-backup/primary-required'})
    await service.prepare(f.adminId,id,{confirm:id})
    expect(await service.status(f.adminId,id)).toMatchObject({preparationStatus:'queued',reviewRevision:null,oldSessionCount:null})
    const review = randomUUID()
    const item = {id:'schedule-review',name:'@deepseek-ai/dsh-schedule',kind:'plugin',itemDigest:'a'.repeat(64),
      artifactSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64),status:'eligible'}
    const unsupported = {...item,id:'unknown-plugin',name:'user-plugin',itemDigest:'d'.repeat(64),status:'suspended'}
    const op = await recovery.get(id)
    await pool.query(`INSERT INTO harness.project_recovery_execution_reviews(id,operation_id,organization_id,runtime_id,target_node_id,
      target_epoch,point_id,policy_digest,composition_digest,old_session_count,items)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,2,$9)`,[review,id,f.org,f.runtimeId,f.target,op.newEpoch,f.point,'e'.repeat(64),JSON.stringify([item,unsupported])])
    await pool.query(`UPDATE harness.project_recovery_execution_requests SET status='ready',review_id=$2 WHERE operation_id=$1`,[id,review])
    await expect(service.enable(f.adminId,id,{confirm:id,reviewRevision:randomUUID(),mode:'new-conversations-only'}))
      .rejects.toMatchObject({code:'peer-backup/execution-review-changed'})
    await expect(service.approveItem(f.adminId,id,unsupported.id,{confirm:id,reviewRevision:review,itemDigest:unsupported.itemDigest,evidenceReference:'review/ticket'}))
      .rejects.toMatchObject({code:'peer-backup/execution-item-unsupported'})
    await service.enable(f.adminId,id,{confirm:id,reviewRevision:review,mode:'new-conversations-only'})
    await service.enable(f.adminId,id,{confirm:id,reviewRevision:review,mode:'new-conversations-only'})
    expect((await pool.query(`SELECT count(*)::int n FROM harness.audit_events WHERE organization_id=$1 AND resource_id=$2
      AND action='admin.project-recovery.execution-enable-new-conversations'`,[f.org,id])).rows[0].n).toBe(1)
    expect(await service.status(f.adminId,id)).toMatchObject({status:'new-conversations-enabled',sessionsReadOnly:true,tasksSuspended:true,oldSessionCount:2})
    await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=generation+1,runtime_token_hash=decode($2,'hex') WHERE runtime_id=$1`,[f.runtimeId,'1'.repeat(64)])
    await expect(service.prepare(f.adminId,id,{confirm:id})).rejects.toMatchObject({code:'peer-backup/execution-runtime-busy'})
    await expect(service.approveItem(f.adminId,id,item.id,{confirm:id,reviewRevision:review,itemDigest:item.itemDigest,evidenceReference:'review/ticket'}))
      .rejects.toMatchObject({code:'peer-backup/execution-runtime-busy'})
    expect((await pool.query(`SELECT desired_state,observed_state FROM harness.instances WHERE runtime_id=$1`,[f.runtimeId])).rows[0])
      .toEqual({desired_state:'running',observed_state:'starting'})
    await pool.query(`UPDATE harness.instances SET desired_state='stopped',observed_state='stopped',runtime_token_hash=NULL WHERE runtime_id=$1`,[f.runtimeId])
    await service.approveItem(f.adminId,id,item.id,{confirm:id,reviewRevision:review,itemDigest:item.itemDigest,evidenceReference:'review/ticket'})
    expect(await service.status(f.adminId,id)).toMatchObject({preparationStatus:'queued',status:'review-required'})
    await expect(pool.query(`UPDATE harness.instances SET desired_state='running' WHERE runtime_id=$1`,[f.runtimeId]))
      .rejects.toMatchObject({constraint:'runtime_recovery_review'})
    await expect(transaction(pool,async tx=>{
      await tx.query(TAKEOVER_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.project_recovery_execution_approvals DISABLE TRIGGER immutable_recovery_execution_approval')
      await tx.query('DELETE FROM harness.project_recovery_execution_approvals WHERE review_id=$1',[review])
      await tx.query(TAKEOVER_RESTORE_SUFFIX)
    })).rejects.toThrow('Execution recovery approvals differ')
    await expect(pool.query('DELETE FROM harness.project_recovery_execution_holds WHERE operation_id=$1',[id])).rejects.toThrow('immutable')
    await expect(recovery.request(f.adminId,{requestId:randomUUID(),policyId:f.policy,pointId:f.point,targetNode:f.target,
      targetVolume:f.targetVolume,recoveryMode:'planned'})).rejects.toMatchObject({code:'peer-backup/independent-drill-required'})

    // A later source loss advances the writer again; the earlier receipt must neither authorize nor permanently block it.
    const secondPolicy=randomUUID(),secondPoint=randomUUID(),secondVolume=randomUUID()
    await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      SELECT $1,$2,id,true FROM harness.users WHERE organization_id=$1 AND public_id=$3 ON CONFLICT DO NOTHING`,[f.org,f.primary.nodeId,f.adminId])
    await pool.query(`INSERT INTO harness.node_content_volumes(organization_id,node_id,volume_id,cluster_id,database_oid)
      VALUES($1,$2,$3,'987654321',987654321)`,[f.org,f.primary.nodeId,secondVolume])
    await pool.query(`UPDATE harness.peer_backup_policies SET enabled=false WHERE id=$1`,[f.policy])
    await pool.query(`INSERT INTO harness.peer_backup_policies(id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,
      tier,enabled,revision,quota_bytes,append_hash,recovery_hash)
      SELECT $2,organization_id,scope_kind,scope_id,target_node_id,$3,tier,true,1,quota_bytes,append_hash,recovery_hash
      FROM harness.peer_backup_policies WHERE id=$1`,[f.policy,secondPolicy,f.primary.nodeId])
    await pool.query(`INSERT INTO harness.peer_backup_points(id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,
      manifest_digest,covered_count,gap_count,protected_through)
      SELECT $2,organization_id,$3,1,2,watermark,snapshot_id,manifest_digest,covered_count,0,now()
      FROM harness.peer_backup_points WHERE id=$1`,[f.point,secondPoint,secondPolicy])
    await pool.query(`INSERT INTO harness.peer_backup_work(id,organization_id,policy_id,revision,kind,node_id,point_id,status)
      VALUES($1,$2,$3,1,'drill',$4,$5,'confirmed')`,[randomUUID(),f.org,secondPolicy,f.primary.nodeId,secondPoint])
    const planned=await recovery.request(f.adminId,{requestId:randomUUID(),policyId:secondPolicy,pointId:secondPoint,
      targetNode:f.primary.nodeId,targetVolume:secondVolume,recoveryMode:'planned'})
    expect((await recovery.get(planned)).executionTransfer).toEqual({operationId:id,reviewId:review,sha256:'e'.repeat(64),oldSessionCount:2})
    expect((await pool.query('SELECT FROM harness.project_recovery_execution_holds WHERE operation_id=$1',[planned])).rowCount).toBe(0)
    await expect(transaction(pool,async tx=>{
      await tx.query(TAKEOVER_RESTORE_PREFIX)
      await tx.query('ALTER TABLE harness.project_recovery_execution_transfers DISABLE TRIGGER immutable_recovery_execution_transfer')
      await tx.query('DELETE FROM harness.project_recovery_execution_transfers WHERE operation_id=$1',[planned])
      await tx.query(TAKEOVER_RESTORE_SUFFIX)
    })).rejects.toThrow('Execution transfer authority differs')
    await expect(pool.query('UPDATE harness.project_recovery_execution_transfers SET source_review_id=$2 WHERE operation_id=$1',[planned,randomUUID()]))
      .rejects.toThrow('immutable')
    await recovery.cancel(f.adminId,planned)
    await recovery.acknowledgeCleanup(await recovery.get(planned))
    const second=await recovery.request(f.adminId,{requestId:randomUUID(),policyId:secondPolicy,pointId:secondPoint,
      targetNode:f.primary.nodeId,targetVolume:secondVolume,recoveryMode:'disaster'})
    const generation=(await pool.query('SELECT generation::text n FROM harness.instances WHERE runtime_id=$1',[f.runtimeId])).rows[0].n
    await acceptSyntheticRecoveryCandidate(pool,second,'f'.repeat(64),'f'.repeat(64),24100)
    await recovery.confirmIsolation(f.adminId,second,{confirm:second,policyRevision:1,sourceGeneration:generation,sourceEpoch:'2',
      sourceNodeId:f.target,pointId:secondPoint,isolationMethod:'power-off',evidenceReference:'console/second-loss',acknowledgeDataLoss:true})
    await pool.query(`UPDATE harness.project_recovery_operations SET phase='disaster-ready',
      target_files_digest=$2,target_schedule_digest=$2,target_port_base=24100 WHERE id=$1`,[second,'f'.repeat(64)])
    await recovery.activate(f.adminId,second)
    await pool.query('UPDATE harness.project_recovery_operations SET target_activated_at=now() WHERE id=$1',[second])
    expect((await pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[f.org,f.runtimeId,f.primary.nodeId])).rows[0].allowed).toBe(false)
    await service.prepare(f.adminId,second,{confirm:second})
    const nextReview=randomUUID()
    await pool.query(`INSERT INTO harness.project_recovery_execution_reviews(id,operation_id,organization_id,runtime_id,target_node_id,
      target_epoch,point_id,policy_digest,composition_digest,old_session_count,items)
      VALUES($1,$2,$3,$4,$5,3,$6,$7,$7,3,'[]')`,[nextReview,second,f.org,f.runtimeId,f.primary.nodeId,secondPoint,'f'.repeat(64)])
    await pool.query(`UPDATE harness.project_recovery_execution_requests SET status='ready',review_id=$2 WHERE operation_id=$1`,[second,nextReview])
    await service.enable(f.adminId,second,{confirm:second,reviewRevision:nextReview,mode:'new-conversations-only'})
    expect((await pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[f.org,f.runtimeId,f.primary.nodeId])).rows[0].allowed).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM harness.project_recovery_execution_holds WHERE runtime_id=$1',[f.runtimeId])).rows[0].n).toBe(2)
    await pool.query('UPDATE harness.deployment_topology SET enabled=false,revision=revision+1 WHERE organization_id=$1',[f.org])
    expect((await service.listLocal(f.adminId)).items.map(row=>row.id)).toEqual([second])
    expect((await service.listLocal(f.adminId,second)).items).toEqual([])
    await expect(service.status(f.adminId,id)).rejects.toMatchObject({code:'peer-backup/execution-target-not-local'})
    await expect(service.prepare(f.adminId,id,{confirm:id})).rejects.toMatchObject({code:'peer-backup/execution-target-not-local'})
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2',[f.org,f.primary.nodeId])
    await expect(service.prepare(f.adminId,second,{confirm:second})).rejects.toMatchObject({code:'peer-backup/project-owner-unavailable'})
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2',[f.org,f.primary.nodeId])
    await service.prepare(f.adminId,second,{confirm:second})
    const singleReview=randomUUID()
    await pool.query(`INSERT INTO harness.project_recovery_execution_reviews(id,operation_id,organization_id,runtime_id,target_node_id,
      target_epoch,point_id,policy_digest,composition_digest,old_session_count,items)
      SELECT $2,operation_id,organization_id,runtime_id,target_node_id,target_epoch,point_id,policy_digest,composition_digest,old_session_count,$3
      FROM harness.project_recovery_execution_reviews WHERE id=$1`,[nextReview,singleReview,JSON.stringify([item])])
    await pool.query(`UPDATE harness.project_recovery_execution_requests SET status='ready',review_id=$2 WHERE operation_id=$1`,[second,singleReview])
    await service.enable(f.adminId,second,{confirm:second,reviewRevision:singleReview,mode:'new-conversations-only'})
    expect((await service.status(f.adminId,second)).status).toBe('new-conversations-enabled')
    await service.approveItem(f.adminId,second,item.id,{confirm:second,reviewRevision:singleReview,itemDigest:item.itemDigest,evidenceReference:'single/local-review'})
    expect((await service.status(f.adminId,second)).preparationStatus).toBe('queued')
  })
})
