import { createHash } from 'node:crypto'
import { link, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  DOCUMENT_UPLOAD_HASH_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  UserDocDirectoryId,
} from '@deepseek-ai/dsh-userdoc'
import { afterEach, describe, expect, it } from 'vitest'
import LocalUserDocStore from '../src/index.ts'

const roots: string[] = []

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

async function store(root: string, config: Record<string, unknown> = {}): Promise<LocalUserDocStore> {
  const value = new LocalUserDocStore(new Context(), {
    uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, ...config,
  })
  await value.list()
  return value
}

async function complete(storeValue: LocalUserDocStore, uploadId: string, sha256: string) {
  const started = await storeValue.completeUpload(uploadId as never, sha256)
  let current = started
  for (let attempt = 0; current.state === 'verifying' && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
    current = await storeValue.inspectUpload(uploadId as never)
  }
  return current
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('resumable local document uploads', () => {
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

  it('accepts the observed 100 MB-plus document through bounded chunks', async () => {
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
    const first = new LocalUserDocStore(new Context(), {
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
    const first = new LocalUserDocStore(new Context(), {
      uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0, uploadMaxConcurrent: 1,
    })
    await first.list()
    const second = new LocalUserDocStore(new Context(), {
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
})
