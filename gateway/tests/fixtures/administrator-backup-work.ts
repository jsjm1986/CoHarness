/** Current administrator authority across real backup commands, registry commits and POST configuration publication. */
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {postgresTestDatabaseUrl} from '../postgres-test-database.mjs'
import {createPostgresPool,runMigrations} from '../../src/postgres/database.ts'
import {resolvePostgresRuntimeContext} from '../../src/postgres/runtime-context.ts'
import {PostgresUserService} from '../../src/postgres/user-service.ts'
import {PostgresProjectService} from '../../src/postgres/project-service.ts'
import {PostgresAuthService} from '../../src/postgres/auth-service.ts'
import {PostgresAuditService} from '../../src/postgres/audit-service.ts'
import {PostgresInstanceRepository} from '../../src/postgres/instance-repository.ts'
import {PostgresBackupService} from '../../src/postgres/backup-service.ts'
import {PostgresDeploymentBackups} from '../../src/postgres/deployment-backups.ts'
import {PostgresMaintenanceService} from '../../src/postgres/maintenance-service.ts'
import {createDeploymentCommands} from '../../src/deployment-commands.ts'
import {NodeConfigurationStore} from '../../src/node-config-store.ts'
import {nodeConfigurationAuthority} from '../../src/postgres/node-configuration-authority.ts'
import {InstanceManager} from '../../src/instances.ts'
import {createGatewayServer} from '../../src/server.ts'
import {createAdminApiHandler} from '../../src/admin-api.ts'
import {testConfig,testEnvironment} from '../test-config.ts'
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(databaseUrl)
const [repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url))]=process.argv.slice(2)
const root=await mkdtemp(join(tmpdir(),'hgw-backup-authority-')),database='hgw_backup_work_'+randomUUID().replaceAll('-','')+'_test'
const administration=createPostgresPool(databaseUrl,{max:1})
let pool:ReturnType<typeof createPostgresPool>|undefined,observer:ReturnType<typeof createPostgresPool>|undefined,created=false
let gateway:ReturnType<typeof createGatewayServer>|undefined,manager:InstanceManager|undefined,primaryError:unknown
let release:(()=>void)|undefined,pending:Promise<{status:number;configurationDisclosed:boolean;code:string|null}>|undefined
let entered:(()=>void)|undefined,gate:Promise<void>|undefined
let hold:{owner:'commands'|'work';method:string;phase:'before'|'after'}|undefined,forwarded:unknown
let captures=0,verifications=0,selectionRequests=0
function command(value:string|undefined,executable:string):string[]{
 if(value===undefined)return[executable]
 const parsed:unknown=JSON.parse(value)
 assert.ok(Array.isArray(parsed)&&parsed.length>0&&parsed.every(item=>typeof item==='string'))
 return parsed
}
function wrapped<T extends object>(target:T,owner:'commands'|'work'):T{
 return new Proxy(target,{get(source,key){
  const original:unknown=Reflect.get(source,key)
  if(typeof original!=='function')return original
  return async(...args:unknown[])=>{
   if(owner==='work'&&(key==='verify'||key==='previewNodeConfiguration'))selectionRequests+=1
   const selected=hold?.owner===owner&&hold.method===key?hold:undefined
   if(selected?.phase==='before'){forwarded=args[key==='create'?0:key==='verify'?2:1];entered!();await gate}
   if(owner==='commands'&&key==='backup')captures+=1
   if(owner==='commands'&&key==='verifyDump')verifications+=1
   const result:unknown=await Reflect.apply(original,source,args)
   if(selected?.phase==='after'){entered!();await gate}
   return result
  }
 }})
}
try{
 await administration.query(`CREATE DATABASE "${database}"`);created=true
 const url=new URL(databaseUrl);url.pathname='/'+database
 // The data lease retains one checkout; admitted registry transactions must finish using the other one.
 pool=createPostgresPool(url.href,{max:2});observer=createPostgresPool(url.href,{max:1})
 await runMigrations(pool,fileURLToPath(new URL('../../deploy/postgres/migrations',import.meta.url)))
 const slug=randomUUID(),organization:string=(await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Backup work fixture') RETURNING id",[slug])).rows[0].id
 await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'backup-work-node')",[organization])
 const context=await resolvePostgresRuntimeContext(pool,slug,'backup-work-node')
 const environment=testEnvironment(root,{HGW_DSH_REPO_ROOT:repositoryRoot,HGW_ORGANIZATION_SLUG:slug,HGW_COMPUTE_NODE_NAME:'backup-work-node',HGW_DEFAULT_ENV_FILE:''})
 const cfg=testConfig(root,environment),users=new PostgresUserService(context,cfg),projects=new PostgresProjectService(context,cfg)
 const actor=await users.create({username:'initial-admin',password:'synthetic-password',role:'admin'})
 await users.create({username:'remaining-admin',password:'synthetic-password',role:'admin'});await users.changeOwnPassword(actor.id,'synthetic-password')
 const internal:string=(await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[organization,actor.id])).rows[0].id
 await new NodeConfigurationStore(context,cfg,environment,nodeConfigurationAuthority(context)).initialize()
 const maintenance=new PostgresMaintenanceService(context,cfg.nodeStaleMs);await maintenance.enterMaintenance(null)
 await pool.query("UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE organization_id=$1",[organization])
 const commands=wrapped(createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND,'pg_dump'),command(process.env.HGW_TEST_PG_RESTORE_COMMAND,'pg_restore')),'commands')
 const backupWork=new PostgresDeploymentBackups(context,cfg,url.href,commands,environment),backups=new PostgresBackupService(context)
 const record=await backupWork.create(null);assert.equal(record.status,'verified')
 manager=new InstanceManager(new PostgresInstanceRepository(context,cfg.instancePortBase),cfg,{instancesOutliveGateway:false,start:async()=>{throw Error('Backup work must not allocate a Runtime')}})
 const deps={cfg,users,projects,instances:manager,auth:new PostgresAuthService(context,cfg),audit:new PostgresAuditService(context),maintenance,backups,backupWork:wrapped(backupWork,'work')}
 gateway=createGatewayServer(deps,{admin:createAdminApiHandler(deps)})
 await new Promise<void>((done,fail)=>{gateway!.once('error',fail);gateway!.listen(0,'127.0.0.1',done)})
 const address=gateway.address();assert.ok(address&&typeof address==='object')
 const origin='http://127.0.0.1:'+address.port;cfg.publicOrigins.push(origin)
 const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:actor.username,password:'synthetic-password'})})
 await login.arrayBuffer();assert.equal(login.status,302)
 const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie)
 const select=async(operation:string,selection:Record<string,unknown>)=>{
  const response=await fetch(origin+'/admin/api/backups'+(operation==='create'?'':operation==='verify'?'/verify':'/node-configuration'),{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({...selection,actorUserId:999})})
  const body=await response.json() as {values?:unknown;code?:string;error?:string}
  return{status:response.status,configurationDisclosed:body.values!==undefined&&body.values!==null,code:body.code??body.error??null}
 }
 const read=(operation:string,id=record.id)=>select(operation,{id})
 const reset=async()=>{
  await observer!.query('UPDATE harness.password_credentials SET must_change_password=false WHERE user_id=$1',[internal])
  await observer!.query("UPDATE harness.organizations SET status='active' WHERE id=$1",[organization])
  await observer!.query("UPDATE harness.users SET status='active',deleted_at=NULL WHERE id=$1",[internal])
  await observer!.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'admin','active') ON CONFLICT (organization_id,user_id) DO UPDATE SET role='admin',status='active'",[organization,internal])
 }
 const withdraw=async(change:string)=>{
  if(change==='password-required')await observer!.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1',[internal])
  if(change==='role')await observer!.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1",[internal])
  if(change==='disabled-account')await observer!.query("UPDATE harness.users SET status='disabled' WHERE id=$1",[internal])
  if(change==='deleted-account')await observer!.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1',[internal])
  if(change==='disabled-membership')await observer!.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1",[internal])
  if(change==='missing-membership')await observer!.query('DELETE FROM harness.memberships WHERE user_id=$1',[internal])
  if(change==='disabled-organization')await observer!.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1",[organization])
 }
 const describe=async()=>({captures,verifications,rows:(await backups.list()).length,selected:await backups.get(record.id),selectedRevision:(await observer!.query<{revision:string}>('SELECT xmin::text revision FROM harness.backup_records WHERE organization_id=$1 AND id=$2',[organization,record.id])).rows[0]!.revision})
 const publish=async(scenario:string,result:Awaited<ReturnType<typeof read>>,before:Awaited<ReturnType<typeof describe>>)=>{
  const after=await describe()
  console.log(JSON.stringify({scenario,...result,captures:captures-before.captures,verifications:verifications-before.verifications,rowsAdded:after.rows-before.rows,selectedStatus:after.selected.status,selectedRowChanged:after.selectedRevision!==before.selectedRevision}))
 }
 for(const operation of ['create','verify','previewNodeConfiguration']){
  const before=await describe(),result=await read(operation)
  assert.equal(result.status,200);assert.equal(result.configurationDisclosed,operation==='previewNodeConfiguration')
  await publish(operation+'/current',result,before)
  for(const change of ['role','disabled-account','deleted-account','disabled-membership','missing-membership','disabled-organization','password-required']){
   const before=await describe();hold={owner:'work',method:operation,phase:'before'}
   const reached=new Promise<void>(done=>{entered=done});gate=new Promise<void>(done=>{release=done})
   pending=read(operation)
   await Promise.race([reached,pending.then(value=>{throw Error('Missed backup entry: '+JSON.stringify(value))})])
   await withdraw(change);release!();const result=await pending;pending=undefined;hold=undefined
   assert.equal(forwarded,actor.id);assert.equal(result.status,403);assert.equal(result.configurationDisclosed,false)
   const after=await describe();assert.equal(captures,before.captures);assert.equal(verifications,before.verifications);assert.equal(after.rows,before.rows)
   assert.equal(after.selected.status,before.selected.status);assert.equal(after.selectedRevision,before.selectedRevision)
   await publish(operation+'/'+change,result,before);await reset()
  }
 }
 for(const scenario of ['capture-commit-role','verification-commit-role','preview-publication-role']){
  const operation=scenario==='capture-commit-role'?'create':scenario==='verification-commit-role'?'verify':'previewNodeConfiguration'
  hold=scenario==='capture-commit-role'?{owner:'commands',method:'backup',phase:'after'}:scenario==='verification-commit-role'?{owner:'commands',method:'verifyStoredFiles',phase:'after'}:{owner:'work',method:'previewNodeConfiguration',phase:'after'}
  const before=await describe(),reached=new Promise<void>(done=>{entered=done});gate=new Promise<void>(done=>{release=done})
  pending=read(operation)
  await Promise.race([reached,pending.then(value=>{throw Error('Missed late backup admission: '+JSON.stringify(value))})])
  await withdraw('role');release!();const result=await pending;pending=undefined;hold=undefined
  assert.equal(result.status,403);assert.equal(result.configurationDisclosed,false)
  const after=await describe();assert.equal(after.rows,before.rows);assert.equal(after.selected.status,'verified')
  if(scenario==='capture-commit-role')assert.equal((await maintenance.listOperations(1))[0]?.status,'failed')
  if(scenario==='verification-commit-role')assert.equal(after.selectedRevision,before.selectedRevision)
  await publish(scenario,result,before);await reset()
 }
 // Damage only an owned dump after authentication; a withdrawn verifier cannot invalidate its registry row.
 const bytes=await readFile(record.path),before=await describe()
 hold={owner:'commands',method:'verifyDump',phase:'before'}
 const reached=new Promise<void>(done=>{entered=done});gate=new Promise<void>(done=>{release=done})
 pending=read('verify');await Promise.race([reached,pending.then(value=>{throw Error('Missed dump verification: '+JSON.stringify(value))})])
 await writeFile(record.path,'fixture-corrupted-dump');await withdraw('role');release!()
 const refused=await pending;pending=undefined;hold=undefined
 assert.equal(refused.status,403);assert.equal((await backups.get(record.id)).status,'verified')
 await publish('failed-verification-role',refused,before)
 await reset();const failureBefore=await describe(),failed=await read('verify')
 assert.equal(failed.status,500);assert.equal((await backups.get(record.id)).status,'failed');await publish('failed-verification-current',failed,failureBefore)
 await writeFile(record.path,bytes)
 const restoredBefore=await describe(),restored=await read('previewNodeConfiguration')
 assert.equal(restored.status,200);assert.equal(restored.configurationDisclosed,true);assert.equal((await backups.get(record.id)).status,'verified')
 await publish('preview-restored',restored,restoredBefore)
 for(const operation of ['verify','previewNodeConfiguration']){
  const invalid:Array<{name:string;selection:Record<string,unknown>;code:string}>=[
   {name:'missing',selection:{},code:'backup-id-required'},
   {name:'number',selection:{id:17},code:'backup-id-required'},
   {name:'null',selection:{id:null},code:'backup-id-required'},
   {name:'text',selection:{id:'invalid'},code:'invalid-backup-id'},
   {name:'hyphens',selection:{id:'-'.repeat(36)},code:'invalid-backup-id'},
   {name:'hex36',selection:{id:'f'.repeat(36)},code:'invalid-backup-id'},
   {name:'hex32',selection:{id:'a'.repeat(32)},code:'invalid-backup-id'},
   {name:'whitespace',selection:{id:' '+record.id},code:'invalid-backup-id'},
  ]
  for(const input of invalid){
   const before=await describe(),requests=selectionRequests,result=await select(operation,input.selection),after=await describe()
   assert.equal(result.status,400);assert.equal(result.code,input.code);assert.equal(result.configurationDisclosed,false)
   assert.equal(captures,before.captures);assert.equal(verifications,before.verifications);assert.equal(after.selectedRevision,before.selectedRevision)
   assert.equal(selectionRequests,requests)
   await publish(operation+'/selection-'+input.name,result,before)
  }
  const missingBefore=await describe(),missing=await read(operation,'00000000-0000-0000-0000-000000000000')
  assert.equal(missing.status,404);assert.equal(missing.code,'backup-not-found');assert.equal(verifications,missingBefore.verifications)
  await publish(operation+'/selection-unknown',missing,missingBefore)
  const validBefore=await describe(),valid=await read(operation,record.id.toUpperCase())
  assert.equal(valid.status,200);assert.equal(valid.configurationDisclosed,operation==='previewNodeConfiguration')
  await publish(operation+'/selection-uppercase',valid,validBefore)
 }
} catch(error){primaryError=error;throw error}
finally{
 release?.();const failures:unknown[]=[]
 const operations:Array<()=>Promise<unknown>>=[async()=>{await pending},async()=>{if(gateway?.listening)await new Promise<void>((done,fail)=>{gateway!.closeAllConnections();gateway!.close(error=>error?fail(error):done())})},async()=>{await manager?.stopAll()},async()=>{await pool?.end()},async()=>{await observer?.end()},async()=>{if(created)await administration.query(`DROP DATABASE "${database}" WITH (FORCE)`)},async()=>{await administration.end()}]
 for(const operation of operations){try{await operation()}catch(error){failures.push(error)}}
 if(failures.length===0)await rm(root,{recursive:true,force:true})
 if(failures.length)throw new AggregateError(primaryError===undefined?failures:[primaryError,...failures],'Backup work cleanup failed; owned files retained at '+root)
}
