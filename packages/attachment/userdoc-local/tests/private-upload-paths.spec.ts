/** Upload housekeeping and chunk I/O remain inside their real provider-owned directories. */
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocDirectoryId, UserDocError, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { LocalUploadManager, type LocalUploadDependencies } from '../src/upload.ts'
import { resolveDocTarget, publishDocPartial } from '../src/store.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

async function fixture(options: { backgroundWrite?: LocalUploadDependencies['backgroundWrite']; maxConcurrent?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-private-upload-paths-'))
  const root = join(base, 'documents')
  const managers: LocalUploadManager[] = []
  onTestFinished(async () => {
    const results = await Promise.allSettled(managers.map(manager => manager.stop()))
    const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    try { await rm(base, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'Upload fixture shutdown failed')
  })
  await mkdir(root)
  const limits = { maxFileBytes: null, maxFilesPerMessage: 20, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
    upload: { protocol: 'resumable-v1' as const, chunkBytes: 65536, sessionTtlMs: 60000, resumable: true as const } }
  const createManager = (backgroundWrite = options.backgroundWrite) => {
    const manager = new LocalUploadManager({ root, limits,
      resolveTarget: (input, reserved) => resolveDocTarget(root, input.directoryId, input.name, reserved),
      publish: (target, partial, bytes, digest) => publishDocPartial(root, target, partial, bytes, digest),
      ...(backgroundWrite === undefined ? {} : { backgroundWrite }),
    }, { chunkBytes: 65536, sessionTtlMs: 60000, minFreeBytes: 0, maxConcurrent: options.maxConcurrent ?? 2,
      cleanupIntervalMs: 60000, manifestMaxBytes: 256 * 1024 })
    managers.push(manager)
    return manager
  }
  const manager = createManager()
  return { base, root, manager, createManager }
}

it.each(['status', 'resume', 'admission', 'peer-cleanup'] as const)('retains a live finalizer past session expiry during %s', async (mode) => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const f = await fixture({ maxConcurrent: 1, backgroundWrite: async (operation) => {
    entered.resolve(undefined); await release.promise; await operation()
  } })
  const owner = UserDocUploadOwnerId('user:7'), bytes = Buffer.from('accepted upload bytes')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const input = { name: 'retained.txt', directoryId: UserDocDirectoryId(''), bytes: bytes.length, fingerprint: 'live-finalizer' }
  const session = await f.manager.begin(input, owner)
  await f.manager.write(session.uploadId, { index: 0, start: 0, end: bytes.length - 1, total: bytes.length,
    sha256: hash, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
  }, undefined, owner)
  try {
    expect((await f.manager.complete(session.uploadId, hash, owner)).state).toBe('verifying')
    await entered.promise
    const path = join(f.root, '.upload-sessions', 'v1', session.uploadId, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFileAtomic(path, JSON.stringify({ ...manifest, expiresAt: 1 }), { mode: 0o600, dirMode: 0o700 })
    if (mode === 'status') await expect(f.manager.inspect(session.uploadId, owner)).resolves.toMatchObject({ state: 'verifying' })
    else if (mode === 'resume') expect((await f.manager.begin(input, owner)).uploadId).toBe(session.uploadId)
    else if (mode === 'admission') {
      await expect(f.manager.begin({ ...input, fingerprint: 'another-file' }, owner)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_BUSY' })
    } else {
      await f.createManager(operation => operation()).cleanupExpired()
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ state: 'verifying' })
    }
  } finally { release.resolve(undefined) }
  await expect.poll(async () => (await f.manager.inspect(session.uploadId, owner)).state, { timeout: 10000 }).toBe('complete')
  expect(await readFile(join(f.root, session.name), 'utf8')).toBe(bytes.toString())
})

it('resumes expired accepted verification after its original manager stops', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const f = await fixture({ backgroundWrite: async (operation) => {
    entered.resolve(undefined); await release.promise; await operation()
  } })
  const owner = UserDocUploadOwnerId('user:7'), hash = createHash('sha256').digest('hex')
  const session = await f.manager.begin({ name: 'recovered.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: 'restart' }, owner)
  try {
    await f.manager.complete(session.uploadId, hash, owner)
    await entered.promise
    const stopping = f.manager.stop()
    release.resolve(undefined)
    await stopping
  } finally { release.resolve(undefined) }
  const path = join(f.root, '.upload-sessions', 'v1', session.uploadId, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFileAtomic(path, JSON.stringify({ ...manifest, expiresAt: 1 }), { mode: 0o600, dirMode: 0o700 })
  const restarted = f.createManager(operation => operation())
  await restarted.cleanupExpired()
  await restarted.resumePendingFinalizations()
  await expect.poll(async () => (await restarted.inspect(session.uploadId, owner)).state, { timeout: 10000 }).toBe('complete')
  expect(await readFile(join(f.root, session.name), 'utf8')).toBe('')
})

it.each(['uploading', 'complete', 'failed'] as const)('still expires a session in %s state without removing published bytes', async (state) => {
  const f = await fixture(), owner = UserDocUploadOwnerId('user:7')
  const session = await f.manager.begin({ name: 'terminal.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: state }, owner)
  if (state !== 'uploading') {
    const hash = state === 'complete' ? createHash('sha256').digest('hex') : '0'.repeat(64)
    await f.manager.complete(session.uploadId, hash, owner)
    await expect.poll(async () => (await f.manager.inspect(session.uploadId, owner)).state, { timeout: 10000 }).toBe(state)
  }
  const path = join(f.root, '.upload-sessions', 'v1', session.uploadId, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFileAtomic(path, JSON.stringify({ ...manifest, expiresAt: 1 }), { mode: 0o600, dirMode: 0o700 })
  await expect(f.manager.inspect(session.uploadId, owner)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_EXPIRED' })
  await f.manager.cleanupExpired()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  if (state === 'complete') expect(await readFile(join(f.root, session.name), 'utf8')).toBe('')
})

it.each(['future-version', 'missing-manifest'] as const)('preserves incomplete bytes during cleanup of %s metadata', async (kind) => {
  const f = await fixture(), owner = UserDocUploadOwnerId('user:7'), bytes = Buffer.from('keep')
  const session = await f.manager.begin({ name: 'retained.txt', directoryId: UserDocDirectoryId(''),
    bytes: bytes.byteLength, fingerprint: 'retained-metadata' }, owner)
  await f.manager.write(session.uploadId, { index: 0, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'), body: new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close() },
    }) }, undefined, owner)
  const directory = join(f.root, '.upload-sessions', 'v1', session.uploadId), path = join(directory, 'manifest.json')
  if (kind === 'future-version') {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, formatVersion: 999 }))
  } else await unlink(path)
  let failure: unknown
  try { await f.manager.cleanupExpired() } catch (error) { failure = error }
  expect(await readFile(join(directory, 'data.part'))).toEqual(bytes)
  if (kind === 'future-version') expect(failure).toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  else expect(failure).toBeUndefined()
})

it('joins every cleanup worker and retains independent failures', async () => {
  const f = await fixture()
  const expired = await f.manager.begin({ name: 'expired.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: 'expired' })
  const unreadable = await f.manager.begin({ name: 'unreadable.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: 'unreadable' })
  const directory = join(f.root, '.upload-sessions', 'v1', expired.uploadId)
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  await writeFile(manifestPath, JSON.stringify({ ...manifest, expiresAt: 1 }))
  const failurePath = join(f.root, '.upload-sessions', 'v1', unreadable.uploadId, 'manifest.json')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const failed = Promise.withResolvers<undefined>()
  const removed = Promise.withResolvers<undefined>()
  const originalRm = fs.rm, originalOpen = fs.open
  const primary = new Error('Owned cleanup read failed'), secondary = new Error('Owned cleanup removal failed')
  fs.rm = async (...args: Parameters<typeof originalRm>) => {
    if (args[0] === directory) {
      entered.resolve(undefined)
      try { await release.promise; await originalRm(...args); throw secondary }
      finally { removed.resolve(undefined) }
    }
    return originalRm(...args)
  }
  fs.open = async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === failurePath) { await entered.promise; failed.resolve(undefined); throw primary }
    return originalOpen(...args)
  }
  syncBuiltinESMExports()
  const cleanup = f.manager.cleanupExpired().catch((error: unknown) => error)
  try {
    await failed.promise
    release.resolve(undefined)
    const failure = await cleanup
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors as unknown[]
    expect(errors).toHaveLength(2)
    expect(errors).toContain(secondary)
    expect(errors.some(error => error instanceof UserDocError && error.code === 'DOCUMENT_UPLOAD_STORAGE' && error.cause === primary)).toBe(true)
  } finally {
    release.resolve(undefined)
    await cleanup
    await removed.promise
    fs.rm = originalRm; fs.open = originalOpen; syncBuiltinESMExports()
  }
  await expect(readFile(join(directory, 'data.part'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.manager.inspect(unreadable.uploadId)).receivedBytes).toBe(0)
})

it.each(['root', 'upload-directory', 'version-directory'] as const)('refuses a linked %s before housekeeping creates outside directories', async (point) => {
  const f = await fixture(), outside = join(f.base, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'retained.txt'), 'outside bytes')
  let link = f.root
  if (point === 'root') await rename(f.root, join(f.base, 'retained-root'))
  else if (point === 'upload-directory') link = join(f.root, '.upload-sessions')
  else { await mkdir(join(f.root, '.upload-sessions')); link = join(f.root, '.upload-sessions', 'v1') }
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.manager.cleanupExpired()).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE' })
  expect(await readdir(outside)).toEqual(['retained.txt'])
  expect(await readFile(join(outside, 'retained.txt'), 'utf8')).toBe('outside bytes')
})

it.skipIf(process.platform !== 'linux')('does not publish through a directory replaced after parent validation', async () => {
  const f = await fixture()
  const targetDirectory = join(f.root, 'reports'), outside = join(f.base, 'outside'), retained = join(f.root, 'reports-retained')
  const partialDirectory = join(f.root, '.upload-sessions', 'v1', 'parent-swap')
  const partialPath = join(partialDirectory, 'data.part'), bytes = 'confined resumable payload'
  await mkdir(targetDirectory); await mkdir(outside); await mkdir(partialDirectory, { recursive: true })
  await writeFile(partialPath, bytes)
  const target = await resolveDocTarget(f.root, UserDocDirectoryId('reports'), 'proof.txt')
  const originalLink = fs.link
  let swapped = false
  fs.link = async (...args: Parameters<typeof originalLink>) => {
    if (!swapped) {
      swapped = true
      await rename(targetDirectory, retained)
      await symlink(outside, targetDirectory, 'dir')
    }
    return originalLink(...args)
  }
  syncBuiltinESMExports()
  try {
    await expect(publishDocPartial(f.root, target, partialPath, Buffer.byteLength(bytes)))
      .rejects.toMatchObject({ code: 'DOCUMENT_WRITE_FAILED' })
  } finally {
    fs.link = originalLink
    syncBuiltinESMExports()
  }
  expect(swapped).toBe(true)
  expect(await readdir(outside)).toEqual([])
  expect(await readdir(retained)).toEqual([])
  expect(await readFile(partialPath, 'utf8')).toBe(bytes)
})

it('refuses a session directory link before chunk I/O can mutate an outside backup', async () => {
  const f = await fixture(), owner = UserDocUploadOwnerId('user:1')
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 3, fingerprint: randomUUID() }, owner)
  const directory = join(f.root, '.upload-sessions', 'v1', String(session.uploadId)), outside = join(f.base, 'outside-session')
  const before = await readFile(join(directory, 'manifest.json'), 'utf8')
  await rename(directory, outside)
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
  const bytes = new TextEncoder().encode('new')
  await expect(f.manager.write(session.uploadId, { index: 0, start: 0, end: 2, total: 3,
    sha256: createHash('sha256').update(bytes).digest('hex'), body: new ReadableStream({ start(controller) {
      controller.enqueue(bytes); controller.close()
    } }) }, undefined, owner)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE' })
  expect(await readFile(join(outside, 'manifest.json'), 'utf8')).toBe(before)
  expect((await readFile(join(outside, 'data.part'))).byteLength).toBe(0)
})

it('does not read a linked manifest through a real session directory', async () => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
  const outside = join(f.base, 'outside-manifest.json'), original = await readFile(path, 'utf8')
  await rename(path, outside)
  await symlink(outside, path, 'file')
  await expect(f.manager.inspect(session.uploadId)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  expect(await readFile(outside, 'utf8')).toBe(original)
})

it('refuses a linked partial before a valid chunk overwrites outside bytes', async () => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 3, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'data.part')
  const outside = join(f.base, 'outside-data.txt')
  await writeFile(outside, 'old')
  await unlink(path); await symlink(outside, path, 'file')
  const bytes = new TextEncoder().encode('new')
  await expect(f.manager.write(session.uploadId, { index: 0, start: 0, end: 2, total: 3,
    sha256: createHash('sha256').update(bytes).digest('hex'), body: new ReadableStream({ start(controller) {
      controller.enqueue(bytes); controller.close()
    } }) })).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE' })
  expect(await readFile(outside, 'utf8')).toBe('old')
  expect((await f.manager.inspect(session.uploadId)).receivedBytes).toBe(0)
})

it('rejects an array masquerading as a durable upload state without deleting its payload', async () => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...original, state: ['uploading'] }))
  await expect(f.manager.inspect(session.uploadId)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  expect((await readFile(join(dirname(path), 'data.part'))).byteLength).toBe(0)
  await unlink(path)
})

it('reads a complete manifest generation published between the path probe and the file open', async () => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const expiresAt = session.expiresAt + 1000, open = fs.open
  let replaced = false
  fs.open = async (...args: Parameters<typeof open>) => {
    if (args[0] === path && !replaced) {
      replaced = true
      await writeFileAtomic(path, JSON.stringify({ ...original, expiresAt }), { mode: 0o600, dirMode: 0o700 })
    }
    return open(...args)
  }
  syncBuiltinESMExports()
  try {
    expect((await f.manager.inspect(session.uploadId)).expiresAt).toBe(expiresAt)
    expect(replaced).toBe(true)
  } finally { fs.open = open; syncBuiltinESMExports() }
})

it.each(['read', 'stat'] as const)('retains an independent manifest %s error and its handle-close error', async (point) => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 0, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
  const primary = new Error(`Owned manifest ${point} failure`), cleanup = new Error('Owned manifest handle-close failure'), open = fs.open
  let closes = 0
  fs.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[0] === path) {
      const close = handle.close.bind(handle)
      handle[point] = async () => { throw primary }
      handle.close = async () => { closes += 1; await close(); throw cleanup }
    }
    return handle
  }
  syncBuiltinESMExports()
  try {
    await expect(f.manager.inspect(session.uploadId)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE',
      cause: { errors: [primary, cleanup] } })
    expect(closes).toBe(1)
  } finally { fs.open = open; syncBuiltinESMExports() }
  expect((await f.manager.inspect(session.uploadId)).receivedBytes).toBe(0)
})

it.each(['write', 'stat', 'sync'] as const)('retains a chunk %s failure and its handle-close failure without acknowledging bytes', async (point) => {
  const f = await fixture()
  const session = await f.manager.begin({ name: 'report.txt', directoryId: UserDocDirectoryId(''), bytes: 3, fingerprint: randomUUID() })
  const path = join(f.root, '.upload-sessions', 'v1', String(session.uploadId), 'data.part')
  const primary = new Error(`Owned chunk ${point} failure`), cleanup = new Error('Owned chunk handle-close failure'), open = fs.open
  let closes = 0
  fs.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (args[0] === path) {
      const close = handle.close.bind(handle)
      handle[point] = async () => { throw primary }
      handle.close = async () => { closes += 1; await close(); throw cleanup }
    }
    return handle
  }
  syncBuiltinESMExports()
  const bytes = new TextEncoder().encode('new')
  try {
    await expect(f.manager.write(session.uploadId, { index: 0, start: 0, end: 2, total: 3,
      sha256: createHash('sha256').update(bytes).digest('hex'), body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes); controller.close()
      } }) })).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE', cause: { errors: [primary, cleanup] } })
    expect(closes).toBe(1)
  } finally { fs.open = open; syncBuiltinESMExports() }
  expect((await f.manager.inspect(session.uploadId)).receivedBytes).toBe(0)
})
