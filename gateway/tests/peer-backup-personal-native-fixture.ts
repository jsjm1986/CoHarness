/** Real SQL, SQLite, UserDoc and JSONL recovery with a fixture-owned immutable file view; no user Runtime is started. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION,SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { expect } from 'vitest'
import type { Pool } from 'pg'
import type { PeerBackupBinding,PeerCapture } from '../src/peer-backup-restic.ts'
import { createPostgresPool,runMigrations } from '../src/postgres/database.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { NodeContentStore } from '../src/node-content-store.ts'
import { PeerPersonalExporter,readPersonalRecoveryPoint,restorePeerPersonalFiles } from '../src/peer-backup-personal.ts'
import { PeerPersonalFiles } from '../src/peer-backup-personal-files.ts'
import { openPersonalIndex } from '../src/personal-index-worker.ts'
import { openDraftStorage } from '../src/node-drafts.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { InstanceManager } from '../src/instances.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'

export interface PersonalNativeFixture {root:string;volume:string;state:string;users:string;home:string;accountHome:string;workspace:string;org:string;node:string;runtime:string;account:string;userId:number;volumeId:string;generation:number;control:Pool;content:Pool;store:NodeContentStore;binding:PeerBackupBinding;captured:PeerCapture;payload:string;limits:{maxBytes:number;maxRows:number;reserveBytes:number};signal:AbortSignal;proof:Awaited<ReturnType<typeof readPersonalRecoveryPoint>>}
/** Own all writers for one immutable native snapshot and supply actual SQL, SQLite, document and JSONL stores. */
export async function personalNativeFixture(work?:(value:PersonalNativeFixture)=>Promise<void>,options:{emptyWorkspace?:boolean}={}){
  const controlUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL),pgdata=process.env.HGW_TEST_NODE_CONTENT_PGDATA
  const root=await realpath(await mkdtemp(join(tmpdir(),'personal-native-'))),volume=join(root,'volume'),state=join(volume,'state'),users=join(volume,'users'),
    accountHome=join(users,'owner'),home=join(accountHome,'dsh'),workspace=join(accountHome,'workspace'),profile=join(home,'profiles','web')
  const org=randomUUID(),node=randomUUID(),runtime=randomUUID(),account=randomUUID(),volumeId=randomUUID(),databaseName='personal_'+randomUUID().replaceAll('-','')
  const control=createPostgresPool(controlUrl!,{max:3}),contentUrl=new URL(controlUrl!),context=new Context()
  contentUrl.pathname='/'+databaseName
  let content:ReturnType<typeof createPostgresPool>|undefined
  const signal=AbortSignal.timeout(60000),limits={maxBytes:32<<20,maxRows:5000,reserveBytes:4096}
  try{
    await runMigrations(control,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    await control.query(`CREATE DATABASE "${databaseName}"`)
    content=createPostgresPool(contentUrl.href,{max:3})
    await control.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1::uuid,$1::uuid::text,'Personal native fixture')",[org])
    await control.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$2,'Source')",[node,org])
    const userId=Number((await control.query(`INSERT INTO harness.users(id,organization_id,username,display_name,home_path)
      VALUES($1,$2,'owner','Owner',$3) RETURNING public_id`,[account,org,accountHome])).rows[0]!.public_id)
    await control.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')",[org,account])
    await control.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[org,node,account])
    await control.query('INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,$4,49020)',[runtime,org,account,node])
    const generation=Number((await control.query('SELECT generation FROM harness.instances WHERE id=$1',[runtime])).rows[0]!.generation)
    await control.query('INSERT INTO harness.personal_directory_placement VALUES($1,$2,$3,$4)',[runtime,org,node,account])
    const nodeOptions={pool:content,organizationId:org,nodeId:node,volumeId,dataDirectory:pgdata!,proofTimeoutMs:5000}
    await migrateNodeContent(nodeOptions,resolve(import.meta.dirname,'../deploy/node-content/migrations'))
    const store=await NodeContentStore.open(nodeOptions);await store.registerVolume(control)
    for(const path of [join(state,'personal-directory'),join(state,'node-content-drafts'),profile,join(home,'storages'),workspace,join(accountHome,'documents')])await mkdir(path,{recursive:true,mode:0o700})
    await writeFile(join(profile,'package.json'),JSON.stringify({name:'personal-test',type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
    await writeFile(join(profile,'cordis.patch.yml'),'[]\n')
    const sourceContext=await resolvePostgresRuntimeContext(control,org,'Source'),sourceCfg=testConfig(volume)
    const manager=new InstanceManager(new PostgresInstanceRepository(sourceContext,sourceCfg.instancePortBase),sourceCfg)
    try{await manager.prepareRecoveryProfile({kind:'user',id:userId,runtimeId:runtime as RuntimeId})}finally{await manager.stopAll()}
    await mkdir(join(profile,'node_modules','fixture-private-plugin'),{recursive:true,mode:0o700})
    await writeFile(join(profile,'node_modules','fixture-private-plugin','package.json'),JSON.stringify({name:'fixture-private-plugin',version:'1.0.0',type:'module',main:'index.js'}))
    await writeFile(join(profile,'node_modules','fixture-private-plugin','index.js'),'export default function retainedPrivatePlugin() {}\n')
    await writeFile(join(home,'.env'),'HGW_DATABASE_URL=retired-control\nHGW_NODE_TOKEN=retired-node\nDSH_GATEWAY_CREDENTIAL_FD=99\nPGPASSWORD=retired-password\nDATABASE_URL=retired-database\nBUSINESS_SETTING=keep-business\nPGP_TEST=keep-signing\n',{mode:0o600})
    await writeFile(join(home,'storages','schedule.json'),JSON.stringify({unit:{name:'schedule',version:1},global:null,tables:{tasks:{}}}))
    if(!options.emptyWorkspace)await writeFile(join(workspace,'work.txt'),'original work\n')
    await writeFile(join(home,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:options.emptyWorkspace?[]:['work'],archivedSessionIds:[],pinnedSessionIds:[],archiveRevision:0},tables:{workspaces:options.emptyWorkspace?{}:{work:{path:workspace,title:'Work',sessionIds:['old-root'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}}}}))
    await context.plugin(Persistence,{root:join(home,'sessions'),compression:'none'})
    const persistence:SessionPersistence=context.sessionPersistence
    for(const id of options.emptyWorkspace?[]:['old-root','old-child']){
      const writer=await persistence.create({version:SESSION_FORMAT_VERSION,id:SessionId(id),createdAt:1,cwd:workspace,isSeeded:false,
        ...(id==='old-child'?{parentSession:SessionId('old-root'),origin:'subagent' as const,delegationDepth:1}:{delegationDepth:0})})
      try{await writer.append([{type:'agent/inbox/spliced',seq:SessionSeq(0),time:2,data:{target:'next-turn',start:0,
        inserted:[createUserMessage({content:[{type:'text',text:'Retained pending work'}],source:{kind:'user'}})]}}])}finally{await writer.close()}
    }
    await context.fiber.dispose()
    for(const [owner,key,kind] of [
      ['@deepseek-ai/dsh-session-persistence-jsonl','sessions','directory'],['@deepseek-ai/dsh-storage-json','storages','directory'],
      ['app-boot','profiles/web/package.json','file'],['app-boot','profiles/web/cordis.patch.yml','file'],
    ] as const)registerManagedDataPath({owner,path:join(home,key),kind},join(home,'managed-data.jsonl'))
    const catalog=new DatabaseSync(join(state,'personal-directory','index.sqlite')),drafts=new DatabaseSync(join(state,'node-content-drafts','drafts.sqlite'))
    try{
      openPersonalIndex(catalog)({op:'publish',owner:{organizationId:org,nodeId:node,runtimeId:runtime,userId},input:{generation,snapshot:{revision:1,
        items:options.emptyWorkspace?[]:[{workspaceId:'work',title:'Work',path:workspace,sessionIds:['old-root'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}],conversations:[]}}})
      openDraftStorage(drafts)
      for(const tab of options.emptyWorkspace?[]:['tab-a','tab-b'])drafts.prepare('INSERT INTO drafts(identity,revision,text,previous_versions) VALUES(?,1,?,?)')
        .run(JSON.stringify([org,node,userId,runtime,'personal','old-root',tab]),'draft-'+tab,'[]')
    }finally{catalog.close();drafts.close()}
    const docs={root:join(accountHome,'documents'),stateRoot:join(state,'doc-metadata'),filesRoot:join(state,'doc-objects')}
    await mkdir(docs.stateRoot,{recursive:true,mode:0o700});await mkdir(docs.filesRoot,{recursive:true,mode:0o700})
    const engine=new LocalUserDocFs({root:docs.root,controlRoot:docs.filesRoot,identityLocations:docs,
      limits:{maxFileBytes:1<<20,maxFilesPerMessage:4,maxMessageBytes:4<<20,maxInlineTextBytes:1024,
        upload:{protocol:'resumable-v1',chunkBytes:65536,sessionTtlMs:60000,resumable:true}},
      upload:{chunkBytes:65536,sessionTtlMs:60000,minFreeBytes:0,maxConcurrent:2,cleanupIntervalMs:60000,manifestMaxBytes:65536},sweepIntervalMs:60000,trashRetentionMs:86400000})
    let rootId:string,head:{sequence:number;ordinal:number},documents:Awaited<ReturnType<NonNullable<typeof engine.identities>['snapshot']>>['documents']
    try{
      await engine.warm();await writeFile(join(docs.root,'document.txt'),'important document\n');await engine.list()
      rootId=await engine.identities!.rootId();documents=(await engine.identities!.snapshot()).documents
      head=(await engine.identities!.projectionChanges({sequence:0,ordinal:0},{limit:20,maxBytes:1<<20})).head
      await engine.identities!.acknowledgeProjection(head)
    }finally{await engine.dispose()}
    await content.query(`INSERT INTO node_content.document_roots(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,sequence,ordinal)
      VALUES($1,$2,'personal',$3,$4,$5,1,$6,$7)`,[org,node,account,rootId,volumeId,head.sequence,head.ordinal])
    for(const doc of documents)await content.query(`INSERT INTO node_content.document_entries(organization_id,root_id,incarnation_id,revision,doc_id,directory_id,name,bytes,media_type,modified_at_ms,owner_public_id,origin,state)
      VALUES($1,$2,$3,$4,$5,'',$5,$6,$7,$8,$9,$10,$11)`,[org,rootId,doc.incarnationId,doc.revision,doc.docId,doc.bytes,doc.mediaType,Math.floor(doc.modifiedAt),userId,doc.origin,doc.state])
    await control.query(`INSERT INTO harness.document_scope_placement(organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision)
      VALUES($1,$2,'personal',$3,$4,$5,1,1)`,[org,node,account,rootId,volumeId])
    const conf=join(root,'snapshot.json')
    await writeFile(conf,JSON.stringify({version:1,organizationId:org,nodeId:node,provider:'btrfs',runtimes:[{runtimeId:runtime,source:volume,snapshotDirectory:root,workspaces:options.emptyWorkspace?[]:[{id:'work',path:workspace}]}]}),{mode:0o600})
    let released=0
    // This private fixture owns every writer and keeps the generation immutable while the provider lease is held.
    const files=new PeerPersonalFiles(control,conf,1000,async()=>({homePath:accountHome,dshHome:home}),async()=>docs,async()=>({root:volume,map:path=>path,confirm:async()=>{},release:async()=>{released++}}))
    const exporter=new PeerPersonalExporter(control,state,limits,control,files,store)
    const binding={organizationId:org,sourceNodeId:node,targetNodeId:randomUUID(),policyId:randomUUID(),scopeId:runtime,revision:1}
    const payload=join(root,'payload');await mkdir(payload)
    const captured=await exporter.capture(binding,payload,signal)
    expect(captured.gaps).toEqual([])
    const proof=await readPersonalRecoveryPoint(binding,captured,payload,limits,signal)
    expect(proof.recovery.oldSessionIds).toEqual(options.emptyWorkspace?[]:['old-child','old-root'])
    expect(proof).toMatchObject({format:'native-personal-v3',owner:account,userId,runtimeId:runtime,sourceNodeId:node})
    const restored=join(root,'restored');await restorePeerPersonalFiles(binding,captured,payload,restored,limits,signal)
    const recoveredDrafts=new DatabaseSync(join(restored,'node-state','node-content-drafts','drafts.sqlite'),{readOnly:true})
    try{expect(recoveredDrafts.prepare('SELECT text FROM drafts ORDER BY text').all()).toEqual(options.emptyWorkspace?[]:[{text:'draft-tab-a'},{text:'draft-tab-b'}])}finally{recoveredDrafts.close()}
    expect(await readFile(join(home,'storages','schedule.json'),'utf8')).toContain('schedule')
    expect(await readFile(join(restored,'content','accounts',account,node,'userdoc-public','document.txt'),'utf8')).toBe('important document\n')
    expect(released).toBe(1)
    await control.query(`INSERT INTO harness.conversation_sessions(id,organization_id,runtime_id,creator_user_id,session_format_version,
      created_at,updated_at,visibility,root_session_id) VALUES('legacy',$1,$2,$3,1,now(),now(),'personal','legacy')`,[org,runtime,account])
    const legacy=join(root,'legacy');await mkdir(legacy)
    const partial=await exporter.capture(binding,legacy,signal)
    expect(partial.gaps).toContain('database:legacy-personal-sessions')
    await expect(readPersonalRecoveryPoint(binding,partial,legacy,limits,signal)).rejects.toThrow('personal-complete-checkpoint-required')
    await expect(readPersonalRecoveryPoint({...binding,sourceNodeId:randomUUID()},captured,payload,limits,signal)).rejects.toThrow()
    await control.query("DELETE FROM harness.conversation_sessions WHERE organization_id=$1 AND runtime_id=$2 AND id='legacy'",[org,runtime])
    await work?.({root,volume,state,users,home,accountHome,workspace,org,node,runtime,account,userId,volumeId,generation,control,content,store,binding,captured,payload,limits,signal,proof})
  }finally{
    await context.fiber.dispose();await content?.end()
    await control.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await control.end();await rm(root,{recursive:true,force:true})
  }
}
