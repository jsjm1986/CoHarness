import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { snapshotManagedFiles } from '../src/managed-files.ts'
import { PeerBackupSourceSpace, watchPeerSourcePaths, writePeerSourceFile } from '../src/peer-backup-source-space.ts'
import { PeerProjectExporter, type PeerProjectFileSnapshots } from '../src/peer-backup-project-export.ts'
import { PeerBackupRestic } from '../src/peer-backup-restic.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import { fixtureQueryClient, fixtureQueryPool } from './postgres-query-fixture.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done() })
async function temporary() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'peer-source-space-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const disk = (bytes: number) => ({ bavail: BigInt(Math.floor(bytes / 4096)), bsize: 4096n })
const signal = () => new AbortController().signal
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('refuses a payload before writing when the source reserve cannot remain free', async () => {
  const root = await temporary(), file = join(root, 'payload.json')
  const space = new PeerBackupSourceSpace(8192, async () => disk(8192)).operation(signal())
  await expect(writePeerSourceFile(file, 'not accepted', space)).rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
  expect(await readdir(root)).toEqual([])
})

it('charges directory entries even when an export contains no file bytes', async () => {
  const root = await temporary(), create = vi.fn(() => mkdir(join(root, 'one', 'two'), { recursive: true }))
  const space = new PeerBackupSourceSpace(8192, async () => disk(16384)).operation(signal())
  await expect(space.write(root, 0, create, 3)).rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
  expect(create).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('serializes overlapping policies through their actual write and rechecks the next allocation', async () => {
  const root = await temporary()
  let free = 32768, inspected = 0
  const owner = new PeerBackupSourceSpace(8192, async () => { inspected++; return disk(free) })
  const first = owner.operation(signal()), second = owner.operation(signal())
  const entered = deferred(), proceed = deferred()
  const accepted = first.write(root, 16384, async () => {
    entered.resolve(); await proceed.promise
    await writeFile(join(root, 'first'), Buffer.alloc(16384)); free -= 16384
  })
  await entered.promise
  const writeSecond = vi.fn(async () => { await writeFile(join(root, 'second'), 'should not exist') })
  const rejected = second.write(root, 8192, writeSecond)
  const failure = expect(rejected).rejects.toMatchObject({ code: 'peer-backup/source-capacity' })
  expect(inspected).toBe(1)
  proceed.resolve(); await accepted; await failure
  expect(writeSecond).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual(['first'])
  await second.check(root)
})

it('stops a large file between bounded chunks when other work consumes source space', async () => {
  const root = await temporary(), source = join(root, 'source'), target = join(root, 'staging')
  await mkdir(source); await mkdir(target)
  const content = Buffer.alloc(3 << 20, 41)
  await writeFile(join(source, 'long-task.data'), content)
  let free = 8 << 20, copied = 0
  const space = new PeerBackupSourceSpace(1 << 20, async () => disk(free)).operation(signal())
  await expect(snapshotManagedFiles([{ owner: 'plugin', path: source, kind: 'directory' }], target, signal(), {
    maxBytes: 4 << 20, maxEntries: 10,
    guardWrite: (bytes, write) => space.write(target, bytes, async () => {
      const result = await write()
      if (bytes > 0) { copied += bytes; free = 1 << 20 }
      return result
    }),
  })).rejects.toMatchObject({ code: 'peer-backup/source-capacity' })
  expect(copied).toBe(1 << 20)
  expect((await stat(join(target, '00000000.data'))).size).toBe(1 << 20)
  expect(await readFile(join(source, 'long-task.data'))).toEqual(content)
  await rm(target, { recursive: true })
})

it('cancels only the waiting backup and keeps admission available for another policy', async () => {
  const root = await temporary(), entered = deferred(), proceed = deferred()
  const owner = new PeerBackupSourceSpace(8192, async () => disk(1 << 20))
  const accepted = owner.operation(signal()).write(root, 1, async () => { entered.resolve(); await proceed.promise })
  await entered.promise
  const cancelled = new AbortController(), write = vi.fn(async () => {})
  const waiting = owner.operation(cancelled.signal).write(root, 1, write)
  const reason = new Error('cancel this backup')
  const rejected = expect(waiting).rejects.toBe(reason)
  cancelled.abort(reason); proceed.resolve()
  await accepted; await rejected
  expect(write).not.toHaveBeenCalled()
  await owner.operation(signal()).check(root)
})

it('checks the live snapshot volume during export and drops its registration after release', async () => {
  const root = await temporary(), source = join(root, 'source')
  await mkdir(source)
  let available = 16384
  const space = new PeerBackupSourceSpace(8192, async path => disk(path === source ? available : 1 << 20)).operation(signal())
  const release = await watchPeerSourcePaths(space, [source])
  available = 8192
  await expect(writePeerSourceFile(join(root, 'snapshot-payload'), 'data', space)).rejects.toMatchObject({ code: 'peer-backup/source-capacity' })
  release()
  await writePeerSourceFile(join(root, 'after-release'), 'data', space)
  expect(await readFile(join(root, 'after-release'), 'utf8')).toBe('data')
})

it('releases prior watched volumes and write admission after an observation error', async () => {
  const root = await temporary(), unavailable = join(root, 'unavailable')
  let firstAvailable = true
  const space = new PeerBackupSourceSpace(8192, async path => {
    if (path === unavailable) throw new Error('disk unavailable')
    return disk(firstAvailable ? 1 << 20 : 8192)
  }).operation(signal())
  await expect(watchPeerSourcePaths(space, [root, unavailable])).rejects.toMatchObject({ status: 503, code: 'peer-backup/source-capacity-unavailable' })
  firstAvailable = false
  await expect(space.check(root)).rejects.toMatchObject({ status: 507 })
  firstAvailable = true
  await space.check(root)
})

it('releases an acquired project snapshot when a SQL payload write runs out of space', async () => {
  const root = await temporary(), payload = join(root, 'payload')
  await mkdir(payload)
  const binding = { organizationId: randomUUID(), projectId: randomUUID(), nodeId: randomUUID(), runtimeId: randomUUID(), volumeId: randomUUID(), writerEpoch: '1' }
  const policy = { organizationId: binding.organizationId, sourceNodeId: binding.nodeId, targetNodeId: randomUUID(), scopeId: binding.projectId, policyId: randomUUID(), revision: 1 }
  let available = 8 << 20
  const released = vi.fn(async () => {}), closed = vi.fn()
  const control = fixtureQueryPool(sql => sql.includes('project_content_placement') ? [binding] : sql.includes('to_regclass') ? [{ present: false }] : [])
  const tx = fixtureQueryClient(sql => {
    if (sql.includes('pg_class')) return [{ name: 'spaces' }]
    if (sql.includes('max(version)')) return [{ version: 1 }]
    if (sql.startsWith('DECLARE')) return []
    if (sql.startsWith('FETCH')) { available = 8192; return [{ body: '{}' }] }
    if (sql.startsWith('CLOSE')) { closed(); return [] }
    return [{ revision: '1', capturedAt: new Date() }]
  })
  const store: Pick<NodeContentStore, 'read'> = { read: async (_binding, work) => work(tx) }
  const files: PeerProjectFileSnapshots = { acquire: async () => ({ revision: '1', capturedAt: new Date().toISOString(), roots: [], gaps: ['plugin:external-data'], release: released }), validate: async () => {} }
  const exporter = new PeerProjectExporter({ control, store, files, maxBytes: 1 << 20, maxRows: 100 })
  const space = new PeerBackupSourceSpace(8192, async () => disk(available)).operation(signal())
  await expect(exporter.capture(policy, payload, signal(), space)).rejects.toMatchObject({ status: 507, code: 'peer-backup/source-capacity' })
  expect(released).toHaveBeenCalledTimes(1)
  expect(closed).toHaveBeenCalledTimes(1)
  expect((await stat(join(payload, 'project', 'spaces.jsonl'))).size).toBe(0)
  await rm(payload, { recursive: true })
})

it('removes the complete private capture directory on capacity refusal without starting restic', async () => {
  const root = await temporary(), staging = join(root, 'staging')
  const server = createServer((_request, response) => response.writeHead(404).end())
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  const engine = new PeerBackupRestic({ executable: join(root, 'absent-restic'), stagingDirectory: staging, uploadKiBps: 1, downloadKiBps: 1, timeoutMs: 60000, maxRestoreBytes: 1 << 20, reserveBytes: 8192 })
  const validate = vi.fn(async () => {})
  const policy = { organizationId: randomUUID(), sourceNodeId: randomUUID(), targetNodeId: randomUUID(), scopeId: randomUUID(), policyId: randomUUID(), revision: 1 }
  await expect(engine.backup(policy, { origin: `http://127.0.0.1:${address.port}`, user: policy.sourceNodeId, token: 'synthetic', passwordFile: join(root, 'unused-key') }, {
    async capture(_binding, path, _signal, space) {
      await writePeerSourceFile(join(path, 'partial'), 'private bytes', space)
      await space!.write(path, Number.MAX_SAFE_INTEGER, async () => {})
      throw new Error('unreachable')
    }, validate,
  }, randomUUID(), signal())).rejects.toMatchObject({ code: 'peer-backup/source-capacity' })
  expect(await readdir(staging)).toEqual([])
  expect(validate).not.toHaveBeenCalled()
})

it('recovers an already confirmed receipt without requiring new source capacity or running the exporter', async () => {
  const root = await temporary(), staging = join(root, 'never-created')
  const binding = { organizationId: randomUUID(), sourceNodeId: randomUUID(), targetNodeId: randomUUID(), scopeId: randomUUID(), policyId: randomUUID(), revision: 1 }
  const point = { ...binding, version: 1, pointId: randomUUID(), writerEpoch: '1', watermark: '1', capturedAt: new Date().toISOString(),
    snapshotId: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), coveredCount: 1, gapCount: 0 }
  const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(point)))
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  const engine = new PeerBackupRestic({ executable: join(root, 'absent-restic'), stagingDirectory: staging, uploadKiBps: 1, downloadKiBps: 1,
    timeoutMs: 60000, maxRestoreBytes: 1 << 20, reserveBytes: Number.MAX_SAFE_INTEGER })
  const capture = vi.fn(async () => { throw new Error('must not execute again') })
  expect(await engine.backup(binding, { origin: `http://127.0.0.1:${address.port}`, user: binding.sourceNodeId, token: 'synthetic', passwordFile: join(root, 'unused') },
    { capture, validate: async () => {} }, point.pointId, signal())).toEqual(point)
  expect(capture).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
