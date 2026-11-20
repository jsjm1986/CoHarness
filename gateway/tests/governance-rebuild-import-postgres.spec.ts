/** Fresh database reconstruction keeps admission closed until reviewed, including the real restricted entry. */
import { createServer } from 'node:http'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,readFile,realpath,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { expect,it } from 'vitest'
import { createPostgresPool,runMigrations } from '../src/postgres/database.ts'
import { importGovernanceRebuild } from '../src/governance-rebuild-import.ts'
import { PeerGovernanceRebuildExporter } from '../src/peer-governance-rebuild-export.ts'
import { readGovernanceRebuildPackage } from '../src/peer-governance-rebuild-validation.ts'
import { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'
import { testConfig } from './test-config.ts'
import { verifyPassword } from '../src/password.ts'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { publishRecoveryProtocol } from '../src/peer-backup-recovery-access.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { GOVERNANCE_REBUILD_SCHEMA_VERSION,governanceRebuildInventory,governanceRebuildSafeColumns,type GovernanceRebuildManifest,type GovernanceRebuildRecord } from '../src/peer-governance-rebuild-manifest.ts'

const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const historicalDigests = new Map([
  [135, 'e9676310059367d8348d7696617006344b6d330c57bc45b4220be1d23683fa7b'],
  [142, 'fd7049d884dd1df330a4140ab8ffc09bfd0c7af19cb57f6df0afb61839366ef7'],
  [143, '9f441b2c745143ea68d2a7bc9f6457d50570a1e6ab4f36bcf75b77905ada0f93'],
])

it.skipIf(databaseUrl===undefined).each([135,136,137,138,142,143,144,145])('rebuilds schema-%s evidence into a current empty database with closed node/runtime admission',async sourceVersion=>{
  const url=databaseUrl!,pool=createPostgresPool(url),roots:string[]=[]
  const targetName='governance_rebuild_'+randomUUID().replaceAll('-',''),migrations=resolve(import.meta.dirname,'../deploy/postgres/migrations')
  let target:ReturnType<typeof createPostgresPool>|undefined,created=false
  try{
    await runMigrations(pool,migrations)
    const f=await disasterRecoveryFixture(pool,roots,true),payload=join(await realpath(roots[0]!),'payload')
    await mkdir(payload,{mode:0o700})
    await pool.query('UPDATE harness.deployment_topology SET revision=1 WHERE organization_id=$1',[f.org])
    await publishRecoveryProtocol(pool,f.org,f.target,300000,{project:true,personal:true})
    const account=(await pool.query<{id:string}>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[f.org,f.adminId])).rows[0]!.id
    const member=(await pool.query<{id:string}>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
      VALUES($1,'closed-member','Member','/private/old-home') RETURNING id`,[f.org])).rows[0]!.id
    await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')`,[f.org,member])
    await pool.query(`INSERT INTO harness.password_credentials(user_id,password_hash) VALUES($1,'old-password')`,[member])
    await pool.query(`UPDATE harness.instances SET desired_state='running',observed_state='ready' WHERE runtime_id=$1`,[f.runtimeId])
    const retainedRecovery=await f.insert('prepared')
    if(sourceVersion===142)await pool.query('DELETE FROM harness.cluster_control WHERE organization_id=$1',[f.org])
    const limits={maxBytes:4<<20,maxRows:3000},signal=AbortSignal.timeout(60000)
    await new PeerGovernanceRebuildExporter(pool,limits).capture({organizationId:f.org,sourceNodeId:f.context.nodeId,targetNodeId:f.target,
      scopeId:f.org,policyId:randomUUID(),revision:1},payload,signal)
    let selectedPayload=payload
    if(sourceVersion<GOVERNANCE_REBUILD_SCHEMA_VERSION){
      const inventory=governanceRebuildInventory(sourceVersion)!,manifest:GovernanceRebuildManifest=JSON.parse(await readFile(join(payload,'governance-rebuild.json'),'utf8'))
      const previousDigest=historicalDigests.get(sourceVersion)
      if(previousDigest!==undefined)expect(inventory.digest).toBe(previousDigest)
      expect(manifest.files).toEqual([])
      const rows=(await readFile(join(payload,'governance-rebuild.jsonl'),'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line) as GovernanceRebuildRecord)
      const bytes=rows.map(record=>JSON.stringify({table:record.table,row:Object.fromEntries(governanceRebuildSafeColumns(record.table,sourceVersion).map(name=>[name,record.row[name]]))})+'\n').join('')
      selectedPayload=join(await realpath(roots[0]!),`schema-${sourceVersion}-payload`)
      await mkdir(selectedPayload,{mode:0o700})
      await writeFile(join(selectedPayload,'governance-rebuild.jsonl'),bytes,{mode:0o600,flag:'wx'})
      await writeFile(join(selectedPayload,'governance-rebuild.json'),JSON.stringify({...manifest,
        schemaMigrations:manifest.schemaMigrations.filter(row=>row.version<=sourceVersion),schemaDigest:inventory.digest,dispositions:inventory.dispositions,
        records:{...manifest.records,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')},
      })+'\n',{mode:0o600,flag:'wx'})
    }
    const data=await readGovernanceRebuildPackage(selectedPayload,limits,signal)
    await pool.query('CREATE DATABASE '+targetName);created=true
    const targetUrl=new URL(url);targetUrl.pathname='/'+targetName
    target=createPostgresPool(targetUrl.href,{max:1})
    await runMigrations(target,migrations)
    const operation=randomUUID(),node=randomUUID(),password='new-governance-admin-fixture'
    const body={operationId:operation,pointId:randomUUID(),targetNodeId:node,targetNodeName:'Replacement primary',bootstrapUserId:account,
      bootstrapPassword:password,isolationMethod:'power-off',evidenceReference:'cloud/verified-off',acknowledgeDataLoss:true}
    const history=data.manifest.schemaMigrations
    for(const invalidHistory of [
      history.map((row,index)=>index===0?{...row,checksum:'0'.repeat(64)}:row),
      history.filter((_,index)=>index!==Math.floor(history.length/2)),
    ]){
      await expect(importGovernanceRebuild(target,{...data,manifest:{...data.manifest,schemaMigrations:invalidHistory}},body,migrations,signal))
        .rejects.toMatchObject({code:'peer-backup/governance-schema-mismatch'})
      expect((await target.query('SELECT count(*)::int n FROM harness.organizations')).rows[0].n).toBe(0)
    }
    expect(await importGovernanceRebuild(target,data,body,migrations,signal)).toMatchObject({operationId:operation,state:'review'})
    expect((await target.query('SELECT mode FROM harness.cluster_control WHERE organization_id=$1',[f.org])).rows[0].mode).toBe('restoring')
    expect((await target.query('SELECT status FROM harness.users WHERE id=$1',[member])).rows[0].status).toBe('disabled')
    const credentials=(await target.query<{password_hash:string}>('SELECT password_hash FROM harness.password_credentials WHERE user_id=$1',[account])).rows[0]!
    expect(await verifyPassword(credentials.password_hash,password)).toBe(true)
    expect((await target.query('SELECT desired_state,observed_state,runtime_token_hash FROM harness.instances WHERE runtime_id=$1',[f.runtimeId])).rows[0])
      .toMatchObject({desired_state:'stopped',observed_state:'ready',runtime_token_hash:null})
    expect((await target.query('SELECT harness.node_physically_isolated($1,$2) isolated',[f.org,f.context.nodeId])).rows[0].isolated).toBe(true)
    await expect(target.query(`UPDATE harness.instances SET desired_state='running' WHERE runtime_id=$1`,[f.runtimeId])).rejects.toMatchObject({constraint:'runtime_recovery_review'})
    expect((await target.query('SELECT count(*)::int n FROM harness.auth_sessions')).rows[0].n).toBe(0)
    expect((await target.query('SELECT count(*)::int n FROM harness.peer_backup_recovery_access')).rows[0].n).toBe(0)
    expect((await target.query('SELECT count(*)::int n FROM harness.peer_recovery_node_protocols')).rows[0].n).toBe(0)
    expect((await target.query('SELECT (SELECT count(*) FROM harness.push_devices)::int devices,(SELECT count(*) FROM harness.push_deliveries)::int deliveries')).rows[0])
      .toEqual({devices:0,deliveries:0})
    expect((await target.query('SELECT repository_node_id,target_node_id,phase FROM harness.project_recovery_operations WHERE id=$1',[retainedRecovery])).rows[0])
      .toEqual({repository_node_id:f.target,target_node_id:f.target,phase:'prepared'})
    expect((await target.query('SELECT count(*)::int n FROM harness.node_agents WHERE credential_hash IS NOT NULL OR connection_id IS NOT NULL')).rows[0].n).toBe(0)
    expect((await target.query(`SELECT count(*)::int n FROM harness.compute_nodes n JOIN harness.organizations o ON o.id=n.organization_id
      WHERE o.id=$1 AND n.access_applied_revision<>o.access_revision`,[f.org])).rows[0].n).toBe(0)
    await expect(importGovernanceRebuild(target,data,{...body,operationId:randomUUID()},migrations,signal)).rejects.toMatchObject({code:'peer-backup/governance-database-not-empty'})
    if(process.env.HGW_TEST_GOVERNANCE_REBUILD_INDEX==='1'){
      const {exerciseGovernanceRebuildIndex}=await import('./governance-rebuild-index.ts')
      const username=(await target.query<{username:string}>('SELECT username::text FROM harness.users WHERE id=$1',[account])).rows[0]!.username
      await exerciseGovernanceRebuildIndex({pool:target,databaseUrl:targetUrl.href,organizationId:f.org,nodeId:node,operationId:operation,
        username,password,root:roots[0]!})
      return
    }
    const gateway=new GovernanceRebuildGateway({context:{...f.context,pool:target,nodeId:node,nodeName:'Replacement primary'},config:testConfig(roots[0]!),
      limits,pageSize:100,assertStopped:async()=>{throw new Error('account review cannot inspect a Runtime')},
      prepareProfile:async()=>{throw new Error('account review cannot project a Runtime')}})
    const restoredPool=target
    const verifyReleased=async()=>{
      expect((await restoredPool.query('SELECT role,status FROM harness.memberships WHERE user_id=$1',[member])).rows[0]).toEqual({role:'member',status:'active'})
      expect((await restoredPool.query('SELECT count(*)::int n FROM harness.computer_use_permissions WHERE enabled')).rows[0].n).toBe(0)
      expect((await restoredPool.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed',[f.org,f.runtimeId,f.context.nodeId])).rows[0].allowed).toBe(false)
      expect((await restoredPool.query('SELECT status FROM harness.compute_nodes WHERE id=$1',[f.target])).rows[0].status).toBe('offline')
      expect((await restoredPool.query('SELECT mode FROM harness.cluster_control WHERE organization_id=$1',[f.org])).rows[0].mode).toBe('serving')
    }
    if(process.env.HGW_TEST_GOVERNANCE_REBUILD_UI==='1'){
      const {exerciseGovernanceRebuildUi}=await import('./governance-rebuild-review-ui.ts')
      await exerciseGovernanceRebuildUi({gateway,adminId:f.adminId,operationId:operation,root:roots[0]!,memberUserId:member,sourceNodeId:f.context.nodeId,targetNodeId:f.target,verifyReleased})
      return
    }
    const server=createServer((req,res)=>{void gateway.admin(req,res,f.adminId,{directLocal:true,signal}).catch(()=>res.writeHead(500).end())})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    try{
      const address=server.address();if(!address||typeof address==='string')throw new Error('review fixture did not listen')
      const endpoint='http://127.0.0.1:'+address.port+'/admin/api/governance-recovery'
      const get=async()=>{const response=await fetch(endpoint);expect(response.status).toBe(200);return response.json() as Promise<NonNullable<Awaited<ReturnType<typeof gateway.review.status>>>>}
      const post=(path:string,input:unknown)=>fetch(endpoint+'/'+operation+'/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
      const initial=await get()
      expect(initial.accounts.find(item=>item.userId===member)).toMatchObject({role:'admin',decision:null})
      expect(initial.runtimes).toEqual([expect.objectContaining({runtimeId:f.runtimeId,dataBinding:'unbound',observedState:'ready'})])
      expect(initial.unreconfiguredItems).toContainEqual(expect.objectContaining({table:'computer_use_permissions',identity:expect.objectContaining({enabled:true})}))
      expect((await target.query('SELECT role,status FROM harness.memberships WHERE user_id=$1',[member])).rows[0]).toEqual({role:'member',status:'disabled'})
      expect((await post('release',{confirm:operation,revision:initial.revision,acknowledgeUnrestoredDomains:[]})).status).toBe(409)
      const restored=await post('accounts/'+member+'/review',{confirm:operation,revision:initial.revision,decision:'restore',newPassword:'fresh-member-password'})
      expect(restored.status).toBe(200)
      expect((await post('accounts/'+member+'/review',{confirm:operation,revision:initial.revision,decision:'keep-disabled'})).status).toBe(409)
      expect((await target.query('SELECT status FROM harness.users WHERE id=$1',[member])).rows[0].status).toBe('disabled')
      const memberPassword=(await target.query<{password_hash:string}>('SELECT password_hash FROM harness.password_credentials WHERE user_id=$1',[member])).rows[0]!.password_hash
      expect(await verifyPassword(memberPassword,'fresh-member-password')).toBe(true)
      expect(await verifyPassword(memberPassword,'old-password')).toBe(false)
      let current=await get()
      expect((await post('nodes/'+f.context.nodeId+'/review',{confirm:operation,revision:current.revision,decision:'restore'})).status).toBe(409)
      expect((await post('nodes/'+f.target+'/review',{confirm:operation,revision:current.revision,decision:'restore'})).status).toBe(200)
      current=await get()
      const released=await post('release',{confirm:operation,revision:current.revision,acknowledgeUnrestoredDomains:current.unrestoredDomains})
      expect(released.status).toBe(200)
      await verifyReleased()
      const memberPublic=(await target.query<{id:number}>('SELECT public_id::float8 id FROM harness.users WHERE id=$1',[member])).rows[0]!.id
      await expect(gateway.review.status(memberPublic)).rejects.toMatchObject({message:'forbidden'})
      expect((await post('release',{confirm:operation,revision:current.revision,acknowledgeUnrestoredDomains:current.unrestoredDomains})).status).toBe(409)
    }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  }finally{
    await target?.end()
    if(created)await pool.query('DROP DATABASE '+targetName)
    await pool.end();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))
  }
})
