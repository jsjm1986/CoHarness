/** Start the real Gateway source entry over a freshly imported database, using OS-assigned listeners. */
import { spawn,type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat,mkdir,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { testEnvironment } from './test-config.ts'

/** Exercise real authentication, restricted startup and release without creating a steward or launching work.
 * @param input - imported target database and newly issued bootstrap password, all owned by this fixture.
 */
export async function exerciseGovernanceRebuildIndex(input:{pool:Pool;databaseUrl:string;organizationId:string;nodeId:string;
  operationId:string;username:string;password:string;root:string}):Promise<void>{
  const root=join(input.root,'source-index'),gateway=resolve(import.meta.dirname,'..')
  await mkdir(root,{mode:0o700})
  const node=(await input.pool.query<{slug:string;name:string}>(`SELECT o.slug,n.name::text name FROM harness.organizations o
    JOIN harness.compute_nodes n ON n.organization_id=o.id WHERE o.id=$1 AND n.id=$2`,[input.organizationId,input.nodeId])).rows[0]!
  const bootstrap=join(root,'ephemeral-listeners.mjs'),unexpected=join(root,'runtime-started'),runtime=join(root,'never-start-runtime.mjs')
  await writeFile(runtime,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(unexpected)},'Unexpected Runtime start');process.exit(91);\n`,{mode:0o600})
  await writeFile(bootstrap,`import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const original=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){const configured=args[0];if(configured!==39001&&configured!==39002)throw new Error('Unexpected fixture listener');args[0]=0;
this.once('listening',()=>process.send?.({kind:'listener',configured,port:this.address().port}));return original.apply(this,args)};
syncBuiltinESMExports();\n`,{mode:0o600})
  const env=testEnvironment(root,{PATH:process.env.PATH,LANG:'C.UTF-8',HGW_DATABASE_URL:input.databaseUrl,
    HGW_ORGANIZATION_SLUG:node.slug,HGW_COMPUTE_NODE_NAME:node.name,HGW_DATABASE_MAX_CONNECTIONS:'3',HGW_PORT:'39001',HGW_INTAKE_PORT:'39002',
    HGW_PUBLIC_ORIGINS:'http://127.0.0.1:39001',HGW_NODE_HEARTBEAT_MS:'100',HGW_DEPLOYMENT_CONTEXT_REFRESH_MS:'100',
    HGW_STEWARD:'on',HGW_STEWARD_ROOT:join(root,'steward'),HGW_STEWARD_SOURCE:resolve(gateway,'..'),
    HGW_DSH_COMMAND:[process.execPath,runtime,'--no-open'].map(value=>JSON.stringify(value)).join(' '),
    TSX_TSCONFIG_PATH:join(gateway,'tsconfig.run.json')})
  let child:ChildProcess|undefined,log=''
  const before=(await input.pool.query(`SELECT (SELECT count(*) FROM harness.projects WHERE organization_id=$1)::int projects,
    (SELECT count(*) FROM harness.instances WHERE organization_id=$1)::int instances`,[input.organizationId])).rows[0]
  try{
    child=spawn(process.execPath,['--import',import.meta.resolve('tsx/esm'),'--import',bootstrap,join(gateway,'src/index.ts')],
      {env,cwd:gateway,stdio:['ignore','pipe','pipe','ipc']})
    const ports=new Map<number,number>()
    child.on('message',message=>{if(message&&typeof message==='object'&&'kind' in message&&message.kind==='listener'&&'configured' in message&&'port' in message)
      ports.set(Number(message.configured),Number(message.port))})
    for(const output of [child.stdout!,child.stderr!])output.on('data',(bytes:Buffer)=>{log=(log+bytes.toString()).slice(-24000)})
    await expect.poll(()=>ports.size,{timeout:20000,message:'Real Gateway must bind both OS-assigned listeners'}).toBe(2)
    const origin='http://127.0.0.1:'+ports.get(39001),headers={origin:'http://127.0.0.1:39001'}
    const login=await fetch(origin+'/login',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({username:input.username,password:input.password}),redirect:'manual'})
    expect(login.status,log).toBe(302)
    const cookie=login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ')
    expect(cookie).toMatch(/session/u)
    for(const path of ['/api/sessions','/admin/api/users','/internal/runtime/verify-profile'])
      expect((await fetch(origin+path,{headers:{...headers,cookie}})).status,path).toBe(503)
    const endpoint=origin+'/admin/api/governance-recovery',response=await fetch(endpoint,{headers:{...headers,cookie}})
    expect(response.status,log).toBe(200)
    const status=await response.json() as {operationId:string;revision:string;state:string;unrestoredDomains:string[]}
    expect(status).toMatchObject({operationId:input.operationId,state:'review'})
    const release=await fetch(endpoint+'/'+input.operationId+'/release',{method:'POST',headers:{...headers,cookie,'content-type':'application/json'},
      body:JSON.stringify({confirm:input.operationId,revision:status.revision,acknowledgeUnrestoredDomains:status.unrestoredDomains})})
    expect(release.status,await release.text()).toBe(200)
    await expect.poll(async()=>Number((await input.pool.query(`SELECT maintenance_applied_epoch::text epoch FROM harness.compute_nodes
      WHERE organization_id=$1 AND id=$2`,[input.organizationId,input.nodeId])).rows[0]?.epoch),{timeout:5000}).toBeGreaterThan(0)
    await delay(400)
    expect((await input.pool.query(`SELECT (SELECT count(*) FROM harness.projects WHERE organization_id=$1)::int projects,
      (SELECT count(*) FROM harness.instances WHERE organization_id=$1)::int instances`,[input.organizationId])).rows[0]).toEqual(before)
    expect((await input.pool.query(`SELECT count(*)::int n FROM harness.instances WHERE organization_id=$1 AND desired_state<>'stopped'`,[input.organizationId])).rows[0].n).toBe(0)
    await expect(lstat(unexpected)).rejects.toMatchObject({code:'ENOENT'})
    await expect(lstat(join(root,'steward','workspace'))).rejects.toMatchObject({code:'ENOENT'})
    await input.pool.query("UPDATE harness.cluster_control SET mode='maintenance',maintenance_epoch=maintenance_epoch+1 WHERE organization_id=$1",[input.organizationId])
    const epoch=(await input.pool.query<{epoch:string}>('SELECT maintenance_epoch::text epoch FROM harness.cluster_control WHERE organization_id=$1',[input.organizationId])).rows[0]!.epoch
    await expect.poll(async()=>(await input.pool.query<{epoch:string}>('SELECT maintenance_applied_epoch::text epoch FROM harness.compute_nodes WHERE id=$1',[input.nodeId])).rows[0]?.epoch,{timeout:5000}).toBe(epoch)
    const runtimeId=randomUUID(),runtimeReview=randomUUID()
    const owner=(await input.pool.query<{id:string}>('SELECT id FROM harness.users WHERE organization_id=$1 AND username=$2',[input.organizationId,input.username])).rows[0]!.id
    await input.pool.query('INSERT INTO harness.instances(id,organization_id,user_id,assigned_node_id,port) VALUES($1,$2,$3,$4,39003)',[runtimeId,input.organizationId,owner,input.nodeId])
    await input.pool.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch)
      SELECT $1,$2,organization_id,runtime_id,assigned_node_id,'user',user_id,generation,generation FROM harness.instances WHERE id=$3`,[runtimeReview,input.operationId,runtimeId])
    await input.pool.query('INSERT INTO harness.governance_rebuild_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)',[runtimeReview,input.organizationId,runtimeId])
    await input.pool.query(`INSERT INTO harness.governance_rebuild_binding_requests(runtime_operation_id,organization_id,request_id,requested_by,status)
      VALUES($1,$2,$3,$4,'queued')`,[runtimeReview,input.organizationId,randomUUID(),owner])
    await delay(400)
    expect((await input.pool.query('SELECT status FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1',[runtimeReview])).rows[0].status).toBe('queued')
    await input.pool.query("UPDATE harness.cluster_control SET mode='serving',maintenance_epoch=maintenance_epoch+1 WHERE organization_id=$1",[input.organizationId])
    await expect.poll(async()=>(await input.pool.query('SELECT status FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1',[runtimeReview])).rows[0]?.status,{timeout:5000}).toBe('failed')
    await expect(lstat(unexpected)).rejects.toMatchObject({code:'ENOENT'})
    expect(log).not.toContain('EADDRINUSE')
  }catch(error){throw new Error('Real Gateway rebuilding entry failed: '+log,{cause:error})}
  finally{
    if(child?.exitCode===null&&child.signalCode===null){
      const exit=once(child,'exit');child.kill('SIGTERM')
      const timer=setTimeout(()=>child?.kill('SIGKILL'),10000)
      try{await exit}finally{clearTimeout(timer)}
    }
  }
}
