/** Exercise the normal primary Admin API and both independently polling Gateway recovery workers on disposable installations. */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PeerBackupDrill } from '../src/peer-backup-restic.ts'
import { projectReplacementLayout } from '../src/peer-backup-takeover-layout.ts'
import { stagePeerProjectFiles } from '../src/peer-backup-takeover-files.ts'
import { PeerRecoveryStageRoots } from '../src/peer-backup-takeover-reservations.ts'
import { createPostgresPool } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import type { GatewayConfig } from '../src/config.ts'
import type { InstanceManager } from '../src/instances.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import type { PeerProjectFileSnapshots } from '../src/peer-backup-project-export.ts'
import type { PeerBackupPolicy } from '../src/peer-backup-governance.ts'
import type { PeerPoint } from '../src/peer-backup-repository.ts'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'
import { PeerProjectRecovery, recoveryBinding } from '../src/peer-backup-takeover.ts'
import { readProjectScheduleWitness } from '../src/peer-backup-takeover-schedule.ts'
import { testConfig } from './test-config.ts'

interface Input {
  a: PostgresRuntimeContext
  b: PostgresRuntimeContext
  cfg: GatewayConfig
  old: NodeContentStore
  next: NodeContentStore
  fileProvider: PeerProjectFileSnapshots
  manager: InstanceManager
  admin: number
  root: string
  policy: PeerBackupPolicy
  point: PeerPoint
  write: string
  read: string
  passwordFile: string
  origin: string
  drill: PeerBackupDrill
  restic: string
  limits: { maxBytes: number; maxRows: number; reserveBytes: number }
  session: string
  rootId: string
  volumeId: string
  witness: string
}
export async function runNormalRecovery(input: Input): Promise<void> {
  const { cfg, old, next, fileProvider, manager, root, limits, point, policy } = input
  const controlUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
  if(!controlUrl) throw new Error('An isolated PostgreSQL test database is required.')
  const a={...input.a,pool:createPostgresPool(controlUrl,{max:1})},b={...input.b,pool:createPostgresPool(controlUrl,{max:1})}
  const transcript:string[]=[]
  const cfgB = testConfig(join(root, 'replacement'))
  for (const directory of [cfgB.projectsRoot, cfgB.userProjectsRoot, cfgB.projectRuntimesRoot, cfgB.stateRoot])
    await mkdir(directory, { recursive: true, mode: 0o700 })
  async function install(label: string, context: PostgresRuntimeContext, config: GatewayConfig, volume: NodeContentStore) {
    const base = join(root, label)
    await mkdir(base, { mode: 0o700 })
    const append = join(base, 'append'),
      escrow = join(base, 'escrow')
    await writeFile(append, input.write, { mode: 0o600 })
    await writeFile(escrow, input.read, { mode: 0o600 })
    const configFile = join(base, 'config.json')
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        directory: join(base, 'repo'),
        stagingDirectory: join(base, 'stage'),
        resticExecutable: input.restic,
        capacityBytes: 64 << 20,
        maxExportBytes: limits.maxBytes,
        maxExportRows: limits.maxRows,
        reserveBytes: limits.reserveBytes,
        pollMs: 1000,
        uploadKiBps: 8192,
        downloadKiBps: 8192,
        routes: [
          {
            policyId: policy.policyId,
            origin: input.origin,
            ...(label === 'source-gw'
              ? { appendTokenFile: append, passwordFile: input.passwordFile }
              : { recoveryTokenFile: escrow, recoveryPasswordFile: input.passwordFile }),
          },
        ],
      }),
      { mode: 0o600 },
    )
    return createPeerBackupGateway({
      context,
      nodeContent: volume,
      files: fileProvider,
      stateRoot: config.stateRoot,
      configFile,
      recovery: { config, volume, instances: manager, fileGate: new PeerProjectFileGate(config.stateRoot) },
    })
  }
  const primary = await install('source-gw', a, cfg, old),
    secondary = await install('target-gw', b, cfgB, next)
  const http = createServer((req, res) => {
    void primary.admin(req, res, input.admin)
  })
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok))
  const base = 'http://127.0.0.1:' + (http.address() as AddressInfo).port + '/admin/api/peer-backups/recoveries'
  async function request(suffix: string, body?: unknown) {
    const response = await fetch(
      base + suffix,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
    const value = await response.json()
    if (!response.ok) throw new Error('Recovery entry returned ' + response.status + ': ' + JSON.stringify(value))
    return value
  }
  let id = randomUUID()
  const work = new PeerProjectFileGate(cfgB.stateRoot,'peer-project-recovery-work')
  const project=Number((await a.pool.query('SELECT public_id FROM harness.projects WHERE organization_id=$1 AND id=$2',[a.organizationId,policy.scopeId])).rows[0].public_id)
  const business=(suffix:string, method:string, body:unknown)=>fetch(base.replace(/\/recoveries$/u,'')+suffix,{
    method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  let writeToken=input.write, readToken=input.read, revision=policy.revision
  const configure=(enabled:boolean, quota=policy.quotaBytes)=>business('','PUT',{id:policy.policyId,expectedRevision:revision,scopeKind:'project',scopeId:policy.scopeId,
    sourceNodeId:a.nodeId,targetNodeId:b.nodeId,tier:policy.tier,enabled,quotaBytes:quota,appendFingerprint:createHash('sha256').update(writeToken).digest('hex'),
    recoveryFingerprint:createHash('sha256').update(readToken).digest('hex')})
  const recover=()=>request('',{requestId:id,policyId:policy.policyId,pointId:point.pointId,targetNode:b.nodeId,targetVolume:input.volumeId})
  async function drillCurrent(){
    const reply=await business('/'+policy.policyId+'/drill','POST',{pointId:point.pointId,recoveryNodeId:b.nodeId})
    expect(reply.status).toBe(202)
    const queued=await reply.json() as {operationId:string}
    await expect.poll(async()=>(await b.pool.query('SELECT status FROM harness.peer_backup_work WHERE id=$1',[queued.operationId])).rows[0]?.status,
      {timeout:18000,interval:200}).toBe('confirmed')
  }
  const poll = async (expected: string) => {
    await expect
      .poll(
        async () => {
          const row = await request('/' + id)
          return row.lastError ?? (row.targetActivatedAt ? 'serving' : row.phase)
        },
        { timeout: 22000, interval: 250 },
      )
      .toBe(expected)
  }
  try {
    expect((await request('?policyId=' + policy.policyId)).targets).toEqual([{ nodeId: b.nodeId, volumeId: input.volumeId }])
    await work.exclusive(project,async()=>{
      expect(await recover()).toEqual({operationId:id})
      const op=await new PeerProjectRecovery(b,next).get(id), layout=await projectReplacementLayout(cfgB,b,op)
      let reservations=new PeerRecoveryStageRoots(next,op)
      await mkdir(layout.runtimeHome,{mode:0o700})
      await writeFile(join(layout.runtimeHome,'outside'),'pre-existing unrelated files')
      await expect(reservations.reserve('runtime',layout.runtimeHome)).rejects.toMatchObject({code:'peer-backup/replacement-must-be-empty'})
      expect(await readFile(join(layout.runtimeHome,'outside'),'utf8')).toBe('pre-existing unrelated files')
      await rm(layout.runtimeHome,{recursive:true})
      await reservations.reserve('workspace',layout.workspace)
      await writeFile(join(layout.workspace,'manual-note'),'independent operator file')
      reservations=new PeerRecoveryStageRoots(next,op)
      expect(await reservations.withdraw()).toBe(1)
      const retained=(await readdir(dirname(layout.workspace))).filter(name=>name.startsWith('.hgw-recovery-retained-'))
      expect(await readFile(join(dirname(layout.workspace),retained[0]!,'manual-note'),'utf8')).toBe('independent operator file')
      await reservations.reserve('workspace',layout.workspace)
      await reservations.reserve('runtime',layout.runtimeHome)
      reservations=new PeerRecoveryStageRoots(next,op)
      expect(await reservations.withdraw()).toBe(2)
      await stagePeerProjectFiles(op,input.drill,layout,limits,new AbortController().signal,reservations)
      // All four roots are durable but the target SQL candidate has not committed.
    })
    await poll('target-ready')
    await request('/'+id+'/cancel',{confirm:id})
    await expect.poll(async()=>(await request('/'+id)).cleanupPending,{timeout:16000,interval:200}).toBe(false)
    expect((await next.readVolume(db=>db.query('SELECT FROM node_content.recovery_candidates WHERE operation_id=$1',[id]))).rowCount).toBe(0)
    transcript.push('Three interrupted preparations recovered on the original volume. Cancellation released the candidate and preserved the unrelated file.')
    id=randomUUID()
    await recover()
    await poll('target-ready')
    const busy=await configure(true,policy.quotaBytes+1)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({error:'peer-backup/recovery-in-progress'})
    const pausedEdit=await configure(false,policy.quotaBytes+1)
    expect(pausedEdit.status).toBe(409)
    expect(await pausedEdit.json()).toEqual({error:'peer-backup/recovery-in-progress'})
    const ownerGrant=(allowed:boolean)=>a.pool.query(`UPDATE harness.computer_use_permissions g SET enabled=$4 FROM harness.projects p
      WHERE g.organization_id=$1 AND p.id=$2 AND p.organization_id=g.organization_id AND g.user_id=p.owner_user_id AND g.node_id=$3`,
      [a.organizationId,policy.scopeId,b.nodeId,allowed])
    await ownerGrant(false)
    await expect(request('/'+id+'/approve-retirement',{confirm:id})).rejects.toThrow('project-owner-unavailable')
    await ownerGrant(true)
    await request('/' + id + '/approve-retirement', { confirm: id })
    await poll('old-fenced')
    await ownerGrant(false)
    await expect(request('/'+id+'/activate',{confirm:id})).rejects.toThrow('project-owner-unavailable')
    await ownerGrant(true)
    transcript.push('Revoking the project owner’s destination access blocked retirement approval and blocked the final switch.')
    expect((await configure(true,policy.quotaBytes+1)).status).toBe(409)
    readToken='dedicated-escrow-'+randomUUID()
    await writeFile(join(root,'target-gw','escrow'),readToken,{mode:0o600})
    const rotated=await configure(true)
    expect(rotated.status).toBe(200)
    revision=(await rotated.json()).revision
    expect((await request('/'+id)).reapprovalRequired).toBe(true)
    const reapprove=(phase:string,rev=revision,confirm=id)=>request('/'+id+'/reapprove',{confirm,phase,policyRevision:rev})
    await expect(reapprove('old-fenced',revision,randomUUID())).rejects.toThrow('409')
    await expect(reapprove('prepared')).rejects.toThrow('409')
    await expect(reapprove('old-fenced',revision-1)).rejects.toThrow('409')
    await expect(reapprove('old-fenced')).rejects.toThrow('current-revision-drill-required')
    await expect(request('/'+id+'/activate',{confirm:id})).rejects.toThrow('recovery-approval-changed')
    await drillCurrent()
    expect((await reapprove('old-fenced')).reapprovalRequired).toBe(false)
    await work.exclusive(project,async()=>{
      await request('/' + id + '/activate', { confirm: id })
      expect((await configure(false)).status).toBe(200)
      revision++
      await expect(reapprove('published')).rejects.toThrow('recovery-approval-changed')
      const resumed=await configure(true)
      expect(resumed.status).toBe(200)
      revision=(await resumed.json()).revision
      await drillCurrent()
      expect((await reapprove('published')).policyRevision).toBe(revision)
      expect((await request('/'+id)).targetActivatedAt).toBeNull()
    })
    await poll('serving')
    transcript.push('A rotated escrow credential required a new drill and explicit approval. Re-enabling the old policy after publication did not activate the destination until approval.')
    expect((await request('/'+id)).policyEnabled).toBe(false)
    expect((await a.pool.query(`SELECT FROM harness.peer_backup_work WHERE organization_id=$1 AND policy_id=$2 AND status IN('running','queued')`,[a.organizationId,policy.policyId])).rowCount).toBe(0)
    expect((await a.pool.query('SELECT FROM harness.peer_backup_points WHERE id=$1 AND policy_id=$2',[point.pointId,policy.policyId])).rowCount).toBe(1)
    transcript.push('After the destination acknowledged activation the former source policy paused. Its recovery point and audit identities remained intact.')
    const finished = await new PeerProjectRecovery(b, next, limits).get(id),
      binding = recoveryBinding(finished, 'target')
    const doc = await next.read(
      binding,
      async (tx) =>
        (
          await tx.query(
            'SELECT d.root_id,s.root_path FROM node_content.document_roots d JOIN node_content.spaces s USING(organization_id,runtime_id) WHERE d.runtime_id=$1',
            [binding.runtimeId],
          )
        ).rows[0],
    )
    expect(doc?.root_id).toBe(input.rootId)
    expect(await readFile(join(doc!.root_path, 'documents', 'report.txt'), 'utf8')).toBe('bytes to recover\n')
    expect(await next.read(binding, (tx) => readProjectScheduleWitness(tx, binding, limits))).toBe(input.witness)
    await expect(old.write(recoveryBinding(finished, 'source'), async () => true)).rejects.toThrow()
    transcript.push('The old writer rejected new work. The replacement recovered the file bytes and original schedule receipts with one governance connection per Gateway.')
    expect(transcript.join('\n')+'\n').toBe(await readFile(fileURLToPath(new URL('./expected/project-recovery-retry.txt',import.meta.url)),'utf8'))
  } finally {
    await new Promise<void>((ok) => http.close(() => ok()))
    await Promise.all([primary.close(), secondary.close()])
    await Promise.all([a.pool.end(),b.pool.end()])
  }
}
