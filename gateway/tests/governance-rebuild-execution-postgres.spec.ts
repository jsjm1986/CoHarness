/** Real retained files and kernel ownership proof feed the shared node-local recovery execution engine. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile,rename,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import { personalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { testConfig } from './test-config.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'
import { transaction } from '../src/postgres/database.ts'
import { TAKEOVER_RESTORE_PREFIX,TAKEOVER_RESTORE_SUFFIX } from '../src/peer-backup-takeover-restore-guard.ts'
import { InstanceManager } from '../src/instances.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { LocalRuntimeOwnerStore } from '../src/local-runtime-owner.ts'
import { localKernelBootId } from '../src/local-runtime-protocol.ts'
import { nodeControlPaths } from '../src/node-control-paths.ts'
import { recoveryExecutionDataRoots } from '../src/peer-backup-execution-data.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_NODE_CONTENT_PGDATA)('binds the existing selected home and freezes old root/child history before new-conversation approval',async()=>{
  await personalNativeFixture(async f=>{
    const lost=randomUUID(),primary=randomUUID(),operation=randomUUID(),runtimeOperation=randomUUID()
    await f.control.query("INSERT INTO harness.compute_nodes(id,organization_id,name,status) VALUES($1,$3,'Lost primary','offline'),($2,$3,'Replacement','active')",[lost,primary,f.org])
    await f.control.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[f.org,f.account])
    await f.control.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture-qualified',false)",[f.account])
    await f.control.query(`INSERT INTO harness.cluster_control(organization_id) VALUES($1)`,[f.org])
    await f.control.query(`UPDATE harness.deployment_topology SET primary_node_id=$2 WHERE organization_id=$1`,[f.org,primary])
    await f.control.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
      schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains,state,released_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,1,1,1,$7,'power-off','fixture physical isolation','[]','released',clock_timestamp())`,
    [operation,f.org,lost,primary,randomUUID(),'0'.repeat(64),f.account])
    await f.control.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
      VALUES($1,$2,$3,$4,$5,'user',$6,$7,$7)`,[runtimeOperation,operation,f.org,f.runtime,f.node,f.account,f.generation])
    await f.control.query(`INSERT INTO harness.governance_rebuild_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)`,[runtimeOperation,f.org,f.runtime])
    await f.control.query("UPDATE harness.instances SET observed_state='ready' WHERE runtime_id=$1",[f.runtime])
    const selected=join(f.accountHome,'selected-runtime');await rename(f.home,selected)
    await writeFile(join(selected,'.env'),'BUSINESS_SETTING=retained\n',{mode:0o600})
    const cfg=testConfig(f.volume,{HGW_COMPUTE_NODE_NAME:'Source'}),context=await resolvePostgresRuntimeContext(f.control,f.org,'Source')
    const repository=new PostgresInstanceRepository(context,cfg.instancePortBase),manager=new InstanceManager(repository,cfg)
    const gateway=new GovernanceRebuildGateway({context,config:cfg,volume:f.store,limits:f.limits,pageSize:100,
      assertStopped:target=>manager.assertRuntimeQuiescent(target),prepareProfile:target=>manager.prepareRecoveryProfile(target)})
    repository.resolveLocalPaths=target=>gateway.adapter.localPaths(target)
    const target={kind:'user' as const,id:f.userId,runtimeId:f.runtime as RuntimeId}
    const owner=new LocalRuntimeOwnerStore(nodeControlPaths(cfg.stateRoot).localRuntime,{node:cfg.computeNodeName,kind:'user',ownerId:f.userId,
      runtimeKey:'owner',generation:f.generation,credentialHash:'a'.repeat(64)})
    const lease=await owner.acquire(),record=await lease.create(await localKernelBootId())
    try{
      await expect(manager.storageOf(target)).rejects.toMatchObject({code:'peer-backup/governance-local-binding-required'})
      await expect(gateway.adapter.bindLocal(f.userId,runtimeOperation,{confirm:runtimeOperation,selection:{homePath:f.accountHome,runtimeHome:selected}},f.signal)).rejects.toMatchObject({code:expect.stringMatching(/^E(?:AGAIN|WOULDBLOCK)$/u)})
      expect((await f.control.query('SELECT observed_state FROM harness.instances WHERE runtime_id=$1',[f.runtime])).rows[0].observed_state).toBe('ready')
      expect((await f.control.query('SELECT FROM harness.governance_rebuild_data_bindings WHERE runtime_operation_id=$1',[runtimeOperation])).rowCount).toBe(0)
      expect((await f.control.query('SELECT status,error_code FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1',[runtimeOperation])).rows[0])
        .toEqual({status:'failed',error_code:'peer-backup/governance-local-binding-failed'})
      await lease.publish({...record,phase:'stopped'});await lease.close()
      await gateway.adapter.bindNext(f.signal)
      expect((await f.control.query('SELECT FROM harness.governance_rebuild_data_bindings WHERE runtime_operation_id=$1',[runtimeOperation])).rowCount).toBe(0)
      expect((await f.control.query('SELECT status FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1',[runtimeOperation])).rows[0].status).toBe('failed')
      const forwarded=createServer((req,res)=>{void gateway.admin(req,res,f.userId,{directLocal:false,signal:f.signal}).catch(()=>res.writeHead(500).end())})
      await new Promise<void>(done=>forwarded.listen(0,'127.0.0.1',done))
      try{
        const address=forwarded.address();if(!address||typeof address==='string')throw new Error('Local rejection fixture did not listen')
        const response=await fetch('http://127.0.0.1:'+address.port+'/admin/api/governance-recovery/local')
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({error:'peer-backup/governance-local-target-required'})
      }finally{forwarded.closeAllConnections();await new Promise<void>((done,reject)=>forwarded.close(error=>error?reject(error):done()))}
      expect(await gateway.review.localStatus(f.userId)).toMatchObject({localOnly:true,localNodeId:f.node,
        runtimes:[{id:runtimeOperation,runtimeId:f.runtime,nodeId:f.node}]})
      await expect(gateway.review.status(f.userId)).rejects.toMatchObject({code:'peer-backup/governance-replacement-entry-required'})
      await f.control.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2',[f.org,f.node])
      await expect(gateway.review.localStatus(f.userId)).rejects.toMatchObject({code:'peer-backup/governance-local-computer-permission-required'})
      await expect(gateway.adapter.bindLocal(f.userId,runtimeOperation,{confirm:runtimeOperation,selection:{homePath:f.accountHome,runtimeHome:selected}},f.signal))
        .rejects.toMatchObject({code:'peer-backup/governance-local-computer-permission-required'})
      await f.control.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND node_id=$2',[f.org,f.node])
      if(process.env.HGW_TEST_GOVERNANCE_REBUILD_UI==='1'){
        const {exerciseGovernanceLocalUi}=await import('./governance-rebuild-local-ui.ts')
        await exerciseGovernanceLocalUi({gateway,adminId:f.userId,operationId:operation,runtimeReviewId:runtimeOperation,root:f.state,
          homePath:f.accountHome,runtimeHome:selected,advance:()=>gateway.execution.prepareNext(f.signal)})
      }else await gateway.adapter.bindLocal(f.userId,runtimeOperation,{confirm:runtimeOperation,selection:{homePath:f.accountHome,runtimeHome:selected}},f.signal)
      expect((await f.control.query('SELECT observed_state FROM harness.instances WHERE runtime_id=$1',[f.runtime])).rows[0].observed_state).toBe('stopped')
      expect(await manager.storageOf(target)).toMatchObject({homePath:f.accountHome,dshHome:selected,runtimeKey:'owner'})
      const binding=(await f.control.query<{binding_id:string}>('SELECT binding_id FROM harness.governance_rebuild_data_bindings WHERE runtime_operation_id=$1',[runtimeOperation])).rows[0]!
      expect(await recoveryExecutionDataRoots(context,f.state,f.runtime)).toContainEqual({owner:'gateway-governance-binding/'+binding.binding_id,kind:'file',path:join(f.state,'governance-rebuild-local',runtimeOperation,binding.binding_id+'.json')})
      const previousRecoveryFiles=await recoveryExecutionDataRoots(context,f.state,f.runtime)
      await gateway.execution.prepare(f.userId,runtimeOperation,{confirm:runtimeOperation})
      await gateway.execution.prepareNext(f.signal)
      const review=await gateway.execution.status(f.userId,runtimeOperation)
      expect(review,JSON.stringify(review)).toMatchObject({preparationStatus:'ready',blockers:[],oldSessionCount:2})
      await gateway.execution.enable(f.userId,runtimeOperation,{confirm:runtimeOperation,reviewRevision:review.reviewRevision,mode:'new-conversations-only'})
      expect((await gateway.execution.status(f.userId,runtimeOperation)).status).toBe('new-conversations-enabled')
      const policy=JSON.parse(await readFile(join(f.state,'recovery-execution',runtimeOperation,review.reviewRevision+'.json'),'utf8'))
      expect(policy.oldSessionIds).toEqual(['old-child','old-root'])
      const recoveryFiles=await recoveryExecutionDataRoots(context,f.state,f.runtime)
      expect(recoveryFiles).toHaveLength(previousRecoveryFiles.length+1)
      expect(recoveryFiles).toEqual(expect.arrayContaining(previousRecoveryFiles))
      expect(recoveryFiles.filter(file=>!previousRecoveryFiles.some(previous=>previous.path===file.path)))
        .toEqual([{owner:'gateway-recovery-execution/'+review.reviewRevision,kind:'file',path:join(f.state,'recovery-execution',runtimeOperation,review.reviewRevision+'.json')}])
      await expect(readFile(join(f.home,'profiles','web','package.json'))).rejects.toMatchObject({code:'ENOENT'})
      await gateway.execution.verifySubject({organizationId:f.org,target,generation:f.generation,userInternalId:f.account})
      await expect(gateway.execution.verifySubject({organizationId:f.org,target,generation:f.generation,userInternalId:randomUUID()})).rejects.toMatchObject({code:'peer-backup/execution-review-changed'})
      await transaction(f.control,async tx=>{await tx.query(TAKEOVER_RESTORE_PREFIX);await tx.query(TAKEOVER_RESTORE_SUFFIX)})
      await expect(transaction(f.control,async tx=>{
        await tx.query(TAKEOVER_RESTORE_PREFIX)
        await tx.query("UPDATE harness.governance_rebuild_binding_requests SET status='failed' WHERE runtime_operation_id=$1",[runtimeOperation])
        await tx.query(TAKEOVER_RESTORE_SUFFIX)
      })).rejects.toThrow('Restore would change governance rebuilding authority')
      const stable=await readFile(join(selected,'profiles','web','cordis.patch.yml'),'utf8')
      await writeFile(join(selected,'profiles','web','cordis.patch.yml'),'[{"id":"agent","config":{"fixtureChanged":true}}]\n')
      await expect(gateway.execution.verifySubject({organizationId:f.org,target,generation:f.generation,userInternalId:f.account})).rejects.toMatchObject({code:'peer-backup/execution-profile-changed'})
      await writeFile(join(selected,'profiles','web','cordis.patch.yml'),stable)
      const second=randomUUID(),secondRuntime=randomUUID()
      await f.control.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
        schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains,state,released_at,created_at)
        SELECT $2,organization_id,source_node_id,target_node_id,$3,manifest_digest,schema_digest,source_watermark,source_topology_revision,2,bootstrap_user_id,
          isolation_method,evidence_reference,unrestored_domains,state,released_at,created_at-interval '1 day' FROM harness.governance_rebuild_operations WHERE id=$1`,[operation,second,randomUUID()])
      await f.control.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
        SELECT $2,$3,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch FROM harness.governance_rebuild_runtimes WHERE id=$1`,[runtimeOperation,secondRuntime,second])
      await f.control.query(`INSERT INTO harness.governance_rebuild_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)`,[secondRuntime,f.org,f.runtime])
      expect(await gateway.adapter.selectHold(f.runtime)).toBe(secondRuntime)
      await expect(gateway.execution.verifySubject({organizationId:f.org,target,generation:f.generation,userInternalId:f.account})).rejects.toMatchObject({code:'peer-backup/execution-review-required'})
      await expect(manager.storageOf(target)).rejects.toMatchObject({code:'peer-backup/governance-local-binding-required'})
      await f.control.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
        schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains)
        SELECT $2,organization_id,source_node_id,target_node_id,$3,manifest_digest,schema_digest,source_watermark,source_topology_revision,3,bootstrap_user_id,
          isolation_method,evidence_reference,unrestored_domains FROM harness.governance_rebuild_operations WHERE id=$1`,[operation,randomUUID(),randomUUID()])
      await expect(gateway.review.localStatus(f.userId)).rejects.toMatchObject({code:'peer-backup/governance-review-required'})
    }finally{await lease.close();await manager.stopAll(true)}
  })
},120000)
