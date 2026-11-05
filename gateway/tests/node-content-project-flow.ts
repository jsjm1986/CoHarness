/** Project identity and cross-computer name reservations on an isolated pair of databases. */
import {createHash,createHmac,randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {expect,vi} from 'vitest'
import {escapeLiteral,type Pool} from 'pg'
import type {PostgresRuntimeContext} from '../src/postgres/runtime-context.ts'
import {createPostgresPool,transaction} from '../src/postgres/database.ts'
import {postgresTestDatabaseUrl} from './postgres-test-database.mjs'
import {PostgresProjectService} from '../src/postgres/project-service.ts'
import {PostgresCollaborationService} from '../src/postgres/collaboration-service.ts'
import {PostgresInstanceRepository} from '../src/postgres/instance-repository.ts'
import {PostgresRuntimeCatalog} from '../src/postgres/runtime-catalog.ts'
import type {RuntimeNodeId} from '../src/runtime-catalog.ts'
import {PROJECT_NAME_RESTORE_PREFIX,PROJECT_NAME_RESTORE_SUFFIX} from '../src/node-content-project-name-restore.ts'
import {NodeProjectMetadata} from '../src/node-content-projects.ts'
import {NodeContentUnavailable,type NodeContentBinding,type NodeContentStore} from '../src/node-content-store.ts'
import {activateProjectNameKey,canonicalProjectName,prepareProjectNameKey,projectNamePolicy,type ProjectNameMacAuthority} from '../src/node-content-project-names.ts'
import {testConfig} from './test-config.ts'

/** Exercise exact project metadata, commit failure, concurrent duplicates and key rotation. */
export async function verifyNodeProjectNames(context:PostgresRuntimeContext,store:NodeContentStore,b:NodeContentBinding,
  owner:{id:string;public_id:string},member:{id:string;public_id:string},initial:string,path:string,directory:string):Promise<ProjectNameMacAuthority>{
  const {pool,organizationId:org,nodeId}=context
  const id=Number((await pool.query('SELECT public_id FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].public_id)
  const actor=Number(owner.public_id),metadata=new NodeProjectMetadata(context,store)
  const projects=new PostgresProjectService(context,testConfig(join(directory,'names-a')),nodeId,{metadata})
  const collaboration=new PostgresCollaborationService(context,undefined,store,metadata)
  expect(await metadata.authorizedMetadata(actor,'account',[id])).toEqual([{projectId:id,nodeId,runtimeId:b.runtimeId,name:initial,rootPath:path}])
  await expect(metadata.authorizedMetadata(actor,'admin',[id])).rejects.toMatchObject({code:'forbidden'})
  await expect(metadata.authorizedMetadata(Number(member.public_id),'account',[id])).rejects.toMatchObject({code:'forbidden'})
  expect((await collaboration.projectsForUser(actor)).find(v=>v.projectId===id)).toMatchObject({name:'#'+id,path:'',metadataOnNode:true})
  const lookup=vi.spyOn(metadata,'lookup').mockRejectedValue(new NodeContentUnavailable('Node metadata is unavailable.'))
  try {
    expect((await collaboration.projectReadAuthorities(actor,id))[0]).toMatchObject({projectId:id,name:'#'+id,path:'',canManage:true,metadataOnNode:true})
    expect(lookup).not.toHaveBeenCalled()
  }finally{lookup.mockRestore()}
  let calls=0
  const offline={read:async()=>{calls++;throw new NodeContentUnavailable()},write:async()=>{throw new NodeContentUnavailable()}}
  const disconnected=new PostgresCollaborationService(context,undefined,offline,new NodeProjectMetadata(context,offline))
  expect((await disconnected.projectsForUser(actor)).find(v=>v.projectId===id)).toMatchObject({name:'#'+id,path:'',metadataOnNode:true})
  expect(calls).toBe(0)
  await expect(disconnected.projectForUser(id,actor)).rejects.toMatchObject({status:503})
  expect(calls).toBe(1)
  const coldProjects=new PostgresProjectService(context,testConfig(join(directory,'names-cold')),nodeId,{metadata:new NodeProjectMetadata(context,offline)})
  const marker={id,name:'#'+id,path:'',metadataOnNode:true,nodeId,runtimeId:b.runtimeId}
  expect((await coldProjects.list('directory')).find(p=>p.id===id)).toMatchObject(marker)
  expect((await coldProjects.getByIds([id],'directory'))[0]).toMatchObject(marker)
  expect(calls).toBe(1)
  await expect(coldProjects.getById(id)).rejects.toMatchObject({status:503})


  expect(await collaboration.projectForUser(id,actor)).toMatchObject({name:initial,path})
  expect(await collaboration.internalProject(id)).toMatchObject({name:initial,path})
  expect(await projects.getById(id)).toMatchObject({name:initial,path})
  const instanceOwner=new PostgresInstanceRepository(context,47300,metadata)
  expect(await instanceOwner.owner({kind:'project',id,runtimeId:b.runtimeId})).toMatchObject({name:initial,homePath:path})
  const catalog=new PostgresRuntimeCatalog(context,{maxBytes:32768,pageSize:16},nodeId as RuntimeNodeId)
  expect(await catalog.resolveForAccount({id:actor,username:'owner',displayName:'Owner',role:'user',status:'active',homePath:'/owner',
    mustChangePassword:false,autoReviewEligible:false},b.runtimeId)).toMatchObject({metadataOnNode:true,owner:{name:'#'+id}})
  await pool.query("UPDATE harness.memberships SET role='admin' WHERE organization_id=$1 AND user_id=$2",[org,owner.id])
  const keys=new Map([['k1',Buffer.alloc(32,43)],['k2',Buffer.alloc(32,55)]])
  const key=(keyId:string)=>({organizationId:org,keyId,fingerprint:createHash('sha256').update(keys.get(keyId)!).digest('hex')})
  const signer=(db:Pool):ProjectNameMacAuthority=>({identify:async request=>transaction(db,async tx=>{
    const policy=await projectNamePolicy(tx,org)
    if (!policy) throw new Error('No test key policy')
    const canonical=await canonicalProjectName(tx,request.name)
    const {name:_,...coordinates}=request
    return {...coordinates,policyRevision:policy.revision,tags:[policy.activeKeyId,...policy.nextKeyId?[policy.nextKeyId]:[]].map(keyId=>({
      keyId,mac:createHmac('sha256',keys.get(keyId)!).update(canonical).digest('hex'),
    }))}
  })})
  const authority=signer(pool)
  await transaction(pool,async tx=>{
    for(const [a,b] of [['ÄBC','äbc'],['İ','i'],['Straße','STRASSE'],['é','e\u0301']] as const) {
      const equality=(await tx.query('SELECT $1::citext=$2::citext eq',[a,b])).rows[0].eq
      expect((await canonicalProjectName(tx,a)).equals(await canonicalProjectName(tx,b))).toBe(equality)
    }
    expect((await tx.query("SELECT current_setting('log_parameter_max_length') v,current_setting('log_parameter_max_length_on_error') e")).rows[0]).toEqual({v:'0',e:'0'})
  })
  const first=await transaction(pool,tx=>prepareProjectNameKey(tx,{...key('k1'),expectedRevision:null}))
  await expect(transaction(pool,tx=>activateProjectNameKey(tx,org,first.revision))).rejects.toThrow('not been indexed')
  expect((await projects.reindexNames(actor,authority)).indexed).toBeGreaterThanOrEqual(2)
  const active=await transaction(pool,tx=>activateProjectNameKey(tx,org,first.revision))
  const nodeB=(await pool.query<{id:string}>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id',[org,'names-b-'+randomUUID()])).rows[0]!.id
  await pool.query("INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,'/test-user-b')",[org,nodeB,owner.id])
  await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[org,nodeB,owner.id])
  const other=new PostgresProjectService({...context,nodeId:nodeB,nodeName:'names-b'},testConfig(join(directory,'names-b')),nodeB)
  const create=(service:PostgresProjectService,name:string)=>service.createManaged({name,ownerUserId:actor,actorUserId:actor},authority)
  await expect(create(other,initial.toUpperCase())).rejects.toThrow(/duplicate project name/)
  const concurrent='Concurrent '+randomUUID()
  const results=await Promise.allSettled([create(other,concurrent.toUpperCase()),create(projects,concurrent)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
  await expect(projects.createManaged({name:'Missing primary',ownerUserId:actor,actorUserId:actor})).rejects.toThrow('verification from the primary')
  const renamed='Private renamed '+randomUUID()
  await projects.rename(id,renamed,actor,authority)
  expect((await metadata.authorizedMetadata(actor,'admin',[id]))[0]?.name).toBe(renamed)
  expect((await projects.getById(id))?.name).toBe(renamed)
  expect((await instanceOwner.owner({kind:'project',id,runtimeId:b.runtimeId}))?.name).toBe(renamed)
  expect((await pool.query('SELECT name FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].name).not.toBe(renamed)
  await pool.query(`CREATE FUNCTION harness.test_reject_content_rename() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'rejected test commit'; END$$`)
  await pool.query(`CREATE CONSTRAINT TRIGGER test_reject_name AFTER UPDATE ON harness.projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN(NEW.id=${escapeLiteral(b.projectId)}::uuid) EXECUTE FUNCTION harness.test_reject_content_rename()`)
  try {await expect(projects.rename(id,'uncommitted node name',actor,authority)).rejects.toThrow('rejected test commit')}
  finally {await pool.query('DROP TRIGGER test_reject_name ON harness.projects');await pool.query('DROP FUNCTION harness.test_reject_content_rename()')}
  expect((await metadata.authorizedMetadata(actor,'account',[id]))[0]?.name).toBe(renamed)
  await expect(create(other,renamed.toUpperCase())).rejects.toThrow(/duplicate project name/)
  await expect(pool.query("INSERT INTO harness.projects(organization_id,name) VALUES($1,'Old direct writer')",[org])).rejects.toMatchObject({constraint:'project_name_policy_coverage'})
  const rotating=await transaction(pool,tx=>prepareProjectNameKey(tx,{...key('k2'),expectedRevision:active.revision}))
  await expect(transaction(pool,tx=>activateProjectNameKey(tx,org,rotating.revision))).rejects.toThrow('not been indexed')
  await projects.reindexNames(actor,authority)
  await other.reindexNames(actor,authority)
  expect((await transaction(pool,tx=>activateProjectNameKey(tx,org,rotating.revision))).activeKeyId).toBe('k2')
  await expect(create(other,renamed)).rejects.toThrow(/duplicate project name/)
  await expect(transaction(pool,async tx=>{
    await tx.query(PROJECT_NAME_RESTORE_PREFIX)
    await tx.query('UPDATE harness.project_name_policies SET revision=revision+1 WHERE organization_id=$1',[org])
    await tx.query(PROJECT_NAME_RESTORE_SUFFIX)
  })).rejects.toThrow('Restore would change project name keys')
  const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
  if(!url)throw new Error('The single-connection name signer requires an isolated test database.')
  const single=createPostgresPool(url,{max:1,connectionTimeoutMillis:1500}),singleAuthority=signer(single)
  try {
    const target=new PostgresProjectService({...context,pool:single},testConfig(join(directory,'single-signer')),nodeId,{metadata})
    const named=await target.createManaged({name:'one-pool-'+randomUUID(),ownerUserId:actor,actorUserId:actor},singleAuthority)
    const next='one-pool-renamed-'+randomUUID()
    await target.rename(named.id,next,actor,singleAuthority)
    expect((await target.getById(named.id))?.name).toBe(next)
    expect((await target.reindexNames(actor,singleAuthority,named.id-1,1)).indexed).toBe(1)
  }finally{await single.end()}
  return authority
}
