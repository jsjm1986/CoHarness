import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  UserDocDirectoryId,
  UserDocUploadId,
} from '@deepseek-ai/dsh-userdoc'
import type {
  UserDocDirectoryListing,
  UserDocLimits,
  UserDocRef,
  UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
import { LocalUserDocFs, SharedRead } from '../src/local-fs.ts'
import type { LocalUserDocFsOptions } from '../src/local-fs.ts'
import * as storeModule from '../src/store.ts'
import * as trashModule from '../src/trash.ts'

const LIMITS: UserDocLimits = {
  maxFileBytes: 1024,
  maxFilesPerMessage: 4,
  maxMessageBytes: 4096,
  maxInlineTextBytes: 256,
  upload: { protocol: 'resumable-v1', chunkBytes: 65536, sessionTtlMs: 86400000, resumable: true },
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function streamOf(data: Uint8Array | string): ReadableStream<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

const roots: string[] = []
const engines: LocalUserDocFs[] = []

async function documentRoot(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-fs-'))
  roots.push(scratch)
  return join(scratch, 'documents')
}

function createEngine(root: string, overrides: Partial<LocalUserDocFsOptions> = {}): LocalUserDocFs {
  const value = new LocalUserDocFs({
    root,
    limits: LIMITS,
    upload: {
      chunkBytes: 65536,
      sessionTtlMs: 60_000,
      minFreeBytes: 0,
      maxConcurrent: 2,
      cleanupIntervalMs: 60_000,
      manifestMaxBytes: 65_536,
    },
    sweepIntervalMs: 60_000,
    trashRetentionMs: 86_400_000,
    ...overrides,
  })
  engines.push(value)
  return value
}

/** Bound the wait for an asynchronous maintenance outcome; the condition ends the loop early. */
async function until(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(engines.splice(0).map(value => value.dispose().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SharedRead', () => {
  it('serves every waiter from one scan', async () => {
    const scan = deferred<string>()
    let starts = 0
    const read = new SharedRead<string>(() => {
      starts += 1
      return scan.promise
    })
    const first = read.wait(new AbortController().signal)
    const second = read.wait(new AbortController().signal)
    const third = read.wait()
    scan.resolve('result')
    await expect(first).resolves.toBe('result')
    await expect(second).resolves.toBe('result')
    await expect(third).resolves.toBe('result')
    expect(starts).toBe(1)
  })

  it('aborts an unsettled scan when the only waiter arrives already cancelled', async () => {
    const read = new SharedRead<string>(() => new Promise<string>(() => {}))
    expect(() => read.wait(AbortSignal.abort())).toThrow()
    expect(read.controller.signal.aborted).toBe(true)
  })

  it('keeps a settled scan untouched when a waiter arrives cancelled', async () => {
    const read = new SharedRead<string>(() => Promise.resolve('cached'))
    await read.promise
    expect(() => read.wait(AbortSignal.abort())).toThrow()
    expect(read.controller.signal.aborted).toBe(false)
  })

  it('keeps the scan alive for other waiters when a late waiter arrives cancelled', async () => {
    const scan = deferred<string>()
    const read = new SharedRead<string>(() => scan.promise)
    const staying = read.wait()
    expect(() => read.wait(AbortSignal.abort())).toThrow()
    expect(read.controller.signal.aborted).toBe(false)
    scan.resolve('done')
    await expect(staying).resolves.toBe('done')
  })

  it('drops only the aborting waiter while the scan completes', async () => {
    const scan = deferred<string>()
    const read = new SharedRead<string>(() => scan.promise)
    const leaving = new AbortController()
    const dropped = read.wait(leaving.signal)
    const staying = read.wait()
    leaving.abort(new Error('caller left'))
    await expect(dropped).rejects.toThrow('caller left')
    expect(read.controller.signal.aborted).toBe(false)
    scan.resolve('kept')
    await expect(staying).resolves.toBe('kept')
    await expect(dropped).rejects.toThrow('caller left')
  })

  it('aborts the underlying scan when the last waiter cancels', async () => {
    const scan = deferred<string>()
    const read = new SharedRead<string>(() => scan.promise)
    const first = new AbortController()
    const second = new AbortController()
    const firstWait = read.wait(first.signal)
    const secondWait = read.wait(second.signal)
    first.abort()
    await expect(firstWait).rejects.toThrow()
    expect(read.controller.signal.aborted).toBe(false)
    second.abort('departed')
    await expect(secondWait).rejects.toThrow('Document listing was aborted.')
    expect(read.controller.signal.aborted).toBe(true)
    scan.resolve('late')
    await expect(read.promise).resolves.toBe('late')
  })

  it('propagates a scan failure to every waiter', async () => {
    const read = new SharedRead<string>(() => Promise.reject(new Error('scan broke')))
    await expect(read.wait(new AbortController().signal)).rejects.toThrow('scan broke')
    await expect(read.wait()).rejects.toThrow('scan broke')
  })

  it('wraps a non-Error scan failure so waiters always reject with Error', async () => {
    const read = new SharedRead<string>(() => Promise.reject('raw failure'))
    let reason: unknown
    await read.wait(new AbortController().signal).catch((error: unknown) => {
      reason = error
    })
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).message).toBe('raw failure')
  })

  it('cancels an unsettled scan with the caller-supplied reason', async () => {
    const scan = deferred<string>()
    const read = new SharedRead<string>(() => scan.promise)
    const waiting = read.wait()
    read.cancel(new Error('invalidate'))
    expect(read.controller.signal.aborted).toBe(true)
    expect((read.controller.signal.reason as Error).message).toBe('invalidate')
    scan.resolve('settled')
    await expect(waiting).resolves.toBe('settled')
  })

  it('ignores cancel once the scan settled', async () => {
    const read = new SharedRead<string>(() => Promise.resolve('done'))
    await read.promise
    read.cancel()
    expect(read.controller.signal.aborted).toBe(false)
  })
})

describe('LocalUserDocFs shared scans', () => {
  it('serves concurrent list callers from one in-flight scan', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocRef[]>()
    const scans = vi.spyOn(storeModule, 'listDocFiles').mockImplementation(() => scan.promise)
    const first = engine.list()
    const second = engine.list()
    scan.resolve([])
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
    expect(scans).toHaveBeenCalledTimes(1)
  })

  it('lets a mutation expire an in-flight listing before it settles', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocRef[]>()
    const scans = vi.spyOn(storeModule, 'listDocFiles').mockImplementation(() => scan.promise)
    const stale = engine.list()
    const target = await engine.resolveTarget({ name: 'fresh.txt' })
    await engine.save(target, streamOf('fresh'))
    scan.resolve([])
    await expect(stale).resolves.toEqual([])
    const next = deferred<UserDocRef[]>()
    scans.mockImplementation(() => next.promise)
    const current = engine.list()
    next.resolve([])
    await expect(current).resolves.toEqual([])
    expect(scans).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight directory scan and retries after a failed one', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const dir = await engine.createDirectory(UserDocDirectoryId(''), 'sub')
    const listing: UserDocDirectoryListing = { directoryId: dir.directoryId, directories: [], documents: [] }
    const scan = deferred<UserDocDirectoryListing>()
    const scans = vi.spyOn(storeModule, 'listDocDirectory').mockImplementation(() => scan.promise)
    const first = engine.listDirectory(dir.directoryId)
    const second = engine.listDirectory(dir.directoryId)
    scan.resolve(listing)
    await expect(first).resolves.toBe(listing)
    await expect(second).resolves.toBe(listing)
    expect(scans).toHaveBeenCalledTimes(1)
    const failure = deferred<UserDocDirectoryListing>()
    scans.mockImplementation(() => failure.promise)
    const failed = engine.listDirectory(dir.directoryId)
    failure.reject(new Error('read broke'))
    await expect(failed).rejects.toThrow('read broke')
    scans.mockImplementation(() => Promise.resolve(listing))
    await expect(engine.listDirectory(dir.directoryId)).resolves.toBe(listing)
    expect(scans).toHaveBeenCalledTimes(3)
  })

  it('shares an in-flight trash scan between concurrent callers', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocTrashRef[]>()
    const scans = vi.spyOn(trashModule, 'listTrash').mockImplementation(() => scan.promise)
    const first = engine.listTrash()
    const second = engine.listTrash()
    scan.resolve([])
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
    expect(scans).toHaveBeenCalledTimes(1)
  })

  it('forgets a rejected root scan so the next list retries', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scans = vi.spyOn(storeModule, 'listDocFiles')
      .mockRejectedValueOnce(new Error('read broke'))
    await expect(engine.list()).rejects.toThrow('read broke')
    scans.mockImplementation(() => Promise.resolve([]))
    await expect(engine.list()).resolves.toEqual([])
    expect(scans).toHaveBeenCalledTimes(2)
  })

  it('drops a pending directory scan when a mutation invalidates it', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const dir = await engine.createDirectory(UserDocDirectoryId(''), 'sub')
    const scan = deferred<UserDocDirectoryListing>()
    vi.spyOn(storeModule, 'listDocDirectory').mockImplementation(() => scan.promise)
    const listing: UserDocDirectoryListing = { directoryId: dir.directoryId, directories: [], documents: [] }
    const stale = engine.listDirectory(dir.directoryId)
    const target = await engine.resolveTarget({ name: 'fresh.txt' })
    await engine.save(target, streamOf('fresh'))
    scan.resolve(listing)
    await expect(stale).resolves.toBe(listing)
  })

  it('drops a pending trash scan when a mutation invalidates it', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocTrashRef[]>()
    vi.spyOn(trashModule, 'listTrash').mockImplementation(() => scan.promise)
    const stale = engine.listTrash()
    const target = await engine.resolveTarget({ name: 'fresh.txt' })
    await engine.save(target, streamOf('fresh'))
    scan.resolve([])
    await expect(stale).resolves.toEqual([])
  })
})

describe('LocalUserDocFs directory mutations', () => {
  it('creates, lists, renames, moves into, and removes directories', async () => {
    const engine = createEngine(await documentRoot())
    const dir = await engine.createDirectory(UserDocDirectoryId(''), 'archive')
    const listed = await engine.listDirectories()
    expect(listed.map(ref => ref.name)).toContain('archive')
    const renamed = await engine.renameDirectory(dir.directoryId, 'renamed')
    expect(renamed.name).toBe('renamed')
    const target = await engine.resolveTarget({ name: 'doc.txt' })
    const saved = await engine.save(target, streamOf('body'))
    const moved = await engine.move(saved.docId, renamed.directoryId)
    expect(moved.docId).toBe(`${String(renamed.directoryId)}/doc.txt`)
    await engine.move(moved.docId, UserDocDirectoryId(''))
    await engine.removeDirectory(renamed.directoryId)
    expect((await engine.listDirectories()).map(ref => ref.directoryId)).not.toContain(renamed.directoryId)
  })
})

describe('LocalUserDocFs readiness', () => {
  it('migrates a legacy document root on first use', async () => {
    const root = await documentRoot()
    const legacy = join(root, '..', 'legacy')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'archive.txt'), 'legacy body')
    const engine = createEngine(root, { legacyRoot: legacy })
    await engine.warm()
    await expect(readFile(join(root, 'archive.txt'), 'utf8')).resolves.toBe('legacy body')
  })

  it('rejects operations once disposed', async () => {
    const engine = createEngine(await documentRoot())
    await engine.dispose()
    await expect(engine.list()).rejects.toThrow('document store is disposed')
  })

  it('skips maintenance startup when disposal wins the warmup race', async () => {
    const engine = createEngine(await documentRoot())
    const warmed = engine.warm()
    await Promise.all([warmed, engine.dispose()])
    await expect(engine.list()).rejects.toThrow('document store is disposed')
  })

  it('retries initialization after the first attempt fails', async () => {
    const root = await documentRoot()
    await writeFile(root, 'blocking file')
    const engine = createEngine(root)
    await expect(engine.warm()).rejects.toThrow()
    await rm(root)
    await engine.warm()
    await expect(engine.list()).resolves.toEqual([])
  })
})

describe('LocalUserDocFs maintenance sweep', () => {
  it('purges expired trash on the sweep interval', async () => {
    const engine = createEngine(await documentRoot(), { sweepIntervalMs: 15, trashRetentionMs: 0 })
    const target = await engine.resolveTarget({ name: 'old.txt' })
    const saved = await engine.save(target, streamOf('expired'))
    await engine.trash(saved.docId)
    expect((await engine.listTrash()).length).toBe(1)
    engine.attach()
    expect(await until(async () => (await engine.listTrash()).length === 0)).toBe(true)
  })

  it('keeps sweeping after a purge failure instead of dropping the interval', async () => {
    vi.useFakeTimers()
    const engine = createEngine(await documentRoot(), { sweepIntervalMs: 25, trashRetentionMs: 0 })
    const target = await engine.resolveTarget({ name: 'old.txt' })
    const saved = await engine.save(target, streamOf('expired'))
    await engine.trash(saved.docId)
    const purge = vi.spyOn(trashModule, 'purgeDueDocuments').mockRejectedValueOnce(new Error('disk gone'))
    engine.attach()
    await vi.advanceTimersByTimeAsync(25)
    await vi.advanceTimersByTimeAsync(25)
    expect(purge.mock.calls.length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
    expect(await until(async () => (await engine.listTrash()).length === 0)).toBe(true)
  })

  it('skips a queued sweep while one is in flight and joins it on dispose', async () => {
    vi.useFakeTimers()
    const engine = createEngine(await documentRoot(), { sweepIntervalMs: 25 })
    await engine.warm()
    const purge = deferred<number>()
    vi.spyOn(trashModule, 'purgeDueDocuments').mockImplementation(() => purge.promise)
    engine.attach()
    vi.advanceTimersByTime(25)
    vi.advanceTimersByTime(25)
    vi.useRealTimers()
    const disposed = engine.dispose()
    purge.resolve(0)
    await disposed
  })

  it('ignores a sweep armed after disposal', async () => {
    vi.useFakeTimers()
    const engine = createEngine(await documentRoot(), { sweepIntervalMs: 25 })
    await engine.warm()
    await engine.dispose()
    const purge = vi.spyOn(trashModule, 'purgeDueDocuments')
    engine.attach()
    vi.advanceTimersByTime(50)
    expect(purge).not.toHaveBeenCalled()
  })
})

describe('LocalUserDocFs uploads', () => {
  it('publishes a complete upload and invalidates listings once finalization lands', async () => {
    const engine = createEngine(await documentRoot())
    const data = new TextEncoder().encode('upload body')
    const session = await engine.beginUpload({
      name: 'upload.bin',
      directoryId: UserDocDirectoryId(''),
      bytes: data.byteLength,
      fingerprint: 'fp-publish',
    })
    await engine.writeUploadChunk(session.uploadId, {
      index: 0,
      start: 0,
      end: data.byteLength - 1,
      total: data.byteLength,
      sha256: digest(data),
      body: streamOf(data),
    })
    const verifying = await engine.completeUpload(session.uploadId, digest(data))
    expect(verifying.state).toBe('verifying')
    let current = verifying
    for (let attempt = 0; current.state === 'verifying' && attempt < 400; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
      current = await engine.inspectUpload(session.uploadId)
    }
    expect(current.state).toBe('complete')
    const confirmed = await engine.completeUpload(session.uploadId, digest(data))
    expect(confirmed.state).toBe('complete')
    const scan = deferred<UserDocRef[]>()
    vi.spyOn(storeModule, 'listDocFiles').mockImplementation(() => scan.promise)
    const listed = engine.list()
    scan.resolve([])
    await expect(listed).resolves.toEqual([])
  })

  it('drops an incomplete upload session on cancel', async () => {
    const engine = createEngine(await documentRoot())
    const session = await engine.beginUpload({
      name: 'cancel.bin',
      directoryId: UserDocDirectoryId(''),
      bytes: 8,
      fingerprint: 'fp-cancel',
    })
    await engine.cancelUpload(session.uploadId)
    await expect(engine.inspectUpload(session.uploadId))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
  })

  it('rejects upload calls with an already-aborted signal before touching storage', async () => {
    const engine = createEngine(await documentRoot())
    const uploadId = UserDocUploadId('00000000-0000-4000-8000-000000000000')
    const signal = AbortSignal.abort()
    await expect(engine.inspectUpload(uploadId, signal)).rejects.toThrow()
    await expect(engine.completeUpload(uploadId, digest(new Uint8Array([1])), signal)).rejects.toThrow()
    await expect(engine.cancelUpload(uploadId, signal)).rejects.toThrow()
  })
})

describe('LocalUserDocFs disposal', () => {
  it('cancels in-flight scans and joins their settle', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocRef[]>()
    vi.spyOn(storeModule, 'listDocFiles').mockImplementation(() => scan.promise)
    const pending = engine.list()
    await Promise.resolve()
    const disposed = engine.dispose()
    scan.resolve([])
    await expect(pending).resolves.toEqual([])
    await disposed
  })
})
