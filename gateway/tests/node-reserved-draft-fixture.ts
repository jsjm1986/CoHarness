/** Real HTTP draft preparation and persistence on a disposable physical project volume. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Pool, PoolClient } from 'pg'
import { expect } from 'vitest'
import { NodeContentStore, type NodeContentBinding } from '../src/node-content-store.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { LocalNodeDrafts } from '../src/node-drafts.ts'
import { projectNodeDrafts } from '../src/project-node-drafts.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { PostgresConversationStore } from '../src/postgres/conversation-repository.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { runMigrations, transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, internalUserId } from '../src/postgres/runtime-context.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { testConfig } from './test-config.ts'
import { PostgresWorkspaceCatalog } from '../src/workspace-catalog.ts'
import { workbenchRows } from '../src/workbench-rows.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'

/** Assemble the shipped Gateway handlers and two real databases; no Runtime process or model is needed for a private draft.
 * @param control - isolated governance database. @param content - isolated content database.
 * @param dataDirectory - fixture-owned physical PGDATA. @returns authenticated clients and awaited resource cleanup.
 */
export async function reservedDraftFixture(control:Pool,content:Pool,dataDirectory:string) {
  const releases:Array<()=>Promise<void>>=[]
  const close=async()=>{const errors:unknown[]=[];for(const release of releases.splice(0).reverse()){try{await release()}catch(error){errors.push(error)}}if(errors.length)throw new AggregateError(errors,'Reserved draft fixture cleanup failed')}
  try {
    const root=await mkdtemp(join(await realpath(tmpdir()),'hgw-reserved-drafts-'))
    releases.push(()=>rm(root,{recursive:true,force:true}))
    const slug='draft-'+randomUUID(),name='Draft project'
    await runMigrations(control,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
    const org=(await control.query<{id:string}>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Drafts') RETURNING id",[slug])).rows[0]!.id
    const node=(await control.query<{id:RuntimeNodeId}>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local') RETURNING id",[org])).rows[0]!.id
    const context=await resolvePostgresRuntimeContext(control,slug,'local'),cfg=testConfig(root)
    const users=new PostgresUserService(context,cfg),password='fixture-'+randomUUID()
    const owner=await users.create({username:'owner',password,role:'user'}),other=await users.create({username:'other',password,role:'admin'})
    for(const user of [owner,other])await users.changeOwnPassword(user.id,password)
    const ownerId=(await internalUserId(control,org,owner.id))!,otherId=(await internalUserId(control,org,other.id))!
    for(const id of [ownerId,otherId])await control.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true) ON CONFLICT(organization_id,node_id,user_id) DO UPDATE SET enabled=true',[org,node,id])
    const options={pool:content,organizationId:org,nodeId:node,volumeId:randomUUID(),dataDirectory,proofTimeoutMs:5000}
    await migrateNodeContent(options,resolve(import.meta.dirname,'../deploy/node-content/migrations'))
    const store=await NodeContentStore.open(options)
    const projectRoot=join(root,'project');await mkdir(projectRoot)
    const binding=await transaction(control,async tx=>{
      const project=(await tx.query<{id:string}>("INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id",[org,randomUUID(),ownerId])).rows[0]!.id
      await tx.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',[org,project,node,'urn:hgw:project:'+project])
      await tx.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw'),($1,$2,$4,'rw')",[org,project,ownerId,otherId])
      const runtimeId=(await tx.query<{runtime_id:RuntimeId}>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47300) RETURNING runtime_id',[org,project,node])).rows[0]!.runtime_id
      const key=await store.stageProject(tx,{projectId:project,runtimeId,name,rootPath:projectRoot})
      // This fixture mounts only Session and draft domains, not document or backup providers.
      await tx.query('INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch) VALUES($1,$2,$3,$4,$5,$6)',[org,project,node,runtimeId,key.volumeId,key.writerEpoch])
      return key
    })
    const projectId=Number((await control.query('SELECT public_id FROM harness.projects WHERE id=$1',[binding.projectId])).rows[0]!.public_id)
    const token=randomUUID()
    await control.query("UPDATE harness.instances SET runtime_token_hash=$3,runtime_token_issued_at=now(),generation=1,desired_state='running',observed_state='ready' WHERE organization_id=$1 AND runtime_id=$2",[org,binding.runtimeId,createHash('sha256').update(token).digest()])
    const repository=new PostgresInstanceRepository(context,47300),instances=new InstanceManager(repository,cfg,{instancesOutliveGateway:true,start:async()=>{throw new Error('Draft requests must not start a Runtime')}})
    const collaboration=new PostgresCollaborationService(context,node,store),principals=new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey,slug,60_000)
    const conversations=new PostgresConversationStore(control,store),disk=new LocalNodeDrafts(cfg.stateRoot)
    releases.push(()=>disk.close())
    let beforeFinalRead:(()=>Promise<void>)|undefined
    let afterFinalRead:(()=>Promise<void>)|undefined
    const local={read:store.read.bind(store),write:store.write.bind(store),confirmCollaborationRead:async<T>(b:NodeContentBinding,revision:string,finish:(tx:PoolClient)=>Promise<T>,generation?:number)=>{
      await beforeFinalRead?.()
      return store.confirmCollaborationRead(b,revision,async tx=>{const value=await finish(tx);await afterFinalRead?.();return value},generation)
    }}
    const drafts=projectNodeDrafts(context,disk,local)
    const catalog=new PostgresRuntimeCatalog(context,cfg.runtimeCatalog,node)
    const deps:GatewayDeps={cfg,users,instances,auth:new PostgresAuthService(context,cfg),projects:new PostgresProjectService(context,cfg),audit:new PostgresAuditService(context),collaboration,
      runtimeCatalog:catalog,nodeServiceIdentity:{organizationId:org,nodeId:node,authorize:async()=>{throw new Error('No remote handoff in this fixture')}}}
    deps.runtimeRouter=new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps),{localNodeId:node,catalog})
    const runtime=createRuntimeApiHandler({context,instances:repository,conversations,nodeContent:store,collaboration,principals,
      governance:new PostgresModelGovernanceService(context,new OrganizationModelCredentialCipher(Buffer.alloc(32,13)),'UTC',store)})
    const server=createGatewayServer(deps,{nodeDrafts:drafts,runtime,
      workbenchRows:workbenchRows(context,new PostgresWorkspaceCatalog(context,node,undefined,store),collaboration,cfg.runtimeCatalog,store),
      runtimeAuthorize:async req=>typeof req.headers.authorization==='string'&&await repository.authenticateRuntimeToken(req.headers.authorization.slice(7))!==null})
    releases.push(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()))})
    await new Promise<void>((done,reject)=>server.once('error',reject).listen(0,'127.0.0.1',done))
    const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;cfg.publicOrigins.push(base)
    const cookies=new Map<number,string>()
    for(const user of [owner,other]){
      const response=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin:base},body:new URLSearchParams({username:user.username,password})})
      await response.arrayBuffer();expect(response.status).toBe(302);cookies.set(user.id,response.headers.getSetCookie()[0]!.split(';')[0]!)
    }
    async function request<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,user=owner.id,internal=false){
      const caller=user===owner.id?owner:other
      const principal=principals.issue({user:{...caller,mustChangePassword:false},runtime:{kind:'project',id:projectId,runtimeId:binding.runtimeId,generation:1},scope:{kind:'project',projectId,projectName:name,mode:'rw'}})
      const response=await fetch(base+path,{method,headers:{origin:base,cookie:cookies.get(user)!,'content-type':'application/json',...(internal?{authorization:'Bearer '+token,[PRINCIPAL_HEADER]:principal}:{})},body:body===undefined?undefined:JSON.stringify(body)})
      return {status:response.status,body:await response.json() as T}
    }
    const prepare=async()=>{
      const sessionId='session-'+randomUUID(),draftId=randomUUID()
      const prepared=await request('/internal/runtime/session/draft/reserve','POST',{sessionId,draftId,cwd:projectRoot,visibility:'private'},owner.id,true)
      expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);expect(prepared.body.sessionId).toBe(sessionId)
      const creation=await request<{authorization:string}>('/internal/runtime/session/create','POST',{header:{id:sessionId,version:1,createdAt:Date.now(),cwd:projectRoot,draft:true},visibility:'private'},owner.id,true)
      expect(creation.status,JSON.stringify(creation.body)).toBe(200)
      return {sessionId,reservationId:draftId,editorId:randomUUID(),authorization:creation.body.authorization}
    }
    const draft=(sessionId:string,editorId:string)=>'/account/api/drafts/'+editorId+'?'+new URLSearchParams({dshNode:node,dshRuntime:binding.runtimeId,dshTarget:'project:'+projectId,sessionId})
    const documentTarget=(sessionId:string)=>'/account/api/workbench/rows?'+new URLSearchParams({dshNode:node,dshRuntime:binding.runtimeId,dshTarget:'project:'+projectId,documentSession:sessionId})
    return {control,content,context,store,drafts,binding,owner,ownerId,other,otherId,projectId,request,prepare,draft,documentTarget,conversations,
      pauseFinalRead:(hook:(()=>Promise<void>)|undefined)=>{beforeFinalRead=hook},
      retainFinalRead:(hook:(()=>Promise<void>)|undefined)=>{afterFinalRead=hook},[Symbol.asyncDispose]:close}
  }catch(error){await close();throw error}
}

/**
 * Drive preparation, private drafts, and the first durable input through authenticated Gateway handlers.
 * @param f - physical project and its authenticated clients.
 * @returns the resulting keyless workflow transcript.
 */
export async function reservedDraftTranscript(f:Awaited<ReturnType<typeof reservedDraftFixture>>):Promise<string>{
  const prepared=await f.prepare(),url=f.draft(prepared.sessionId,prepared.editorId),otherTab=f.draft(prepared.sessionId,randomUUID())
  expect((await f.content.query('SELECT FROM node_content.conversation_sessions WHERE organization_id=$1 AND runtime_id=$2 AND id=$3',[f.context.organizationId,f.binding.runtimeId,prepared.sessionId])).rowCount).toBe(0)
  expect(await f.request(url,'PUT',{revision:0,text:'first tab draft'})).toEqual({status:200,body:{revision:1,text:'first tab draft'}})
  expect(await f.request(url)).toEqual({status:200,body:{revision:1,text:'first tab draft'}})
  expect(await f.request(otherTab)).toEqual({status:200,body:{revision:0,text:''}})
  expect((await f.request(otherTab,'PUT',{revision:0,text:'second tab draft'})).status).toBe(200)
  expect((await f.request(url)).body.text).toBe('first tab draft')
  expect((await f.request(url,'GET',undefined,f.other.id)).status).toBe(403)
  expect(await f.request(f.documentTarget(prepared.sessionId))).toEqual({status:200,body:{runtimeId:f.binding.runtimeId,sessionId:prepared.sessionId,canWrite:true}})
  expect((await f.request(f.documentTarget(prepared.sessionId),'GET',undefined,f.other.id)).status).toBe(409)

  const appendPath='/internal/runtime/session/append'
  const source={kind:'user',rpcId:randomUUID(),participant:{userId:f.owner.id},admission:{key:'a'.repeat(64),digest:'b'.repeat(64)}}
  const message={id:randomUUID(),role:'user',source,content:[{type:'text',text:'first submitted message'}]}
  const queued={seq:0,time:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[message]}}
  const queuedBatch={sessionId:prepared.sessionId,batchId:randomUUID(),creationAuthorization:prepared.authorization,events:[queued]}
  expect(await f.request(appendPath,'POST',queuedBatch,f.owner.id,true)).toEqual({status:200,body:{result:'inserted'}})
  const receiptPath='/internal/runtime/session/read-event?'+new URLSearchParams({sessionId:prepared.sessionId,seq:'0'})
  const receipt=await f.request(receiptPath,'GET',undefined,f.owner.id,true)
  expect(receipt.status,JSON.stringify(receipt.body)).toBe(200)
  expect(receipt.body).toMatchObject({header:{id:prepared.sessionId,draft:true},events:[queued]})
  expect(await f.request(appendPath,'POST',queuedBatch,f.owner.id,true)).toEqual({status:200,body:{result:'duplicate'}})

  const visible={seq:1,time:2,type:'user/message',surfaceOp:'append',data:message}
  const append=await f.request(appendPath,'POST',{sessionId:prepared.sessionId,batchId:randomUUID(),events:[visible]},f.owner.id,true)
  expect(append).toEqual({status:200,body:{result:'inserted'}})
  const history=await f.request('/internal/runtime/session/load?sessionId='+encodeURIComponent(prepared.sessionId),'GET',undefined,f.owner.id,true)
  expect(history.status,JSON.stringify(history.body)).toBe(200)
  expect(history.body.events).toEqual([queued,visible])
  expect((await f.request(url)).body.text).toBe('first tab draft')
  expect((await f.request(otherTab)).body.text).toBe('second tab draft')
  expect(await f.request(url,'GET',undefined,f.other.id)).toEqual({status:200,body:{revision:0,text:''}})
  expect((await f.control.query('SELECT FROM harness.conversation_sessions WHERE organization_id=$1 AND runtime_id=$2',[f.context.organizationId,f.binding.runtimeId])).rowCount).toBe(0)
  expect((await f.content.query('SELECT FROM node_content.composer_drafts WHERE organization_id=$1 AND runtime_id=$2',[f.context.organizationId,f.binding.runtimeId])).rowCount).toBe(2)
  return [
    '# Reserved project drafts',
    '',
    'Authenticated preparation: one unmaterialized Session on the project computer.',
    'First tab: save HTTP 200, read HTTP 200; private text preserved.',
    'Second tab: independent draft; neither tab overwrites the other.',
    'Another account with project and administrator access: unmaterialized draft HTTP 403.',
    'Document target: creator HTTP 200 with exact coordinates; another account HTTP 409.',
    'Queued input: exact committed receipt before the first visible message; replay keeps one insertion.',
    'First submitted message: persisted once on the project volume; authorized history HTTP 200.',
    'Both drafts remain readable after Session materialization.',
    'Governance database: no Session body; content database: two private draft records.',
    '',
  ].join('\n')
}
