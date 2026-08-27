import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { DOCUMENT_TOO_LARGE_CODE, INVALID_DOCUMENT_REF_CODE, UserDocDirectoryId, UserDocId } from '@deepseek-ai/dsh-userdoc'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalUserDocStore, {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
  DEFAULT_MAX_INLINE_TEXT_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_DOCUMENT_DIR_NAME,
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
} from '../src/index.ts'

const roots: string[] = []

async function store(config: Record<string, unknown> = {}): Promise<LocalUserDocStore> {
  const uploadRoot = await mkdtemp(join(tmpdir(), 'dsh-userdoc-service-'))
  roots.push(uploadRoot)
  return new LocalUserDocStore(new Context(), { uploadRoot, ...config })
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local user-document service', () => {
  it('resolves every omitted limit explicitly', async () => {
    const service = await store()
    expect(service.limits).toEqual({
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      maxFilesPerMessage: DEFAULT_MAX_FILES_PER_MESSAGE,
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
      maxInlineTextBytes: DEFAULT_MAX_INLINE_TEXT_BYTES,
      upload: {
        protocol: 'resumable-v1',
        chunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES,
        sessionTtlMs: DEFAULT_UPLOAD_SESSION_TTL_MS,
        resumable: true,
      },
    })
  })

  it('roots uploads under the operating-system home when no root is configured', () => {
    const service = new LocalUserDocStore(new Context(), {})
    expect(service.root).toBe(join(homedir(), DEFAULT_DOCUMENT_DIR_NAME))
  })

  it('expands a tilde-prefixed configured root', () => {
    const service = new LocalUserDocStore(new Context(), { uploadRoot: '~/docs-under-test' })
    expect(service.root).toBe(join(homedir(), 'docs-under-test'))
  })

  it('does not create or migrate storage before the first operation', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-userdoc-lazy-'))
    roots.push(scratch)
    const uploadRoot = join(scratch, 'documents')
    const legacyUploadRoot = join(scratch, 'uploads')
    const service = new LocalUserDocStore(new Context(), { uploadRoot, legacyUploadRoot })

    await expect(lstat(uploadRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.list()).resolves.toEqual([])
    const created = await lstat(uploadRoot)
    expect(created.isDirectory()).toBe(true)
  })

  it('carries one document through save, stat, read, list, and remove', async () => {
    const service = await store()
    const target = await service.resolveTarget({ name: '年报.txt' })
    const ref = await service.save(target, stream('hello'))
    expect(ref.name).toBe('年报.txt')
    expect(ref.bytes).toBe(5)
    expect(ref.mediaType).toBe('text/plain')

    await expect(service.stat(ref.docId)).resolves.toMatchObject({ docId: ref.docId, bytes: 5 })
    const read = await service.read(ref.docId)
    expect(new TextDecoder().decode(read.data)).toBe('hello')
    await expect(service.list()).resolves.toHaveLength(1)

    await service.remove(ref.docId)
    await expect(service.list()).resolves.toEqual([])
  })

  it('returns bounded directory and trash pages with continuation cursors', async () => {
    const service = await store({ trashRetentionDays: 30 })
    const first = await service.resolveTarget({ name: 'a.txt' })
    await service.save(first, stream('a'))
    const second = await service.resolveTarget({ name: 'b.txt' })
    await service.save(second, stream('b'))
    const third = await service.resolveTarget({ name: 'c.txt' })
    await service.save(third, stream('c'))
    const page = await service.listDirectoryPage(UserDocDirectoryId(''), { limit: 2, sort: 'name-asc' })
    expect(page.documents).toHaveLength(2)
    expect(page.totalDocuments).toBe(3)
    expect(page.nextCursor).toBe('2')
    const next = await service.listDirectoryPage(UserDocDirectoryId(''), {
      limit: 2,
      sort: 'name-asc',
      ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
    })
    expect(next.documents).toHaveLength(1)
    await service.trash(first.docId)
    const trash = await service.listTrashPage({ limit: 1 })
    expect(trash.documents).toHaveLength(1)
    expect(trash.totalDocuments).toBe(1)
  })

  it('keeps a coalesced listing alive when only the first waiter aborts', async () => {
    const service = await store()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const listDirectory = vi.spyOn(service, 'listDirectory').mockImplementation(async (_directoryId, signal) => {
      await gate
      signal?.throwIfAborted()
      return { directoryId: UserDocDirectoryId(''), directories: [], documents: [] }
    })
    const firstAbort = new AbortController()
    const first = service.listDirectoryPage(UserDocDirectoryId(''), { limit: 20 }, firstAbort.signal)
    const second = service.listDirectoryPage(UserDocDirectoryId(''), { limit: 20 })
    await vi.waitFor(() => { expect(listDirectory).toHaveBeenCalledOnce() })
    firstAbort.abort(new Error('first browser closed'))
    await expect(first).rejects.toThrow('first browser closed')
    release()
    await expect(second).resolves.toMatchObject({ totalDocuments: 0, documents: [] })
    listDirectory.mockRestore()
  })

  it('streams a download without buffering and closes over the whole file', async () => {
    const service = await store()
    const target = await service.resolveTarget({ name: 'big.bin' })
    const ref = await service.save(target, stream('0123456789'))
    const opened = await service.openRead(ref.docId)
    expect(opened.ref.docId).toBe(ref.docId)
    const chunks: Uint8Array[] = []
    for await (const chunk of opened.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('0123456789')
  })

  it('refuses an identifier that escapes the upload root through the service face', async () => {
    const service = await store()
    const outside = join(service.root, '..', 'outside.txt')
    await writeFile(outside, 'secret')
    roots.push(outside)
    const outsideId = UserDocId('../outside.txt')
    await expect(service.stat(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.read(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.openRead(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
    await expect(service.remove(outsideId)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
  })

  it('cuts off a stream that exceeds the configured single-file limit', async () => {
    const service = await store({ maxFileBytes: 4 })
    const target = await service.resolveTarget({ name: 'over.txt' })
    await expect(service.save(target, stream('12345'))).rejects.toMatchObject({ code: DOCUMENT_TOO_LARGE_CODE })
    await expect(service.list()).resolves.toEqual([])
  })

  it('does not impose a default single-file limit', async () => {
    const service = await store()
    const target = await service.resolveTarget({ name: 'large.txt' })
    const ref = await service.save(target, stream('x'.repeat(96)))

    expect(service.limits.maxFileBytes).toBeNull()
    expect(ref.bytes).toBe(96)
  })

  it('resumes, verifies, and publishes a resumable upload without exposing session files', async () => {
    const service = await store({ maxFileBytes: null, uploadChunkBytes: 65536, uploadMinFreeBytes: 0 })
    const bytes = new TextEncoder().encode('hello')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const session = await service.beginUpload({
      name: 'resume.txt', directoryId: UserDocDirectoryId(''), bytes: bytes.byteLength, fingerprint: 'resume-test',
    })
    expect(session.receivedBytes).toBe(0)
    const chunk = await service.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, sha256: digest,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    })
    expect(chunk.receivedBytes).toBe(bytes.byteLength)
    const duplicate = await service.writeUploadChunk(session.uploadId, {
      index: 0, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, sha256: digest,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
    })
    expect(duplicate.receivedBytes).toBe(bytes.byteLength)
    expect((await service.completeUpload(session.uploadId, digest)).state).toBe('verifying')
    let completed = await service.inspectUpload(session.uploadId)
    for (let attempt = 0; completed.state === 'verifying' && attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
      completed = await service.inspectUpload(session.uploadId)
    }
    expect(completed.state).toBe('complete')
    expect(completed.ref).toMatchObject({ name: 'resume.txt', bytes: 5 })
    expect(await service.list()).toHaveLength(1)
  })
})
