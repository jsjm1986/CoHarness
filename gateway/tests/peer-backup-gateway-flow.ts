/** Exercise two running backup gateways against real governance and a real restic encryption engine. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { rehearseOfflinePeer } from '../src/peer-backup-rehearse-main.ts'
import { exportOfflinePeerRepository } from '../src/peer-backup-offline.ts'
import { PeerBackupGovernance } from '../src/peer-backup-governance.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { GatewayConfig } from '../src/config.ts'

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener has no address')
  return 'http://127.0.0.1:' + address.port
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    }),
  )
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Run only inside the private peer test database. Both nodes, identities, files and recovery material are synthetic. */
export async function actualPeerFlow(
  primary: PostgresRuntimeContext,
  target: PostgresRuntimeContext,
  admin: number,
  base: string,
  resticExecutable: string,
  options:{sourceConfig?:GatewayConfig;beforeOffline?:()=>Promise<void>;afterOffline?:(directory:string,pointId:string)=>Promise<void>;rotate?:boolean}={},
) {
  const root = await realpath(base),
    policyId = randomUUID()
  const append = randomBytes(32).toString('hex'),
    recover = randomBytes(32).toString('hex'),
    key = randomBytes(32).toString('hex')
  const file = async (name: string, body: string) => {
    const path = join(root, name)
    await writeFile(path, body, { mode: 0o600, flag: 'wx' })
    return path
  }
  const config = {
    version: 1,
    resticExecutable,
    capacityBytes: 20 << 20,
    maxExportBytes: 4 << 20,
    reserveBytes: 1 << 20,
    pollMs: 1000,
    uploadKiBps: 8192,
    downloadKiBps: 8192,
    routes: [],
  }
  const encrypted = join(root, 'target-encrypted')
  const escrow = await file('escrow-secret', key)
  const successor = { id: randomUUID(), append:randomBytes(32).toString('hex'), recover:randomBytes(32).toString('hex') }
  const successorKey = options.rotate ? await file('successor-escrow-secret',randomBytes(32).toString('hex')) : ''
  const successorRecovery = options.rotate ? await file('successor-recovery-token',successor.recover) : ''
  let receiver: Awaited<ReturnType<typeof createPeerBackupGateway>>
  const targetServer = createServer((req, res) => { void receiver.internal(req, res) })
  const origin = await listen(targetServer)
  const receiverConfig = await file(
      'target-config',
      JSON.stringify({
        ...config,
        directory: encrypted,
        stagingDirectory: join(root, 'target-plain'),
        ...(options.rotate ? { routes:[{policyId:successor.id,origin,
          recoveryPasswordFile:successorKey,recoveryTokenFile:successorRecovery}] } : {}),
      }),
  )
  const startReceiver = () => createPeerBackupGateway({ context: target, configFile: receiverConfig })
  receiver = await startReceiver()
  const sourceKey = await file('source-secret', key)
  const sourceDirectory = join(root, 'source-private')
  await mkdir(sourceDirectory, { mode: 0o700 })
  const source = await createPeerBackupGateway({
    context: primary,
    ...(options.sourceConfig?{config:options.sourceConfig}:{}),
    configFile: await file(
      'source-config',
      JSON.stringify({
        ...config,
        directory: join(sourceDirectory, 'repo'),
        stagingDirectory: join(sourceDirectory, 'stage'),
        routes: [{ policyId, origin, passwordFile: sourceKey, appendTokenFile: await file('append-token', append) },
          ...(options.rotate ? [{policyId:successor.id,origin,passwordFile:successorKey,
            appendTokenFile:await file('successor-append-token',successor.append)}] : [])],
      }),
    ),
  })
  const server = createServer((req, res) => {
    void source.admin(req, res, admin)
  })
  const api = (await listen(server)) + '/admin/api/peer-backups'
  const submit = (url: string, method: string, data: unknown) =>
    fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  let pointId: string | undefined
  let finalPolicy = policyId, finalKey = escrow
  const list = async (id:string) => (((await (await fetch(api)).json()) as {policies:{policyId:string; revision:number;
    coverage:string; freshness:string; pointId:string|null; captureStoppedAt:string|null; retiredAt:string|null; retirementNeedsReview:boolean;
    receiverCapacity:{used:number; remaining:number; receiverUsed:number}|null; retirementCandidate:{pointId:string}|null
  }[]}).policies.find(row=>row.policyId===id))!
  try {
    const policy = {
      id: policyId,
      expectedRevision: 0,
      scopeKind: 'governance',
      scopeId: primary.organizationId,
      sourceNodeId: primary.nodeId,
      targetNodeId: target.nodeId,
      tier: 'important',
      enabled: true,
      quotaBytes: 12 << 20,
      appendFingerprint: digest(append),
      recoveryFingerprint: digest(recover),
    }
    expect((await submit(api, 'PUT', { ...policy, enabled:!options.rotate })).status).toBe(200)
    if (options.rotate) {
      await expect.poll(async()=>(await list(policyId)).receiverCapacity?.used,{timeout:10000}).toBe(0)
      expect(await list(policyId)).toMatchObject({ pointId:null, freshness:'unprotected' })
      expect((await submit(api,'PUT',{...policy,expectedRevision:1})).status).toBe(200)
    }
    const start = await submit(api + '/' + policyId + '/capture', 'POST', {})
    expect(start.status, await start.clone().text()).toBe(202)
    const job = (await start.json()) as { operationId: string }
    const deadline = Date.now() + 45000
    let lastState:unknown
    while (Date.now() < deadline) {
      const read = (await (await fetch(api)).json()) as {
        policies: Array<{
          policyId: string
          pointId?: string
          errorCode?: string
          coverage: string
          repositoryBytes: number
        }>
      }
      const row = read.policies.find((value) => value.policyId === policyId)
      lastState=row?{coverage:row.coverage,errorCode:row.errorCode,pointId:row.pointId}:null
      if (row?.errorCode) throw new Error(row.errorCode)
      if (row?.pointId) {
        pointId = row.pointId
        expect(row.coverage).toBe('current')
        expect(row.repositoryBytes).toBeGreaterThan(0)
        break
      }
      await delay(80)
    }
    expect(pointId,JSON.stringify(lastState)).toBe(job.operationId)
    if (options.rotate) {
      const before = await list(policyId)
      expect((await submit(api,'PUT',{...policy,id:successor.id,appendFingerprint:digest(successor.append),
        recoveryFingerprint:digest(successor.recover),replacementOf:{policyId,revision:before.revision}})).status).toBe(200)
      const url = `${origin}/internal/peer-backups/v1/repositories/${policyId}/points/${pointId}`
      const authorization = (token:string)=>`Basic ${Buffer.from(primary.nodeId+':'+token).toString('base64')}`
      expect((await fetch(url,{headers:{authorization:authorization(recover)}})).status).toBe(200)
      expect((await fetch(url,{headers:{authorization:authorization(append)}})).status).toBe(403)
      await expect.poll(async()=>(await list(successor.id)).pointId,{timeout:30000}).toEqual(expect.any(String))
      let witness = (await list(successor.id)).pointId!
      let request = { confirm:policyId,revision:before.revision,pointId:witness }
      const retire = ()=>submit(api+'/'+policyId+'/retire','POST',request)
      expect(await (await retire()).json()).toEqual({error:'peer-backup/retirement-verified-point-required'})
      const task = await submit(api+'/'+successor.id+'/drill','POST',{pointId:witness,recoveryNodeId:target.nodeId})
      expect(task.status).toBe(202)
      await expect.poll(async()=>(await list(policyId)).retirementCandidate?.pointId,{timeout:30000}).toBe(witness)
      // Stop this synthetic receiver before the approval so invalidation cannot race real deletion.
      await receiver.close()
      expect((await retire()).status).toBe(202)
      const successorPolicy = {...policy,id:successor.id,appendFingerprint:digest(successor.append), recoveryFingerprint:digest(successor.recover)}
      expect((await submit(api,'PUT',{...successorPolicy,expectedRevision:1,enabled:false})).status).toBe(200)
      expect((await list(policyId)).retirementNeedsReview).toBe(true)
      receiver = await startReceiver()
      const receiverAuthority = new PeerBackupGovernance(target)
      const bypass = () => { throw Error('Reclaim reached the filesystem with a disabled retained policy') }
      expect(await receiverAuthority.reclaimReceiverRepository('',bypass)).toBe('')
      const original = await exportOfflinePeerRepository({repositoryDirectory:encrypted,privateRecoveryDirectory:join(root,'retained-original'),
        organizationId:primary.organizationId,sourceNodeId:primary.nodeId,targetNodeId:target.nodeId,policyId,pointId:pointId!,
        maxBytes:6<<20,reserveBytes:1<<20,signal:new AbortController().signal})
      await original.dispose()
      expect((await submit(api,'PUT',{...successorPolicy,expectedRevision:2,enabled:true})).status).toBe(200)
      expect(await receiverAuthority.reclaimReceiverRepository('',bypass)).toBe('')
      await expect.poll(async()=>(await list(successor.id)).pointId ?? witness,{timeout:30000}).not.toBe(witness)
      witness = (await list(successor.id)).pointId!
      expect((await submit(api+'/'+successor.id+'/drill','POST',{pointId:witness,recoveryNodeId:target.nodeId})).status).toBe(202)
      await expect.poll(async()=>(await list(policyId)).retirementCandidate?.pointId,{timeout:30000}).toBe(witness)
      request = { confirm:policyId,revision:(await list(policyId)).revision,pointId:witness }
      await expect.poll(async()=>(await list(successor.id)).receiverCapacity?.used ?? 0,{timeout:15000}).toBeGreaterThan(0)
      const occupied = (await list(successor.id)).receiverCapacity!.receiverUsed
      expect((await retire()).status).toBe(202)
      await expect.poll(async()=>(await list(policyId)).retiredAt,{timeout:20000}).toEqual(expect.any(String))
      expect((await retire()).status).toBe(202)
      expect((await fetch(url,{headers:{authorization:authorization(recover)}})).status).toBe(403)
      await expect(exportOfflinePeerRepository({repositoryDirectory:encrypted,privateRecoveryDirectory:join(root,'retired-offline'),
        organizationId:primary.organizationId,sourceNodeId:primary.nodeId,targetNodeId:target.nodeId,policyId,pointId:pointId!,
        maxBytes:6<<20,reserveBytes:1<<20,signal:new AbortController().signal})).rejects.toMatchObject({status:410})
      await expect.poll(async()=>(await list(successor.id)).receiverCapacity?.receiverUsed ?? occupied,{timeout:15000}).toBeLessThan(occupied)
      expect((await submit(api+'/'+successor.id+'/capture','POST',{})).status).toBe(202)
      await expect.poll(async()=>(await list(successor.id)).pointId ?? witness,{timeout:30000}).not.toBe(witness)
      finalPolicy = successor.id
      finalKey = successorKey
      pointId = witness
    } else expect((await submit(api, 'PUT', { ...policy, expectedRevision: 1, enabled: false })).status).toBe(200)
  } finally {
    await close(server)
    await source.close()
    await close(targetServer)
    await receiver.close()
  }
  await rm(sourceKey)
  await rm(sourceDirectory, { recursive: true })
  if(options.beforeOffline)await options.beforeOffline()
  const offline = await file(
    'recovery-config',
    JSON.stringify({
      version: 1,
      organizationId: primary.organizationId,
      sourceNodeId: primary.nodeId,
      targetNodeId: target.nodeId,
      policyId: finalPolicy,
      pointId,
      kind: 'governance',
      repositoryDirectory: encrypted,
      recoveryDirectory: join(root, 'isolated-after-disaster'),
      passwordFile: finalKey,
      resticExecutable,
      maxBytes: 6 << 20,
      reserveBytes: 1 << 20,
      maxRows: 2000,
      timeoutMs: 45000,
    }),
  )
  const restored = await rehearseOfflinePeer(offline, new AbortController().signal)
  expect(restored.gapCount).toBe(0)
  expect(restored.publication).toBe('fenced')
  const body = await readFile(join(restored.isolatedDirectory, 'governance-rebuild.jsonl'), 'utf8')
  expect(body).toContain('"table":"memberships"')
  expect(body).not.toContain(append)
  expect(body).not.toContain('credential_hash')
  if (options.rotate) await expect([
    '# Encrypted repository rotation', '',
    'Receiver capacity is measured before the first recovery point.',
    'The original point remains available to recovery readers after rotation.',
    'Retirement without an independently rehearsed complete replacement is refused.',
    'Disabling and revising the retained policy pauses reclaim. A new point and independent drill are required for reapproval.',
    'Administrator approval reclaims the original repository without reviving its credentials on retry.',
    'Captures continue within shared capacity and the retained point rehearses offline.', '',
  ].join('\n')).toMatchFileSnapshot(fileURLToPath(new URL('./snapshots/peer-backup-capacity/rotation.expected.md',import.meta.url)))
  if(options.afterOffline)await options.afterOffline(restored.isolatedDirectory,pointId!)
}
