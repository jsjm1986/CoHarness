/** Actual Gateway shutdown while a steward Runtime waits for its first pressure credit. */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { testEnvironment } from './test-config.ts'
import type { RuntimeDrainReport } from '../src/runtime-shutdown.ts'
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

it.skipIf(databaseUrl === undefined).each([
  { mode: 'confirmed', outcomes: Array<string>(10).fill('confirmed'), exitCode: 0 },
  { mode: 'incomplete', outcomes: ['failed', 'forced', 'timeout', 'unconfirmed', 'throws', ...Array<string>(5).fill('confirmed')], exitCode: 1 },
  { mode: 'deadline', outcomes: ['blocked'], exitCode: 1 },
  { mode: 'retained', outcomes: ['confirmed'], exitCode: 0 },
])('reports node drain at the real Gateway entry ($mode)', async ({ mode, outcomes, exitCode }) => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-runtime-drain-'))
  const database = `hgw_node_drain_${randomUUID().replaceAll('-', '')}_test`
  const admin = createPostgresPool(databaseUrl!, { max: 1 })
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  let child: ChildProcess | undefined, exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let diagnostic = ''
  try {
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl!)
    url.pathname = `/${database}`
    pool = createPostgresPool(url.href, { max: 2 })
    await runMigrations(pool, join(gateway, 'deploy/postgres/migrations'))
    const slug = randomUUID()
    const { id: organization } = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Runtime drain fixture') RETURNING id`, [slug])).rows[0]!
    const { id: node } = (await pool.query<{ id: string }>(`INSERT INTO harness.compute_nodes(organization_id,name)
      VALUES($1,'runtime-drain') RETURNING id`, [organization])).rows[0]!
    const expected = new Map<number, { runtimeId: string; id: number; outcome: string }>()
    for (const [index, outcome] of outcomes.entries()) {
      const directory = join(root, `project-${index}`)
      await mkdir(directory)
      const project = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(organization_id,name)
        VALUES($1,$2) RETURNING id,public_id`, [organization, `Fixture ${index}`])).rows[0]!
      await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
        VALUES($1,$2,$3,$4,$4)`, [organization, project.id, node, directory])
      const generation = index + 7
      const { runtime_id: runtimeId } = (await pool.query<{ runtime_id: string }>(`INSERT INTO harness.instances(
        organization_id,project_id,assigned_node_id,port,generation,observed_generation,observed_state,desired_state)
        VALUES($1,$2,$3,$4,$5,$5,'ready','running') RETURNING runtime_id`, [organization, project.id, node, 46_000 + index, generation])).rows[0]!
      expected.set(generation, { runtimeId, id: Number(project.public_id), outcome })
    }
    const env = testEnvironment(root, {
      PATH: process.env.PATH, LANG: 'C.UTF-8', HGW_DATABASE_URL: url.href, HGW_ORGANIZATION_SLUG: slug,
      HGW_COMPUTE_NODE_NAME: 'runtime-drain', HGW_STEWARD: 'off', HGW_LAUNCHER: 'local', HGW_RECONCILE: 'off',
      HGW_PORT: '8899', HGW_INTAKE_PORT: '8900', HGW_DSH_REPO_ROOT: join(gateway, '..'),
      HGW_DRAIN_RUNTIMES_ON_SHUTDOWN: mode === 'retained' ? 'false' : 'true',
      HGW_RUNTIME_DRAIN_TIMEOUT_MS: mode === 'deadline' ? '1000' : '15000',
      HGW_TEST_DRAIN_OUTCOMES: JSON.stringify(Object.fromEntries([...expected].map(([generation, { outcome }]) => [generation, outcome]))),
      NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
    })
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--import',
      new URL('./fixtures/node-runtime-drain-preload.mjs', import.meta.url).href, join(gateway, 'src/index.ts')],
    { cwd: gateway, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 55_000, killSignal: 'SIGKILL' })
    exit = new Promise((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    void exit.catch(() => {})
    for (const stream of [child.stdout, child.stderr]) stream!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-40_000) })
    let ingress: number | undefined
    const attempted: number[] = []
    child.on('message', (message: { kind: string; address?: { port: number }; generation?: number }) => {
      if (message.kind === 'gateway-listening') ingress = message.address?.port
      if (message.kind === 'runtime-stop' && message.generation !== undefined) attempted.push(message.generation)
    })
    await until(async () => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Gateway exited before binding\n${diagnostic}`)
      return ingress !== undefined
    }, () => `Gateway listener never bound\n${diagnostic}`)
    const health = await fetch(`http://127.0.0.1:${ingress}/healthz`, { signal: AbortSignal.timeout(5_000) })
    expect(health.status).toBe(200)
    if (process.platform === 'win32') child.send('stop-fixture-gateway')
    else child.kill('SIGTERM')
    expect(await exit, diagnostic).toEqual({ code: exitCode, signal: null })
    const marker = '[gateway] Runtime drain '
    const reports = diagnostic.split('\n').filter(line => line.startsWith(marker)).map(line => JSON.parse(line.slice(marker.length)) as RuntimeDrainReport)
    const rows = (await pool.query<{ generation: string; observed_state: string }>(`SELECT generation::text,observed_state FROM harness.instances
      WHERE organization_id=$1 AND runtime_id=ANY($2::uuid[]) ORDER BY generation`, [organization, [...expected.values()].map(item => item.runtimeId)])).rows
    if (mode === 'retained') {
      expect(reports).toEqual([])
      expect(attempted).toEqual([])
      expect(rows.map(row => row.observed_state)).toEqual(['ready'])
      return
    }
    expect(reports).toHaveLength(1)
    const report = reports[0]!
    expect(report).toMatchObject({ inventory: 'complete', deadlineExceeded: mode === 'deadline', succeeded: mode === 'confirmed' })
    expect(report.runtimes).toHaveLength(expected.size)
    expect(attempted.toSorted((a, b) => a - b)).toEqual([...expected.keys()])
    for (const entry of report.runtimes) {
      const item = expected.get(entry.generation!)!
      expect(entry.target).toEqual({ kind: 'project', id: item.id, runtimeId: item.runtimeId })
      const observed = rows.find(row => Number(row.generation) === entry.generation)?.observed_state
      if (item.outcome === 'blocked') {
        expect(entry.state).toBe('stopping')
        expect(observed).toBe('stopping')
      } else if (item.outcome === 'throws') {
        expect(entry).toMatchObject({ state: 'failed', error: 'Error' })
        expect(observed).toBe('stopping')
      } else {
        expect(entry).toMatchObject({ state: 'stopped', shutdownOutcome: item.outcome })
        expect(observed).toBe('stopped')
      }
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    try { await exit } finally {
      try { await pool?.end() } finally {
        try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) } finally {
          try { await admin.end() } finally { await rm(root, { recursive: true, force: true }) }
        }
      }
    }
  }
}, 60_000)
