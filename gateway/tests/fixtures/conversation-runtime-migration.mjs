/** Session identity and text migrations preserve recorded history and refuse invalid derived fields. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const { createPostgresPool, runMigrations } = await import(new URL(`postgres/database.${mode === 'src' ? 'ts' : 'js'}`, base))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const temporary = await mkdtemp(join(tmpdir(), 'session-runtime-migration-'))

const administration=createPostgresPool(databaseUrl,{max:1}),database=`session_namespace_${randomUUID().replaceAll('-','')}_test`
let pool,created=false
const failures=[]
const migrationRoot=fileURLToPath(new URL('../../deploy/postgres/migrations/',import.meta.url))
async function through(version){
 const target=join(temporary,`through-${version}`);await mkdir(target,{recursive:true})
 for(const name of await readdir(migrationRoot))if(/^\d+.*\.sql$/.test(name)&&Number(name.slice(0,3))<=version)await copyFile(join(migrationRoot,name),join(target,name))
 return target
}
const tables=['conversation_sessions','conversation_append_batches','conversation_events','conversation_search','conversation_participants','conversation_interaction_responses','content_files','conversation_migrations','conversation_migrated_events','conversation_draft_reservations','push_deliveries','project_journal_materials','steward_query_log','project_journal_state','runtime_workspace_catalog']
try{
 await administration.query(`CREATE DATABASE ${database}`);created=true
 const url=new URL(databaseUrl);url.pathname=`/${database}`;pool=createPostgresPool(url.toString(),{max:2})
 await runMigrations(pool,await through(86))
 const organization=(await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Session namespace migration') RETURNING id",[randomUUID()])).rows[0].id
 const node=(await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id",[organization])).rows[0].id
 const users=[]
 for(const username of ['assigned','unassigned'])users.push((await pool.query("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,$2::text,$2::text,'/tmp/session-namespace-migration') RETURNING id,public_id",[organization,username])).rows[0])
 const runtime=(await pool.query('INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,48000) RETURNING runtime_id',[organization,users[0].id,node])).rows[0].runtime_id
 for(const [index,user]of users.entries()){
  const root=`migration-root-${index}`,child=`migration-child-${index}`
  for(const [id,parent]of [[root,null],[child,root]])await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,parent_session_id,root_session_id,visibility,session_format_version,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'personal',1,to_timestamp(1),to_timestamp(1))`,[id,organization,user.id,parent,root])
  await pool.query('INSERT INTO harness.conversation_append_batches(batch_id,session_id,first_seq,event_count,checksum) VALUES($1,$2,0,1,$3)',[randomUUID(),child,Buffer.from('legacy-checksum')])
  const event=' { "seq": 0, "type": "user/message", "time": 1000, "data": { "content": "Preserved \\u0000 body" } } '
  await pool.query("INSERT INTO harness.conversation_events(session_id,seq,event_type,occurred_at,event,payload_bytes) VALUES($1,0,'user/message',to_timestamp(1),$2::json,$3)",[child,event,Buffer.byteLength(event)])
  await pool.query("INSERT INTO harness.conversation_search(session_id,event_seq,role,content,occurred_at) VALUES($1,0,'user','Search body',to_timestamp(1))",[child])
  await pool.query('INSERT INTO harness.conversation_participants(organization_id,conversation_id,user_id,first_contributed_at,last_contributed_at) VALUES($1,$2,$3,to_timestamp(1),to_timestamp(1))',[organization,root,user.id])
  await pool.query("INSERT INTO harness.conversation_interaction_responses(organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome) VALUES($1,'approval',$2,$3,$4,'{}')",[organization,`interaction-${index}`,root,user.id])
  await pool.query("INSERT INTO harness.content_files(organization_id,owner_user_id,session_id,kind,local_path,sha256,byte_length,media_type) VALUES($1,$2,$3,'attachment',$4,$5,1,'text/plain')",[organization,user.id,child,`/tmp/legacy-session-${index}`,'a'.repeat(64)])
  const receipt=(await pool.query('INSERT INTO harness.conversation_migrations(session_id,migration_id,from_format_version,to_format_version,source_revision,event_count) VALUES($1,$2,0,1,\'1:1\',1) RETURNING id',[child,`migration-${index}`])).rows[0].id
  await pool.query("INSERT INTO harness.conversation_migrated_events(migration_id,session_id,seq,event_type,occurred_at,event,payload_bytes) VALUES($1,$2,0,'user/message',to_timestamp(1),$3::json,$4)",[receipt,child,event,Buffer.byteLength(event)])
  await pool.query("INSERT INTO harness.conversation_draft_reservations(organization_id,scope_key,draft_id,session_id,user_id,cwd,visibility,lease_expires_at) VALUES($1,$2,$3,$4,$5,'/tmp','personal',now()+interval '1 minute')",[organization,`scope-${index}`,`draft-${index}`,`reserved-${index}`,user.id])
 }
 await runMigrations(pool,await through(98))
 const project=(await pool.query("INSERT INTO harness.projects(organization_id,name,created_by) VALUES($1,'Preserved project',$2) RETURNING id",[organization,users[0].id])).rows[0].id
 await pool.query("INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,'/tmp/preserved-project','/tmp/preserved-project')",[organization,project,node])
 const projectRuntime=(await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,49000) RETURNING runtime_id',[organization,project,node])).rows[0].runtime_id
 const projectRoot='migration-project-root'
 await pool.query("INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,project_id,creator_user_id,root_session_id,visibility,session_format_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$1,'project',1,to_timestamp(1),to_timestamp(1))",[projectRoot,organization,projectRuntime,project,users[0].id])
 const devices=[]
 for(const [index,user]of users.entries()){
  const device=(await pool.query("INSERT INTO harness.push_devices(organization_id,user_id,token,platform) VALUES($1,$2,$3,'android') RETURNING id",[organization,user.id,`legacy-device-${index}`])).rows[0].id;devices.push(device)
  await pool.query("INSERT INTO harness.push_deliveries(organization_id,session_id,event_seq,device_id,status,attempts) VALUES($1,$2,0,$3,'sent',1)",[organization,`migration-child-${index}`,device])
 }
 const receiptFor=(session,entry)=>createHash('sha256').update(session).update(Buffer.from([0])).update(entry).digest()
 for(const id of [projectRoot,'detached-journal-root'])await pool.query('INSERT INTO harness.project_journal_materials(organization_id,project_id,session_id,entry_id,receipt) VALUES($1,$2,$3,$4,$5)',[organization,project,id,'message:0',receiptFor(id,'message:0')])
 await pool.query("INSERT INTO harness.conversation_interaction_responses(organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome) VALUES($1,'approval','preserved-approval',$2,$3,'\"allowed-once\"')",[organization,projectRoot,users[0].id])
 for(const [classification,approval]of [['write','preserved-approval'],['read',null]])await pool.query("INSERT INTO harness.steward_query_log(organization_id,project_id,runtime_generation,statement,classification,dry_run,approval_interaction_id,responder_user_id,status,row_count,result_bytes) VALUES($1,$2,1,'SELECT 1',$3,false,$4,$5,'ok',1,1)",[organization,project,classification,approval,users[0].id])
 await pool.query("INSERT INTO harness.project_journal_state(organization_id,project_id,watermark_ts,watermark_session,watermark_seq) VALUES($1,$2,to_timestamp(1),$3,0)",[organization,project,projectRoot])
 await pool.query("INSERT INTO harness.runtime_workspace_catalog(organization_id,runtime_id,generation,revision,items) VALUES($1,$2,1,3,'[{\"path\":\"preserved-workspace\"}]')",[organization,runtime])
 const history=async()=>{
  const result={}
  for(const table of tables)result[table]=(await pool.query(`SELECT row_to_json(row) value FROM harness.${table} row`)).rows.map(x=>x.value)
  result.rawEventBytes=(await pool.query('SELECT session_id,seq::text,event::text payload FROM harness.conversation_events ORDER BY session_id,seq')).rows
  result.rawMigratedBytes=(await pool.query('SELECT migration_id,session_id,seq::text,event::text payload FROM harness.conversation_migrated_events ORDER BY session_id,seq')).rows
  return result
 }
 const before=await history()
 await runMigrations(pool,await through(99))
 const after=await history()
 const newlyAdded={
  conversation_sessions:['runtime_namespace'],
  conversation_append_batches:['organization_id','runtime_id','runtime_namespace'],conversation_events:['organization_id','runtime_id','runtime_namespace'],conversation_search:['organization_id','runtime_id','runtime_namespace'],
  conversation_participants:['runtime_id','runtime_namespace'],conversation_interaction_responses:['runtime_id','runtime_namespace'],content_files:['runtime_id','runtime_namespace'],
  conversation_migrations:['organization_id','runtime_id','runtime_namespace'],conversation_migrated_events:['organization_id','runtime_id','runtime_namespace'],conversation_draft_reservations:['runtime_id','runtime_namespace'],
  push_deliveries:['runtime_id','runtime_namespace'],project_journal_materials:['runtime_id','runtime_namespace'],steward_query_log:['runtime_id','runtime_namespace'],project_journal_state:['watermark_runtime_namespace'],runtime_workspace_catalog:[],
 }
 for(const table of tables)for(const row of after[table])for(const field of newlyAdded[table])delete row[field]
 for(const table of tables){before[table].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));after[table].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}
 assert.deepEqual(after,before,'Every legacy column and exact body bytes survive migration099')
 const reserved=(await pool.query('SELECT runtime_id,runtime_namespace FROM harness.conversation_draft_reservations ORDER BY scope_key')).rows
 assert.deepEqual(reserved,[{runtime_id:null,runtime_namespace:'legacy'},{runtime_id:null,runtime_namespace:'legacy'}])
 const unassigned=(await pool.query("SELECT runtime_id,runtime_namespace FROM harness.conversation_sessions WHERE id='migration-root-1'")).rows[0]
 assert.deepEqual(unassigned,{runtime_id:null,runtime_namespace:'legacy'})
 const laterRuntime=(await pool.query("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48002,'isolated') RETURNING runtime_id",[organization,users[1].id,node])).rows[0].runtime_id
 let adoption;try{await pool.query("UPDATE harness.conversation_sessions SET runtime_id=$1 WHERE organization_id=$2 AND id='migration-root-1'",[laterRuntime,organization])}catch(error){adoption=error}
 assert.equal(adoption?.code,'23514','an allocation created later cannot adopt unassigned history')
 let draftAdoption;try{await pool.query("UPDATE harness.conversation_draft_reservations SET runtime_id=$1 WHERE organization_id=$2 AND scope_key='scope-1'",[laterRuntime,organization])}catch(error){draftAdoption=error}
 assert.equal(draftAdoption?.code,'23514','an allocation created later cannot adopt a legacy reservation')
 const retainedPush=(await pool.query('SELECT session_id,runtime_id,runtime_namespace FROM harness.push_deliveries ORDER BY session_id')).rows
 assert.deepEqual(retainedPush,[{session_id:'migration-child-0',runtime_id:runtime,runtime_namespace:runtime},{session_id:'migration-child-1',runtime_id:null,runtime_namespace:'legacy'}])
 const retainedMaterials=(await pool.query('SELECT session_id,runtime_id,runtime_namespace FROM harness.project_journal_materials ORDER BY session_id')).rows
 assert.deepEqual(retainedMaterials,[{session_id:'detached-journal-root',runtime_id:null,runtime_namespace:'legacy'},{session_id:projectRoot,runtime_id:projectRuntime,runtime_namespace:projectRuntime}])
 assert.deepEqual((await pool.query('SELECT classification,runtime_id FROM harness.steward_query_log ORDER BY classification')).rows,[{classification:'read',runtime_id:null},{classification:'write',runtime_id:projectRuntime}])
 assert.equal((await pool.query('SELECT watermark_runtime_namespace FROM harness.project_journal_state WHERE project_id=$1',[project])).rows[0].watermark_runtime_namespace,projectRuntime)
 await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2',[organization,projectRuntime])
 const replacement=(await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,49002) RETURNING runtime_id',[organization,project,node])).rows[0].runtime_id
 assert.notEqual(replacement,projectRuntime)
 await pool.query("INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,project_id,creator_user_id,root_session_id,visibility,session_format_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$1,'project',1,now(),now())",[projectRoot,organization,replacement,project,users[0].id])
 await pool.query('INSERT INTO harness.project_journal_materials(organization_id,project_id,runtime_id,session_id,entry_id,receipt) VALUES($1,$2,$3,$4,$5,$6)',[organization,project,replacement,projectRoot,'message:0',receiptFor(projectRoot,'message:0')])
 assert.equal((await pool.query('SELECT count(*)::int total FROM harness.project_journal_materials WHERE project_id=$1 AND session_id=$2',[project,projectRoot])).rows[0].total,2)
 let wrongMaterial;try{await pool.query('INSERT INTO harness.project_journal_materials(organization_id,project_id,runtime_id,session_id,entry_id,receipt) VALUES($1,$2,$3,$4,$5,$6)',[organization,project,runtime,projectRoot,'message:1',receiptFor(projectRoot,'message:1')])}catch(error){wrongMaterial=error}
 assert.equal(wrongMaterial?.code,'23503','a journal receipt requires its exact project and Runtime Session source')
 const sibling=(await pool.query("INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48001,'isolated') RETURNING runtime_id",[organization,users[0].id,node])).rows[0].runtime_id
 const root='same-local-root',batch=randomUUID()
 for(const [index,runtimeId]of [runtime,sibling].entries()){
  await pool.query("INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,root_session_id,visibility,session_format_version,created_at,updated_at) VALUES($1,$2,$3,$4,$1,'personal',1,now(),now())",[root,organization,runtimeId,users[0].id])
  await pool.query("INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes) VALUES($1,$2,$3,0,'user/message',to_timestamp(1),$4::json,1)",[organization,runtimeId,root,JSON.stringify({seq:0,data:{content:`Body ${index}`}})])
  await pool.query('INSERT INTO harness.conversation_append_batches(organization_id,runtime_id,batch_id,session_id,first_seq,event_count,checksum) VALUES($1,$2,$3,$4,0,1,$5)',[organization,runtimeId,batch,root,Buffer.from([index])])
 }
 const interaction='equal-interaction'
 for(const runtimeId of [runtime,sibling]){
  await pool.query("INSERT INTO harness.conversation_interaction_responses(organization_id,runtime_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome) VALUES($1,$2,'approval',$3,$4,$5,'{}')",[organization,runtimeId,interaction,root,users[0].id])
  await pool.query("INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,parent_session_id,root_session_id,visibility,session_format_version,created_at,updated_at) VALUES('same-local-child',$1,$2,$3,$4,$4,'personal',1,now(),now())",[organization,runtimeId,users[0].id,root])
 }
 assert.equal((await pool.query('SELECT count(*)::int total FROM harness.conversation_interaction_responses WHERE organization_id=$1 AND interaction_id=$2',[organization,interaction])).rows[0].total,2)
 for(const runtimeId of [runtime,sibling])await pool.query("INSERT INTO harness.push_deliveries(organization_id,runtime_id,session_id,event_seq,device_id,status,attempts) VALUES($1,$2,$3,0,$4,'sent',1)",[organization,runtimeId,root,devices[0]])
 assert.equal((await pool.query('SELECT count(*)::int total FROM harness.push_deliveries WHERE organization_id=$1 AND session_id=$2',[organization,root])).rows[0].total,2)
 assert.equal((await pool.query('SELECT count(*)::int total FROM harness.conversation_sessions WHERE organization_id=$1 AND id=$2',[organization,root])).rows[0].total,2)
 for(const [label,sql,values,code]of [
  ['foreign-parent',"INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,parent_session_id,root_session_id,visibility,session_format_version,created_at,updated_at) VALUES('foreign-parent-child',$1,$2,$3,'migration-root-0','migration-root-0','personal',1,now(),now())",[organization,sibling,users[0].id],'23514'],
  ['foreign-migration-reference',"INSERT INTO harness.conversation_migrated_events(migration_id,organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes) SELECT id,$1,$2,session_id,9,'user/message',now(),'{}',1 FROM harness.conversation_migrations WHERE migration_id='migration-0'",[organization,sibling],'23503'],
  ['missing-runtime',"INSERT INTO harness.conversation_events(organization_id,session_id,seq,event_type,occurred_at,event,payload_bytes) VALUES($1,$2,1,'user/message',now(),'{}',1)",[organization,root],'23514'],
  ['foreign-session',"INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes) VALUES($1,$2,'migration-child-0',1,'user/message',now(),'{}',1)",[organization,sibling],'23503'],
  ['reference-reassignment','UPDATE harness.conversation_events SET runtime_id=$1 WHERE organization_id=$2 AND runtime_id=$3 AND session_id=$4',[sibling,organization,runtime,root],'23514'],
 ]){let error;try{await pool.query(sql,values)}catch(e){error=e};assert.equal(error?.code,code,label)}
 await pool.query("DELETE FROM harness.conversation_sessions WHERE organization_id=$1 AND runtime_id=$2 AND parent_session_id=$3",[organization,runtime,root])
 await pool.query('DELETE FROM harness.conversation_sessions WHERE organization_id=$1 AND runtime_namespace=$2::uuid::text AND id=$3',[organization,runtime,root])
 assert.equal((await pool.query('SELECT count(*)::int total FROM harness.conversation_events WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3',[organization,sibling,root])).rows[0].total,1)
 console.log(JSON.stringify({status:'passed',migration:99,legacyTables:tables.length,originalEventBytes:true,legacyRuntimePreserved:true,unknownReservationsNotAdopted:true,laterRuntimeCannotAdopt:true,parentReferenceScoped:true,migrationReferenceScoped:true,equalInteractionIds:2,equalPushKeys:2,equalProjectReceiptKeys:2,workspaceCatalogPreserved:true,equalHostSessions:2,equalBatchIds:2,missingRuntimeRefused:true,foreignReferenceRefused:true,referenceReassignmentRefused:true,siblingBodySurvivesDelete:true}))
 const indexedLegacy='Existing %_\\ CJK尾巴 \n\\u0000'
 const archive=(await pool.query(`INSERT INTO harness.conversation_archive_records(organization_id,root_session_id,runtime_kind,runtime_public_id,runtime_id,node_id,creator_user_id,message_count)
   VALUES($1,'legacy-text-archive','user',$2,$3,$4,$5,1) RETURNING archive_id`,[organization,users[0].public_id,runtime,node,users[0].id])).rows[0].archive_id
 await pool.query(`INSERT INTO harness.conversation_archive_search(organization_id,archive_id,runtime_id,session_id,event_seq,role,content,occurred_at)
   VALUES($1,$2,$3,'legacy-text-archive',0,'user',$4,to_timestamp(1))`,[organization,archive,runtime,indexedLegacy])
 const legacyRequestId=randomUUID(),legacyText='Literal\\u0000 Unicode尾巴😀'
 const legacyRequest={model:'legacy',messages:[{role:'user',content:legacyText}]}
 const legacySession={header:{id:legacyRequestId,version:1,createdAt:1000},inheritedEventCount:0,events:[{seq:0,type:'user/message',time:1000,data:{content:[{type:'text',text:legacyText}]}}]}
 await pool.query("INSERT INTO harness.project_journal(organization_id,project_id,kind,content) VALUES($1,$2,'current',$3::jsonb)",[organization,project,JSON.stringify({summary:legacyText,sections:{decided:[],done:[],doing:[],blocked:[]}})])
 await pool.query(`INSERT INTO harness.project_journal_requests(organization_id,node_id,project_id,project_public_id,request_id,operation_id,actor_public_id,occurred_at,provider,model,credential_source,request,request_session)
   VALUES($1,$2,$3,$4,$5,$6,0,to_timestamp(1),'legacy','legacy','organization',$7::jsonb,$8::jsonb)`,[organization,node,project,1,legacyRequestId,randomUUID(),JSON.stringify(legacyRequest),JSON.stringify(legacySession)])
 const legacyProgress=(await pool.query('SELECT content FROM harness.project_journal WHERE organization_id=$1 AND project_id=$2',[organization,project])).rows
 const legacyEvidence=(await pool.query('SELECT request,request_session FROM harness.project_journal_requests WHERE request_id=$1',[legacyRequestId])).rows

 for(let seq=1;seq<=205;seq++){
  const event={seq,type:'user/message',time:1000+seq,data:{scopeKey:'legacy\u0000scope',source:{kind:'user',participant:{userId:Number(users[0].public_id),displayName:'Legacy\u0000尾巴'}},content:[{type:'text',text:'legacy body'}]}}
  const raw=' '+JSON.stringify(event)+' \n'
  await pool.query(`INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes)
    VALUES($1,$2,$3,$4,'user/message',to_timestamp(1),$5::json,$6)`,[organization,sibling,root,seq,raw,Buffer.byteLength(raw)])
 }
 const original=await pool.query('SELECT organization_id,runtime_namespace,session_id,seq::text,event::text,payload_bytes FROM harness.conversation_events ORDER BY organization_id,runtime_namespace,session_id,seq')
 let updateBatches=0
 const failingPool={connect:async()=>{
  const client=await pool.connect()
  return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('UPDATE harness.conversation_events event SET query_fields')&&++updateBatches===2)throw new Error('Injected second query-field batch failure');return target.query(...args)}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
 }}
 await assert.rejects(runMigrations(failingPool,await through(100)),/Injected second query-field batch failure/)
 assert.equal(updateBatches,2)
 assert.equal((await pool.query('SELECT max(version) version FROM harness.schema_migrations')).rows[0].version,99)
 assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='harness' AND table_name='conversation_events' AND column_name='query_fields'")).rowCount,0)
 assert.deepEqual(await runMigrations(pool,await through(100)),{applied:[100],current:100})
 const current=await pool.query('SELECT organization_id,runtime_namespace,session_id,seq::text,event::text,payload_bytes FROM harness.conversation_events ORDER BY organization_id,runtime_namespace,session_id,seq')
 assert.deepEqual(current.rows,original.rows,'query-field backfill preserves every original JSON byte and payload length')
 const projected=(await pool.query('SELECT query_fields FROM harness.conversation_events WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3 AND seq>0 ORDER BY seq',[organization,sibling,root])).rows
 assert.equal(projected.length,205)
 assert.ok(projected.every(row=>row.query_fields.actorUid===users[0].public_id&&JSON.parse(row.query_fields.actorLabelJson)==='Legacy\u0000尾巴'))
 assert.equal((await pool.query("SELECT convalidated FROM pg_constraint WHERE conrelid='harness.conversation_events'::regclass AND conname='conversation_event_query_fields'")).rows[0].convalidated,true)
 const oldSearch=(await pool.query('SELECT content,content_nul_parts,harness.conversation_search_text(content,content_nul_parts) original FROM harness.conversation_search')).rows
 assert.ok(oldSearch.every(row=>row.content_nul_parts===null&&row.original===row.content))
 const oldArchive=(await pool.query('SELECT content,content_nul_parts,harness.conversation_search_text(content,content_nul_parts) original FROM harness.conversation_archive_search WHERE archive_id=$1',[archive])).rows[0]
 assert.deepEqual(oldArchive,{content:indexedLegacy,content_nul_parts:null,original:indexedLegacy})

 assert.deepEqual((await pool.query('SELECT content FROM harness.project_journal WHERE organization_id=$1 AND project_id=$2',[organization,project])).rows,legacyProgress)
 assert.deepEqual((await pool.query('SELECT request,request_session FROM harness.project_journal_requests WHERE request_id=$1',[legacyRequestId])).rows,legacyEvidence)
 await assert.rejects(pool.query('UPDATE harness.project_journal_requests SET request_session=$2::json WHERE request_id=$1',[legacyRequestId,JSON.stringify({...legacySession,events:[]})]),error=>error.code==='23514'&&error.message==='committed progress request Session is immutable')
 let refused=0
 for(const table of ['conversation_search','conversation_archive_search'])for(const [content,parts]of [['x',['x']],['x',[]],['a\nb',['a',null]],['wrong',['a','b']]]){
  await assert.rejects(pool.query(`UPDATE harness.${table} SET content=$1,content_nul_parts=$2::text[] WHERE runtime_id IS NOT NULL`,[content,parts]),error=>error.code==='23514'&&error.constraint===table+'_nul_text');refused++
 }
 await assert.rejects(pool.query(`INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes)
   VALUES($1,$2,$3,999,'state',now(),'{}',2)`,[organization,sibling,root]),error=>error.code==='23514')
 await assert.rejects(pool.query(`INSERT INTO harness.conversation_events(organization_id,session_id,seq,event_type,occurred_at,event,payload_bytes,query_fields) VALUES($1,'migration-child-1',999,'state',now(),'{}',2,'{}')`,[organization]),error=>error.code==='23514'&&error.constraint==='conversation_event_runtime_registered')

 await assert.rejects(pool.query(`INSERT INTO harness.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes,query_fields)
   VALUES($1,$2,$3,999,'state',now(),'{}',2,'[]')`,[organization,sibling,root]),error=>error.code==='23514'&&error.constraint==='conversation_event_query_fields')
 console.log(JSON.stringify({status:'passed',migration:100,legacyEventBytes:true,legacySearchTables:2,derivedEventRows:205,boundedBackfill:true,secondBatchRollback:true,retryCommitted:true,queryFieldsRequired:true,nonObjectQueryFieldsRefused:true,legacyProgressRetained:true,legacyRequestSessionImmutable:true,legacyRuntimeWriteRefused:true,invalidNulEncodingsRefused:refused}))

}catch(error){failures.push(error)}finally{
 try{await pool?.end()}catch(error){failures.push(error)}
 if(created)try{await administration.query(`DROP DATABASE ${database}`)}catch(error){failures.push(error)}
 try{await administration.end()}catch(error){failures.push(error)}
 try{await rm(temporary,{recursive:true,force:true})}catch(error){failures.push(error)}
}
if(failures.length)throw new AggregateError(failures,'Session migration or fixture cleanup failed')
