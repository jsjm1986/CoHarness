/** Restore a real encrypted recovery point with the source pool closed and its temporary business files removed. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { runPeerRecoveryPhase } from '../src/peer-backup-takeover-worker.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { projectReplacementLayout } from '../src/peer-backup-takeover-layout.ts'
import { recoveryBinding } from '../src/peer-backup-takeover.ts'
import type { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { GatewayConfig } from '../src/config.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import type { InstanceManager } from '../src/instances.ts'
import type { PeerBackupRestic } from '../src/peer-backup-restic.ts'
import { PeerBackupGovernance, type PeerBackupPolicy } from '../src/peer-backup-governance.ts'
import type { PeerPoint } from '../src/peer-backup-repository.ts'
import type { PeerProjectExporter } from '../src/peer-backup-project-export.ts'
import { testConfig } from './test-config.ts'
import { createRecoveryExecutionFixture } from './peer-backup-execution-fixture.ts'
import { exportRecoveryExecutionData, recoveryExecutionDataRoots, verifyRecoveryExecutionData } from '../src/peer-backup-execution-data.ts'
import { createPostgresPool, transaction } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
interface Input {
  primary:PostgresRuntimeContext;b:PostgresRuntimeContext;cfg:GatewayConfig;next:NodeContentStore;root:string;
  projectA:PeerProjectRecovery;projectB:PeerProjectRecovery;manager:InstanceManager;admin:number;
  intent:{requestId:string;pointId:string;policyId:string;targetNode:string;targetVolume:string};
  engine:PeerBackupRestic;policy:PeerBackupPolicy;point:PeerPoint;origin:string;passwordFile:string;read:string;readerAccess?:()=>{user:string;token:string};approveReader?:(revision:number)=>Promise<void>;exporter:PeerProjectExporter;
  limits:{maxBytes:number;maxRows:number;reserveBytes:number};signal:AbortSignal;session:string;rootId:string;legacyIsolated?:boolean;
}
/** Run target workers and governance with no access to the lost source files or store.
 * @param input - independently captured and drilled disposable deployment resources.
 */
export async function runDisasterRecovery(input:Input):Promise<void> {
  const {primary,b,next,projectA,projectB,admin,root,limits,signal}=input
  const cfg=testConfig(join(root,'disaster-replacement'))
  for(const path of [cfg.projectsRoot,cfg.userProjectsRoot,cfg.projectRuntimesRoot,cfg.stateRoot]) await mkdir(path,{recursive:true,mode:0o700})
  const id=input.legacyIsolated?input.intent.requestId:await projectA.request(admin,{...input.intent,recoveryMode:'disaster'})
  let readPolicy=input.policy
  const dependencies={service:projectB,volume:next,instances:input.manager,limits,
    workGate:new PeerProjectFileGate(cfg.stateRoot,'peer-project-recovery-work'),
    layout:(op:Awaited<ReturnType<PeerProjectRecovery['get']>>)=>projectReplacementLayout(cfg,b,op),
    drill:()=>input.engine.drill(readPolicy,input.point.pointId,{origin:input.origin,...(input.readerAccess?.()??{user:input.policy.sourceNodeId,token:input.read}),passwordFile:input.passwordFile},input.exporter,signal)}
  if(!input.legacyIsolated){await runPeerRecoveryPhase(dependencies,signal);expect((await projectA.status(admin,id)).phase).toBe('prepared')}
  else expect(await projectA.get(id)).toMatchObject({phase:'externally-fenced',repositoryNode:input.policy.targetNodeId,targetVerifiedAt:null,scheduleDigest:null,filesDigest:null})
  const starts=(await primary.pool.query("SELECT count(*)::int count FROM harness.instances WHERE organization_id=$1 AND (generation>1 OR desired_state='running')",[primary.organizationId])).rows[0].count
  expect(starts).toBe(0)
  expect((await next.readVolume(tx=>tx.query('SELECT FROM node_content.recovery_candidates WHERE operation_id=$1',[id]))).rowCount).toBe(input.legacyIsolated?0:1)
  const before=await projectA.status(admin,id)
  if(!input.legacyIsolated)await projectA.confirmIsolation(admin,id,{confirm:id,policyRevision:before.policyRevision,sourceGeneration:before.sourceGeneration,sourceEpoch:before.sourceEpoch,
    sourceNodeId:before.sourceNodeId,pointId:before.pointId,evidenceReference:'console/evidence/'+randomUUID(),isolationMethod:'power-off',acknowledgeDataLoss:true})
  const governance=new PeerBackupGovernance(primary),targetGovernance=new PeerBackupGovernance(b)
  const settings={id:input.policy.policyId,scopeKind:input.policy.scopeKind,scopeId:input.policy.scopeId,sourceNodeId:input.policy.sourceNodeId,
    targetNodeId:input.policy.targetNodeId,tier:input.policy.tier,quotaBytes:input.policy.quotaBytes,
    appendFingerprint:createHash('sha256').update('unusable-old-source-append').digest('hex'),recoveryFingerprint:createHash('sha256').update(input.readerAccess?.().user===b.nodeId ? 'legacy-reader-'+randomUUID() : input.read).digest('hex')}
  const disabled=await governance.configure(admin,{...settings,expectedRevision:input.policy.revision,enabled:false})
  await runPeerRecoveryPhase(dependencies,signal)
  expect((await projectA.status(admin,id)).phase).toBe('externally-fenced')
  readPolicy=await governance.configure(admin,{...settings,expectedRevision:disabled.revision,enabled:true})
  await input.approveReader?.(readPolicy.revision)
  await expect(governance.enqueue(admin,input.policy.policyId,'capture')).rejects.toMatchObject({code:'peer-backup/node-not-admitted'})
  await expect(projectA.reapprove(admin,id,readPolicy.revision,'externally-fenced')).rejects.toMatchObject({code:'peer-backup/current-revision-drill-required'})
  await governance.enqueue(admin,input.policy.policyId,'drill',input.point.pointId,b.nodeId)
  const job=await targetGovernance.claim()
  if(!job || job.kind!=='drill') throw new Error('Missing independent current-policy drill')
  const currentDrill=await dependencies.drill()
  await targetGovernance.finish(job,{recoveryMs:currentDrill.recoveryMs})
  await currentDrill.dispose()
  await projectA.reapprove(admin,id,readPolicy.revision,'externally-fenced')
  await runPeerRecoveryPhase(dependencies,signal)
  const ready=await projectA.status(admin,id)
  expect(ready).toMatchObject({phase:'disaster-ready',lastError:null,schedulesSuspended:true,executionReviewRequired:true})
  const suspendedKeys=['DATABASE_URL','DSH_GATEWAY_CREDENTIAL_FD','HGW_NODE_TOKEN','PGHOST','PGPASSWORD']
  expect(ready.suspendedEnvironmentKeys).toEqual(suspendedKeys)
  const op=await projectA.get(id),binding=recoveryBinding(op,'target')
  const workspace=(await next.readVolume(tx=>tx.query('SELECT cwd FROM node_content.conversation_sessions WHERE runtime_id=$1 AND id=$2',[op.runtimeId,input.session]))).rows[0].cwd
  expect(await readFile(join(workspace,'documents','report.txt'),'utf8')).toBe('bytes to recover\n')
  const storage=join(cfg.projectRuntimesRoot,String(op.publicId),'dsh','storages')
  const recoveredEnvironment=await readFile(join(storage,'..','.env'),'utf8')
  expect(recoveredEnvironment).not.toContain('retired-')
  expect(recoveredEnvironment).not.toContain('DSH_GATEWAY_CREDENTIAL_FD')
  expect(recoveredEnvironment).toContain('PGP_RECIPIENT="preserved"')
  expect(recoveredEnvironment).toContain('BUSINESS_SETTING="preserved"')
  await expect(primary.pool.query("UPDATE harness.project_recovery_operations SET suspended_environment_keys='[]' WHERE id=$1",[id])).rejects.toThrow()
  const tasks=JSON.parse(await readFile(join(storage,'schedule.json'),'utf8')).tables.tasks as Record<string,{status:string}>
  expect(Object.keys(tasks).length).toBeGreaterThan(0)
  expect(Object.values(tasks).every(task=>task.status==='inactive')).toBe(true)
  await projectA.activate(admin,id)
  await runPeerRecoveryPhase(dependencies,signal)
  expect(await projectA.status(admin,id)).toMatchObject({phase:'published',executionReviewRequired:true,lastError:null})
  expect((await projectA.status(admin,id)).targetActivatedAt).toBeTruthy()
  expect((await primary.pool.query('SELECT enabled,revision,target_node_id FROM harness.peer_backup_policies WHERE id=$1',[input.policy.policyId])).rows[0])
    .toEqual({enabled:false,revision:readPolicy.revision+1,target_node_id:input.policy.targetNodeId})
  const reader=input.readerAccess?.()??{user:input.policy.sourceNodeId,token:input.read}
  await expect(governance.grant(input.policy.policyId,reader.user,reader.token)).rejects.toBeTruthy()
  expect(await next.read(binding,async tx=>(await tx.query('SELECT root_id FROM node_content.document_roots WHERE runtime_id=$1',[op.runtimeId])).rows[0].root_id)).toBe(input.rootId)
  expect((await primary.pool.query('SELECT source_schedule_digest,source_files_digest FROM harness.project_recovery_operations WHERE id=$1',[id])).rows[0]).toEqual({source_schedule_digest:null,source_files_digest:null})
  await expect(primary.pool.query("UPDATE harness.instances SET desired_state='running',observed_state='starting',generation=generation+1 WHERE runtime_id=$1",[op.runtimeId]))
    .rejects.toMatchObject({constraint:'runtime_recovery_review'})
  const single=createPostgresPool(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)!,{max:1})
  let beforePrepare:(()=>Promise<void>)|undefined
  try {
    const target={...b,pool:single}
    const execution=await createRecoveryExecutionFixture({primary,target,volume:next,cfg,operationId:id,beforePrepare:async()=>{await beforePrepare?.()}})
    if(process.env.HGW_TEST_DISASTER_EXECUTION_UI==='1') {
      const ui=await import('./peer-backup-execution-ui.ts')
      const withLocalMode=async(exercise:()=>Promise<void>)=>{
        // This fixture owns synthetic node connections; SQL still enforces stopped writers and topology transitions.
        await transaction(primary.pool,async tx=>{
          expect((await tx.query(`SELECT FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2
            AND (observed_state<>'stopped' OR desired_state<>'stopped' OR runtime_token_hash IS NOT NULL)`,[op.organizationId,b.nodeId])).rowCount).toBe(0)
          await tx.query(`UPDATE harness.node_agents SET attachment_state='detached',credential_hash=NULL,connection_id=NULL,
            connection_epoch=connection_epoch+1,lease_expires_at=NULL,revoked_at=now(),revision=revision+1 WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,b.nodeId])
          await tx.query('UPDATE harness.deployment_topology SET enabled=false,revision=revision+1 WHERE organization_id=$1',[op.organizationId])
        })
        try {await exercise()} finally {
          await transaction(primary.pool,async tx=>{
            await tx.query('UPDATE harness.deployment_topology SET enabled=true,revision=revision+1 WHERE organization_id=$1',[op.organizationId])
            await tx.query(`UPDATE harness.node_agents SET attachment_state='managed',credential_hash=$3,connection_id=$4,
              connection_epoch=connection_epoch+1,lease_expires_at=now()+interval '5 minutes',revoked_at=NULL,revision=revision+1
              WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,b.nodeId,randomBytes(32),randomUUID()])
          })
        }
      }
      await ui.exerciseRecoveryExecutionUi({primary,targetContext:target,targetService:execution.targetService,
        operationId:id,adminId:admin,root,withLocalMode})
    }
    await execution.adminService.prepare(admin,id,{confirm:id})
    let rivalCalls=0
    const rival=new PeerRecoveryExecution({context:target,config:cfg,volume:next,prepareProfile:async()=>{rivalCalls++}})
    const paused=()=>{
      let notify!:()=>void,finish!:()=>void
      const entered=new Promise<void>(resolve=>{notify=resolve}),release=new Promise<void>(resolve=>{finish=resolve})
      beforePrepare=async()=>{await single.query('SELECT 1');notify();await release}
      return {entered,release:()=>{beforePrepare=undefined;finish()}}
    }
    let wait=paused(),working=execution.targetService.prepareNext(signal)
    try {
      expect(await Promise.race([wait.entered.then(()=>true),working.then(()=>false)])).toBe(true)
      await expect(primary.pool.query("UPDATE harness.instances SET desired_state='running' WHERE runtime_id=$1",[op.runtimeId]))
        .rejects.toMatchObject({constraint:'runtime_recovery_review'})
      await rival.prepareNext(signal)
      expect(rivalCalls).toBe(0)
      expect((await execution.adminService.status(admin,id)).preparationStatus).toBe('queued')
    } finally {wait.release();await working}
    await execution.adminService.prepare(admin,id,{confirm:id})
    wait=paused();working=execution.targetService.prepareNext(signal)
    try {
      expect(await Promise.race([wait.entered.then(()=>true),working.then(()=>false)])).toBe(true)
      await primary.pool.query('UPDATE harness.project_recovery_execution_requests SET request_id=$2 WHERE operation_id=$1',[id,randomUUID()])
    } finally {wait.release();await working}
    expect((await execution.adminService.status(admin,id)).preparationStatus).toBe('queued')
    await execution.targetService.prepareNext(signal)
    const review=await execution.adminService.status(admin,id)
    expect(review).toMatchObject({preparationStatus:'ready',status:'review-required',blockers:[]})
    expect(review.oldSessionCount).toBeGreaterThan(0)
    expect(review.reviewRevision).toBeTruthy()
    await execution.adminService.enable(admin,id,{confirm:id,reviewRevision:review.reviewRevision,mode:'new-conversations-only'})
    expect((await primary.pool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[op.organizationId,op.runtimeId,op.targetNode])).rows[0].allowed).toBe(true)
    const runtime={kind:'project' as const,ownerId:op.publicId,username:'project-'+op.publicId,runtimeKey:'project-'+op.publicId,
      systemUser:cfg.projectRuntimeUser,port:cfg.instancePortBase+op.publicId,homePath:workspace,dshHome:execution.home,generation:1,
      target:{kind:'project' as const,id:op.publicId,runtimeId:op.runtimeId}}
    const permit=await execution.targetService.beforeStart(runtime)
    expect(permit).toBeTruthy()
    const bareGateway=await createPeerBackupGateway({context:target,config:cfg,nodeContent:next})
    try {expect(await bareGateway.beforeRuntimeStart(runtime)).toEqual(permit)} finally {await bareGateway.close()}
    const sealed=JSON.parse(await readFile(permit!.policyFile,'utf8'))
    expect(sealed.oldSessionIds).toContain(input.session)
    expect(createHash('sha256').update(await readFile(permit!.policyFile)).digest('hex')).toBe(permit!.policySha256)
    const executionBackup=join(root,'execution-policy-backup')
    await mkdir(executionBackup,{mode:0o700})
    const budget=()=>({bytes:limits.maxBytes,rows:limits.maxRows})
    expect(await exportRecoveryExecutionData(primary.pool,binding,cfg.stateRoot,executionBackup,budget(),signal)).toBeGreaterThan(0)
    await verifyRecoveryExecutionData(executionBackup,op.runtimeId,b.nodeId,budget(),signal)
    expect((await recoveryExecutionDataRoots(b,cfg.stateRoot)).some(file=>file.path===permit!.policyFile)).toBe(true)
    const held=permit!.policyFile+'.held'
    await rename(permit!.policyFile,held)
    try {
      await expect(recoveryExecutionDataRoots(b,cfg.stateRoot)).rejects.toMatchObject({code:'peer-backup/execution-policy-missing'})
      await expect(execution.targetService.beforeStart(runtime)).rejects.toMatchObject({code:'peer-backup/execution-policy-missing'})
    } finally {await rename(held,permit!.policyFile)}
    await writeFile(join(executionBackup,'recovery-execution',review.reviewRevision+'.json'),'{}\n')
    await expect(verifyRecoveryExecutionData(executionBackup,op.runtimeId,b.nodeId,budget(),signal))
      .rejects.toMatchObject({code:'peer-backup/execution-policy-missing'})
    expect((await primary.pool.query('SELECT observed_state,desired_state FROM harness.instances WHERE runtime_id=$1',[op.runtimeId])).rows[0])
      .toEqual({observed_state:'stopped',desired_state:'stopped'})
    if(process.env.HGW_TEST_RECOVERY_PLANNED_TRANSFER==='1') {
      const {runPlannedExecutionTransfer}=await import('./peer-backup-planned-execution-full.ts')
      await runPlannedExecutionTransfer({primary,source:b,volume:next,cfg,op,engine:input.engine,passwordFile:input.passwordFile,root,
        admin,signal,limits})
    }
  } finally {await single.end()}
  const transcript=[{phase:input.legacyIsolated?'externally-fenced':'prepared',unselectedRuntimeStarts:starts,stagedBeforeIsolation:!input.legacyIsolated},
    {phase:'disaster-ready',sourceAvailable:false,fileRestored:true,schedules:'inactive'},
    {phase:'published',writerEpoch:op.newEpoch,execution:'new-conversations-permitted',history:'read-only',sourceEvidence:'unavailable'}].map(row=>JSON.stringify(row)).join('\n')+'\n'
  expect(transcript).toBe(await readFile(new URL(input.legacyIsolated?'./expected/peer-backup-disaster-legacy.jsonl':'./expected/peer-backup-disaster.jsonl',import.meta.url),'utf8'))
}
