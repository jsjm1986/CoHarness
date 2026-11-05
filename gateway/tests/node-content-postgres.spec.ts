/** Real control/content databases and an authenticated Runtime HTTP connection. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp,realpath,rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { escapeIdentifier, escapeLiteral, type PoolClient } from 'pg'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { verifyExecutionAttribution } from '../src/execution-identity.ts'
import { createRuntimeApiHandler } from '../src/runtime-api.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { PostgresConversationStore, type ConversationEvent } from '../src/postgres/conversation-repository.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { migrateNodeContent } from '../src/node-content-migrations.ts'
import { NodeContentStore, NodeContentUnavailable, type NodeContentBinding } from '../src/node-content-store.ts'
import { NodeContentCollaboration } from '../src/node-content-collaboration.ts'
import { NodeContentMigration } from '../src/node-content-migration.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import type { RuntimeStopOperationId } from '../src/instances.ts'
import { NodeContentPublication } from '../src/node-content-publication.ts'
import { DEFAULT_PROGRESS_CONFIG,PostgresProgressService } from '../src/postgres/progress-service.ts'
import { PostgresProgressUsage } from '../src/postgres/progress-usage.ts'
import { verifyProjectRecoveryPoint } from './peer-backup-node-content-flow.ts'
import { verifySlowConversationRevocation } from './node-content-read-revocation.ts'
import { verifyAdminProjectMigration } from './node-content-migration-admin-flow.ts'
import { verifyNodeProjectNames } from './node-content-project-flow.ts'
import { verifyNodePluginStorage } from './node-content-plugin-flow.ts'
import { verifyPublishedArchive } from './node-archive-flow.ts'
import { verifyPersonalDocumentHistory } from './node-content-personal-document-history.ts'
import { verifyPublishedDocuments } from './node-content-documents-flow.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const controlUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const contentUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_NODE_CONTENT_DATABASE_URL)
const dataDirectory = process.env.HGW_TEST_NODE_CONTENT_PGDATA
const nodeMigrations = resolve(import.meta.dirname, '../deploy/node-content/migrations')
const skip = !controlUrl || !contentUrl || !dataDirectory

describe.skipIf(skip)('physical project content PostgreSQL', () => {
  it('serves committed Session history through the authenticated Runtime while keeping the control database private', async () => {
    if (new URL(controlUrl!).pathname === new URL(contentUrl!).pathname) throw new Error('This fixture requires two separate disposable databases.')
    const control = createPostgresPool(controlUrl!, { max: 3 })
    const content = createPostgresPool(contentUrl!, { max: 3 })
    const appUrl=new URL(contentUrl!)
    appUrl.username='hgw_node_app_'+randomUUID().replaceAll('-','')
    appUrl.password=randomUUID()
    const application=createPostgresPool(appUrl.href,{ max:3 })
    const server = createServer()
    const work=await mkdtemp(resolve(await realpath(tmpdir()),'hgw-content-workspace-'))
    try {
      await runMigrations(control, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
      const slug = 'node-'+randomUUID(), label = 'test computer'
      const org = (await control.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Organization') RETURNING id",[slug])).rows[0]!.id
      const node = (await control.query<{ id: string }>('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id',[org,label])).rows[0]!.id
      const options = { pool: content, organizationId: org, nodeId: node, volumeId: randomUUID(), dataDirectory: dataDirectory!, proofTimeoutMs: 5000 }
      await expect(migrateNodeContent({ ...options, pool: control }, nodeMigrations)).rejects.toBeInstanceOf(NodeContentUnavailable)
      expect((await control.query("SELECT to_regnamespace('node_content') n")).rows[0].n).toBeNull()
      await content.query('CREATE ROLE '+escapeIdentifier(appUrl.username)+' LOGIN PASSWORD '+escapeLiteral(appUrl.password))
      const version = await migrateNodeContent(options,nodeMigrations,appUrl.username)
      expect(version).toBeGreaterThan(0)
      expect(await migrateNodeContent(options,nodeMigrations)).toBe(version)
      const store = await NodeContentStore.open({...options,pool:application})
      await expect(application.query("SELECT pg_read_binary_file('global/pg_control',0,8)")).rejects.toMatchObject({code:'42501'})
      await expect(application.query('UPDATE node_content.volume SET cluster_id=cluster_id')).rejects.toMatchObject({code:'42501'})
      await expect(NodeContentStore.open({ ...options,volumeId: randomUUID() })).rejects.toBeInstanceOf(NodeContentUnavailable)
      const { rows: users } = await control.query<{ id:string;public_id:string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'owner','Owner','/owner'),($1,'member','Member','/member') RETURNING id,public_id::text`,[org])
      const owner = users[0]!, member = users[1]!
      for (const u of users) {
        await control.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)",[u.id])
        await control.query("INSERT INTO harness.memberships(organization_id,user_id,role,status) VALUES($1,$2,'member','active')",[org,u.id])
        await control.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)',[org,node,u.id,'/user/'+u.id])
        await control.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[org,node,u.id])
      }
      const privateName = 'Sensitive project '+randomUUID(), rootPath = work
      const b = await transaction(control, async (tx:PoolClient):Promise<NodeContentBinding> => {
        const project = (await tx.query<{id:string}>("INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id",[org,randomUUID(),owner.id])).rows[0]!.id
        const ref = '/opaque/'+project
        await tx.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',[org,project,node,ref])
        await tx.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw'),($1,$2,$4,'rw')",[org,project,owner.id,member.id])
        const runtimeId = (await tx.query<{runtime_id:RuntimeId}>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47300) RETURNING runtime_id',[org,project,node])).rows[0]!.runtime_id
        const seed={projectId:project,runtimeId,name:privateName,rootPath}
        await expect(store.bindNewProject(tx,seed)).rejects.toThrow('Project content services are not ready')
        const staged=await store.stageProject(tx,seed)
        // The synthetic fixture publishes a Session-only allocation directly; production requires all project domains.
        await tx.query(`INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch)
          VALUES($1,$2,$3,$4,$5,$6)`,[org,project,node,runtimeId,staged.volumeId,staged.writerEpoch])
        return staged
      })
      await verifyPublishedDocuments(control,store,b)
      const scope = { organizationId:org,runtimeId:b.runtimeId }, subject = { generation:1,contentBinding:b }
      const conversations = new PostgresConversationStore(control,store)
      const repository = conversations.forRuntime(scope,subject)
      const sessionId = randomUUID(), batch = randomUUID()
      const header = { ...scope,id:sessionId,creatorUserId:owner.id,projectId:b.projectId,visibility:'private' as const,sessionFormatVersion:1,createdAt:1000,cwd:rootPath }
      const words = 'node-only\u0000'+randomUUID()
      const event:ConversationEvent = { seq:0,time:1001,type:'user/message',surfaceOp:'append',data:{
        source:{kind:'user',participant:{userId:Number(owner.public_id)}},content:[{type:'text',text:words}] } }
      expect(await repository.append(sessionId,batch,[event],header)).toBe('inserted')
      expect(await repository.append(sessionId,batch,[event],header)).toBe('duplicate')
      await expect(repository.append(sessionId,batch,[{...event,time:1002}],header)).rejects.toThrow('different content')
      expect((await repository.load(sessionId))?.events).toEqual([event])
      expect((await repository.search(org,'\u0000')).map(row=>row.content)).toEqual([words])
      const localAcl = new NodeContentCollaboration(control,store,b)
      expect((await localAcl.listProjectRows(Number(owner.public_id),{limit:16}))[0]).toMatchObject({sessionId,runtime:{projectName:privateName},cwd:rootPath})
      expect(await localAcl.listProjectRows(Number(member.public_id),{limit:16})).toEqual([])
      await content.query(`INSERT INTO node_content.workspace_catalog(organization_id,project_id,runtime_id,generation,revision,items)
        VALUES($1,$2,$3,1,1,$4::jsonb)`,[org,b.projectId,b.runtimeId,JSON.stringify([{workspaceId:'selected',sessionIds:[sessionId]},{workspaceId:'empty',sessionIds:[]}])])
      expect((await localAcl.listProjectRows(Number(owner.public_id),{limit:1,workspaceId:'selected'})).map(row=>row.sessionId)).toEqual([sessionId])
      expect(await localAcl.listProjectRows(Number(owner.public_id),{limit:1,workspaceId:'empty'})).toEqual([])
      expect(await localAcl.listProjectRows(Number(member.public_id),{limit:1,workspaceId:'selected'})).toEqual([])
      await expect(localAcl.access(Number(member.public_id),b.runtimeId,sessionId,'read')).rejects.toThrow()
      await localAcl.setVisibility(Number(owner.public_id),b.runtimeId,sessionId,'project')
      expect((await localAcl.access(Number(member.public_id),b.runtimeId,sessionId,'write')).canWrite).toBe(true)
      await verifySlowConversationRevocation(control,content,store,b,member,sessionId)
      const context = { pool:control,organizationId:org,organizationSlug:slug,nodeId:node,nodeName:label }
      await verifyPersonalDocumentHistory(context,store,work)
      const token = randomUUID()
      await control.query("UPDATE harness.instances SET runtime_token_hash=$3,runtime_token_issued_at=now(),generation=1,desired_state='running',observed_state='ready' WHERE organization_id=$1 AND runtime_id=$2",[org,b.runtimeId,createHash('sha256').update(token).digest()])
      await verifyPublishedArchive(context,content,store,b,owner,sessionId)
      const instances = new PostgresInstanceRepository(context,47300)
      expect((await instances.authenticateRuntimeToken(token))?.contentBinding).toEqual(b)
      const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey,slug,60000)
      const governance = new PostgresModelGovernanceService(context,new OrganizationModelCredentialCipher(Buffer.alloc(32,31)),'Asia/Shanghai',store)
      const syntheticKey=randomUUID()
      let observedPrompt:string|undefined
      let digestRequest:string|undefined
      const handler = createRuntimeApiHandler({ context, instances, conversations, nodeContent:store,
        collaboration:new PostgresCollaborationService(context,undefined,store),
        principals,governance })
      server.on('request',(req,res)=>{ void (async()=>{
        const chunks:Buffer[]=[];for await(const part of req) chunks.push(Buffer.from(part))
        const url=new URL(req.url!,'http://127.0.0.1')
        if (url.pathname==='/digest/chat/completions' && req.method==='POST') {
          digestRequest=Buffer.concat(chunks).toString('utf8')
          res.writeHead(200,{'content-type':'application/json'})
          res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'local journal result'})}}],usage:{prompt_tokens:12,completion_tokens:5}}))
          return
        }
        if (url.pathname==='/anthropic/v1/messages' && req.method==='POST') {
          if (req.headers['x-api-key']!==syntheticKey) {res.writeHead(401);res.end();return}
          observedPrompt=Buffer.concat(chunks).toString('utf8')
          const events=[
            {type:'message_start',message:{id:'test',model:'deepseek-v4-flash',usage:{input_tokens:12,output_tokens:1}}},
            {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
            {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'controlled node reply'}},
            {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}]
          res.writeHead(200,{'content-type':'text/event-stream'})
          res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''))
          return
        }
        if (!await handler(req,res,url.pathname,Buffer.concat(chunks).toString('utf8'))) {res.writeHead(404);res.end()}
      })().catch(()=>res.destroy()) })
      await new Promise<void>((done,reject)=>server.once('error',reject).listen(0,'127.0.0.1',done))
      const endpoint='http://127.0.0.1:'+String((server.address() as AddressInfo).port)+'/internal/runtime/session/'
      const headers = { authorization:'Bearer '+token,'content-type':'application/json' }
      const projectNumber=Number((await control.query('SELECT public_id FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].public_id)
      const runtime={kind:'project' as const,id:projectNumber,runtimeId:b.runtimeId,generation:1}
      const principal = principals.issue({ user:{id:Number(owner.public_id),username:'owner',displayName:'Owner',role:'user',
        status:'active',homePath:'/owner',mustChangePassword:false,autoReviewEligible:false},
        runtime,scope:{kind:'project',projectId:projectNumber,projectName:privateName,mode:'rw'} })
      const executionUrl=new URL('../execution/',endpoint)
      const invoke=async(action:string,input:Record<string,unknown>)=>{
        const response=await fetch(new URL(action,executionUrl),{method:'POST',headers:{...headers,[PRINCIPAL_HEADER]:principal},body:JSON.stringify({sessionId,...input})})
        const json=await response.json();expect(response.status,JSON.stringify(json)).toBe(200);return json
      }
      expect(await invoke('register-session',{})).toMatchObject({registered:true})
      const messageId=randomUUID(), contentHash=createHash('sha256').update(words).digest('hex')
      const receipt=await invoke('input',{messageId,kind:'message',contentHash})
      const captured=await invoke('enter',{messageId,inputId:receipt.inputId,contentHash,currentScopeId:null})
      expect(await invoke('authorize',{capability:'execute',scopeId:captured.scopeId})).toMatchObject({actors:[{userId:Number(owner.public_id)}]})
      const question={questionId:randomUUID(),answer:{answers:[{text:words}]},scopeId:captured.scopeId}
      const answered=await invoke('question',question)
      expect(await invoke('question',question)).toEqual(answered)
      expect((await content.query('SELECT outcome FROM node_content.conversation_interaction_responses WHERE interaction_id=$1',[question.questionId])).rows[0].outcome).toEqual(question.answer)
      const activityService=new PostgresCollaborationService(context,undefined,store)
      const activity=await activityService.listActivity(Number(member.public_id),b.runtimeId,projectNumber,{limit:1})
      expect(activity.items[0]).toMatchObject({kind:'answer',actorUserId:Number(owner.public_id),outcome:question.answer})
      expect((await activityService.listActivity(Number(member.public_id),b.runtimeId,projectNumber,{limit:1,before:activity.nextBefore})).items[0]).toMatchObject({kind:'message',text:words})
      const usage={organizationId:org,runtime,sessionId,inputIds:[receipt.inputId],primaryActorUserId:Number(owner.public_id)}
      await expect(verifyExecutionAttribution(control,usage,store)).resolves.toBeUndefined()
      await expect(verifyExecutionAttribution(control,{...usage,primaryActorUserId:Number(member.public_id)},store)).rejects.toMatchObject({status:403})
      const baseURL=new URL('/anthropic',endpoint).href
      const provider={provider:'org-local',displayName:'Test provider',driver:'pi-ai' as const,protocol:'anthropic-messages' as const,baseURL,authMode:'api-key' as const}
      await governance.upsertProvider({...provider,status:'draft',credential:syntheticKey})
      await governance.upsertModel({provider:provider.provider,model:'deepseek-v4-flash',displayName:'Test model',enabled:true,
        inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0})
      await governance.upsertProvider({...provider,status:'enabled'})
      await governance.setProjectAccess(projectNumber,provider.provider,'deepseek-v4-flash',true)
      const ref=(await control.query('SELECT credential_ref FROM harness.model_providers WHERE organization_id=$1 AND provider_key=$2',[org,provider.provider])).rows[0].credential_ref
      const credentialUrl=new URL('../model-credential',endpoint)
      const credential=await (await fetch(credentialUrl,{method:'POST',headers,body:JSON.stringify({ref})})).json()
      expect(credential.configured).toBe(true)
      const {nodeContentModelReply}=await import('./fixtures/node-content-model.mjs')
      const reply=await nodeContentModelReply(baseURL,credential.value,words)
      expect(reply).toBe('controlled node reply')
      expect(observedPrompt).toContain(JSON.stringify(words).slice(1,-1))
      const bill={eventId:randomUUID(),occurredAt:Date.now(),provider:provider.provider,model:'deepseek-v4-flash',purpose:'chat',sessionId,
        actorUserId:Number(owner.public_id),actorProjectId:projectNumber,executionInputIds:[receipt.inputId],credentialSource:'organization',
        credentialClass:'company' as const,status:'succeeded' as const,usage:{inputTokens:12,outputTokens:5}}
      expect((await governance.ingest(runtime,bill)).inserted).toBe(true)
      expect((await governance.ingest(runtime,bill)).inserted).toBe(false)
      await governance.setProjectAccess(projectNumber,provider.provider,'deepseek-v4-flash',false)
      expect(await (await fetch(credentialUrl,{method:'POST',headers,body:JSON.stringify({ref})})).json()).toEqual({configured:false})
      const follow:ConversationEvent = {seq:1,time:1002,type:'assistant/message',surfaceOp:'append',data:{message:{content:[{type:'text',text:reply}]}}}
      const append = await fetch(endpoint+'append',{method:'POST',headers,body:JSON.stringify({sessionId,batchId:randomUUID(),events:[follow]})})
      expect(await append.json()).toMatchObject({result:'inserted'})
      const loaded=await fetch(endpoint+'load?sessionId='+sessionId,{headers})
      expect(await loaded.json()).toMatchObject({header:{id:sessionId},events:[event,follow]})
      await control.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[org,node,member.id])
      await expect(localAcl.access(Number(member.public_id),b.runtimeId,sessionId,'read')).rejects.toThrow()
      await expect(repository.append(sessionId,randomUUID(),[{...event,seq:2,data:{source:{kind:'user',participant:{userId:Number(member.public_id)}},content:[]}}])).rejects.toThrow()
      await store.write(b,async()=>{},2)
      await expect(repository.append(sessionId,randomUUID(),[{...follow,seq:2}])).rejects.toBeInstanceOf(NodeContentUnavailable)
      await expect(store.read({...b,writerEpoch:'2'},async()=>{})).rejects.toBeInstanceOf(NodeContentUnavailable)
      expect(()=>new PostgresConversationStore(control).forRuntime(scope,subject)).toThrow(NodeContentUnavailable)
      const old = new PostgresConversationStore(control).forRuntime(scope)
      await expect(old.append(sessionId,randomUUID(),[event],header)).rejects.toThrow('assigned node volume')
      for (const table of ['conversation_sessions','conversation_events','conversation_search','conversation_participants','conversation_append_batches',
        'conversation_interaction_responses','execution_sessions','execution_inputs','execution_scopes']) {
        expect((await control.query('SELECT count(*)::int n FROM harness.'+table+' WHERE organization_id=$1 AND runtime_id=$2',[org,b.runtimeId])).rows[0].n).toBe(0)
      }
      expect((await control.query('SELECT name FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].name).not.toBe(privateName)
      expect((await content.query("SELECT to_regnamespace('harness') n")).rows[0].n).toBeNull()
      expect((await content.query('SELECT count(*)::int n FROM node_content.conversation_events WHERE session_id=$1',[sessionId])).rows[0].n).toBe(2)
      const legacy = await transaction(control,async tx=>{
        const project=(await tx.query<{id:string}>('INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id',[org,'Legacy project',owner.id])).rows[0]!.id
        await tx.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',[org,project,node,'/legacy'])
        await tx.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')",[org,project,owner.id])
        const allocation=(await tx.query<{runtime_id:RuntimeId}>('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47301) RETURNING runtime_id',[org,project,node])).rows[0]!.runtime_id
        return store.stageProject(tx,{projectId:project,runtimeId:allocation,name:'Legacy project',rootPath:'/legacy'})
      })
      const legacyRepository=conversations.forRuntime({organizationId:org,runtimeId:legacy.runtimeId})
      const original=randomUUID(),oldHeader={...header,id:original,projectId:legacy.projectId,runtimeId:legacy.runtimeId,cwd:'/legacy'}
      await legacyRepository.append(original,randomUUID(),[event],oldHeader)
      const legacyPublic=Number((await control.query('SELECT public_id FROM harness.projects WHERE id=$1',[legacy.projectId])).rows[0].public_id)
      const historicalUsage=new PostgresProgressUsage(context,governance,16,undefined,store)
      const historicalRequest=await historicalUsage.prepare({projectId:legacyPublic,internalProjectId:legacy.projectId,actorId:0,
        operationId:randomUUID() as ResourceOperationId,provider:'org-local',credentialSource:'organization',
        request:{model:'deepseek-v4-flash',messages:[{role:'user',content:'Historical journal '+words}],max_tokens:64,temperature:0.2,stream:false}})
      await historicalUsage.complete(historicalRequest,{status:'succeeded',response:'Historical journal reply',usage:{inputTokens:3,outputTokens:2}})
      await historicalUsage.flush(historicalRequest)
      const migration=new NodeContentMigration(control,store,legacy)
      expect(await migration.register()).toBe(await migration.register())
      const snapshot=await migration.copy()
      await expect(migration.verify(snapshot)).resolves.toBeUndefined()
      expect(await migration.copy()).toEqual(snapshot)
      await migration.materialize(snapshot)
      await migration.materialize(snapshot)
      expect((await content.query('SELECT request,completed FROM node_content.project_journal_requests WHERE project_id=$1 AND request_id=$2',[legacy.projectId,historicalRequest])).rows[0]).toMatchObject({
        request:{messages:[{content:'Historical journal '+words}]},completed:true})
      expect((await content.query('SELECT domain FROM node_content.migration_domain_receipts WHERE snapshot_id=$1 ORDER BY domain',[snapshot.id])).rows.map(r=>r.domain))
        .toEqual(['archive','collaboration','execution','progress','search','sessions'])
      await legacyRepository.append(original,randomUUID(),[{...follow,seq:1}])
      const changed=await migration.copy()
      expect(changed.id).not.toBe(snapshot.id)
      await expect(migration.verify(changed)).resolves.toBeUndefined()
      await migration.materialize(changed)
      expect((await legacyRepository.load(original))?.events).toEqual([event,follow])
      expect((await control.query('SELECT 1 FROM harness.project_content_placement WHERE project_id=$1',[legacy.projectId])).rows).toEqual([])
      const legacyId=Number((await control.query('SELECT public_id FROM harness.projects WHERE id=$1',[legacy.projectId])).rows[0].public_id)
      const target={kind:'project' as const,id:legacyId,runtimeId:legacy.runtimeId}
      const directory=await mkdtemp(resolve(tmpdir(),'hgw-content-stop-'))
      const budget=new NodeResourceBudget(control,org,node,{sampleMs:500,staleMs:2000,cpuTarget:0.85,eventLoopTargetMs:100,linuxMemoryReserveRatio:0.1,
        maxQueued:16,maxQueuedPerUser:8,maxQueuedPerProject:8,maxQueuedBytes:65536,maxWaitMs:30000})
      await budget.configure()
      const liveSubject=await instances.authenticateRuntimeToken(token)
      if (!liveSubject) throw new Error('The test Runtime lost its current credential.')
      await budget.register(liveSubject)
      const processOwner=await GatewayModelBudget.open(budget,directory)
      try {
        const digestProvider={provider:'org-journal',displayName:'Local journal',driver:'pi-ai' as const,protocol:'openai-completions' as const,
          baseURL:new URL('/digest',endpoint).href,authMode:'none' as const}
        await governance.upsertProvider({...digestProvider,status:'draft'})
        await governance.upsertModel({provider:digestProvider.provider,model:'journal',displayName:'Journal',enabled:true,
          inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0})
        await governance.upsertProvider({...digestProvider,status:'enabled'})
        await governance.setProjectAccess(projectNumber,digestProvider.provider,'journal',true)
        const shared='journal public '+randomUUID(), hidden='journal confidential '+randomUUID()
        const currentRepo=conversations.forRuntime(scope,{...subject,generation:2})
        const digestSession=randomUUID()
        for (const [id,visibility,text] of [[digestSession,'project',shared],[randomUUID(),'private',hidden]] as const) {
          await currentRepo.append(id,randomUUID(),[{...event,time:Date.now(),data:{source:{kind:'user',participant:{userId:Number(owner.public_id)}},content:[{type:'text',text}]}}],
            {...header,id,visibility,createdAt:Date.now()})
        }
        const progressUsage=new PostgresProgressUsage(context,governance,16,undefined,store)
        const progress=new PostgresProgressService(context,{collaboration:activityService,governance,budget:processOwner,nodeContent:store,usage:progressUsage},
          {...DEFAULT_PROGRESS_CONFIG,minActivity:1,idleMs:0,intervalMs:0})
        try {
          expect((await progress.progressForUser(projectNumber,Number(owner.public_id))).status.pending).toBeGreaterThan(0)
          const sweep=progress.sweep()
          await expect.poll(async()=>(await budget.snapshot()).kinds.model.queued).toBe(1)
          await control.query("UPDATE harness.node_resource_state SET credits=credits+1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2",[org,node])
          await sweep
          const journal=await progress.progressForUser(projectNumber,Number(owner.public_id))
          expect(journal.current?.content.summary,JSON.stringify(journal.status)).toBe('local journal result')
          expect(digestRequest).toContain(shared)
          expect(digestRequest).not.toContain(hidden)
          expect((await content.query('SELECT request_session,completed,delivered_at FROM node_content.project_journal_requests WHERE project_id=$1',[b.projectId])).rows[0]).toMatchObject({completed:true,delivered_at:expect.any(Date)})
          expect((await control.query('SELECT 1 FROM harness.project_journal_requests WHERE project_id=$1',[b.projectId])).rows).toEqual([])
          expect((await control.query('SELECT 1 FROM harness.project_journal WHERE project_id=$1',[b.projectId])).rows).toEqual([])
          expect((await control.query("SELECT 1 FROM harness.model_usage WHERE organization_id=$1 AND project_id=$2 AND purpose='project-progress'",[org,b.projectId])).rows).toHaveLength(1)
          await localAcl.setVisibility(Number(owner.public_id),b.runtimeId,digestSession,'private')
          expect((await progress.progressForUser(projectNumber,Number(owner.public_id))).current).toBeUndefined()
          await progressUsage.flush()
          expect((await control.query('SELECT 1 FROM harness.node_journal_deliveries WHERE project_id=$1',[b.projectId])).rows).toEqual([])
        } finally { await progress.close() }
        await verifyProjectRecoveryPoint(control,store,b,directory)
        const nameAuthority=await verifyNodeProjectNames(context,store,b,owner,member,privateName,rootPath,directory)
        await verifyAdminProjectMigration(context,store,nameAuthority,progress,processOwner,Number(owner.public_id),Number(member.public_id),directory)
        await verifyNodePluginStorage(context,store,b,Number(owner.public_id),rootPath,directory)
        await processOwner.withOwnership(async witness=>{
          await control.query("UPDATE harness.instances SET desired_state='running',observed_state='ready' WHERE runtime_id=$1",[legacy.runtimeId])
          const operationId=randomUUID() as RuntimeStopOperationId
          await expect(instances.acquireStopLease(target,operationId,witness,undefined,1,'content-publication')).rejects.toThrow()
          expect((await control.query('SELECT observed_state FROM harness.instances WHERE runtime_id=$1',[legacy.runtimeId])).rows[0].observed_state).toBe('ready')
          await control.query("UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE runtime_id=$1",[legacy.runtimeId])
          const lease=await instances.acquireStopLease(target,operationId,witness,undefined,1,'content-publication')
          try {
            await expect(transaction(control,tx=>migration.lockSource(tx,changed,lease))).rejects.toThrow('source has changed')
            await instances.confirmStopLease(operationId,witness)
            await expect(transaction(control,tx=>migration.lockSource(tx,snapshot,lease))).rejects.toThrow('source has changed')
            await expect(transaction(control,tx=>migration.lockSource(tx,changed,lease))).resolves.toBeUndefined()
            await expect(migration.publish(changed,lease,new NodeContentPublication())).rejects.toThrow('Project content services are not ready')
          } finally { await instances.releaseStopLease(operationId,witness) }
        })
      } finally {
        try { await processOwner.close() } finally { await rm(directory,{force:true,recursive:true}) }
      }
      await content.query("UPDATE node_content.migration_batches SET body='[]' WHERE snapshot_id=$1 AND relation='conversation_events'",[changed.id])
      await expect(migration.verify(changed)).rejects.toThrow('failed verification')
    } finally {
      if (server.listening) { server.closeAllConnections(); await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done())) }
      await Promise.all([control.end(),application.end(),content.end()])
      await rm(work,{recursive:true,force:true})
    }
  }, 75_000)
})
