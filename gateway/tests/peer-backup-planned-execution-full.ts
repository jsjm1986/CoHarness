/** Real encrypted planned relocation of a disaster-recovered project, with a fresh target execution review. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { expect } from 'vitest'
import type { GatewayConfig } from '../src/config.ts'
import { documentIdentityLocations } from '../src/document-storage.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { InstanceManager } from '../src/instances.ts'
import { NodeContentStore } from '../src/node-content-store.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { NodeProjectMetadata } from '../src/node-content-projects.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { latestPeerFileWitness } from '../src/peer-backup-file-digest.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { PeerProjectExporter, type PeerProjectFileSnapshots } from '../src/peer-backup-project-export.ts'
import { PeerBackupRepository, PEER_REPOSITORY_PREFIX } from '../src/peer-backup-repository.ts'
import type { PeerBackupRestic } from '../src/peer-backup-restic.ts'
import { PeerProjectRecovery, recoveryBinding, type PeerRecoveryOperation } from '../src/peer-backup-takeover.ts'
import { stagePeerProjectFiles } from '../src/peer-backup-takeover-files.ts'
import { projectReplacementLayout } from '../src/peer-backup-takeover-layout.ts'
import { PeerRecoveryStageRoots } from '../src/peer-backup-takeover-reservations.ts'
import { runPeerRecoveryPhase } from '../src/peer-backup-takeover-worker.ts'
import type { PeerFileRootMap } from '../src/peer-snapshot-roots.ts'
import { createPostgresPool } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { createRecoveryExecutionFixture } from './peer-backup-execution-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

/** Keep pre-disaster history frozen while a later ordinary conversation survives a real planned move.
 * @param input - already activated isolated disaster recovery with a reviewed source policy.
 */
export async function runPlannedExecutionTransfer(input:{primary:PostgresRuntimeContext;source:PostgresRuntimeContext;
  volume:NodeContentStore;cfg:GatewayConfig;op:PeerRecoveryOperation;engine:PeerBackupRestic;passwordFile:string;root:string;
  admin:number;signal:AbortSignal;limits:{maxBytes:number;maxRows:number;reserveBytes:number}}):Promise<void> {
  const {primary,source,volume,cfg,op,limits,signal,admin,root}=input
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const database='hgw_transfer_'+randomUUID().replaceAll('-',''),url=new URL(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)!)
  await primary.pool.query('CREATE DATABASE "'+database+'"')
  url.pathname='/'+database
  const pool=createPostgresPool(url.href,{max:3}),destination=testConfig(join(root,'planned-after-disaster'))
  let owner:GatewayModelBudget|undefined,repository:PeerBackupRepository|undefined
  const server=createServer()
  try {
    const options={pool,organizationId:op.organizationId,nodeId:primary.nodeId,volumeId:randomUUID(),
      dataDirectory:process.env.HGW_TEST_NODE_CONTENT_PGDATA!,proofTimeoutMs:5000}
    await migrateNodeContent(options,resolve(import.meta.dirname,'../deploy/node-content/migrations'))
    const next=await NodeContentStore.open(options)
    await next.registerVolume(primary.pool)
    for(const path of [destination.stateRoot,destination.projectRuntimesRoot,destination.projectsRoot,destination.userProjectsRoot]) await mkdir(path,{recursive:true,mode:0o700})
    await primary.pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      SELECT $1,$2,id,true FROM harness.users WHERE organization_id=$1 AND public_id=$3 ON CONFLICT DO NOTHING`,[op.organizationId,primary.nodeId,admin])
    const binding=recoveryBinding(op,'target'),home=join(cfg.projectRuntimesRoot,String(op.publicId),'dsh')
    const space=await volume.read(binding,async tx=>(await tx.query('SELECT root_path FROM node_content.spaces WHERE runtime_id=$1',[op.runtimeId])).rows[0])
    const workspace=space.root_path as string,storage=join(home,'storages')
    const docs=await documentIdentityLocations(cfg,workspace,join(workspace,'documents'),{organizationId:op.organizationId,
      target:{kind:'project',id:op.publicId},projectionOwner:async()=>{throw new Error('Existing document identity expected')}})
    const rootId=await volume.read(binding,async tx=>(await tx.query('SELECT root_id FROM node_content.document_roots WHERE runtime_id=$1',[op.runtimeId])).rows[0].root_id)
    const governanceReview=process.env.HGW_TEST_RECOVERY_GOVERNANCE_TRANSFER==='1'
      ?await (await import('./governance-rebuild-planned-fixture.ts')).prepareGovernancePlannedFixture(input):undefined
    const ordinary='after-disaster-'+randomUUID()
    await volume.write(binding,async tx=>{await tx.query(`INSERT INTO node_content.conversation_sessions
      (organization_id,runtime_id,id,creator_user_id,project_id,root_session_id,visibility,session_format_version,created_at,updated_at,cwd)
      SELECT organization_id,runtime_id,$2,creator_user_id,project_id,$2,visibility,session_format_version,now(),now(),cwd
      FROM node_content.conversation_sessions WHERE runtime_id=$1 LIMIT 1`,[op.runtimeId,ordinary])})
    const scheduleBefore=await readFile(join(storage,'schedule.json'))
    const sourceFiles:PeerProjectFileSnapshots={async acquire(b,revision){
      const roots:PeerFileRootMap['roots']=[['workspace',workspace],['runtime-data',storage],['userdoc-public',docs.root],
        ['userdoc-metadata',docs.stateRoot],['userdoc-objects',docs.filesRoot]].map(([role,path])=>({
          role:role as PeerFileRootMap['roots'][number]['role'],owner:role==='workspace'?'project-workspace':role==='runtime-data'?'project-runtime-storage':
            'gateway-documents/'+basename(docs.stateRoot)+'/'+{'userdoc-public':'public','userdoc-metadata':'metadata','userdoc-objects':'files'}[role!],
          kind:'directory',logicalRoot:path!,snapshotRoot:path!}))
      return {revision,capturedAt:new Date().toISOString(),logicalRoots:{version:1,organizationId:op.organizationId,projectId:b.projectId,
        runtimeId:b.runtimeId,sourceNodeId:b.nodeId,volumeId:b.volumeId,writerEpoch:b.writerEpoch,revision,documentRootId:rootId,provider:'btrfs',roots},
        roots:roots.map(r=>({owner:r.owner,kind:r.kind,path:r.logicalRoot})),gaps:[],async release(){}}
    },async validate(){throw new Error('Offline file validation expected')}}
    const exporter=new PeerProjectExporter({control:primary.pool,store:volume,files:sourceFiles,recoveryStateRoot:cfg.stateRoot,...limits})
    const adminService=new PeerBackupGovernance(primary),sourceGovernance=new PeerBackupGovernance(source)
    const append=randomUUID(),read=randomUUID(),policy=await adminService.configure(admin,{id:randomUUID(),expectedRevision:0,scopeKind:'project',
      scopeId:op.projectId,sourceNodeId:source.nodeId,targetNodeId:primary.nodeId,tier:'important',quotaBytes:64<<20,enabled:true,
      appendFingerprint:hash(append),recoveryFingerprint:hash(read)})
    repository=await PeerBackupRepository.open({directory:join(root,'planned-transfer-repository'),nodeId:primary.nodeId,capacityBytes:128<<20,
      objectLimit:2048,maxObjectBytes:32<<20,concurrency:2,grant:(id,user,token)=>adminService.grant(id,user,token)})
    server.on('request',(req,res)=>{void(async()=>{
      const [user,token]=Buffer.from((req.headers.authorization??'').slice(6),'base64').toString().split(':')
      if(!req.url?.startsWith(PEER_REPOSITORY_PREFIX)||!user||!token){res.writeHead(403).end();return}
      await repository!.handle(req,res,await adminService.grant(policy.policyId,user,token))
    })().catch(()=>{if(!res.headersSent)res.writeHead(403);res.end()})})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port
    const captureId=await adminService.enqueue(admin,policy.policyId,'capture'),job=await sourceGovernance.claim()
    if(!job || job.id!==captureId)throw new Error('Missing planned source capture')
    const point=await sourceGovernance.withLease(job,signal,(active,progress)=>input.engine.backup(policy,
      {origin,user:source.nodeId,token:append,passwordFile:input.passwordFile},exporter,captureId,active,progress))
    await sourceGovernance.finish(job,{point});expect(point.gapCount).toBe(0)
    await adminService.enqueue(admin,policy.policyId,'drill',point.pointId,primary.nodeId)
    const drillJob=await adminService.claim()
    if(!drillJob || drillJob.kind!=='drill')throw new Error('Missing independent planned drill')
    const drill=()=>input.engine.drill(policy,point.pointId,{origin,user:source.nodeId,token:read,passwordFile:input.passwordFile},exporter,signal)
    const checked=await drill()
    try{await adminService.finish(drillJob,{recoveryMs:checked.recoveryMs})}finally{await checked.dispose()}
    const gate=new PeerProjectFileGate(cfg.stateRoot),budget=new NodeResourceBudget(source.pool,op.organizationId,source.nodeId,cfg.resourceBudget)
    await budget.configure();owner=await GatewayModelBudget.open(budget,join(root,'planned-source-owner'))
    const manager=new InstanceManager(new PostgresInstanceRepository(source,cfg.instancePortBase,new NodeProjectMetadata(source,volume)),cfg,
      undefined,undefined,undefined,owner)
    const sourceService=new PeerProjectRecovery(source,volume,limits,cfg.instancePortBase,
      (operation,s)=>latestPeerFileWitness(exporter,policy,operation,join(root,'planned-current-files'),s),gate)
    const targetService=new PeerProjectRecovery(primary,next,limits,destination.instancePortBase,undefined,new PeerProjectFileGate(destination.stateRoot))
    const administration=new PeerProjectRecovery(primary)
    await publishRecoveryProtocol(primary.pool,op.organizationId,primary.nodeId,300000,{project:true,personal:false})
    if(governanceReview){
      await primary.pool.query("UPDATE harness.governance_rebuild_execution_requests SET status='failed' WHERE operation_id=$1",[governanceReview.operationId])
      await expect(administration.request(admin,{requestId:randomUUID(),policyId:policy.policyId,pointId:point.pointId,targetNode:primary.nodeId,
        targetVolume:options.volumeId,recoveryMode:'planned'})).rejects.toMatchObject({code:'peer-backup/execution-policy-migration-required'})
      expect((await primary.pool.query('SELECT assigned_node_id FROM harness.instances WHERE runtime_id=$1',[op.runtimeId])).rows[0].assigned_node_id).toBe(source.nodeId)
      await primary.pool.query("UPDATE harness.governance_rebuild_execution_requests SET status='ready' WHERE operation_id=$1",[governanceReview.operationId])
    }
    const id=await administration.request(admin,{requestId:randomUUID(),policyId:policy.policyId,
      pointId:point.pointId,targetNode:primary.nodeId,targetVolume:options.volumeId,recoveryMode:'planned'})
    const planned=await administration.get(id)
    expect(planned.executionTransfer).toBeTruthy()
    if(governanceReview)expect(planned.executionTransfer).toMatchObject(governanceReview)
    if(governanceReview){
      await expect(primary.pool.query(`UPDATE harness.project_recovery_operations SET phase='target-ready',target_verified_at=now(),
        target_schedule_digest=$2,target_files_digest=$2,target_port_base=24000 WHERE id=$1`,[id,'d'.repeat(64)]))
        .rejects.toMatchObject({constraint:'recovery_execution_transfer_protocol'})
      expect((await administration.status(admin,id)).phase).toBe('prepared')
    }
    expect((await primary.pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[op.organizationId,op.runtimeId,source.nodeId])).rows[0].allowed).toBe(true)
    const missing=await drill(),sourcePolicy=join(missing.directory,'project','recovery-execution',planned.executionTransfer!.reviewId+'.json')
    const stagedLayout=await projectReplacementLayout(destination,primary,planned),reservations=new PeerRecoveryStageRoots(next,planned)
    await rename(sourcePolicy,sourcePolicy+'.held')
    try {
      await expect(stagePeerProjectFiles(planned,missing,stagedLayout,limits,signal,reservations)).rejects.toMatchObject({code:'peer-backup/execution-policy-missing'})
      expect((await administration.status(admin,id)).phase).toBe('prepared')
      expect((await primary.pool.query('SELECT assigned_node_id,desired_state FROM harness.instances WHERE runtime_id=$1',[op.runtimeId])).rows[0])
        .toEqual({assigned_node_id:source.nodeId,desired_state:'stopped'})
    } finally {await rename(sourcePolicy+'.held',sourcePolicy);await reservations.withdraw();await missing.dispose()}
    const targetWorker={service:targetService,volume:next,instances:manager,limits,
      workGate:new PeerProjectFileGate(destination.stateRoot,'peer-project-recovery-work'),layout:(value:PeerRecoveryOperation)=>projectReplacementLayout(destination,primary,value),drill}
    await runPeerRecoveryPhase(targetWorker,signal)
    expect(await administration.status(admin,id)).toMatchObject({phase:'target-ready',lastError:null,executionPolicyTransferRequired:true})
    await administration.approveRetirement(admin,id)
    await sourceService.retireSource(id,admin,manager,signal)
    expect((await administration.status(admin,id)).phase).toBe('old-fenced')
    await administration.activate(admin,id);await runPeerRecoveryPhase(targetWorker,signal)
    expect(await administration.status(admin,id)).toMatchObject({phase:'published',executionReviewRequired:true,lastError:null})
    await expect(primary.pool.query("UPDATE harness.instances SET desired_state='running' WHERE runtime_id=$1",[op.runtimeId]))
      .rejects.toMatchObject({constraint:'runtime_recovery_review'})
    const execution=await createRecoveryExecutionFixture({primary,target:primary,volume:next,cfg:destination,operationId:id})
    await execution.adminService.prepare(admin,id,{confirm:id});await execution.targetService.prepareNext(signal)
    const review=await execution.adminService.status(admin,id)
    expect(review).toMatchObject({preparationStatus:'ready',status:'review-required',blockers:[]})
    await execution.adminService.enable(admin,id,{confirm:id,reviewRevision:review.reviewRevision,mode:'new-conversations-only'})
    const targetOp=await administration.get(id),stored=JSON.parse(await readFile(join(destination.stateRoot,'recovery-execution',id,review.reviewRevision+'.json'),'utf8'))
    const original=JSON.parse(await readFile(join(cfg.stateRoot,'recovery-execution',planned.executionTransfer!.operationId,planned.executionTransfer!.reviewId+'.json'),'utf8'))
    expect(stored.oldSessionIds).toEqual(original.oldSessionIds)
    expect(stored.oldSessionIds).not.toContain(ordinary)
    expect(stored.approvedItems).toEqual([])
    expect(stored.writerEpoch).toBe(targetOp.newEpoch)
    expect(await readFile(join(execution.home,'storages','schedule.json'))).toEqual(scheduleBefore)
    expect(await readFile(join(storage,'schedule.json'))).toEqual(scheduleBefore)
    await expect(volume.write(binding,async()=>true)).rejects.toThrow()
    expect((await primary.pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[op.organizationId,op.runtimeId,primary.nodeId])).rows[0].allowed).toBe(true)
    const result=JSON.stringify({phase:(await administration.status(admin,id)).phase,writerEpoch:stored.writerEpoch,
      frozenSessions:stored.oldSessionIds.length,laterConversationReadOnly:stored.oldSessionIds.includes(ordinary),
      inheritedComponentApprovals:stored.approvedItems.length,schedules:'unchanged',previousWriter:'rejected'})+'\n'
    expect(result).toBe(await readFile(new URL('./expected/peer-backup-planned-execution.jsonl',import.meta.url),'utf8'))
  } finally {
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()))
    await repository?.close();await owner?.close();await pool.end()
    await primary.pool.query('DROP DATABASE "'+database+'"')
  }
}
