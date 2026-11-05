/** Actual Gateway entry, disposable PostgreSQL and an owned Git checkout barrier. */
import {randomUUID} from 'node:crypto'
import {spawn,execFile,type ChildProcess} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {expect,it} from 'vitest'
import {postgresTestDatabaseUrl} from './postgres-test-database.mjs'
import {createPostgresPool,runMigrations} from '../src/postgres/database.ts'
import {PostgresMaintenanceService} from '../src/postgres/maintenance-service.ts'
import {resolvePostgresRuntimeContext} from '../src/postgres/runtime-context.ts'
import {testEnvironment} from './test-config.ts'
const gateway=resolve(import.meta.dirname,'..')
const execute=promisify(execFile)
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
async function until(predicate:()=>Promise<boolean>,message:()=>string){const end=performance.now()+30000;while(!await predicate()){if(performance.now()>end)throw Error(message());await delay(15)}}
// The real repository hook is a POSIX executable; native Windows hook behavior remains separate.
it.skipIf(databaseUrl===undefined||process.platform==='win32')('keeps a serving Gateway responsive while steward checkout waits and excludes Gateway secrets from Git',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hgw-steward-checkout-')),database='hgw_steward_git_'+randomUUID().replaceAll('-','')+'_test'
 const admin=createPostgresPool(databaseUrl!,{max:1});let created=false,pool:ReturnType<typeof createPostgresPool>|undefined,child:ChildProcess|undefined,exited:Promise<number|null>|undefined,logs=''
 const hookPidFile=join(root,'hook-pid')
 const firstHook=join(root,'first-hook'),armed=join(root,'armed'),release=join(root,'release'),ready=join(root,'ready'),bound=join(root,'bound.json'),report=join(root,'hook.json'),repo=join(root,'source'),preload=join(root,'listen.mjs')
 try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true
  const url=new URL(databaseUrl!);url.pathname='/'+database
  pool=createPostgresPool(url.href,{max:2});await runMigrations(pool,join(gateway,'deploy/postgres/migrations'))
  const slug=randomUUID(),org=(await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Synthetic Git startup') RETURNING id",[slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'steward-git')",[org])
  await mkdir(repo)
  const gitEnv={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}
  const git=(args:string[])=>execute('git',['-C',repo,...args],{env:gitEnv,timeout:10000,maxBuffer:65536})
  await execute('git',['init',repo],{env:gitEnv,timeout:10000,maxBuffer:65536})
  await git(['config','user.email','fixture@example.test']);await git(['config','user.name','Synthetic fixture'])
  await writeFile(join(repo,'README.md'),'Synthetic steward source\n');await git(['add','README.md']);await git(['commit','-m','Synthetic initial source'])
  await writeFile(join(repo,'.git/hooks/post-checkout'),`#!${process.execPath}\nconst fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(armed)})){fs.writeFileSync(${JSON.stringify(firstHook)},'first');process.exit(1)};process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(hookPidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({gatewaySecretInherited:process.env.HGW_AUDIT_FIXTURE_SECRET==='synthetic-steward-only'}));fs.writeFileSync(${JSON.stringify(ready)},'ready');const waiting=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(waiting);process.exit(1)}},10);\n`,{mode:0o700})
  await writeFile(preload,`import {Server} from 'node:net';import fs from 'node:fs';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]===8899){args[0]=0;this.once('listening',()=>fs.writeFileSync(${JSON.stringify(bound)},JSON.stringify(this.address())))}else if(args[0]===8900)args[0]=0;return listen.apply(this,args)};\n`)
  const env=testEnvironment(root,{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',HGW_DATABASE_URL:url.href,HGW_ORGANIZATION_SLUG:slug,HGW_COMPUTE_NODE_NAME:'steward-git',HGW_STEWARD:'on',HGW_STEWARD_ROOT:join(root,'steward'),HGW_STEWARD_WORKSPACE:join(root,'steward/workspace'),HGW_STEWARD_SOURCE:repo,HGW_STEWARD_RUNTIME_USER:'synthetic-steward',HGW_AUDIT_FIXTURE_SECRET:'synthetic-steward-only',HGW_DSH_COMMAND:JSON.stringify(join(root,'never-launch-a-runtime'))+' --no-open',HGW_LAUNCHER:'local',HGW_PORT:'8899',HGW_INTAKE_PORT:'8900',HGW_NODE_HEARTBEAT_MS:'100',HGW_DSH_REPO_ROOT:join(gateway,'..'),TSX_TSCONFIG_PATH:join(gateway,'tsconfig.run.json'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'})
  child=spawn(process.execPath,['--import',import.meta.resolve('tsx/esm'),'--import',preload,join(gateway,'src/index.ts')],{cwd:gateway,env,stdio:['ignore','pipe','pipe']})
  exited=new Promise((done,fail)=>{child!.once('error',fail);child!.once('exit',done)})
  const capture=(data:Buffer)=>{logs=(logs+data.toString()).slice(-20000)};child.stdout!.on('data',capture);child.stderr!.on('data',capture)
  await until(async()=>{if(child!.exitCode!==null)throw Error('Gateway exited before binding: '+logs);return stat(bound).then(()=>true,()=>false)},()=> 'Gateway listener never bound: '+logs)
  const address=JSON.parse(await readFile(bound,'utf8')) as {port:number}
  const origin='http://127.0.0.1:'+address.port
  const control=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(5000)})
  await control.arrayBuffer();expect(control.status).toBe(200)
  const context=await resolvePostgresRuntimeContext(pool,slug,'steward-git')
  const maintenance=new PostgresMaintenanceService(context,60000)
  await until(async()=>stat(firstHook).then(()=>true,()=>false),()=> 'First checkout hook did not finish: '+logs)
  await maintenance.enterMaintenance(null)
  await until(async()=> (await maintenance.state()).writersQuiesced,()=> 'Serving Gateway never acknowledged maintenance')
  await git(['worktree','remove','--force',join(root,'steward/workspace')])
  await writeFile(armed,'armed')
  await maintenance.exitMaintenance(null)
  await until(async()=>{if(child!.exitCode!==null)throw Error('Gateway exited before Git barrier: '+logs);return stat(ready).then(()=>true,()=>false)},()=> 'Git barrier never reached after reopening writes: '+logs)
  const health=await fetch('http://127.0.0.1:'+address.port+'/healthz',{signal:AbortSignal.timeout(2000)}).then(async response=>({responded:true,status:response.status,body:await response.json()}),()=>({responded:false,status:null}))
  const hook=JSON.parse(await readFile(report,'utf8')) as {gatewaySecretInherited:boolean}
  const hookPid=Number(await readFile(hookPidFile,'utf8'))
  let forced=false
  child.kill('SIGTERM')
  const deadline=setTimeout(()=>{if(child!.exitCode===null&&child!.signalCode===null){forced=true;child!.kill('SIGKILL')}},15000)
  let shutdownExit:number|null
  try{shutdownExit=await exited}finally{clearTimeout(deadline)}
  const hookAlive=()=>{try{process.kill(hookPid,0);return true}catch{return false}}
  await until(async()=>!hookAlive(),()=> 'Checkout hook survived Gateway shutdown')
  const stewardProjects=Number((await pool.query("SELECT count(*) AS count FROM harness.projects WHERE organization_id=$1 AND kind='steward'",[org])).rows[0].count)
  expect(JSON.stringify({baselineHealth:control.status,healthDuringCheckout:health.status,gatewaySecretInherited:hook.gatewaySecretInherited,shutdownExit,forcedShutdown:forced,checkoutHookAlive:hookAlive(),stewardProjects})+'\n').toBe(await readFile(new URL('./expected/steward-worktree.jsonl',import.meta.url),'utf8'))
  expect(health.responded).toBe(true);expect(hook.gatewaySecretInherited).toBe(false)
 }finally{
  await writeFile(release,'release')
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM')
   const deadline=setTimeout(()=>{if(child!.exitCode===null&&child!.signalCode===null)child!.kill('SIGKILL')},15000)
   try{await exited}finally{clearTimeout(deadline)}
  }
  try{
   const pid=Number(await readFile(hookPidFile,'utf8').catch(()=>''))
   if(pid>0)await until(async()=>{try{process.kill(pid,0);return false}catch{return true}},()=> 'Owned checkout hook did not exit')
  }finally{
   try{await pool?.end()}finally{try{if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)}finally{try{await admin.end()}finally{await rm(root,{recursive:true,force:true})}}}
  }
 }
},60000)
