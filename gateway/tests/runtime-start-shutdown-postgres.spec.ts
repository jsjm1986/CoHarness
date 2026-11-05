/** Actual Gateway shutdown while a steward Runtime waits for its first pressure credit. */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { testEnvironment } from './test-config.ts'
const gateway=resolve(import.meta.dirname,'..')
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
async function until(predicate:()=>Promise<boolean>,message:()=>string){const end=performance.now()+30000;while(!await predicate()){if(performance.now()>end)throw Error(message());await delay(15)}}
// This assembled fixture uses the unprivileged macOS launcher; Linux account provisioning and Windows are separate acceptance.
it.skipIf(databaseUrl===undefined||process.platform!=='darwin')('cancels a Runtime start waiting for pressure before draining its writer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hgw-start-drain-')),database='hgw_start_drain_'+randomUUID().replaceAll('-','')+'_test'
 const admin=createPostgresPool(databaseUrl!,{max:1});let created=false,pool:ReturnType<typeof createPostgresPool>|undefined,child:ChildProcess|undefined,exited:Promise<number|null>|undefined,logs=''
 const bound=join(root,'bound.json'),preload=join(root,'listen.mjs')
 try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true
  const url=new URL(databaseUrl!);url.pathname='/'+database
  pool=createPostgresPool(url.href,{max:2});await runMigrations(pool,join(gateway,'deploy/postgres/migrations'))
  const slug=randomUUID(),org=(await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Synthetic start drain') RETURNING id",[slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'start-drain')",[org])
  await writeFile(preload,`import {Server} from 'node:net';import fs from 'node:fs';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]===8899){args[0]=0;this.once('listening',()=>fs.writeFileSync(${JSON.stringify(bound)},JSON.stringify(this.address())))}else if(args[0]===8900)args[0]=0;return listen.apply(this,args)};\n`)
  const env=testEnvironment(root,{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',HGW_DATABASE_URL:url.href,HGW_ORGANIZATION_SLUG:slug,HGW_COMPUTE_NODE_NAME:'start-drain',HGW_STEWARD:'on',HGW_STEWARD_ROOT:join(root,'steward'),HGW_STEWARD_WORKSPACE:join(root,'steward/workspace'),HGW_STEWARD_RUNTIME_USER:'synthetic-steward',HGW_DSH_COMMAND:JSON.stringify(join(root,'never-launch-a-runtime'))+' --no-open',HGW_LAUNCHER:'local',HGW_PORT:'8899',HGW_INTAKE_PORT:'8900',HGW_NODE_HEARTBEAT_MS:'100',HGW_DSH_REPO_ROOT:join(gateway,'..'),HGW_RESOURCE_SAMPLE_MS:'60000',HGW_RESOURCE_STALE_MS:'120000',HGW_RESOURCE_QUEUE_WAIT_MS:'120000',TSX_TSCONFIG_PATH:join(gateway,'tsconfig.run.json')})
  child=spawn(process.execPath,['--import',import.meta.resolve('tsx/esm'),'--import',preload,join(gateway,'src/index.ts')],{cwd:gateway,env,stdio:['ignore','pipe','pipe']})
  exited=new Promise((done,fail)=>{child!.once('error',fail);child!.once('exit',done)})
  const capture=(data:Buffer)=>{logs=(logs+data.toString()).slice(-20000)};child.stdout!.on('data',capture);child.stderr!.on('data',capture)
  await until(async()=>{if(child!.exitCode!==null)throw Error('Gateway exited before binding: '+logs);return stat(bound).then(()=>true,()=>false)},()=> 'Gateway listener never bound: '+logs)
  const address=JSON.parse(await readFile(bound,'utf8')) as {port:number}
  const initial=await fetch('http://127.0.0.1:'+address.port+'/healthz',{signal:AbortSignal.timeout(5000)});await initial.arrayBuffer();expect(initial.status).toBe(200)
  await until(async()=>{if(child!.exitCode!==null)throw Error('Gateway exited before pressure admission: '+logs);return (await pool!.query("SELECT 1 FROM harness.instances i JOIN harness.projects p ON p.organization_id=i.organization_id AND p.id=i.project_id WHERE i.organization_id=$1 AND p.kind='steward' AND i.allocation_state='waiting'",[org])).rowCount===1},()=> 'Runtime did not enter real pressure admission: '+logs)
  const before=await pool.query("SELECT runtime_starts_admitted FROM harness.node_resource_state WHERE organization_id=$1",[org]);expect(Number(before.rows[0].runtime_starts_admitted)).toBe(0)
  child.kill('SIGTERM')
  const code=await exited
  const state=(await pool.query("SELECT i.observed_state,i.allocation_state FROM harness.instances i JOIN harness.projects p ON p.organization_id=i.organization_id AND p.id=i.project_id WHERE i.organization_id=$1 AND p.kind='steward'",[org])).rows
  const observation={initialHealth:initial.status,waitingForRealPressureCredit:true,shutdownExit:code,forcedShutdown:logs.includes('forced shutdown after'),runtimeState:state,modelRequests:0}
  expect(JSON.stringify(observation)+'\n').toBe(await readFile(new URL('./expected/runtime-start-shutdown.jsonl',import.meta.url),'utf8'))
  expect(observation.forcedShutdown).toBe(false);expect(code).toBe(0)
  expect(state).toEqual([{observed_state:'stopped',allocation_state:'waiting'}])
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}
  try{await pool?.end()}finally{try{if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)}finally{try{await admin.end()}finally{await rm(root,{recursive:true,force:true})}}}
 }
},60000)
