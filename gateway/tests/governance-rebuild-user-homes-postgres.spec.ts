/** Restored account documents follow accepted local evidence without storing business paths in governance. */
import { randomUUID } from 'node:crypto'
import { cp,mkdir,readFile,rename,rmdir,stat,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect,it } from 'vitest'
import { personalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { testConfig } from './test-config.ts'
import { GovernanceRebuildLocalData,type GovernanceLocalDataProof } from '../src/governance-rebuild-local-data.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { LocalDocumentBroker } from '../src/documents-local.ts'
import { documentIdentityLocations } from '../src/document-storage.ts'
import { personalRuntimeLayout } from '../src/runtime-layout.ts'
import { openPersonalIndex } from '../src/personal-index-worker.ts'
import { PostgresRuntimeManagement } from '../src/runtime-management.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolveGovernanceLocalPaths } from '../src/governance-rebuild-local-paths.ts'
import { InstanceManager } from '../src/instances.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import type { RuntimeNodeId,RuntimeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_NODE_CONTENT_PGDATA)('keeps one account home across restored Runtimes and refuses documents without accepted local evidence',async()=>{
  await personalNativeFixture(async f=>{
    const source=randomUUID(),operation=randomUUID(),runtimeOperation=randomUUID(),context=await resolvePostgresRuntimeContext(f.control,f.org,'Source')
    await f.control.query("INSERT INTO harness.compute_nodes(id,organization_id,name,status) VALUES($1,$2,'Lost entry','offline')",[source,f.org])
    await f.control.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
      schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains,state,released_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,1,1,1,$7,'power-off','fixture isolation','[]','released',clock_timestamp())`,
    [operation,f.org,source,f.node,randomUUID(),'0'.repeat(64),f.account])
    await f.control.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
      VALUES($1,$2,$3,$4,$5,'user',$6,$7,$7)`,[runtimeOperation,operation,f.org,f.runtime,f.node,f.account,f.generation])
    await f.control.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'unused-fixture-password',false)",[f.account])
    const placeholder='governance-recovery-unbound:'+f.account
    await f.control.query('UPDATE harness.users SET home_path=$2 WHERE id=$1',[f.account,placeholder])
    await f.control.query('UPDATE harness.node_user_accounts SET home_path=$3 WHERE user_id=$1 AND node_id=$2',[f.account,f.node,placeholder])
    await writeFile(join(f.home,'.env'),'BUSINESS_SETTING=keep-business\nPGP_TEST=keep-signing\n',{mode:0o600})
    const cfg=testConfig(f.volume),local=new GovernanceRebuildLocalData(context,cfg,{limits:f.limits,volume:f.store})
    const users=new PostgresUserService(context,cfg)
    users.resolveLocalHomes=ids=>local.accountHomes(ids)
    await f.control.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[f.org,f.account])
    const management=new PostgresRuntimeManagement(context,cfg),allocationRequest={requestId:randomUUID()}
    management.resolveLocalHomes=ids=>local.accountHomes(ids)
    const actor=(await users.getById(f.userId))!
    expect(actor.homeNodeId).toBeUndefined()
    const broker=new LocalDocumentBroker({cfg,nodeId:context.nodeId as RuntimeNodeId,organizationId:f.org,users,
      projects:{getById:async()=>null},collaboration:{projectForUser:async()=>null},computerAccess:{authorize:async()=>{}}})
    try{
      await expect(broker.listDocuments(actor,{kind:'personal'},new URLSearchParams(),f.signal)).rejects.toMatchObject({status:403})
      await expect(management.allocate(actor,f.userId,allocationRequest)).rejects.toMatchObject({code:'runtime-management/local-home-binding-required'})
      expect((await f.control.query('SELECT count(*)::integer n FROM harness.instances WHERE organization_id=$1',[f.org])).rows[0].n).toBe(1)
      expect((await f.control.query('SELECT count(*)::integer n FROM harness.runtime_allocation_receipts WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0)
      await expect(stat(resolve(placeholder))).rejects.toMatchObject({code:'ENOENT'})
      await expect(stat(join(f.users,'owner','home'))).rejects.toMatchObject({code:'ENOENT'})
      const accepted=await local.bind(runtimeOperation,{homePath:f.accountHome},f.signal)
      const accept=async(id:string,runtime:string,proof:GovernanceLocalDataProof)=>f.control.query(`INSERT INTO harness.governance_rebuild_data_bindings(
        runtime_operation_id,organization_id,runtime_id,node_id,binding_id,evidence_digest,old_session_count,source_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,f.org,runtime,f.node,proof.bindingId,proof.evidenceDigest,proof.oldSessionCount,proof.sourceGeneration])
      await accept(runtimeOperation,f.runtime,accepted)
      for(const user of [(await users.getById(f.userId))!, (await users.getByUsername('owner'))!, (await users.getListedById(f.userId))!,...(await users.list())]){
        expect(user).toMatchObject({homePath:f.accountHome,homeNodeId:f.node})
      }
      expect((await f.control.query('SELECT home_path FROM harness.node_user_accounts WHERE user_id=$1 AND node_id=$2',[f.account,f.node])).rows[0].home_path).toBe(placeholder)
      const locations=await documentIdentityLocations(cfg,f.accountHome,join(f.accountHome,'documents'),{
        organizationId:f.org,target:{kind:'user',id:f.userId},projectionOwner:async()=>null,
      })
      // The native fixture owns a separate private UserDoc layout; preserve its exact identities in the broker's ordinary layout.
      await rename(join(f.state,'doc-metadata'),locations.stateRoot)
      await rmdir(locations.filesRoot)
      await rename(join(f.state,'doc-objects'),locations.filesRoot)
      const listed=await broker.listDocuments(actor,{kind:'personal'},new URLSearchParams(),f.signal)
      expect(listed.status).toBe(200)
      expect(JSON.stringify(listed.body)).toContain('document.txt')
      const identities=new DatabaseSync(join(locations.stateRoot,'metadata.sqlite'),{readOnly:true})
      try{expect(identities.prepare('SELECT root_id FROM document_identity_root WHERE slot=1').get()?.root_id).toBe(f.proof.documents.rootId)}finally{identities.close()}

      const second=randomUUID(),secondOperation=randomUUID()
      await f.control.query('UPDATE harness.runtime_allocation_policies SET max_per_node=3,max_total=4 WHERE organization_id=$1 AND user_id IS NULL',[f.org])
      await f.control.query("INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,$4,49024,'isolated')",[second,f.org,f.account,f.node])
      await f.control.query('INSERT INTO harness.personal_directory_placement VALUES($1,$2,$3,$4)',[second,f.org,f.node,f.account])
      const generation=String((await f.control.query('SELECT generation FROM harness.instances WHERE runtime_id=$1',[second])).rows[0].generation)
      await f.control.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,$7)`,[secondOperation,operation,f.org,second,f.node,f.account,generation])
      const secondHome=personalRuntimeLayout(cfg,{username:'owner',runtimeId:second as RuntimeId,storageLayout:'isolated'}).dshHome
      await cp(f.home,secondHome,{recursive:true})
      const directory=new DatabaseSync(join(f.state,'personal-directory','index.sqlite'))
      try{openPersonalIndex(directory)({op:'publish',owner:{organizationId:f.org,nodeId:f.node,runtimeId:second,userId:f.userId},input:{generation:Number(generation),snapshot:{revision:1,
        items:[{workspaceId:'work',title:'Work',path:f.workspace,sessionIds:['old-root'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}],conversations:[]}}})}finally{directory.close()}
      expect((await users.getById(f.userId))!.homePath).toBe(f.accountHome)
      const allocated=await management.allocate(actor,f.userId,allocationRequest)
      expect(allocated.status).toBe('allocated')
      const allocatedHome=personalRuntimeLayout(cfg,{username:'owner',runtimeId:allocated.runtimeId,storageLayout:'isolated'}).dshHome
      expect(await readFile(join(allocatedHome,'managed-data.jsonl'),'utf8')).toContain(join(f.accountHome,'documents'))
      expect(await management.allocate(actor,f.userId,allocationRequest)).toEqual(allocated)
      const repository=new PostgresInstanceRepository(context,cfg.instancePortBase)
      repository.resolveLocalPaths=target=>resolveGovernanceLocalPaths(context,local,target)
      const resources=new NodeResourceBudget(f.control,f.org,f.node,cfg.resourceBudget)
      const processOwner=await GatewayModelBudget.open(resources,join(f.root,'gateway-owners'))
      let launches=0
      const manager=new InstanceManager(repository,cfg,{instancesOutliveGateway:false,start:async()=>{launches++;throw new Error('Stopped fixture cannot launch')}},undefined,resources,processOwner)
      try{
        const ordinary={kind:'user' as const,id:f.userId,runtimeId:allocated.runtimeId}
        expect(await manager.storageOf(ordinary)).toMatchObject({homePath:f.accountHome,dshHome:allocatedHome})
        expect((await manager.storageOf(ordinary)).retainedData).toBeUndefined()
        const policy=await repository.personalPolicy(f.userId,undefined,allocated.runtimeId)
        expect(policy?.homePath).toBe(f.accountHome)
        expect(policy?.dshHome).toBeUndefined()
        const conflict=join(f.volume,'other-account-home');await mkdir(conflict,{mode:0o700})
        await expect(local.bind(secondOperation,{homePath:conflict},f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-account-home-conflict'})
        const secondBinding=await local.bind(secondOperation,{homePath:f.accountHome},f.signal)
        await accept(secondOperation,second,secondBinding)
        expect((await users.list()).find(user=>user.id===f.userId)!.homePath).toBe(f.accountHome)
        const evidence=join(f.state,'governance-rebuild-local',secondOperation,secondBinding.bindingId+'.json'),original=await readFile(evidence,'utf8')
        await writeFile(evidence,original+' ',{mode:0o600})
        await expect(users.getById(f.userId)).rejects.toMatchObject({code:'peer-backup/governance-local-binding-changed'})
        await expect(broker.listDocuments(actor,{kind:'personal'},new URLSearchParams(),f.signal)).rejects.toMatchObject({status:503})
        await writeFile(evidence,original,{mode:0o600})
        expect((await users.getById(f.userId))!.homePath).toBe(f.accountHome)
        await expect(stat(join(f.users,'owner','home'))).rejects.toMatchObject({code:'ENOENT'})
        const instances=(await f.control.query('SELECT desired_state,runtime_token_hash FROM harness.instances WHERE organization_id=$1',[f.org])).rows
        expect(instances).toHaveLength(3)
        for(const instance of instances)expect(instance).toEqual({desired_state:'stopped',runtime_token_hash:null})
        for(const runtimeId of [f.runtime,second]){
          await manager.withStopped({kind:'user',id:f.userId,runtimeId:runtimeId as RuntimeId},async lease=>{
            await management.retire(actor,f.userId,lease!)
          },actor.id)
        }
        expect((await users.getById(f.userId))!.homePath).toBe(f.accountHome)
        expect((await broker.listDocuments(actor,{kind:'personal'},new URLSearchParams(),f.signal)).status).toBe(200)
        expect(await manager.storageOf(ordinary)).toMatchObject({homePath:f.accountHome,dshHome:allocatedHome})
        expect((await manager.storageOf(ordinary)).retainedData).toBeUndefined()
        await expect(local.verify(runtimeOperation,accepted)).rejects.toMatchObject({code:'peer-backup/governance-local-identity-mismatch'})
        await expect(manager.storageOf({kind:'user',id:f.userId,runtimeId:f.runtime as RuntimeId})).rejects.toThrow()
        expect(launches).toBe(0)
        expect((await f.control.query('SELECT count(*)::integer n FROM harness.instances WHERE organization_id=$1',[f.org])).rows[0].n).toBe(1)
      }finally{await manager.stopAll();await processOwner.close()}
    }finally{await broker.dispose()}
  })
})
