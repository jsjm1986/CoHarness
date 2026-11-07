import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_UPLOAD_HASH_CODE,
  DOCUMENT_UPLOAD_BUSY_CODE,
  DOCUMENT_UPLOAD_EXPIRED_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  UserDocDirectoryId,
  UserDocIncarnationId,
  UserDocUploadOwnerId,
} from '@deepseek-ai/dsh-userdoc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalUserDocStore from '../src/index.ts'
import * as documentStore from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function body(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function store(root: string, config: Record<string, unknown> = {}, ctx = context()): Promise<LocalUserDocStore> {
  const value = new LocalUserDocStore(ctx, {
    uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, ...config,
  })
  await value.list()
  return value
}

async function complete(storeValue: LocalUserDocStore, uploadId: string, sha256: string, ownerId?: UserDocUploadOwnerId) {
  const started = await storeValue.completeUpload(uploadId as never, sha256, undefined, ownerId)
  let current = started
  // Finalization hashes the file through a bounded stream; a 100 MB fixture
  // can legitimately take longer than a few scheduler ticks on a busy host.
  for (let attempt = 0; current.state === 'verifying' && attempt < 400; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    current = await storeValue.inspectUpload(uploadId as never, undefined, ownerId)
  }
  return current
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('resumable local document uploads', () => {
  it.each([undefined, UserDocUploadOwnerId('user:7')])('retains an identified publication through status inspection and restart for %s', async (owner) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-identity-'))
    roots.push(root)
    const identity = { incarnationId: UserDocIncarnationId(randomUUID()), revision: 1,
      origin: 'upload' as const, ...(owner === undefined ? {} : { createdBy: owner }) }
    const original = documentStore.publishDocPartial
    vi.spyOn(documentStore, 'publishDocPartial').mockImplementation(async (...args) => ({
      ...await original(...args), identity,
    }))
    const firstContext = context(), first = await store(root, {}, firstContext)
    const data = Uint8Array.of(65)
    const session = await first.beginUpload({ name: 'identified.txt', directoryId: UserDocDirectoryId(''),
      bytes: data.byteLength, fingerprint: 'identified-publication' }, owner)
    await first.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: 0, total: 1,
      sha256: digest(data), body: body(data) }, undefined, owner)
    const completeSession = await complete(first, session.uploadId, digest(data), owner)
    expect(completeSession.ref?.identity).toEqual(identity)
    await firstContext.fiber.dispose()
    const restarted = await store(root)
    expect((await restarted.inspectUpload(session.uploadId, undefined, owner)).ref?.identity).toEqual(identity)
    const manifestPath = join(root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest.formatVersion).toBe(3)
    for (const invalid of [
      { ...manifest, formatVersion: owner === undefined ? 1 : 2 },
      { ...manifest, ref: { ...completeSession.ref, identity: undefined } },
      { ...manifest, ref: { ...completeSession.ref, identity: { ...identity, revision: 0 } } },
      { ...manifest, receivedBytes: 0 },
    ]) {
      await writeFile(manifestPath, JSON.stringify(invalid))
      await expect(restarted.inspectUpload(session.uploadId, undefined, owner))
        .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect((await restarted.inspectUpload(session.uploadId, undefined, owner)).ref?.identity).toEqual(identity)
  })

  it('retains an upload actor across restart without exposing it in public metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-'))
    roots.push(root)
    const owner = UserDocUploadOwnerId('user:7'), other = UserDocUploadOwnerId('user:9')
    const firstContext = context()
    const first = await store(root, {}, firstContext)
    const created = await first.beginUpload({ name: 'private.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'actor-restart' }, owner)
    expect(Object.hasOwn(created, 'ownerId')).toBe(false)
    await firstContext.fiber.dispose()
    const restarted = await store(root)
    await expect(restarted.inspectUpload(created.uploadId, undefined, other))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    await expect(restarted.inspectUpload(created.uploadId)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    await expect(restarted.inspectUpload(created.uploadId, undefined, owner))
      .resolves.toMatchObject({ uploadId: created.uploadId, fingerprint: 'actor-restart' })
    await restarted.cancelUpload(created.uploadId, undefined, owner)
  })

  it('keeps legacy ownerless sessions available only to an ownerless composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-legacy-'))
    roots.push(root)
    const value = await store(root)
    const created = await value.beginUpload({ name: 'legacy.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'legacy' })
    await expect(value.inspectUpload(created.uploadId, undefined, UserDocUploadOwnerId('user:7')))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    await expect(value.inspectUpload(created.uploadId)).resolves.toMatchObject({ uploadId: created.uploadId, state: 'uploading' })
  })

  it('reserves separate names for concurrent actors with the same browser file fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-names-'))
    roots.push(root)
    const value = await store(root)
    const input = { name: 'shared.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'same-file' }
    const first = UserDocUploadOwnerId('user:7'), second = UserDocUploadOwnerId('user:9')
    const a = await value.beginUpload(input, first)
    const b = await value.beginUpload(input, second)
    expect(b.name).not.toBe(a.name)
    for (const [session, actor, byte] of [[a, first, 65], [b, second, 66]] as const) {
      const bytes = Uint8Array.of(byte)
      await value.writeUploadChunk(session.uploadId, {
        index: 0, start: 0, end: 0, total: 1, sha256: digest(bytes), body: body(bytes),
      }, undefined, actor)
      const result = await complete(value, session.uploadId, digest(bytes), actor)
      expect(result.state).toBe('complete')
      expect(await readFile(result.ref!.path)).toEqual(Buffer.from(bytes))
    }
    expect(await value.list()).toHaveLength(2)
  })

  it.each(['cancelled', 'failed', 'expired'] as const)('releases the name reservation for a %s actor upload', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-reservation-'))
    roots.push(root)
    const value = await store(root, { uploadMaxConcurrent: 1 })
    const owner = UserDocUploadOwnerId('user:7')
    const input = { name: 'available.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'first' }
    const created = await value.beginUpload(input, owner)
    if (outcome === 'cancelled') await value.cancelUpload(created.uploadId, undefined, owner)
    else if (outcome === 'expired') {
      const path = join(root, '.upload-sessions', 'v1', created.uploadId, 'manifest.json')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      await writeFile(path, JSON.stringify({ ...manifest, expiresAt: Date.now() - 1 }))
    } else {
      const bytes = Uint8Array.of(65)
      await value.writeUploadChunk(created.uploadId, {
        index: 0, start: 0, end: 0, total: 1, sha256: digest(bytes), body: body(bytes),
      }, undefined, owner)
      expect((await complete(value, created.uploadId, '0'.repeat(64), owner)).state).toBe('failed')
    }
    const next = await value.beginUpload({ ...input, fingerprint: 'replacement' }, UserDocUploadOwnerId('user:9'))
    expect(next.name).toBe('available.txt')
  })

  it('keeps the owner finalization running when another actor attempts cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-finalizer-'))
    roots.push(root)
    const release = Promise.withResolvers<undefined>()
    const publish = documentStore.publishDocPartial
    const publishing = vi.spyOn(documentStore, 'publishDocPartial').mockImplementation(async (...args) => {
      await release.promise
      return publish(...args)
    })
    const value = await store(root), owner = UserDocUploadOwnerId('user:7')
    const bytes = Uint8Array.of(65)
    const session = await value.beginUpload({
      name: 'finalizing.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'finalizing',
    }, owner)
    await value.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: 0, total: 1, sha256: digest(bytes), body: body(bytes),
    }, undefined, owner)
    let cancellation: Promise<void> | undefined
    let outcome: { denied: boolean; error?: unknown } | undefined
    try {
      expect((await value.completeUpload(session.uploadId, digest(bytes), undefined, owner)).state).toBe('verifying')
      await expect.poll(() => publishing.mock.calls.length).toBe(1)
      cancellation = value.cancelUpload(session.uploadId, undefined, UserDocUploadOwnerId('user:9'))
        .then(() => { outcome = { denied: false } }, (error: unknown) => { outcome = { denied: true, error } })
      await expect.poll(() => outcome).toMatchObject({ denied: true, error: { code: DOCUMENT_UPLOAD_NOT_FOUND_CODE } })
    } finally {
      release.resolve(undefined)
      await cancellation
    }
    expect((await complete(value, session.uploadId, digest(bytes), owner)).state).toBe('complete')
  })

  it('retains the scope concurrency cap across distinct upload actors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-cap-'))
    roots.push(root)
    const value = await store(root, { uploadMaxConcurrent: 2 })
    for (const actor of ['7', '9']) {
      await value.beginUpload({ name: `${actor}.txt`, directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: actor }, UserDocUploadOwnerId(`user:${actor}`))
    }
    await expect(value.beginUpload({ name: 'third.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'third' }, UserDocUploadOwnerId('user:11')))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_BUSY_CODE })
  })

  it.each([null, 7, '', 'bad\u0000actor', 'x'.repeat(129)])('refuses malformed durable upload actor metadata: %s', async (ownerId) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-invalid-'))
    roots.push(root)
    const value = await store(root)
    const owner = UserDocUploadOwnerId('user:7')
    const created = await value.beginUpload({ name: 'private.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'invalid' }, owner)
    const path = join(root, '.upload-sessions', 'v1', created.uploadId, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, ownerId }))
    await expect(value.inspectUpload(created.uploadId, undefined, owner)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
  })

  it.each([
    { formatVersion: 1, ownerId: 'user:7' },
    { formatVersion: 2 },
    { formatVersion: 3, ownerId: 'user:7' },
  ])('refuses incompatible private upload manifest versions: %j', async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-version-'))
    roots.push(root)
    const value = await store(root)
    const owner = UserDocUploadOwnerId('user:7')
    const created = await value.beginUpload({ name: 'private.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'version' }, owner)
    const path = join(root, '.upload-sessions', 'v1', created.uploadId, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete manifest.ownerId
    await writeFile(path, JSON.stringify({ ...manifest, ...version }))
    await expect(value.inspectUpload(created.uploadId, undefined, owner)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
  })

  it('does not expire another actor private upload during a denied inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-actor-expired-'))
    roots.push(root)
    const value = await store(root)
    const owner = UserDocUploadOwnerId('user:7')
    const created = await value.beginUpload({ name: 'private.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'expired' }, owner)
    const path = join(root, '.upload-sessions', 'v1', created.uploadId, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, expiresAt: Date.now() - 1 }))
    await expect(value.inspectUpload(created.uploadId, undefined, UserDocUploadOwnerId('user:9')))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    expect(await readFile(path, 'utf8')).toContain('user:7')
    await expect(value.inspectUpload(created.uploadId, undefined, owner)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_EXPIRED_CODE })
  })

  it('handles a file larger than one request and resumes after a runtime restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-'))
    roots.push(root)
    const first = await store(root)
    const prefix = new Uint8Array(65536).fill(65)
    const suffix = new Uint8Array([66])
    const all = new Uint8Array(prefix.byteLength + suffix.byteLength)
    all.set(prefix)
    all.set(suffix, prefix.byteLength)
    const session = await first.beginUpload({
      name: 'large.json', directoryId: UserDocDirectoryId(''), bytes: all.byteLength, fingerprint: 'restart',
    })
    const firstChunk = await first.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: prefix.byteLength - 1, total: all.byteLength, sha256: digest(prefix), body: body(prefix),
    })
    expect(firstChunk.receivedBytes).toBe(prefix.byteLength)

    const restarted = await store(root)
    await expect(restarted.inspectUpload(session.uploadId)).resolves.toMatchObject({ receivedBytes: prefix.byteLength })
    await restarted.writeUploadChunk(session.uploadId, {
      index: 1, start: prefix.byteLength, end: all.byteLength - 1, total: all.byteLength, sha256: digest(suffix), body: body(suffix),
    })
    const finished = await complete(restarted, String(session.uploadId), digest(all))
    expect(finished.state).toBe('complete')
    expect(finished.ref).toMatchObject({ name: 'large.json', bytes: all.byteLength })
    expect(await readFile(finished.ref!.path)).toEqual(Buffer.from(all))
  })

  it('accepts the observed 100 MB-plus document through bounded chunks', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-100mb-'))
    roots.push(root)
    const size = 100_230_654
    const chunkBytes = 8 * 1024 * 1024
    const service = await store(root, { uploadChunkBytes: chunkBytes })
    const all = new Uint8Array(size)
    for (let index = 0; index < all.length; index += 1) all[index] = index % 251
    const session = await service.beginUpload({
      name: 'cloudflare-limit.bin', directoryId: UserDocDirectoryId(''), bytes: size, fingerprint: '100mb-plus',
    })
    const finalHash = createHash('sha256')
    for (let start = 0, index = 0; start < size; index += 1) {
      const end = Math.min(size, start + chunkBytes)
      const data = all.subarray(start, end)
      const sha256 = digest(data)
      finalHash.update(data)
      await service.writeUploadChunk(session.uploadId, {
        index, start, end: end - 1, total: size, sha256, body: body(data),
      })
      start = end
    }
    const finished = await complete(service, String(session.uploadId), finalHash.digest('hex'))
    expect(finished.state).toBe('complete')
    expect(finished.ref).toMatchObject({ name: 'cloudflare-limit.bin', bytes: size })
  })

  it('rejects bad ranges and hashes without publishing a partial document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-errors-'))
    roots.push(root)
    const service = await store(root)
    const session = await service.beginUpload({
      name: 'bad.txt', directoryId: UserDocDirectoryId(''), bytes: 3, fingerprint: 'bad',
    })
    await expect(service.writeUploadChunk(session.uploadId, {
      index: 1, start: 1, end: 2, total: 3, sha256: digest(new Uint8Array([1, 2])), body: body(new Uint8Array([1, 2])),
    })).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_RANGE_CODE })
    await expect(service.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: 2, total: 3, sha256: '0'.repeat(64), body: body(new Uint8Array([1, 2, 3])),
    })).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_HASH_CODE })
    await expect(service.list()).resolves.toEqual([])
  })

  it('recovers a publication committed before a runtime restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-recovery-'))
    roots.push(root)
    const first = new LocalUserDocStore(context(), {
      uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, uploadMaxConcurrent: 1,
    })
    await first.list()
    const bytes = new TextEncoder().encode('recover me')
    const sha256 = digest(bytes)
    const session = await first.beginUpload({
      name: 'recovery.txt', directoryId: UserDocDirectoryId(''), bytes: bytes.byteLength, fingerprint: 'recovery',
    })
    await first.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, sha256, body: body(bytes),
    })

    const manifestPath = join(root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
    const partialPath = join(root, '.upload-sessions', 'v1', String(session.uploadId), 'data.part')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.state = 'verifying'
    manifest.finalSha256 = sha256
    const targetPath = String(manifest.targetPath)
    await link(partialPath, targetPath)
    await unlink(partialPath)
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)

    const restarted = await store(root)
    let current = await restarted.inspectUpload(session.uploadId)
    for (let attempt = 0; current.state === 'verifying' && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      current = await restarted.inspectUpload(session.uploadId)
    }
    expect(current.state).toBe('complete')
    expect(await readFile(targetPath)).toEqual(Buffer.from(bytes))
  })

  it('serializes admission across stores sharing one document root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-admission-'))
    roots.push(root)
    const first = new LocalUserDocStore(context(), {
      uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, uploadMaxConcurrent: 1,
    })
    await first.list()
    const second = new LocalUserDocStore(context(), {
      uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, uploadMaxConcurrent: 1,
    })
    await second.list()
    const results = await Promise.allSettled([
      first.beginUpload({ name: 'first.bin', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'first' }),
      second.beginUpload({ name: 'second.bin', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'second' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'DOCUMENT_UPLOAD_BUSY' })
  })

  it('reclaims an admission lock left by a stopped runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-orphan-lock-'))
    roots.push(root)
    await store(root)
    const lockPath = join(root, '.upload-sessions', 'v1', '.admission.lock')
    const exited = await promisify(execFile)(process.execPath, ['-p', 'process.pid'])
    await writeFile(lockPath, exited.stdout, { mode: 0o600 })

    const restarted = await store(root)
    await expect(restarted.list()).resolves.toEqual([])
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([String(process.pid), 'not-a-pid', '0', '9007199254740991'])(
    'preserves an admission lock whose owner cannot be proved dead: %s',
    async (owner) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-held-lock-'))
      roots.push(root)
      await store(root)
      const admission = join(root, '.upload-sessions', 'v1', '.admission')
      const lockPath = `${admission}.lock`
      await writeFile(lockPath, owner + '\n', { mode: 0o600 })
      const acquisition = Promise.withResolvers<undefined>()
      const proceed = Promise.withResolvers<undefined>()
      const withFileLock = atomicWrite.withFileLock
      vi.spyOn(atomicWrite, 'withFileLock').mockImplementation(async (filename, operation, options) => {
        if (filename === admission) {
          acquisition.resolve(undefined)
          await proceed.promise
        }
        return withFileLock(filename, operation, options)
      })
      const opening = store(root)
      try {
        await Promise.race([acquisition.promise, opening.then(() => {
          throw new Error('startup bypassed document admission')
        })])
        expect(await readFile(lockPath, 'utf8')).toBe(owner + '\n')
      } finally {
        await rm(lockPath, { force: true })
        proceed.resolve(undefined)
        await opening
      }
    },
  )

  it('rechecks a replacement owner when two startups observed the same orphan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-recovery-race-'))
    roots.push(root)
    await store(root)
    const admission = join(root, '.upload-sessions', 'v1', '.admission')
    const lockPath = `${admission}.lock`
    const exited = await promisify(execFile)(process.execPath, ['-p', 'process.pid'])
    await writeFile(lockPath, exited.stdout, { mode: 0o600 })
    const bothRecovering = Promise.withResolvers<undefined>()
    const firstAdmission = Promise.withResolvers<undefined>()
    const secondAdmission = Promise.withResolvers<undefined>()
    const releaseAdmission = Promise.withResolvers<undefined>()
    let recoveries = 0
    let admissions = 0
    let active = 0
    let maxActive = 0
    const withFileLock = atomicWrite.withFileLock
    vi.spyOn(atomicWrite, 'withFileLock').mockImplementation(async (filename, operation, options) => {
      if (filename === `${lockPath}.recovery`) {
        if (++recoveries === 1) await bothRecovering.promise
        else {
          bothRecovering.resolve(undefined)
          await firstAdmission.promise
        }
      }
      if (filename !== admission) return withFileLock(filename, operation, options)
      const ordinal = ++admissions
      if (ordinal === 2) secondAdmission.resolve(undefined)
      return withFileLock(filename, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          if (ordinal === 1) {
            firstAdmission.resolve(undefined)
            await releaseAdmission.promise
          }
          return await operation()
        } finally {
          active -= 1
        }
      }, options)
    })
    const opening = Promise.all([store(root), store(root)])
    try {
      await firstAdmission.promise
      const original = await stat(lockPath)
      await secondAdmission.promise
      const retained = await stat(lockPath)
      expect([retained.dev, retained.ino]).toEqual([original.dev, original.ino])
      expect(await readFile(lockPath, 'utf8')).toBe(String(process.pid) + '\n')
    } finally {
      bothRecovering.resolve(undefined)
      firstAdmission.resolve(undefined)
      releaseAdmission.resolve(undefined)
      await opening
    }
    expect(recoveries).toBe(2)
    expect(maxActive).toBe(1)
  })

  it('refuses oversized metadata while preserving its manifest and received bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-manifest-limit-'))
    roots.push(root)
    const service = await store(root, { uploadManifestMaxBytes: 1024 })
    const session = await service.beginUpload({
      name: 'manifest-limit.txt', directoryId: UserDocDirectoryId(''), bytes: 1, fingerprint: 'x'.repeat(512),
    })
    const directory = join(root, '.upload-sessions', 'v1', String(session.uploadId))
    await service.writeUploadChunk(session.uploadId, { index: 0, start: 0, end: 0, total: 1,
      sha256: digest(Uint8Array.of(65)), body: body(Uint8Array.of(65)) })
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.fingerprint = 'y'.repeat(512)
    manifest.padding = 'z'.repeat(2_000)
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)

    await expect(service.inspectUpload(session.uploadId)).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    await expect(store(root, { uploadManifestMaxBytes: 1024 })).rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest)
    expect(await readFile(join(directory, 'data.part'))).toEqual(Buffer.from('A'))
  })

  it('reports missing sessions as not found on complete and cancel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-userdoc-upload-missing-'))
    roots.push(root)
    const service = await store(root)
    const missing = '00000000-0000-0000-0000-000000000000' as never
    await expect(service.completeUpload(missing, 'a'.repeat(64)))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
    await expect(service.cancelUpload(missing))
      .rejects.toMatchObject({ code: DOCUMENT_UPLOAD_NOT_FOUND_CODE })
  })
})
