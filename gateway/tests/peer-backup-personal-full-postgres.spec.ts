/** Native personal files, real encrypted transfer and current-authority publication; no Runtime task is started or stopped. */
import { createHash,randomBytes,randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cp,mkdir,readFile,readdir,rename,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe,expect,it } from 'vitest'
import { personalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { createPostgresPool,transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { NodeContentStore } from '../src/node-content-store.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import { PeerBackupRepository } from '../src/peer-backup-repository.ts'
import { PeerBackupRestic,type PeerBackupExporter } from '../src/peer-backup-restic.ts'
import { documentIdentityLocations } from '../src/document-storage.ts'
import { PeerPersonalFiles } from '../src/peer-backup-personal-files.ts'
import { PeerPersonalExporter,readPersonalRecoveryPoint } from '../src/peer-backup-personal.ts'
import { PeerPersonalRecovery } from '../src/peer-backup-personal-recovery.ts'
import { PeerPersonalRecoveryFiles } from '../src/peer-backup-personal-target.ts'
import { runPersonalRecoveryPhase } from '../src/peer-backup-personal-recovery-worker.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { recoveryExecutionDataRoots } from '../src/peer-backup-execution-data.ts'
import { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { InstanceManager } from '../src/instances.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { testConfig } from './test-config.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const thirdNode=process.env.HGW_TEST_RECOVERY_THIRD_NODE==='1'
const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),restic=process.env.HGW_TEST_RESTIC

describe.skipIf(!url||!restic)('complete encrypted personal replacement',()=>{
  it('keeps old root and child inboxes, restores shared documents and tab drafts, and separately approves new conversations',async()=>{
    await personalNativeFixture(async f=>{
      const {control,root,org,account,runtime,userId,signal,limits}=f
      const primaryId=randomUUID(),receiver=f.binding.targetNodeId,target=thirdNode?randomUUID():receiver,targetVolume=randomUUID(),database='personal_target_'+randomUUID().replaceAll('-','')
      const targetUrl=new URL(url!);targetUrl.pathname='/'+database
      await control.query(`CREATE DATABASE "${database}"`)
      const content=createPostgresPool(targetUrl.href,{max:3}),server=createServer()
      let repository:PeerBackupRepository|undefined
      try{
        for(const [id,name]of[[primaryId,'primary'],[target,'target'],...(thirdNode?[[receiver,'receiver']]:[])])await control.query('INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,$3)',[id,org,name])
        await control.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(organization_id,user_id) DO UPDATE SET role='admin'",[org,account])
        await control.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'private-fixture',false)",[account])
        for(const node of[f.node,target,primaryId])await control.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING',[org,node,account])
        await control.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1) ON CONFLICT DO NOTHING',[org])
        await control.query("UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,primary_origin='https://fixture.test' WHERE organization_id=$1",[org,primaryId])
        for(const node of[f.node,target,...(thirdNode?[receiver]:[])])await control.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,platform,architecture,connection_id,connection_epoch,lease_expires_at)
          VALUES($1,$2,$3,$4,'x64',$5,1,now()+interval '5 minutes')`,[org,node,randomBytes(32),process.platform,randomUUID()])
        const primary=await resolvePostgresRuntimeContext(control,org,'primary'),source=await resolvePostgresRuntimeContext(control,org,'Source'),destination=await resolvePostgresRuntimeContext(control,org,'target')
        const options={pool:content,organizationId:org,nodeId:target,volumeId:targetVolume,dataDirectory:process.env.HGW_TEST_NODE_CONTENT_PGDATA!,proofTimeoutMs:5000}
        await migrateNodeContent(options,resolve(import.meta.dirname,'../deploy/node-content/migrations'))
        const volume=await NodeContentStore.open(options);await volume.registerVolume(control)
        const receiverContext=thirdNode?await resolvePostgresRuntimeContext(control,org,'receiver'):destination
        if(thirdNode)await publishRecoveryProtocol(control,org,receiver,300000,{project:false,personal:false})
        await publishRecoveryProtocol(control,org,target,300000,{project:false,personal:true})
        const receiverGovernance=new PeerBackupGovernance(receiverContext)
        const admin=new PeerBackupGovernance(primary,60000,300000),sourceGovernance=new PeerBackupGovernance(source),targetGovernance=new PeerBackupGovernance(destination)
        const append=randomUUID(),read=randomUUID(),passwordFile=join(root,'restic-password')
        await writeFile(passwordFile,randomUUID(),{mode:0o600})
        const policy=await admin.configure(userId,{id:f.binding.policyId,expectedRevision:0,sourceNodeId:f.node,targetNodeId:receiver,scopeKind:'personal',scopeId:runtime,
          tier:'important',quotaBytes:64<<20,appendFingerprint:hash(append),recoveryFingerprint:hash(thirdNode?'legacy-reader-'+randomUUID():read),enabled:true})
        repository=await PeerBackupRepository.open({directory:join(root,'receiver'),nodeId:receiver,capacityBytes:128<<20,objectLimit:256,maxObjectBytes:32<<20,concurrency:2,
          grant:(id,user,token)=>receiverGovernance.grant(id,user,token)})
        server.on('request',(req,res)=>{void(async()=>{
          const [user,token]=Buffer.from((req.headers.authorization??'').slice(6),'base64').toString().split(':')
          if(!user||!token){res.writeHead(403).end();return}
          await repository!.handle(req,res,await receiverGovernance.grant(policy.policyId,user,token))
        })().catch(()=>{if(!res.headersSent)res.writeHead(403);res.end()})})
        await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
        const origin='http://127.0.0.1:'+String((server.address() as AddressInfo).port)
        const engine=new PeerBackupRestic({executable:restic!,stagingDirectory:join(root,'encrypted-stage'),uploadKiBps:8192,downloadKiBps:8192,
          timeoutMs:50000,maxRestoreBytes:limits.maxBytes,reserveBytes:limits.reserveBytes})
        // The fixture owns the immutable native payload; validation uses the installed Session and UserDoc readers on every drill.
        const exporter:PeerBackupExporter={capture:async(_binding,directory)=>{await cp(f.payload,directory,{recursive:true});return f.captured},
          validate:async(binding,capture,directory,lifetime)=>{await readPersonalRecoveryPoint(binding,capture,directory,limits,lifetime)}}
        const jobId=await admin.enqueue(userId,policy.policyId,'capture'),job=await sourceGovernance.claim()
        expect(job?.id).toBe(jobId)
        const point=await engine.backup(policy,{origin,user:f.node,token:append,passwordFile},exporter,jobId,signal)
        await sourceGovernance.finish(job!,{point})
        if(thirdNode)await admin.approveRead(userId,policy.policyId,{id:randomUUID(),expectedRevision:policy.revision,pointId:point.pointId,recoveryNodeId:target,fingerprint:hash(read),expiresAt:new Date(Date.now()+240000).toISOString()})
        await admin.enqueue(userId,policy.policyId,'drill',point.pointId,target)
        const drillJob=await targetGovernance.claim(),drill=()=>engine.drill(policy,point.pointId,{origin,user:thirdNode?target:f.node,token:read,passwordFile},exporter,signal)
        const checked=await drill();await targetGovernance.finish(drillJob!,{recoveryMs:checked.recoveryMs});await checked.dispose()
        const cfg=testConfig(join(root,'replacement'));for(const path of[cfg.usersRoot,cfg.stateRoot])await mkdir(path,{recursive:true,mode:0o700})
        const service=new PeerPersonalRecovery(primary),targetService=new PeerPersonalRecovery(destination,cfg.instancePortBase),files=new PeerPersonalRecoveryFiles(destination,cfg,volume,limits)
        const id=await service.request(userId,{requestId:randomUUID(),policyId:policy.policyId,pointId:point.pointId,targetNode:target,targetVolume})
        const worker={service:targetService,files,gate:new PeerProjectFileGate(cfg.stateRoot,'personal-document-handoff'),drill}
        const manager=new InstanceManager(new PostgresInstanceRepository(destination,cfg.instancePortBase),cfg,{instancesOutliveGateway:false,
          start:async()=>{throw new Error('Review must not start a process')},attach:()=>{throw new Error('Review must not attach a process')}})
        const execution=new PeerRecoveryExecution({context:destination,config:cfg,personal:{service:targetService,paths:op=>files.paths(op),oldSessions:op=>files.oldSessions(op)},
          maxRows:limits.maxRows,maxBytes:limits.maxBytes,prepareProfile:selected=>manager.prepareRecoveryProfile(selected)})
        const management=new PeerRecoveryExecution({context:primary,personal:{service,paths:op=>files.paths(op),oldSessions:op=>files.oldSessions(op)}})
        const oldSessions=await readFile(join(f.payload,'personal-recovery.json'),'utf8')
        const sessionFiles=await readdir(join(f.home,'sessions'),{recursive:true,withFileTypes:true})
        const beforeBytes=await Promise.all(sessionFiles.filter(row=>row.isFile()).map(async row=>({
          path:join(row.parentPath,row.name).slice(join(f.home,'sessions').length+1),sha:hash(await readFile(join(row.parentPath,row.name),'base64'))})))
        let sourceRemoved=false
        const advance=async()=>{
          if((await service.get(id)).phase==='activating'&&!sourceRemoved){await rename(f.volume,join(root,'unavailable-source'));sourceRemoved=true}
          await runPersonalRecoveryPhase(worker,signal)
        }
        const withLocalMode=async(exercise:()=>Promise<void>)=>{
          await transaction(control,async tx=>{
            expect((await tx.query("SELECT FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2 AND (observed_state<>'stopped' OR desired_state<>'stopped' OR runtime_token_hash IS NOT NULL)",[org,target])).rowCount).toBe(0)
            await tx.query("UPDATE harness.node_agents SET attachment_state='detached',credential_hash=NULL,connection_id=NULL,connection_epoch=connection_epoch+1,lease_expires_at=NULL,revoked_at=now(),revision=revision+1 WHERE organization_id=$1 AND node_id=$2",[org,target])
            await tx.query('UPDATE harness.deployment_topology SET enabled=false,revision=revision+1 WHERE organization_id=$1',[org])
          })
          try{await exercise()}finally{await transaction(control,async tx=>{
            await tx.query('UPDATE harness.deployment_topology SET enabled=true,revision=revision+1 WHERE organization_id=$1',[org])
            await tx.query("UPDATE harness.node_agents SET attachment_state='managed',credential_hash=$3,connection_id=$4,connection_epoch=connection_epoch+1,lease_expires_at=now()+interval '5 minutes',revoked_at=NULL,revision=revision+1 WHERE organization_id=$1 AND node_id=$2",[org,target,randomBytes(32),randomUUID()])
          })}
        }
        if(process.env.HGW_TEST_PERSONAL_RECOVERY_UI==='1'){
          const ui=await import('./peer-backup-personal-recovery-ui.ts')
          await ui.exercisePersonalRecoveryUi({primary,targetContext:destination,adminId:userId,policyId:policy.policyId,pointId:point.pointId,
            operationId:id,root,advance,executionService:execution,withLocalMode})
        }else{
          await advance()
          expect(await service.status(userId,id)).toMatchObject({phase:'prepared',lastError:null})
          const before=await service.get(id)
          await service.confirmIsolation(userId,id,{confirm:id,sourceNodeId:f.node,sourceGeneration:before.sourceGeneration,sourceEpoch:before.oldEpoch,pointId:point.pointId,
            policyRevision:policy.revision,isolationMethod:'power-off',evidenceReference:'fixture/source-power-off',acknowledgeDataLoss:true})
          await service.activate(userId,id);await advance()
          expect(await service.status(userId,id)).toMatchObject({phase:'published',lastError:null,executionReviewRequired:true})
          await management.prepare(userId,id,{confirm:id});await execution.prepareNext(signal)
          const review=await management.status(userId,id)
          expect(review,JSON.stringify(review)).toMatchObject({preparationStatus:'ready',blockers:[],oldSessionCount:2})
          await management.enable(userId,id,{confirm:id,reviewRevision:review.reviewRevision,mode:'new-conversations-only'})
        }
        const op=await service.get(id),paths=await files.paths(op)
        expect(await management.status(userId,id)).toMatchObject({status:'new-conversations-enabled'})
        expect(await files.oldSessions(op)).toEqual(['old-child','old-root'])
        expect(oldSessions).toContain('old-child')
        for(const file of beforeBytes)expect(hash(await readFile(join(paths.home,'sessions',file.path),'base64'))).toBe(file.sha)
        expect(await readFile(join(paths.cwd,'work.txt'),'utf8')).toBe('original work\n')
        expect(await readFile(join(cfg.usersRoot,'owner','home','documents','document.txt'),'utf8')).toBe('important document\n')
        const drafts=new DatabaseSync(join(cfg.stateRoot,'node-content-drafts','drafts.sqlite'),{readOnly:true})
        try{const rows=drafts.prepare('SELECT identity,text FROM drafts ORDER BY text').all();expect(rows.map(row=>row.text)).toEqual(['draft-tab-a','draft-tab-b']);expect(rows.every(row=>String(row.identity).includes(target))).toBe(true)}finally{drafts.close()}
        const managed=await recoveryExecutionDataRoots(destination,cfg.stateRoot,runtime)
        expect(managed.some(row=>row.owner==='gateway-personal-recovery/'+id)).toBe(true)
        expect(managed.some(row=>row.owner.startsWith('gateway-recovery-execution/'))).toBe(true)
        const launch=await new PostgresInstanceRepository(destination,cfg.instancePortBase).personalPolicy(userId,undefined,runtime as import('../src/runtime-catalog.ts').RuntimeId)
        expect(launch?.runtimeId).toBe(runtime)
        // Removing backup provisioning cannot remove the hold or silently bypass installed policy verification.
        const bareGateway=await createPeerBackupGateway({context:destination,config:cfg})
        const accountRow=await new PostgresUserService(destination,cfg).getById(userId)
        if(!accountRow||!launch)throw new Error('Recovered account must retain its full user and Runtime assignment')
        const runtimeContext={kind:'user' as const,ownerId:userId,target:{kind:'user' as const,id:userId,runtimeId:runtime as import('../src/runtime-catalog.ts').RuntimeId},
          generation:Number(op.newEpoch)+1,user:{...accountRow,...launch},username:'owner',runtimeKey:'owner',systemUser:'harness-owner',privileged:true,port:49020,homePath:launch!.homePath,dshHome:paths.home}
        expect(await bareGateway.beforeRuntimeStart(runtimeContext)).toMatchObject({policyFile:expect.any(String),policySha256:expect.any(String)})
        const accountHome=launch!.homePath,documentPaths=await documentIdentityLocations(cfg,accountHome,join(accountHome,'documents'),
          {organizationId:org,target:{kind:'user',id:userId},projectionOwner:async()=>{throw new Error('Published identity must not be re-created')}})
        const snapshotConfig=join(root,'target-native.json'),targetRoot=join(root,'replacement')
        await writeFile(snapshotConfig,JSON.stringify({version:1,organizationId:org,nodeId:target,provider:'btrfs',runtimes:[
          {runtimeId:runtime,source:targetRoot,snapshotDirectory:root,workspaces:[{id:'work',path:paths.cwd}]}]}),{mode:0o600})
        const protectedFiles=new PeerPersonalFiles(control,snapshotConfig,1000,async()=>({homePath:accountHome,dshHome:paths.home}),async()=>documentPaths,
          async()=>({root:targetRoot,map:path=>path,confirm:async()=>{},release:async()=>{}}))
        const protectedExporter=new PeerPersonalExporter(control,cfg.stateRoot,limits,control,protectedFiles,volume)
        const nextBinding={...f.binding,sourceNodeId:target,targetNodeId:primaryId,policyId:randomUUID()},nextPayload=join(root,'replacement-checkpoint')
        await mkdir(nextPayload)
        const nextCapture=await protectedExporter.capture(nextBinding,nextPayload,signal)
        expect(nextCapture.gaps).toEqual([])
        const nextProof=await readPersonalRecoveryPoint(nextBinding,nextCapture,nextPayload,limits,signal)
        expect(nextProof.recovery.oldSessionIds).toEqual(['old-child','old-root'])
        expect(nextProof.roots.roots.filter(row=>row.role==='recovery-private').length).toBe(managed.length)
        expect((await control.query('SELECT desired_state,observed_state,generation::text FROM harness.instances WHERE runtime_id=$1',[runtime])).rows[0])
          .toEqual({desired_state:'stopped',observed_state:'stopped',generation:op.newEpoch})
      }finally{
        server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await repository?.close();await content.end()
        await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      }
    })
  },90000)
})
