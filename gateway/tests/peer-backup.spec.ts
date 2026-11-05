import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { snapshotManagedFiles } from '../src/managed-files.ts'
import { PEER_REPOSITORY_PREFIX, PeerBackupError, PeerBackupRepository } from '../src/peer-backup-repository.ts'
import { PeerBackupRestic, verifyPeerManagedFiles, type PeerBackupExporter } from '../src/peer-backup-restic.ts'
import { exportOfflinePeerRepository } from '../src/peer-backup-offline.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-peer-test-')))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const binding = {
    policyId: randomUUID(),
    organizationId: randomUUID(),
    sourceNodeId: randomUUID(),
    targetNodeId: randomUUID(),
    scopeId: randomUUID(),
    revision: 1,
  }
  const token = randomBytes(32).toString('hex'),
    recovery = randomBytes(32).toString('hex')
  let allowed = true
  const assertPair = async (): Promise<void> => {
    if (!allowed) throw new PeerBackupError(403, 'peer-backup/pair-denied')
  }
  const repoRoot = join(directory, 'designated-target')
  const repo = await PeerBackupRepository.open({
    directory: repoRoot,
    nodeId: binding.targetNodeId,
    capacityBytes: 16 << 20,
    maxObjectBytes: 8 << 20,
    objectLimit: 200,
    concurrency: 8,
    grant: async (id, user, secret) => {
      await assertPair()
      if (id !== binding.policyId || user !== binding.sourceNodeId || (secret !== token && secret !== recovery))
        throw new PeerBackupError(403, 'peer-backup/pair-denied')
      return { ...binding, mode: secret === token ? 'append' : 'recover', quotaBytes: 12 << 20, revalidate: assertPair }
    },
  })
  cleanups.push(() => repo.close())
  const server = createServer((req, res) => {
    void repo.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  cleanups.push(
    () =>
      new Promise<void>((ok, fail) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error) fail(error)
          else ok()
        })
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test loopback unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  const source = join(directory, 'source'),
    escrow = join(directory, 'independent-escrow'),
    staging = join(directory, 'worker')
  await mkdir(source, { mode: 0o700 })
  await mkdir(escrow, { mode: 0o700 })
  const key = randomBytes(32).toString('hex')
  const passwordFile = join(source, 'recovery.key'),
    recoveryFile = join(escrow, 'recovery.key')
  await writeFile(passwordFile, key, { mode: 0o600 })
  await writeFile(recoveryFile, key, { mode: 0o600 })
  return {
    directory,
    source,
    staging,
    repoRoot,
    binding,
    token,
    recovery,
    origin,
    passwordFile,
    recoveryFile,
    revoke: () => {
      allowed = false
    },
  }
}

it('refuses wrong peers, poisoned object identifiers, replacement and ordinary deletion', async () => {
  const f = await fixture()
  const upload = Buffer.from('synthetic ciphertext')
  const url = f.origin + PEER_REPOSITORY_PREFIX + f.binding.policyId + '/data/' + hash(upload)
  const headers = { authorization: 'Basic ' + Buffer.from(f.binding.sourceNodeId + ':' + f.token).toString('base64') }
  expect((await fetch(url, { method: 'POST', headers, body: upload })).status).toBe(200)
  expect((await fetch(url, { method: 'POST', headers, body: upload })).status).toBe(200)
  expect((await fetch(url, { method: 'POST', headers, body: 'different' })).status).toBe(422)
  expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(403)
  expect(
    (await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from('wrong:' + f.token).toString('base64') } })).status,
  ).toBe(403)
  f.revoke()
  expect((await fetch(url, { headers })).status).toBe(403)
})

it.skipIf(!process.env.HGW_TEST_RESTIC)(
  'recovers a real encrypted incremental repository after deleting the synthetic source',
  async () => {
    const f = await fixture()
    const backend = new PeerBackupRestic({
      executable: process.env.HGW_TEST_RESTIC!,
      stagingDirectory: f.staging,
      uploadKiBps: 16384,
      downloadKiBps: 16384,
      timeoutMs: 120000,
      maxRestoreBytes: 8 << 20,
      reserveBytes: 1 << 20,
    })
    const sentinel = 'confidential-project-payload-' + randomUUID()
    const version = join(f.source, 'sealed-project-version')
    await mkdir(version)
    await writeFile(join(version, 'attachment.txt'), sentinel)
    const exporter: PeerBackupExporter = {
      async capture(binding, path, signal) {
        const dir = join(path, 'managed')
        await mkdir(dir, { mode: 0o700 })
        const snapshot = await snapshotManagedFiles(
          [{ owner: 'synthetic-plugin', path: version, kind: 'directory' }],
          dir,
          signal,
        )
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(snapshot))
        return {
          version: 1,
          organizationId: binding.organizationId,
          scopeId: binding.scopeId,
          sourceNodeId: binding.sourceNodeId,
          writerEpoch: '2',
          watermark: '5',
          capturedAt: new Date().toISOString(),
          coveredCount: 1,
          gaps: [],
        }
      },
      async validate(_binding, _capture, path, signal) {
        await verifyPeerManagedFiles(join(path, 'managed'), signal)
      },
    }
    const access = { origin: f.origin, user: f.binding.sourceNodeId, token: f.token, passwordFile: f.passwordFile }
    const pointId = randomUUID(),
      signal = new AbortController().signal
    const first = await backend.backup(f.binding, access, exporter, pointId, signal)
    expect(await backend.backup(f.binding, access, exporter, pointId, signal)).toEqual(first)
    const second = await backend.backup(f.binding, access, exporter, randomUUID(), signal)
    expect(second.pointId).not.toBe(first.pointId)
    await rm(f.source, { recursive: true })
    for (const file of await readdir(f.repoRoot))
      expect((await readFile(join(f.repoRoot, file))).includes(Buffer.from(sentinel))).toBe(false)
    const drill = await backend.drill(
      f.binding,
      first.pointId,
      { ...access, token: f.recovery, passwordFile: f.recoveryFile },
      exporter,
      signal,
    )
    try {
      const manifest = JSON.parse(await readFile(join(drill.directory, 'managed', 'manifest.json'), 'utf8')) as {
        files: Array<{ member: string }>
      }
      expect(await readFile(join(drill.directory, 'managed', manifest.files[0]!.member), 'utf8')).toBe(sentinel)
    } finally {
      await drill.dispose()
    }
    f.revoke()
    const offline = await exportOfflinePeerRepository({
      ...f.binding,
      pointId: first.pointId,
      repositoryDirectory: f.repoRoot,
      privateRecoveryDirectory: join(f.directory, 'disaster-recovery'),
      maxBytes: 16 << 20,
      reserveBytes: 1 << 20,
      signal,
    })
    try {
      const recovered = await backend.drillOffline(offline.point, offline.repository, f.recoveryFile, exporter, signal)
      try {
        expect(recovered.point).toEqual(first)
      } finally {
        await recovered.dispose()
      }
    } finally {
      await offline.dispose()
    }
  },
  120000,
)
