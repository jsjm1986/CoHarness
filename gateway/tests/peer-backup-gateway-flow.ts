/** Exercise two running backup gateways against real governance and a real restic encryption engine. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from 'vitest'
import { createPeerBackupGateway } from '../src/peer-backup-gateway.ts'
import { rehearseOfflinePeer } from '../src/peer-backup-rehearse-main.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

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
  const receiver = await createPeerBackupGateway({
    context: target,
    configFile: await file(
      'target-config',
      JSON.stringify({
        ...config,
        directory: encrypted,
        stagingDirectory: join(root, 'target-plain'),
      }),
    ),
  })
  const targetServer = createServer((req, res) => {
    void receiver.internal(req, res)
  })
  const origin = await listen(targetServer)
  const sourceKey = await file('source-secret', key)
  const sourceDirectory = join(root, 'source-private')
  await mkdir(sourceDirectory, { mode: 0o700 })
  const source = await createPeerBackupGateway({
    context: primary,
    configFile: await file(
      'source-config',
      JSON.stringify({
        ...config,
        directory: join(sourceDirectory, 'repo'),
        stagingDirectory: join(sourceDirectory, 'stage'),
        routes: [{ policyId, origin, passwordFile: sourceKey, appendTokenFile: await file('append-token', append) }],
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
    expect((await submit(api, 'PUT', policy)).status).toBe(200)
    const start = await submit(api + '/' + policyId + '/capture', 'POST', {})
    expect(start.status).toBe(202)
    const job = (await start.json()) as { operationId: string }
    const deadline = Date.now() + 45000
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
      if (row?.errorCode) throw new Error(row.errorCode)
      if (row?.pointId) {
        pointId = row.pointId
        expect(row.coverage).toBe('partial')
        expect(row.repositoryBytes).toBeGreaterThan(0)
        break
      }
      await delay(80)
    }
    expect(pointId).toBe(job.operationId)
    expect((await submit(api, 'PUT', { ...policy, expectedRevision: 1, enabled: false })).status).toBe(200)
  } finally {
    await close(server)
    await source.close()
    await close(targetServer)
    await receiver.close()
  }
  await rm(sourceKey)
  await rm(sourceDirectory, { recursive: true })
  const offline = await file(
    'recovery-config',
    JSON.stringify({
      version: 1,
      organizationId: primary.organizationId,
      sourceNodeId: primary.nodeId,
      targetNodeId: target.nodeId,
      policyId,
      pointId,
      kind: 'governance',
      repositoryDirectory: encrypted,
      recoveryDirectory: join(root, 'isolated-after-disaster'),
      passwordFile: escrow,
      resticExecutable,
      maxBytes: 6 << 20,
      reserveBytes: 1 << 20,
      maxRows: 2000,
      timeoutMs: 45000,
    }),
  )
  const restored = await rehearseOfflinePeer(offline, new AbortController().signal)
  expect(restored.gapCount).toBeGreaterThan(0)
  expect(restored.publication).toBe('fenced')
  const body = await readFile(join(restored.isolatedDirectory, 'governance.jsonl'), 'utf8')
  expect(body).toContain('"table":"memberships"')
  expect(body).not.toContain(append)
  expect(body).not.toContain('password_hash')
}
