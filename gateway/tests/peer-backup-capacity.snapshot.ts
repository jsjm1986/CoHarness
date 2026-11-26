/** Real encrypted backup and recovery refusals retain source task data and release private staging. */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { snapshotManagedFiles } from '../src/managed-files.ts'
import { PeerBackupError, PeerBackupRepository } from '../src/peer-backup-repository.ts'
import { PeerBackupRestic, verifyPeerManagedFiles, type PeerBackupExporter } from '../src/peer-backup-restic.ts'
import { writePeerSourceFile } from '../src/peer-backup-source-space.ts'

const expected = new URL('./snapshots/peer-backup-capacity/flow.expected.md', import.meta.url)
const restic = process.env.HGW_TEST_RESTIC

it.skipIf(restic === undefined)('refuses backup and recovery allocations while preserving an open foreground writer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'peer-capacity-snapshot-')))
  const cleanup: Array<() => Promise<void>> = [() => rm(root, { recursive: true, force: true })]
  try {
    const source = join(root, 'source'), staging = join(root, 'staging'), repository = join(root, 'receiver')
    await mkdir(source, { mode: 0o700 })
    const sessionFile = join(source, 'session.jsonl'), scheduleFile = join(source, 'schedule.json')
    const session = '{"task":"long-running","checkpoint":1}\n'
    const schedule = '{"tasks":{"daily":{"enabled":true,"pendingDelivery":"delivery-1"}}}\n'
    await writeFile(sessionFile, session)
    await writeFile(scheduleFile, schedule)
    // This writer stays open across both refusals; backup owns only its private copy.
    const writer = await open(sessionFile, 'a')
    cleanup.push(() => writer.close())
    const binding = { policyId: randomUUID(), organizationId: randomUUID(), sourceNodeId: randomUUID(),
      targetNodeId: randomUUID(), scopeId: randomUUID(), revision: 1 }
    const append = randomBytes(32).toString('hex'), recover = randomBytes(32).toString('hex')
    const passwordFile = join(root, 'recovery.key')
    await writeFile(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    const receiver = await PeerBackupRepository.open({ directory: repository, nodeId: binding.targetNodeId,
      capacityBytes: 32 << 20, maxObjectBytes: 8 << 20, objectLimit: 200, concurrency: 4,
      grant: async (policy, user, token) => {
        if (policy !== binding.policyId || user !== binding.sourceNodeId || ![append, recover].includes(token))
          throw new PeerBackupError(403, 'peer-backup/pair-denied')
        return { ...binding, mode: token === append ? 'append' : 'recover', quotaBytes: 24 << 20, revalidate: async () => {} }
      },
    })
    cleanup.push(() => receiver.close())
    const server = createServer((request, response) => {
      void receiver.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end() })
    })
    cleanup.push(() => new Promise<void>((done, fail) => {
      server.closeAllConnections()
      if (!server.listening) { done(); return }
      server.close(error => error ? fail(error) : done())
    }))
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing allocated receiver address')
    const access = { origin: `http://127.0.0.1:${address.port}`, user: binding.sourceNodeId, token: append, passwordFile }
    const engine = new PeerBackupRestic({ executable: restic!, stagingDirectory: staging, uploadKiBps: 16384,
      downloadKiBps: 16384, timeoutMs: 90000, maxRestoreBytes: 8 << 20, reserveBytes: 4096 })
    const signal = new AbortController().signal
    let failure: 'capture' | 'validation' | undefined, copied = 0, validated = 0
    const exporter: PeerBackupExporter = {
      async capture(owner, destination, lifetime, space) {
        expect(space).toBeDefined()
        const managed = join(destination, 'managed')
        await space!.write(destination, 0, () => mkdir(managed, { mode: 0o700 }))
        const snapshot = await snapshotManagedFiles([{ owner: 'fixture-task-store', path: source, kind: 'directory' }],
          managed, lifetime, { maxBytes: 1 << 20, maxEntries: 10,
            guardWrite: (bytes, work) => space!.write(managed, bytes, work) })
        copied = snapshot.files.length
        await writePeerSourceFile(join(managed, 'manifest.json'), JSON.stringify(snapshot), space)
        if (failure === 'capture') await space!.write(managed, Number.MAX_SAFE_INTEGER, async () => {
          throw Error('A refused allocation executed')
        })
        return { version: 1, organizationId: owner.organizationId, sourceNodeId: owner.sourceNodeId,
          scopeId: owner.scopeId, writerEpoch: '1', watermark: '1', capturedAt: '2026-11-17T00:00:00.000Z',
          coveredCount: snapshot.files.length, gaps: [] }
      },
      async validate(_owner, _capture, destination, lifetime, space) {
        await verifyPeerManagedFiles(join(destination, 'managed'), lifetime)
        validated++
        if (failure === 'validation') {
          expect(space).toBeDefined()
          await space!.write(destination, Number.MAX_SAFE_INTEGER, async () => {
            throw Error('A refused validation allocation executed')
          })
        }
      },
    }
    async function unchanged() {
      expect(await readFile(sessionFile, 'utf8')).toBe(session)
      expect(await readFile(scheduleFile, 'utf8')).toBe(schedule)
      expect(await readdir(staging)).toEqual([])
    }
    const lines = ['# Peer backup capacity', '']
    failure = 'capture'
    await expect(engine.backup(binding, access, exporter, randomUUID(), signal))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
    expect(copied).toBe(2)
    await unchanged()
    lines.push('## Source allocation refused', 'status=507 code=peer-backup/source-capacity',
      `privateFilesCopiedBeforeRefusal=${copied}`, 'sourceSession=unchanged sourceSchedule=unchanged privateStaging=empty', '')

    failure = undefined
    const point = await engine.backup(binding, access, exporter, randomUUID(), signal)
    expect(point.coveredCount).toBe(2)
    await unchanged()
    lines.push('## A later backup succeeds', `confirmed=true coveredFiles=${point.coveredCount}`, 'privateStaging=empty', '')

    failure = 'validation'
    const before = validated
    await expect(engine.drill(binding, point.pointId, { ...access, token: recover }, exporter, signal))
      .rejects.toMatchObject({ status: 507, code: 'peer-backup/recovery-capacity' })
    expect(validated).toBe(before + 1)
    await unchanged()
    lines.push('## Restored-payload validation allocation refused', 'resticRestore=verified managedFiles=verified',
      'status=507 code=peer-backup/recovery-capacity',
      'sourceSession=unchanged sourceSchedule=unchanged privateStaging=empty', '')

    const recoveryDirectory = join(root, 'offline-rehearsal'), configFile = join(root, 'rehearsal.json')
    await writeFile(configFile, JSON.stringify({ version: 1, organizationId: binding.organizationId,
      sourceNodeId: binding.sourceNodeId, targetNodeId: binding.targetNodeId, policyId: binding.policyId,
      pointId: point.pointId, kind: 'project', repositoryDirectory: repository, recoveryDirectory, passwordFile,
      resticExecutable: await realpath(restic!), maxBytes: 16 << 20, maxRows: 1000,
      reserveBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 30000 }), { mode: 0o600 })
    // The shipped source CLI is the subject: its structured refusal must reach stderr without private paths.
    const cli = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      resolve(import.meta.dirname, '../src/peer-backup-rehearse-main.ts'), configFile], {
      cwd: root, timeout: 45000, maxBuffer: 64 * 1024,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, NODE_NO_WARNINGS: '1',
        TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    }).then(() => { throw Error('An over-reserved recovery unexpectedly succeeded') }, error => {
      const result = error as Error & { code: number; signal: string | null; killed: boolean; stdout: string; stderr: string }
      expect(result.signal).toBeNull()
      expect(result.killed).toBe(false)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('peer-backup/recovery-capacity\n')
      return result
    })
    expect(await readdir(recoveryDirectory)).toEqual([])
    await unchanged()
    lines.push('## Offline recovery CLI', `exit=${cli.code} stderr=${cli.stderr.trim()}`,
      'privateRecovery=empty originalPoint=retained', '')

    failure = undefined
    const drill = await engine.drill(binding, point.pointId, { ...access, token: recover }, exporter, signal)
    try { expect(drill.point.pointId).toBe(point.pointId) } finally { await drill.dispose() }
    await unchanged()
    await writer.write('{"task":"long-running","checkpoint":2}\n')
    await writer.sync()
    expect(await readFile(sessionFile, 'utf8')).toBe(session + '{"task":"long-running","checkpoint":2}\n')
    expect(await readFile(scheduleFile, 'utf8')).toBe(schedule)
    lines.push('## Foreground data remains usable', 'originalWriter=continued recoveryPoint=readable', 'schedule=unchanged', '')
    const transcript = lines.join('\n')
    if (process.env.DSH_SNAPSHOT === 'refresh' || process.env.DSH_SNAPSHOT === 'record') {
      await mkdir(new URL('.', expected), { recursive: true })
      await writeFile(expected, transcript)
    }
    await expect(transcript).toMatchFileSnapshot(fileURLToPath(expected))
  } finally {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { errors.push(error) } }
    if (errors.length) throw new AggregateError(errors, 'Backup capacity snapshot cleanup failed')
  }
})
