/** Actual project model reads across committed authority withdrawal. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'
const [mode,artifactRoot]=process.argv.slice(2)
assert.ok(mode==='src'||mode==='lib');assert.ok(artifactRoot===undefined||mode==='lib')
const gatewayRoot=artifactRoot??fileURLToPath(new URL('../../',import.meta.url))
const load=name=>import(pathToFileURL(`${gatewayRoot}/${mode}/${name}.${mode==='src'?'ts':'js'}`))
const [{createPostgresPool,runMigrations},{resolvePostgresRuntimeContext},{PostgresUserService},
 {PostgresProjectService},{PostgresCollaborationService},{PostgresAuthService},{PostgresAuditService},
 {PostgresInstanceRepository},{PostgresModelGovernanceService,projectProviderCredentialRef},
 {OrganizationModelCredentialCipher},{InstanceManager},{loadConfig},{createGatewayServer}]=await Promise.all([
 'postgres/database','postgres/runtime-context','postgres/user-service','postgres/project-service',
 'postgres/collaboration-service','postgres/auth-service','postgres/audit-service','postgres/instance-repository',
 'postgres/model-governance-service','organization-model-credentials','instances','config','server',
].map(load))
const url=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL);assert(url)
const pool=createPostgresPool(url,{max:1})
const listen=server=>new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.off('error',fail);done()})})
const close=async server=>{server.closeAllConnections();await new Promise((done,fail)=>server.close(error=>error?fail(error):done()))}
const failures=[]
const changes=['current','owner-transfer','removed-member','disabled-account','deleted-account','disabled-membership','missing-membership',
 'disabled-organization','password-reset','computer-disabled','foreign-computer-only','project-archived','mount-disabled',
 'administrator-current','administrator-demoted','steward-current','steward-withdrawn','steward-demoted']
const scenarios=['settings','credentials','discover','explicit-discover'].flatMap(operation=>changes.map(change=>({operation,change})))
scenarios.push(...['settings','credentials'].flatMap(operation=>['readonly-member','contributor-member','administrator-promoted'].map(change=>({operation,change}))))
try{
 await runMigrations(pool,`${gatewayRoot}/deploy/postgres/migrations`)
 for(const {operation,change} of scenarios){
  const root=await mkdtemp(join(tmpdir(),'project-model-read-')),slug=`model-read-${randomUUID()}`
  let organizationId,server,probe,instances,pending,release
  try{
   organizationId=(await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Project model read') RETURNING id",[slug])).rows[0].id
   await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'read-node')",[organizationId])
   const context=await resolvePostgresRuntimeContext(pool,slug,'read-node')
   const cfg=loadConfig({HGW_USERS_ROOT:join(root,'users'),HGW_STATE_ROOT:join(root,'state'),HGW_PROJECT_RUNTIMES_ROOT:join(root,'runtimes'),
    HGW_PROJECTS_ROOT:join(root,'projects'),HGW_USER_PROJECTS_ROOT:join(root,'user-projects'),HGW_SYSTEMD_UNIT_DIR:join(root,'units'),HGW_DEFAULT_ENV_FILE:''})
   await mkdir(cfg.stateRoot,{mode:0o700,recursive:true})
   const users=new PostgresUserService(context,cfg),projects=new PostgresProjectService(context,cfg)
   const owner=await users.create({username:'owner',password:'pw-12345678',...(change.startsWith('steward-')||change==='administrator-current'||change==='administrator-demoted'?{role:'admin'}:{})})
   const administrator=await users.create({username:'administrator',password:'pw-12345678',role:'admin'})
   await users.changeOwnPassword(owner.id,'pw-12345678')
   await users.changeOwnPassword(administrator.id,'pw-12345678')
   const steward=change.startsWith('steward-')
   const stewardPath=join(root,'steward');if(steward)await mkdir(stewardPath,{mode:0o700})
   const project=steward?await projects.ensureSteward({name:'Steward model catalog',path:stewardPath,createdBy:owner.id})
    :await projects.createManaged({name:'Private project catalog',ownerUserId:owner.id})
   const actor=(await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[organizationId,owner.id])).rows[0].id
   if(steward)await pool.query('INSERT INTO harness.steward_access_policies(organization_id,node_id,user_id,enabled,revision) VALUES($1,$2,$3,true,1)',[organizationId,context.nodeId,actor])
   if(['administrator-current','administrator-demoted','readonly-member','contributor-member','administrator-promoted'].includes(change)){
    await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,[organizationId,project.id,administrator.id])
    if(change==='readonly-member')await projects.setMember(project.id,owner.id,'ro',administrator.id)
   }
   const governance=new PostgresModelGovernanceService(context,new OrganizationModelCredentialCipher(Buffer.alloc(32,7)))
   let discoveries=0
   const entered=Promise.withResolvers(),gate=Promise.withResolvers();release=()=>gate.resolve()
   probe=createServer(async(request,response)=>{
    discoveries+=1
    assert.equal(request.headers.authorization,`Bearer ${operation==='explicit-discover'?'fixture-explicit-secret':'fixture-initial-secret'}`)
    entered.resolve();await gate.promise
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'fixture-private-model'}]}))
   });await listen(probe)
   const endpoint=`http://127.0.0.1:${probe.address().port}/v1`,ref=projectProviderCredentialRef(project.id,'fixture')
   await governance.mutateProjectModelSettings(project.id,[{op:'set',path:['providers','fixture'],value:{api:'openai-completions',baseURL:endpoint,apiKeyEnv:ref,models:[{id:'fixture-private-model'}]}}])
   await governance.setProjectCredential(project.id,ref,'fixture-initial-secret')
   if(operation==='settings'||operation==='credentials'){
    const member=operation==='settings'?'describeProjectModelSettings':'describeProjectCredentials',read=governance[member].bind(governance)
    governance[member]=async(...args)=>{const value=await read(...args);entered.resolve();await gate.promise;return value}
   }
   instances=new InstanceManager(new PostgresInstanceRepository(context,cfg.instancePortBase),cfg)
   server=createGatewayServer({cfg,users,projects,governance,instances,auth:new PostgresAuthService(context,cfg),
    audit:new PostgresAuditService(context),collaboration:new PostgresCollaborationService(context)})
   await listen(server);const base=`http://127.0.0.1:${server.address().port}`;cfg.publicOrigins.push(base)
   const login=await fetch(`${base}/login`,{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({username:owner.username,password:'pw-12345678'})})
   await login.arrayBuffer();assert.equal(login.status,302);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie)
   const suffix=operation==='settings'?'':operation==='credentials'?`/credentials?refs=${encodeURIComponent(ref)}`:'/discover'
   pending=fetch(`${base}/account/api/projects/${project.id}/model-settings${suffix}`,{method:operation.endsWith('discover')?'POST':'GET',
    headers:{cookie,origin:base,'content-type':'application/json'},...(operation.endsWith('discover')?{body:JSON.stringify({provider:'fixture',api:'openai-completions',baseURL:endpoint,actorUserId:administrator.id,...(operation==='explicit-discover'?{apiKey:'fixture-explicit-secret'}:{})})}:{})})
    .then(async response=>({status:response.status,body:await response.json()}))
   const discovery=operation.endsWith('discover')
   const adminAtRequest=change.startsWith('steward-')||change==='administrator-current'||change==='administrator-demoted'
   // Non-administrator discovery refuses the private endpoint before the probe or
   // any authorization check runs, so no probe request exists to gate the change behind.
   if(!discovery||adminAtRequest)await entered.promise
   const early=discovery&&!adminAtRequest?await pending:undefined
   if(change==='owner-transfer')await pool.query(`UPDATE harness.projects SET owner_user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3) WHERE organization_id=$1 AND public_id=$2`,[organizationId,project.id,administrator.id])
   if(change==='removed-member')await pool.query(`DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2) AND user_id=(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$3)`,[organizationId,project.id,owner.id])
   if(change==='disabled-account')await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1",[actor])
   if(change==='deleted-account')await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1',[actor])
   if(change==='disabled-membership')await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1",[actor])
   if(change==='missing-membership')await pool.query('DELETE FROM harness.memberships WHERE user_id=$1',[actor])
   if(change==='disabled-organization')await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1",[organizationId])
   if(change==='password-reset')await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id=$1',[actor])
   if(change==='computer-disabled'||change==='foreign-computer-only'){
    await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[organizationId,context.nodeId,actor])
    if(change==='foreign-computer-only'){
     const foreign=(await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'foreign-read-node') RETURNING id",[organizationId])).rows[0].id
     await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',[organizationId,foreign,actor])
    }
   }
   if(change==='project-archived')await pool.query("UPDATE harness.projects SET status='archived' WHERE organization_id=$1 AND public_id=$2",[organizationId,project.id])
   if(change==='mount-disabled')await pool.query("UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1 AND project_id=(SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2)",[organizationId,project.id])
   if(change==='steward-withdrawn')await pool.query('UPDATE harness.steward_access_policies SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[organizationId,context.nodeId,actor])
   if(change==='steward-demoted'||change==='administrator-demoted')await users.setRole(owner.id,'user')
   if(change==='administrator-promoted')await users.setRole(owner.id,'admin')
   release();const result=early??await pending
   const writable=operation==='settings'?result.body.writable:operation==='credentials'?result.body.credentials?.[ref]?.writable:null
   const readOnly=['owner-transfer','administrator-demoted','readonly-member','contributor-member'].includes(change)
   const readable=['current','owner-transfer','administrator-current','administrator-demoted','steward-current','readonly-member','contributor-member','administrator-promoted'].includes(change)
   const expected=discovery&&!adminAtRequest?400:readable&&(!discovery||!readOnly)?200:403
   const expectedWritable=!readOnly
   const event={operation,change,status:result.status,writable:writable??null,discoveryRequests:discoveries,metadataPublished:result.status===200}
   process.stdout.write(JSON.stringify(event)+'\n')
   if(result.status!==expected||(!discovery&&expected===200&&writable!==expectedWritable))failures.push(`${operation}:${change}`)
   if(discovery)assert.equal(discoveries,adminAtRequest?1:0)
   if(discovery&&!adminAtRequest)assert.equal(result.body?.error,'model-discovery-target-not-public')
   if(expected===403)assert.equal(JSON.stringify(result.body).includes('fixture-private-model'),false)
  }finally{
   release?.();await pending?.catch(()=>{})
   if(server)await close(server);if(probe)await close(probe);await instances?.stopAll()
   if(organizationId)await removeFixtureOrganization(pool,organizationId)
   await rm(root,{recursive:true,force:true})
  }
 }
 assert.deepEqual(failures,[],'Project model reads retained withdrawn authority')
}finally{await pool.end()}
