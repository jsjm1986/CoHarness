import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PeerSnapshotOwner } from '../src/peer-backup-snapshot-owner.ts'
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
  const openReceiver = () => PeerBackupRepository.open({
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
  let repo = await openReceiver()
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
    repository: () => repo,
    restartReceiver: async () => {
      await repo.close()
      repo = await openReceiver()
    },
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

it('resumes authorized repository reclaim after restart without accepting a previously admitted writer', async () => {
  const f = await fixture()
  const endpoint = f.origin + PEER_REPOSITORY_PREFIX + f.binding.policyId
  const headers = { authorization: 'Basic ' + Buffer.from(f.binding.sourceNodeId + ':' + f.token).toString('base64') }
  const reader = { authorization: 'Basic ' + Buffer.from(f.binding.sourceNodeId + ':' + f.recovery).toString('base64') }
  const repository = { ...f.binding, quotaBytes: 12 << 20 }
  let url = ''
  for(let index=0;index<9;index++) {
    const payload = Buffer.from(`test pack ${index}`)
    url = endpoint + '/data/' + hash(payload)
    expect((await fetch(url,{method:'POST',headers,body:payload})).status).toBe(200)
  }
  expect((await fetch(url,{method:'DELETE',headers})).status).toBe(403)
  expect((await fetch(url,{method:'DELETE',headers:reader})).status).toBe(403)
  expect((await f.repository().capacity(repository)).used).toBe(9*4096)
  expect(await f.repository().retireBatch(repository)).toBe(false)
  expect((await f.repository().capacity(repository)).used).toBe(4096)
  await f.restartReceiver()
  const payload = Buffer.from('a previously admitted append')
  expect((await fetch(endpoint+'/data/'+hash(payload),{method:'POST',headers,body:payload})).status).toBe(410)
  expect((await fetch(url,{headers:reader})).status).toBe(404)
  expect(await f.repository().retireBatch(repository)).toBe(true)
  expect(await f.repository().retireBatch(repository)).toBe(true)
  expect((await f.repository().capacity(repository)).used).toBe(0)
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
    const insufficientValidationSpace: Pick<PeerBackupExporter, 'validate'> = {
      async validate(_binding, _capture, directory, _signal, space) {
        expect(space).toBeDefined()
        await space!.write(directory, Number.MAX_SAFE_INTEGER, async () => {
          throw new Error('A rejected validation allocation must not run')
        })
      },
    }
    await expect(backend.drill(f.binding, first.pointId,
      { ...access, token: f.recovery, passwordFile: f.recoveryFile }, insufficientValidationSpace, signal))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/recovery-capacity' })
    expect(await readdir(f.staging)).toEqual([])
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
      await expect(backend.drillOffline(offline.point, offline.repository, f.recoveryFile, insufficientValidationSpace, signal))
        .rejects.toMatchObject({ status: 507, code: 'peer-backup/recovery-capacity' })
      expect(await readdir(f.staging)).toEqual([])
    } finally {
      await offline.dispose()
    }
  },
  120000,
)

/** POSIX execFile can launch this private Node shebang directly; Windows requires an approved native provider executable. */
async function personalProvider(f: Awaited<ReturnType<typeof fixture>>) {
  const installation = join(f.directory, 'approved-provider')
  await mkdir(installation, { mode: 0o700 })
  const executable = join(installation, 'provider.mjs'), config = join(installation, 'provider.json')
  const source = join(f.source, 'sealed-personal.json'), sentinel = 'personal-content-' + randomUUID()
  const state = { organizationId: f.binding.organizationId, sourceNodeId: f.binding.sourceNodeId, scopeId: f.binding.scopeId,
    writerEpoch: '2', watermark: '5', capturedAt: '2026-11-01T00:00:00.000Z', domains: {
      directory: { workspaces: ['same'], sessions: ['same'] },
      drafts: [{ tab: 'tab-a', text: 'first draft' }, { tab: 'tab-b', text: 'second draft' }],
      sessions: { generation: 'session.v1.jsonl', inbox: [{ sessionId: 'same', id: 'delivery-1' }] },
      files: { 'document.txt': sentinel },
      'document-references': [{ name: 'document.txt', sha256: hash(Buffer.from(sentinel)) }],
      plugins: { known: ['fixture-memory'], unverified: [] as string[] },
      'background-delivery': { receipts: [{ sessionId: 'same', messageId: 'delivery-1' }] },
    } }
  await writeFile(source, JSON.stringify(state), { mode: 0o600 })
  const script = await readFile(new URL('./fixtures/personal-snapshot-owner.mjs', import.meta.url), 'utf8')
  await writeFile(executable, '#!' + process.execPath + '\n' + script, { mode: 0o700 })
  await writeFile(config, JSON.stringify({ source }), { mode: 0o600 })
  const exporter = new PeerSnapshotOwner(executable, 'personal', 10000, { maxBytes: 1 << 20, maxRows: 100 })
  return { exporter, source, state, config, sentinel }
}

it.skipIf(process.platform === 'win32')('requires every personal provider domain and rejects wrong scope or altered payload before backup', async () => {
  const f = await fixture(), p = await personalProvider(f), payload = join(f.directory, 'validation')
  await mkdir(payload, { mode: 0o700 })
  const signal = AbortSignal.timeout(20000), capture = await p.exporter.capture(f.binding, payload, signal)
  await p.exporter.validate(f.binding, capture, payload, signal)
  await expect(p.exporter.validate({ ...f.binding, scopeId: randomUUID() }, capture, payload, signal)).rejects.toMatchObject({ code: 'peer-backup/snapshot-owner-unavailable' })
  await writeFile(p.config, JSON.stringify({ source: p.source, omitCheck: 'background-delivery' }), { mode: 0o600 })
  await expect(p.exporter.validate(f.binding, capture, payload, signal)).rejects.toMatchObject({ code: 'peer-backup/unverified-domain' })
  await writeFile(p.config, JSON.stringify({ source: p.source }), { mode: 0o600 })
  await writeFile(join(payload, 'personal-provider.json'), JSON.stringify({ ...p.state, writerEpoch: '3' }))
  await expect(p.exporter.validate(f.binding, capture, payload, signal)).rejects.toMatchObject({ code: 'peer-backup/snapshot-owner-unavailable' })
  expect(await readFile(p.source, 'utf8')).toBe(JSON.stringify(p.state))
  p.state.domains['background-delivery'].receipts[0]!.messageId = 'missing-inbox-message'
  await writeFile(p.source, JSON.stringify(p.state))
  const inconsistent = join(f.directory, 'unproved-delivery')
  await mkdir(inconsistent, { mode: 0o700 })
  const unproved = await p.exporter.capture(f.binding, inconsistent, signal)
  await expect(p.exporter.validate(f.binding, unproved, inconsistent, signal)).rejects.toMatchObject({ code: 'peer-backup/snapshot-owner-unavailable' })
})

it.skipIf(process.platform === 'win32' || !process.env.HGW_TEST_RESTIC)('validates an approved personal provider after source loss and keeps unknown plugin coverage partial', async () => {
  const f = await fixture(), p = await personalProvider(f), signal = AbortSignal.timeout(90000)
  const backend = new PeerBackupRestic({ executable: process.env.HGW_TEST_RESTIC!, stagingDirectory: f.staging,
    uploadKiBps: 16384, downloadKiBps: 16384, timeoutMs: 30000, maxRestoreBytes: 8 << 20, reserveBytes: 1 << 20 })
  const access = { origin: f.origin, user: f.binding.sourceNodeId, token: f.token, passwordFile: f.passwordFile }
  await writeFile(p.source, JSON.stringify({ ...p.state, scopeId: randomUUID() }))
  await expect(backend.backup(f.binding, access, p.exporter, randomUUID(), signal)).rejects.toMatchObject({ code: 'peer-backup/capture-mismatch' })
  await writeFile(p.source, JSON.stringify(p.state))
  const full = await backend.backup(f.binding, access, p.exporter, randomUUID(), signal)
  expect(full).toMatchObject({ gapCount: 0, coveredCount: 7 })
  p.state.watermark = '6'
  p.state.domains.plugins.unverified.push('custom-listener')
  await writeFile(p.source, JSON.stringify(p.state))
  const partial = await backend.backup(f.binding, access, p.exporter, randomUUID(), signal)
  expect(partial.gapCount).toBe(1)
  await rm(f.source, { recursive: true })
  f.revoke()
  for (const point of [full, partial]) {
    const offline = await exportOfflinePeerRepository({ ...f.binding, pointId: point.pointId,
      repositoryDirectory: f.repoRoot, privateRecoveryDirectory: join(f.directory, 'personal-recovery'),
      maxBytes: 16 << 20, reserveBytes: 1 << 20, signal })
    try {
      const recovered = await backend.drillOffline(offline.point, offline.repository, f.recoveryFile, p.exporter, signal)
      try {
        const payload = await readFile(join(recovered.directory, 'personal-provider.json'), 'utf8')
        expect(payload).toContain(p.sentinel)
        expect(recovered.point.gapCount).toBe(point.gapCount)
        if (point === partial) {
          const checkpoint = JSON.parse(await readFile(join(recovered.directory, 'checkpoint.json'), 'utf8'))
          await expect(p.exporter.validate(f.binding, { ...checkpoint.capture, gaps: [] }, recovered.directory, signal))
            .rejects.toMatchObject({ code: 'peer-backup/snapshot-owner-unavailable' })
        }
      } finally { await recovered.dispose() }
    } finally { await offline.dispose() }
  }
}, 120000)
