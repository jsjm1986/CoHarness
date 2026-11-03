import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_PERMISSION_DENIED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_EXPIRED_CODE,
  UserDocDirectoryId,
  UserDocIncarnationId,
  UserDocUploadId,
  UserDocUploadOwnerId,
} from '@deepseek-ai/dsh-userdoc'
import type {
  UserDocDirectoryListing,
  UserDocLimits,
  UserDocRef,
  UserDocSelection,
  UserDocTrashRef,
  UserDocTrashSelection,
} from '@deepseek-ai/dsh-userdoc'
import { LocalUserDocFs, SharedRead } from '../src/local-fs.ts'
import type { LocalUserDocFsOptions } from '../src/local-fs.ts'
import * as storeModule from '../src/store.ts'
import * as trashModule from '../src/trash.ts'
import { LocalUploadManager } from '../src/upload.ts'

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

function barrier(): Deferred<void> {
  return deferred()
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

it('cancels an accepted ordinary save before disposal releases the filesystem engine', async () => {
  const root = await documentRoot(), engine = createEngine(root)
  const target = await engine.resolveTarget({ name: 'unfinished.txt' })
  const entered = barrier(), release = barrier(), abort = new AbortController()
  let cancelled = false
  // A zero buffer makes pull observe the store's pending read rather than eager stream prefetch.
  const body = new ReadableStream<Uint8Array>({
    pull() { entered.resolve(); return release.promise },
    cancel() { cancelled = true; release.resolve() },
  }, { highWaterMark: 0 })
  const saving = engine.save(target, body, abort.signal)
  const outcome = saving.then(() => ({ stored: true }), () => ({ stored: false }))
  try {
    await entered.promise
    await engine.dispose()
    expect(cancelled).toBe(true)
    expect(await outcome).toEqual({ stored: false })
    await expect(readFile(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    abort.abort(new Error('Owned save fixture cleanup'))
    release.resolve()
    await outcome
  }
})

it('keeps upload sessions and recoverable trash below the configured private control root', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-private-controls-'))
  roots.push(scratch)
  const root = join(scratch, 'documents'), controlRoot = join(scratch, 'gateway-private', 'documents')
  await mkdir(root, { mode: 0o700 })
  await mkdir(join(scratch, 'gateway-private'), { mode: 0o700 })
  await mkdir(controlRoot, { mode: 0o700 })
  let engine = createEngine(root, { controlRoot })
  const owner = UserDocUploadOwnerId('user:7'), data = new TextEncoder().encode('x')
  const uploaded = await engine.beginUpload({ name: 'pending.txt', directoryId: UserDocDirectoryId(''),
    bytes: data.byteLength, fingerprint: 'private-session' }, owner)
  await engine.writeUploadChunk(uploaded.uploadId, { index: 0, start: 0, end: 0, total: data.byteLength,
    sha256: digest(data), body: streamOf(data) }, undefined, owner)
  await engine.completeUpload(uploaded.uploadId, digest(data), undefined, owner)
  expect(await until(async () => (await engine.inspectUpload(uploaded.uploadId, undefined, owner)).state !== 'verifying')).toBe(true)
  const completed = await engine.inspectUpload(uploaded.uploadId, undefined, owner)
  expect(completed.state).toBe('complete')
  if (completed.ref === undefined) throw new Error('Completed upload must retain its published reference.')
  expect(await readFile(completed.ref.path, 'utf8')).toBe('x')
  await engine.dispose()
  engine = createEngine(root, { controlRoot })
  expect((await engine.inspectUpload(uploaded.uploadId, undefined, owner)).ref).toEqual(completed.ref)
  await engine.trash(completed.ref.docId)
  const restored = await engine.restore(completed.ref.docId)
  expect(await readFile(restored.path, 'utf8')).toBe('x')
  await engine.trash(restored.docId)
  await engine.purge(restored.docId)
  const saved = await engine.save(await engine.resolveTarget({ name: 'saved.txt' }), streamOf('saved'))
  await engine.trash(saved.docId)

  expect(await readFile(join(controlRoot, '.upload-sessions', 'v1', uploaded.uploadId, 'manifest.json'), 'utf8'))
    .toContain('private-session')
  expect(await readFile(join(controlRoot, '.dsh-trash', 'manifest.json'), 'utf8')).toContain('saved.txt')
  await expect(stat(join(root, '.upload-sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, '.dsh-trash'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await engine.list(new AbortController().signal)).toEqual([])
  expect(await engine.listDirectories(new AbortController().signal)).toEqual([])
})

describe('LocalUserDocFs identity mode', () => {
  async function identityEngine(overrides: Partial<LocalUserDocFsOptions> = {}): Promise<{
    readonly engine: LocalUserDocFs
    readonly filesRoot: string
  }> {
    const root = await documentRoot(), privateParent = join(root, '..', 'identity-private')
    const filesRoot = join(privateParent, 'files')
    await mkdir(privateParent, { mode: 0o700 })
    await mkdir(filesRoot, { mode: 0o700 })
    const engine = createEngine(root, {
      controlRoot: filesRoot,
      identityLocations: { root, stateRoot: join(privateParent, 'state'), filesRoot },
      ...overrides,
    })
    await engine.warm()
    return { engine, filesRoot }
  }

  it('reads, streams, and attributes one-shot saves through the identity owner', async () => {
    const actor = UserDocUploadOwnerId('user:7')
    const { engine } = await identityEngine({ identityActor: () => actor })
    const target = await engine.resolveTarget({ name: 'identity.txt' })
    const saved = await engine.save(target, streamOf('identity body'))
    expect(saved.identity).toMatchObject({ createdBy: actor, origin: 'transfer', revision: 1 })
    const read = await engine.read(saved.docId)
    expect(read).toMatchObject({ ref: saved, data: new TextEncoder().encode('identity body') })
    const opened = await engine.openRead(saved.docId)
    expect(opened.ref.identity).toEqual(saved.identity)
    expect(new TextDecoder().decode(await new Response(opened.body).arrayBuffer())).toBe('identity body')
    const aborted = AbortSignal.abort(new Error('Owned identity read cancellation'))
    await expect(engine.read(saved.docId, aborted)).rejects.toThrow('Owned identity read cancellation')
  })

  it('keeps same-path trash incarnations distinct and selects exact restore and purge actions', async () => {
    const selected = new Map<'active' | 'trash', UserDocSelection | UserDocTrashRef>()
    let actor = UserDocUploadOwnerId('user:7')
    const { engine } = await identityEngine({
      identityActor: () => actor,
      identitySelection: (_docId, state) => {
        const value = selected.get(state)
        if (value === undefined) return undefined
        if (state === 'active') return value as UserDocSelection
        const trash = value as UserDocTrashRef
        if (trash.identity === undefined || trash.trashId === undefined) return undefined
        return { docId: trash.docId, incarnationId: trash.identity.incarnationId,
          revision: trash.identity.revision, trashId: trash.trashId }
      },
    })
    const target = await engine.resolveTarget({ name: 'reused.txt' })
    const first = await engine.save(target, streamOf('first'))
    selected.set('active', { docId: first.docId, ...first.identity! })
    const firstTrash = await engine.trash(first.docId)
    actor = UserDocUploadOwnerId('user:9')
    const second = await engine.save(target, streamOf('second'))
    expect(second.identity?.incarnationId).not.toBe(first.identity?.incarnationId)
    selected.set('active', { docId: second.docId, ...second.identity! })
    const secondTrash = await engine.trash(second.docId)
    actor = UserDocUploadOwnerId('user:11')
    const active = await engine.save(target, streamOf('active'))
    expect(active.identity?.createdBy).toBe(actor)
    expect(new Set((await engine.listTrash()).map(item => item.trashId))).toEqual(new Set([firstTrash.trashId, secondTrash.trashId]))

    selected.set('trash', firstTrash)
    const restored = await engine.restore(firstTrash.docId, UserDocDirectoryId(''), 'restored.txt')
    expect(restored.identity?.incarnationId).toBe(first.identity?.incarnationId)
    expect(restored.identity?.createdBy).toBe(UserDocUploadOwnerId('user:7'))
    selected.set('trash', secondTrash)
    await engine.purge(secondTrash.docId)
    expect(await engine.listTrash()).toEqual([])
    expect(await engine.read(active.docId)).toMatchObject({ ref: active, data: new TextEncoder().encode('active') })
  })

  it('fails closed when Gateway identity selection is absent and preserves the active file', async () => {
    const { engine } = await identityEngine({ identitySelection: () => undefined })
    const saved = await engine.save(await engine.resolveTarget({ name: 'unselected.txt' }), streamOf('keep me'))
    await expect(engine.trash(saved.docId)).rejects.toMatchObject({ code: DOCUMENT_PERMISSION_DENIED_CODE })
    await expect(engine.trash(saved.docId, undefined, { docId: saved.docId, ...saved.identity! }))
      .rejects.toMatchObject({ code: DOCUMENT_PERMISSION_DENIED_CODE })
    expect(await engine.read(saved.docId)).toMatchObject({ ref: saved, data: new TextEncoder().encode('keep me') })
  })

  it('enforces explicit versions and complete directory inventories across every identity mutation', async () => {
    const { engine } = await identityEngine()
    const select = (ref: UserDocRef): UserDocSelection => {
      if (ref.identity === undefined) throw new Error('Identity mode omitted a file identity.')
      return { docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision }
    }
    const retain = (ref: UserDocTrashRef): UserDocTrashSelection => {
      if (ref.identity === undefined || ref.trashId === undefined) throw new Error('Identity mode omitted a trash identity.')
      return { docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision, trashId: ref.trashId }
    }
    const target = await engine.resolveTarget({ name: 'explicit.txt' })
    const first = await engine.save(target, streamOf('first'))
    const firstTrash = await engine.trash(first.docId, undefined, select(first))
    const replacement = await engine.save(target, streamOf('second'))
    await expect(engine.trash(first.docId, undefined, select(first))).rejects.toThrow('no longer current')
    expect((await engine.read(replacement.docId)).data).toEqual(new TextEncoder().encode('second'))
    const replacementTrash = await engine.trash(replacement.docId, undefined, select(replacement))
    await expect(engine.restore(first.docId)).rejects.toThrow('ambiguous')
    const restored = await engine.restore(first.docId, undefined, undefined, undefined, retain(firstTrash))
    await engine.purge(replacement.docId, undefined, retain(replacementTrash))
    const folder = await engine.createDirectory(UserDocDirectoryId(''), 'folder')
    const moved = await engine.move(restored.docId, folder.directoryId, select(restored))
    await expect(engine.renameDirectory(folder.directoryId, 'renamed', [])).rejects.toThrow('contents changed')
    await engine.renameDirectory(folder.directoryId, 'renamed', [select(moved)])
    const renamed = (await engine.list())[0]!
    expect(renamed.identity?.incarnationId).toBe(first.identity?.incarnationId)
    await engine.remove(renamed.docId, undefined, select(renamed))
    expect(await engine.list()).toEqual([])
  })

  it('treats an unchanged folder name as a no-op after checking its authorized inventory', async () => {
    const { engine } = await identityEngine()
    const folder = await engine.createDirectory(UserDocDirectoryId(''), 'folder')
    const saved = await engine.save(await engine.resolveTarget({ name: 'kept.txt', directoryId: folder.directoryId }), streamOf('kept'))
    const selected = { docId: saved.docId, ...saved.identity! }
    const before = await engine.identities!.snapshot()
    await expect(engine.renameDirectory(folder.directoryId, 'folder', [selected]))
      .resolves.toMatchObject({ directoryId: folder.directoryId, path: folder.path, name: folder.name })
    expect(await engine.identities!.snapshot()).toEqual(before)
    expect((await engine.read(saved.docId)).ref.identity).toEqual(saved.identity)
    await expect(engine.renameDirectory(folder.directoryId, 'folder', [{ ...selected, revision: selected.revision + 1 }]))
      .rejects.toMatchObject({ code: DOCUMENT_TARGET_CONFLICT_CODE })
  })

  it.each(['list', 'directory', 'stat', 'read'] as const)('admits identity writes discovered by %s reads and preserves unchanged reads in maintenance', async (operation) => {
    const denied = new Error('identity maintenance')
    let serving = true, writers = 0
    const { engine, filesRoot } = await identityEngine({ backgroundWrite: async (work) => {
      if (!serving) throw denied
      writers += 1
      try { await work() } finally { writers -= 1 }
    } })
    const saved = await engine.save(await engine.resolveTarget({ name: 'observed.txt' }), streamOf('original'))
    const identities = engine.identities!
    const pending = await identities.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })
    expect(await identities.hasPendingProjection()).toBe(true)
    await identities.acknowledgeProjection(pending.next)
    expect(await identities.hasPendingProjection()).toBe(false)
    serving = false
    expect(await engine.list()).toEqual([saved])
    expect((await engine.read(saved.docId)).data).toEqual(new TextEncoder().encode('original'))
    const before = await identities.snapshot()
    const databasePath = join(filesRoot, '..', 'state', 'metadata.sqlite')
    const databaseBefore = await readFile(databasePath)
    await writeFile(saved.path, 'externally changed bytes')
    const inspect = () => operation === 'list' ? engine.list()
      : operation === 'directory' ? engine.listDirectory(UserDocDirectoryId(''))
        : operation === 'stat' ? engine.stat(saved.docId) : engine.read(saved.docId)
    await expect(inspect()).rejects.toBe(denied)
    await expect(identities.acknowledgeProjection(pending.next)).rejects.toBe(denied)
    expect(await identities.snapshot()).toEqual(before)
    expect(await readFile(databasePath)).toEqual(databaseBefore)
    expect(await identities.hasPendingProjection()).toBe(false)
    expect(writers).toBe(0)
    serving = true
    await inspect()
    expect((await engine.stat(saved.docId)).identity).toEqual({ ...saved.identity, revision: 2 })
    expect(await identities.hasPendingProjection()).toBe(true)
    expect(writers).toBe(0)
  })

  it('repeats completed removals without selecting a later publication at the same path', async () => {
    const { engine } = await identityEngine()
    const target = await engine.resolveTarget({ name: 'removed.txt' })
    await engine.remove(target.docId)
    const saved = await engine.save(target, streamOf('first'))
    const selection = { docId: saved.docId, ...saved.identity! }
    await engine.remove(saved.docId, undefined, selection)
    await engine.remove(saved.docId, undefined, selection)
    await engine.remove(saved.docId)
    const replacement = await engine.save(target, streamOf('replacement'))
    await expect(engine.remove(saved.docId, undefined, selection)).rejects.toMatchObject({ code: DOCUMENT_TARGET_CONFLICT_CODE })
    expect((await engine.read(replacement.docId)).data).toEqual(new TextEncoder().encode('replacement'))
  })

  it('refuses to stream a retained object whose kernel identity changed', async () => {
    const { engine, filesRoot } = await identityEngine()
    const saved = await engine.save(await engine.resolveTarget({ name: 'replaced.txt' }), streamOf('original'))
    const retained = join(filesRoot, 'objects', `${String(saved.identity!.incarnationId)}.object`)
    await rm(retained)
    await writeFile(retained, 'replacement')
    await expect(engine.openRead(saved.docId)).rejects.toThrow('retained document identity object has changed')
  })
})

it('refuses exact selections in a path-only engine instead of ignoring their identity', async () => {
  const engine = createEngine(await documentRoot())
  const saved = await engine.save(await engine.resolveTarget({ name: 'legacy.txt' }), streamOf('preserve'))
  await expect(engine.trash(saved.docId, undefined, { docId: saved.docId,
    incarnationId: UserDocIncarnationId('11111111-1111-4111-8111-111111111111'), revision: 1 }))
    .rejects.toMatchObject({ code: DOCUMENT_PERMISSION_DENIED_CODE })
  expect((await engine.read(saved.docId)).data).toEqual(new TextEncoder().encode('preserve'))
})

it('refuses control roots that overlap or resolve under the public root', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-invalid-controls-'))
  roots.push(scratch)
  const root = join(scratch, 'documents'), parent = join(scratch, 'gateway-private')
  await mkdir(root, { mode: 0o700 })
  await mkdir(parent, { mode: 0o700 })

  await mkdir(join(root, 'nested'), { mode: 0o700 })
  await expect(createEngine(root, { controlRoot: join(root, 'nested') }).warm())
    .rejects.toThrow('disjoint from the public document root')
  await expect(createEngine(root, { controlRoot: 'relative-control-root' }).warm())
    .rejects.toThrow('absolute normalized path')

  await mkdir(join(root, 'aliased-control'), { mode: 0o700 })
  await symlink(root, join(scratch, 'documents-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(createEngine(root, { controlRoot: join(scratch, 'documents-alias', 'aliased-control') }).warm())
    .rejects.toThrow('disjoint real directory')
})

it.skipIf(process.getuid === undefined)('refuses POSIX control directories or parents that permit another account access', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-exposed-controls-'))
  roots.push(scratch)
  const root = join(scratch, 'documents'), parent = join(scratch, 'gateway-private')
  await mkdir(root, { mode: 0o700 })
  await mkdir(parent, { mode: 0o700 })
  const exposed = join(parent, 'exposed')
  await mkdir(exposed, { mode: 0o700 })
  await chmod(exposed, 0o755)
  await expect(createEngine(root, { controlRoot: exposed }).warm()).rejects.toThrow('owner-only Gateway directories')

  const exposedParent = join(scratch, 'exposed-parent')
  await mkdir(exposedParent, { mode: 0o755 })
  await chmod(exposedParent, 0o755)
  const protectedChild = join(exposedParent, 'controls')
  await mkdir(protectedChild, { mode: 0o700 })
  await expect(createEngine(root, { controlRoot: protectedChild }).warm()).rejects.toThrow('owner-only Gateway directories')
})

it('accepts an isolated private control root on platforms without POSIX uid checks', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-no-posix-controls-'))
  roots.push(scratch)
  const root = join(scratch, 'documents'), parent = join(scratch, 'gateway-private'), controlRoot = join(parent, 'documents')
  await mkdir(root, { mode: 0o700 })
  await mkdir(parent, { mode: 0o700 })
  await mkdir(controlRoot, { mode: 0o700 })
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true })
  try {
    await createEngine(root, { controlRoot }).warm()
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process, 'getuid')
    else Object.defineProperty(process, 'getuid', descriptor)
  }
})

it('cancels an accepted chunk body before disposal releases the filesystem engine', async () => {
  const engine = createEngine(await documentRoot())
  const session = await engine.beginUpload({ name: 'unfinished.txt', directoryId: UserDocDirectoryId(''),
    bytes: 3, fingerprint: 'pending-chunk-disposal' })
  const entered = barrier(), release = barrier(), abort = new AbortController()
  let cancelled = false, controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    pull() { entered.resolve(); return release.promise },
    cancel() { cancelled = true; release.resolve() },
  }, { highWaterMark: 0 })
  const outcome = engine.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: 2, total: 3,
    sha256: digest(new TextEncoder().encode('new')), body }, abort.signal)
    .then(() => ({ acknowledged: true }), () => ({ acknowledged: false }))
  await entered.promise
  const disposed = engine.dispose()
  try {
    await Promise.resolve()
    expect(cancelled).toBe(true)
    await disposed
    expect(await outcome).toEqual({ acknowledged: false })
  } finally {
    if (!cancelled) controller.close()
    release.resolve()
    abort.abort(new Error('Owned chunk fixture cleanup'))
    await outcome
    await disposed
  }
})

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
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test.
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
  it('refuses cold storage writes while its host has closed background write admission', async () => {
    const root = await documentRoot(), denied = new Error('host maintenance')
    let open = false
    const backgroundWrite = async (operation: () => Promise<void>) => {
      if (!open) throw denied
      await operation()
    }
    const engine = createEngine(root, { backgroundWrite })
    await expect(engine.warm()).rejects.toBe(denied)
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    open = true
    await engine.warm()
    expect((await stat(root)).isDirectory()).toBe(true)
  })

  it('retains a background writer until an asynchronous upload has finished publishing', async () => {
    const entered = barrier(), release = barrier()
    let writers = 0
    const backgroundWrite = async (operation: () => Promise<void>) => {
      writers += 1
      try { await operation() } finally { writers -= 1 }
    }
    const root = await documentRoot(), engine = createEngine(root, { backgroundWrite })
    await engine.warm()
    const original = storeModule.publishDocPartial
    vi.spyOn(storeModule, 'publishDocPartial').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    const bytes = new TextEncoder().encode('background verification')
    const session = await engine.beginUpload({ name: 'detached.txt', directoryId: UserDocDirectoryId(''),
      bytes: bytes.byteLength, fingerprint: 'detached-writer' })
    await engine.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: bytes.byteLength - 1,
      total: bytes.byteLength, sha256: digest(bytes), body: streamOf(bytes) })
    try {
      expect((await engine.completeUpload(session.uploadId, digest(bytes))).state).toBe('verifying')
      await entered.promise
      expect(writers).toBe(1)
      release.resolve()
      await engine.dispose()
      expect(writers).toBe(0)
      expect(await readFile(join(root, 'detached.txt'), 'utf8')).toBe('background verification')
    } finally {
      release.resolve()
      await engine.dispose()
    }
  })

  it('retains a verifying upload across refused finalization and resumes it after maintenance', async () => {
    const root = await documentRoot(), denied = barrier()
    let open = true
    const backgroundWrite = async (operation: () => Promise<void>) => {
      if (!open) { denied.resolve(); throw new Error('host maintenance') }
      await operation()
    }
    const engine = createEngine(root, { backgroundWrite })
    const bytes = new TextEncoder().encode('resume verification')
    const session = await engine.beginUpload({ name: 'resume.txt', directoryId: UserDocDirectoryId(''),
      bytes: bytes.byteLength, fingerprint: 'maintenance-resume' })
    await engine.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: bytes.byteLength - 1,
      total: bytes.byteLength, sha256: digest(bytes), body: streamOf(bytes) })
    open = false
    expect((await engine.completeUpload(session.uploadId, digest(bytes))).state).toBe('verifying')
    await denied.promise
    await engine.dispose()
    const manifest: unknown = JSON.parse(await readFile(join(root, '.upload-sessions', 'v1', session.uploadId, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ state: 'verifying', finalSha256: digest(bytes) })
    await expect(stat(join(root, 'resume.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    open = true
    const resumed = createEngine(root, { backgroundWrite })
    await resumed.warm()
    expect(await until(async () => (await resumed.inspectUpload(session.uploadId)).state === 'complete')).toBe(true)
    expect(await readFile(join(root, 'resume.txt'), 'utf8')).toBe('resume verification')
  })

  it('does not publish after disposal cancels a finalizer waiting for host admission', async () => {
    const root = await documentRoot(), entered = barrier(), release = barrier()
    let calls = 0
    const engine = createEngine(root, { backgroundWrite: async (operation) => {
      calls += 1
      if (calls > 1) { entered.resolve(); await release.promise }
      await operation()
    } })
    const bytes = new TextEncoder().encode('cancel queued publication')
    const session = await engine.beginUpload({ name: 'cancelled.txt', directoryId: UserDocDirectoryId(''),
      bytes: bytes.byteLength, fingerprint: 'cancel-admission' })
    await engine.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: bytes.byteLength - 1,
      total: bytes.byteLength, sha256: digest(bytes), body: streamOf(bytes) })
    const stop = vi.spyOn(LocalUploadManager.prototype, 'stop')
    try {
      await engine.completeUpload(session.uploadId, digest(bytes))
      await entered.promise
      const disposed = engine.dispose()
      await vi.waitFor(() => { expect(stop).toHaveBeenCalledTimes(1) })
      release.resolve()
      await disposed
      await expect(stat(join(root, 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve()
      await engine.dispose()
    }
  })

  it('reports an expired upload without deleting its files during a maintenance status read', async () => {
    const root = await documentRoot()
    let open = true
    const engine = createEngine(root, { backgroundWrite: async (operation) => {
      if (!open) throw new Error('host maintenance')
      await operation()
    } })
    const session = await engine.beginUpload({ name: 'expired.txt', directoryId: UserDocDirectoryId(''),
      bytes: 1, fingerprint: 'read-expiry' })
    const path = join(root, '.upload-sessions', 'v1', session.uploadId, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const expired = JSON.stringify({ ...manifest, expiresAt: 1 }) + '\n'
    await writeFile(path, expired)
    open = false
    await expect(engine.inspectUpload(session.uploadId)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_EXPIRED_CODE })
    expect(await readFile(path, 'utf8')).toBe(expired)
  })

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
    const disposed = engine.dispose()
    expect(engine.dispose()).toBe(disposed)
    await disposed
    await expect(engine.list()).rejects.toThrow('document store is disposed')
    await expect(engine.warm()).rejects.toThrow('document store is disposed')
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
  it('defers both retention and upload cleanup while the host denies background writes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let open = true
    const engine = createEngine(await documentRoot(), { sweepIntervalMs: 60_000,
      backgroundWrite: async (operation) => {
        if (!open) throw new Error('host maintenance')
        await operation()
      } })
    await engine.warm()
    const purge = vi.spyOn(trashModule, 'purgeDueDocuments').mockResolvedValue(0)
    const cleanup = vi.spyOn(LocalUploadManager.prototype, 'cleanupExpired').mockResolvedValue()
    engine.attach()
    open = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(purge).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    open = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await engine.dispose()
  })

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
    engine.attach()
    await vi.advanceTimersByTimeAsync(25)
    await vi.advanceTimersByTimeAsync(25)
    expect(purge.mock.calls.length).toBe(2)
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
  it('accepts caller cancellation through reads and every file lifecycle mutation', async () => {
    const engine = createEngine(await documentRoot()), signal = new AbortController().signal
    const original = await engine.save(await engine.resolveTarget({ name: 'lifecycle.txt' }), streamOf('body'), signal)
    expect((await engine.stat(original.docId, signal)).docId).toBe(original.docId)
    expect(new TextDecoder().decode((await engine.read(original.docId, signal)).data)).toBe('body')
    await engine.trash(original.docId, signal)
    const restored = await engine.restore(original.docId, undefined, undefined, signal)
    await engine.trash(restored.docId, signal)
    await engine.purge(restored.docId, signal)
    const removed = await engine.save(await engine.resolveTarget({ name: 'remove.txt' }), streamOf('body'))
    await engine.remove(removed.docId, signal)
    await expect(readFile(removed.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await engine.listTrash()).toEqual([])
  })

  it.each(['independent', 'same', 'cause'] as const)('settles save body cleanup after an early %s failure', async (kind) => {
    const engine = createEngine(await documentRoot()), target = await engine.resolveTarget({ name: 'refused.txt' })
    const cleanup = new Error('Owned body cleanup failure')
    const primary = kind === 'same' ? cleanup : new Error('Owned early save failure', kind === 'cause' ? { cause: cleanup } : undefined)
    vi.spyOn(storeModule, 'saveDocFile').mockRejectedValueOnce(primary)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; throw cleanup } })
    const saving = engine.save(target, body)
    if (kind === 'independent') await expect(saving).rejects.toMatchObject({ errors: [primary, cleanup] })
    else await expect(saving).rejects.toBe(primary)
    expect(cancelled).toBe(true)
  })

  it('leaves a caller-held reader usable when a locked body cannot be saved', async () => {
    const engine = createEngine(await documentRoot()), target = await engine.resolveTarget({ name: 'locked.txt' })
    const body = streamOf('caller bytes'), reader = body.getReader()
    try {
      await expect(engine.save(target, body)).rejects.toMatchObject({ code: 'DOCUMENT_WRITE_FAILED' })
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('caller bytes')
      await expect(readFile(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await reader.cancel(); reader.releaseLock() }
  })

  it('retains an unknown early I/O failure together with source cancellation failure', async () => {
    const engine = createEngine(await documentRoot()), target = await engine.resolveTarget({ name: 'unknown.txt' })
    const cleanup = new Error('Owned source cancellation failure')
    vi.spyOn(storeModule, 'saveDocFile').mockRejectedValueOnce(undefined)
    const body = new ReadableStream<Uint8Array>({ cancel() { throw cleanup } })
    await expect(engine.save(target, body)).rejects.toMatchObject({ errors: [undefined, cleanup] })
  })

  it('cancels in-flight scans and joins their settle', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const scan = deferred<UserDocRef[]>(), entered = barrier()
    let scanSignal: AbortSignal | undefined
    vi.spyOn(storeModule, 'listDocFiles').mockImplementation((_root, signal) => {
      scanSignal = signal
      entered.resolve()
      return scan.promise
    })
    const outcome = engine.list().then(() => undefined, (error: unknown) => error)
    await entered.promise
    let closed = false
    const disposed = engine.dispose().then(() => { closed = true })
    try {
      expect(await outcome).toMatchObject({ message: 'document store disposed' })
      expect(scanSignal?.aborted).toBe(true)
      expect(closed).toBe(false)
    } finally {
      scan.resolve([])
      await disposed
    }
    expect(closed).toBe(true)
  })

  it('joins an accepted directory mutation before disposal completes', async () => {
    const engine = createEngine(await documentRoot())
    await engine.warm()
    const entered = barrier(), release = barrier()
    const create = storeModule.createDocDirectory
    vi.spyOn(storeModule, 'createDocDirectory').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return create(...args)
    })
    const created = engine.createDirectory(UserDocDirectoryId(''), 'accepted')
    await entered.promise
    let closed = false
    const disposed = engine.dispose().then(() => { closed = true })
    try {
      await Promise.resolve()
      expect(closed).toBe(false)
    } finally {
      release.resolve()
      await disposed
    }
    expect((await created).directoryId).toBe('accepted')
    expect(closed).toBe(true)
  })

  it('joins a scan created after disposal starts during initialization', async () => {
    const engine = createEngine(await documentRoot())
    const initializing = barrier(), initialized = barrier()
    const scanned = barrier(), scan = deferred<UserDocRef[]>()
    vi.spyOn(LocalUploadManager.prototype, 'cleanupExpired').mockImplementation(async () => {
      initializing.resolve()
      await initialized.promise
    })
    vi.spyOn(storeModule, 'listDocFiles').mockImplementation(() => {
      scanned.resolve()
      return scan.promise
    })
    const outcome = engine.list().then(() => undefined, (error: unknown) => error)
    await initializing.promise
    let closed = false
    const disposed = engine.dispose().then(() => { closed = true })
    try {
      initialized.resolve()
      await scanned.promise
      expect(await outcome).toMatchObject({ message: 'document store disposed' })
      expect(closed).toBe(false)
    } finally {
      initialized.resolve()
      scan.resolve([])
      await disposed
    }
  })
})
