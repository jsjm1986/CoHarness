/** Keyless built Gateway login, creation and organization-wide name reservation against two disposable databases. */
import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,rm,realpath,readFile,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'

const gateway=fileURLToPath(new URL('../../',import.meta.url)),root=process.env.HGW_TEST_RELEASE_ROOT??resolve(gateway,'..')
const base=gateway,lib=async name=>import(pathToFileURL(join(base,'lib',name+'.js')).href)
const {createPostgresPool,runMigrations}=await lib('postgres/database')
const {resolvePostgresRuntimeContext}=await lib('postgres/runtime-context')
const {loadConfig}=await lib('config')
const {migrateNodeContent}=await lib('node-content-migrations')
const {NodeContentStore}=await lib('node-content-store')
const {PostgresUserService}=await lib('postgres/user-service')
const {createProjectNameKeyring}=await lib('project-name-keyring')
const windowsVolume=process.env.HGW_TEST_VSS_VOLUME
const nativeRoot=windowsVolume?process.env.HGW_TEST_VSS_SOURCE:process.env.HGW_TEST_BTRFS_SOURCE
const nativeStage=windowsVolume?process.env.HGW_TEST_VSS_STAGING:process.env.HGW_TEST_BTRFS_STAGING
if(nativeRoot)assert.ok(process.platform===(windowsVolume?'win32':'linux') && nativeStage && await realpath(nativeRoot)===nativeRoot)
const temp=await mkdtemp(join(nativeRoot??await realpath(tmpdir()),'hgw-live-instance-'))
const env=process.env, dbUrl=env.HGW_TEST_DATABASE_URL,nodeUrl=env.HGW_TEST_NODE_CONTENT_DATABASE_URL
assert.match(new URL(dbUrl).pathname,/_test$/);assert.match(new URL(nodeUrl).pathname,/_test$/)
assert.notEqual(dbUrl,nodeUrl)
assert.ok(new URL(dbUrl).hostname==='127.0.0.1' || new URL(dbUrl).searchParams.get('host')?.includes('hgw-'))
const control=createPostgresPool(dbUrl,{max:3}), content=createPostgresPool(nodeUrl,{max:3})
const sockets=await Promise.all([0,1].map(async()=>{const sock=createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');return sock}))
const [port,intake]=sockets.map(s=>s.address().port)
const slug='real-'+randomUUID(),label='local-fixture',volume=randomUUID(),origin='http://127.0.0.1:'+port
const windowsTools=process.platform==='win32'?{SystemRoot:env.SystemRoot,ComSpec:env.ComSpec,PATHEXT:env.PATHEXT,
  TEMP:temp,TMP:temp,USERPROFILE:temp,ProgramData:env.ProgramData,ProgramFiles:env.ProgramFiles,LOCALAPPDATA:temp,APPDATA:temp}:{}
const cfgEnv={...windowsTools,PATH:process.env.PATH,HOME:temp,TMPDIR:temp,HGW_PORT:String(port),HGW_INTAKE_PORT:String(intake),HGW_PUBLIC_ORIGINS:origin,
 HGW_USERS_ROOT:join(temp,'accounts'),HGW_PROJECTS_ROOT:join(temp,'projects'),HGW_USER_PROJECTS_ROOT:join(temp,'my-projects'),
 HGW_PROJECT_RUNTIMES_ROOT:join(temp,'project-runtimes'),HGW_STATE_ROOT:join(temp,'state'),HGW_DEFAULT_ENV_FILE:'',
 HGW_DATABASE_URL_FILE:join(temp,'governance-url'),HGW_NODE_CONTENT_DATABASE_URL_FILE:join(temp,'content-url'),HGW_NODE_CONTENT_VOLUME_ID:volume,
 HGW_NODE_CONTENT_PGDATA:env.HGW_TEST_NODE_CONTENT_PGDATA,HGW_COMPUTE_NODE_NAME:label,HGW_ORGANIZATION_SLUG:slug,
 HGW_PROJECT_NAME_KEY_FILE:join(temp,'project-name-key'),HGW_DSH_REPO_ROOT:root,HGW_STEWARD:'off'}
let child,closed
try {
 for(const [file,value] of [[cfgEnv.HGW_DATABASE_URL_FILE,dbUrl],[cfgEnv.HGW_NODE_CONTENT_DATABASE_URL_FILE,nodeUrl]])await writeFile(file,value,{mode:0o600,flag:'wx'})
 for(const path of ['state','accounts','projects','my-projects','project-runtimes'])await mkdir(join(temp,path),{mode:0o700})
 await runMigrations(control,join(base,'deploy/postgres/migrations'))
 const org=(await control.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Qualification') RETURNING id",[slug])).rows[0].id
 const node=(await control.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id',[org,label])).rows[0].id
 const options={pool:content,organizationId:org,nodeId:node,volumeId:volume,dataDirectory:cfgEnv.HGW_NODE_CONTENT_PGDATA,proofTimeoutMs:5000}
 await migrateNodeContent(options,join(base,'deploy/node-content/migrations'))
 const store=await NodeContentStore.open(options);await store.registerVolume(control)
 const ctx=await resolvePostgresRuntimeContext(control,slug,label),cfg=loadConfig(cfgEnv)
 const users=new PostgresUserService(ctx,cfg),pass=randomUUID()
 const admin=await users.create({username:'fixture-admin',password:pass,role:'admin'})
 await users.changeOwnPassword(admin.id,pass)
 await createProjectNameKeyring({file:cfgEnv.HGW_PROJECT_NAME_KEY_FILE,keyId:'initial',nodeId:node,organizationId:org})
 await Promise.all(sockets.map(s=>new Promise(ok=>s.close(ok))))
 child=spawn(process.execPath,[join(base,'lib/index.js')],{env:cfgEnv,cwd:temp,stdio:['ignore','pipe','pipe']})
 closed=once(child,'close')
 const counts={startup:0,degraded:0}
 for(const source of [child.stdout,child.stderr])source.on('data',bytes=>{
   for(const line of bytes.toString().split('\n')) {
     if(line.includes('[gateway]'))counts.startup++
     if(line.includes('degraded') || line.includes('permanently'))counts.degraded++
   }
 })
 let ok=false
 for(let i=0;i<100;i++){if(child.exitCode!==null)break;try{if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(1800)})).ok){ok=true;break}}catch{};await delay(150)}
 assert.ok(ok,'candidate boot '+JSON.stringify(counts))
 const login=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'fixture-admin',password:pass})})
 assert.equal(login.status,302);const cookie=login.headers.getSetCookie()[0]?.split(';')[0];assert.ok(cookie?.startsWith('hgw_session='))
 const request=async(url,method,body)=>{const r=await fetch(origin+url,{method,credentials:'omit',redirect:'manual',headers:{origin,cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const value=await r.json().catch(()=>null);return {status:r.status,value}}
 const health=await request('/admin/api/deployment/node-content','GET');assert.equal(health.value?.status,'verified')
 const prepare=await request('/admin/api/deployment/project-names/prepare','POST',{keyId:'initial',expectedRevision:null});assert.equal(prepare.status,200,JSON.stringify(prepare.value))
 const activate=await request('/admin/api/deployment/project-names/activate','POST',{revision:prepare.value.revision});assert.equal(activate.status,200,JSON.stringify(activate.value))
 const title='Qualification '+randomUUID()
 const first=await request('/account/api/projects?dshNode='+node,'POST',{name:title})
 assert.equal(first.status,201,'physical project HTTP '+JSON.stringify(first.value))
 const id=first.value.id
 const info=await request('/account/api/project-metadata?dshNode='+node+'&ids='+id,'GET')
 assert.equal(info.value.items[0].name,title)
 const duplicate=await request('/account/api/projects?dshNode='+node,'POST',{name:title.toUpperCase()})
 assert.equal(duplicate.status,409,'organization duplicate '+JSON.stringify(duplicate.value))
 const coord=(await control.query(`SELECT p.id,p.name::text AS alias,m.local_path,p.logical_name_id,b.runtime_id,d.root_id,h.mac FROM harness.projects p JOIN harness.project_mounts m ON m.project_id=p.id
 JOIN harness.project_content_placement b ON b.project_id=p.id JOIN harness.document_scope_placement d ON d.scope_id=p.id JOIN harness.project_name_claims h ON h.project_id=p.id
 WHERE p.organization_id=$1 AND p.public_id=$2`,[org,id])).rows[0]
 assert.ok(coord);assert.notEqual(coord.alias,title);assert.ok(!coord.local_path.includes(title));assert.equal(coord.mac.length,32)
 const stored=(await content.query('SELECT s.name,s.root_path,d.root_id,s.publication_state FROM node_content.spaces s JOIN node_content.document_roots d USING(organization_id,runtime_id) WHERE s.runtime_id=$1',[coord.runtime_id])).rows[0]
 assert.equal(stored.name,title);assert.equal(stored.root_path,info.value.items[0].rootPath);assert.equal(stored.root_id,coord.root_id);assert.equal(stored.publication_state,'published')
 const metrics=(await control.query("SELECT count(*) FROM harness.instances WHERE organization_id=$1 AND observed_state<>'stopped'",[org])).rows[0].count
 assert.equal(metrics,'0')
 const retirement='/admin/api/deployment/project-content-migrations/'+id+'/retirement'
 const report=await request(retirement+'?dshNode='+node,'GET')
 assert.equal(report.status,200);assert.equal(report.value.runtimeId,coord.runtime_id);assert.equal(report.value.sourceRetirement,'new')
 assert.deepEqual(report.value.retainedRelations,[])
 const invalid=await request(retirement+'/finalize?dshNode='+node,'POST',{reviewId:'unverified'})
 assert.equal(invalid.status,400)
 const {NodeArchiveRouter}=await lib('node-archive-router')
 const {rows:[purged]}=await content.query(`INSERT INTO node_content.conversation_archive_records
   (organization_id,runtime_id,root_session_id,state,runtime_public_id) VALUES($1,$2,$3,'purged',$4) RETURNING archive_id`,
 [org,coord.runtime_id,randomUUID(),id])
 const original=join(stored.root_path,'retired-attachment'),edited=join(stored.root_path,'edited-attachment')
 await writeFile(original,'original',{flag:'wx'});await writeFile(edited,'modified',{flag:'wx'})
 const digest=createHash('sha256').update('original').digest('hex')
 for(const path of [original,edited])await content.query(`INSERT INTO node_content.conversation_archive_file_cleanup
   (node_id,organization_id,archive_id,local_path,expected_sha256,expected_bytes) VALUES($1,$2,$3,$4,$5,8)`,[node,org,purged.archive_id,path,digest])
 assert.equal(await new NodeArchiveRouter(ctx,30,store).cleanupDue(10),1)
 await assert.rejects(lstat(original),e=>e.code==='ENOENT')
 assert.equal(await readFile(edited,'utf8'),'modified')
 const transcript={entry:'built Gateway',volumeHealth:health.value.status,create:first.status,duplicate:duplicate.status,metadata:info.status,
   organizationNameCleartext:false,nodeDisplayMatches:true,documentRootMatches:true,unselectedRuntimeStarts:Number(metrics)}
 const expected=JSON.parse(await readFile(new URL('../expected/physical-project-gateway.jsonl',import.meta.url),'utf8'))
 assert.deepEqual(transcript,expected)
 console.log(JSON.stringify(transcript))
 if(nativeRoot){
   const {verifyNativeProjectPoint}=await import('./native-project-point.mjs')
   await verifyNativeProjectPoint({lib,temp,config:cfg,context:ctx,store,project:id,projectUuid:coord.id,
     workspace:stored.root_path,source:nativeRoot,staging:nativeStage,windowsVolume})
 }
} finally {
 if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await closed}
 for(const s of sockets)if(s.listening)s.close()
 await Promise.all([control.end(),content.end()]);await rm(temp,{recursive:true,force:true})
}
