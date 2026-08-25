import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_PROTOCOL_CODE,
  DOCUMENT_WRITE_FAILED_CODE,
  UserDocDirectoryId,
  UserDocError,
  UserDocId,
  UserDocStore,
  type BeginUserDocUpload,
} from '../src/index.ts'
import type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadId,
  UserDocUploadSession,
} from '../src/index.ts'

const LIMITS: UserDocLimits = {
  maxFileBytes: 8,
  maxFilesPerMessage: 2,
  maxMessageBytes: 16,
  maxInlineTextBytes: 4,
  upload: { protocol: 'resumable-v1', chunkBytes: 65536, sessionTtlMs: 86400000, resumable: true },
}

function ref(docId: string): UserDocRef {
  return {
    docId: UserDocId(docId),
    path: `/root/${docId}`,
    name: docId,
    bytes: 3,
    mediaType: 'text/plain',
    modifiedAt: 1,
  }
}

/** Minimal in-memory implementation: proves the abstract surface is implementable as declared. */
class MemoryUserDocStore extends UserDocStore {
  readonly limits = LIMITS
  readonly saved = new Map<string, Uint8Array>()
  readonly directories = new Set<string>()

  async resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    return { path: `/root/${input.name}`, name: input.name, docId: UserDocId(input.name) }
  }

  async save(target: UserDocTarget, body: ReadableStream<Uint8Array>): Promise<UserDocRef> {
    const chunks: Uint8Array[] = []
    const reader = body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    this.saved.set(String(target.docId), Uint8Array.from(chunks.flatMap(chunk => [...chunk])))
    return { ...ref(target.name), docId: target.docId, path: target.path }
  }

  async list(): Promise<UserDocRef[]> {
    return [...this.saved.keys()].map(ref)
  }

  async listDirectory(directoryId: string): Promise<UserDocDirectoryListing> {
    const prefix = directoryId === '' ? '' : `${directoryId}/`
    return {
      directoryId: UserDocDirectoryId(directoryId),
      directories: [...this.directories]
        .filter(id => id.startsWith(prefix) && !id.slice(prefix.length).includes('/'))
        .map(id => this.directoryRef(id)),
      documents: [...this.saved.keys()]
        .filter(id => id.startsWith(prefix) && !id.slice(prefix.length).includes('/'))
        .map(ref),
    }
  }

  async listDirectories(): Promise<UserDocDirectoryRef[]> {
    return [...this.directories].map(id => this.directoryRef(id))
  }

  async createDirectory(parentDirectoryId: string, name: string): Promise<UserDocDirectoryRef> {
    const id = parentDirectoryId === '' ? name : `${parentDirectoryId}/${name}`
    this.directories.add(id)
    return this.directoryRef(id)
  }

  async renameDirectory(directoryId: string, name: string): Promise<UserDocDirectoryRef> {
    const parent = directoryId.split('/').slice(0, -1).join('/')
    const target = parent === '' ? name : `${parent}/${name}`
    this.directories.delete(directoryId)
    this.directories.add(target)
    return this.directoryRef(target)
  }

  async removeDirectory(directoryId: string): Promise<void> {
    this.directories.delete(directoryId)
  }

  async move(docId: string, directoryId: string): Promise<UserDocRef> {
    const data = this.saved.get(docId)
    if (data === undefined) throw new UserDocError('missing', DOCUMENT_NOT_FOUND_CODE)
    const name = docId.split('/').at(-1) as string
    const target = directoryId === '' ? name : `${directoryId}/${name}`
    this.saved.delete(docId)
    this.saved.set(target, data)
    return ref(target)
  }

  async stat(docId: string): Promise<UserDocRef> {
    if (!this.saved.has(docId)) throw new UserDocError('missing', DOCUMENT_NOT_FOUND_CODE)
    return ref(docId)
  }

  async read(docId: string): Promise<StoredUserDoc> {
    const data = this.saved.get(docId)
    if (data === undefined) throw new UserDocError('missing', DOCUMENT_NOT_FOUND_CODE)
    return { ref: ref(docId), data }
  }

  async openRead(docId: string): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    const { ref: reference, data } = await this.read(docId)
    return {
      ref: reference,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      }),
    }
  }

  async remove(docId: string): Promise<void> {
    this.saved.delete(docId)
  }

  async beginUpload(_input: BeginUserDocUpload): Promise<UserDocUploadSession> {
    throw new UserDocError('resumable uploads are unavailable in this test store', DOCUMENT_UPLOAD_PROTOCOL_CODE)
  }

  async inspectUpload(_uploadId: UserDocUploadId): Promise<UserDocUploadSession> {
    throw new UserDocError('resumable uploads are unavailable in this test store', DOCUMENT_UPLOAD_PROTOCOL_CODE)
  }

  async writeUploadChunk(_uploadId: UserDocUploadId, _chunk: UserDocUploadChunk): Promise<UserDocUploadSession> {
    throw new UserDocError('resumable uploads are unavailable in this test store', DOCUMENT_UPLOAD_PROTOCOL_CODE)
  }

  async completeUpload(_uploadId: UserDocUploadId, _sha256: string): Promise<UserDocUploadSession> {
    throw new UserDocError('resumable uploads are unavailable in this test store', DOCUMENT_UPLOAD_PROTOCOL_CODE)
  }

  async cancelUpload(_uploadId: UserDocUploadId): Promise<void> {
    throw new UserDocError('resumable uploads are unavailable in this test store', DOCUMENT_UPLOAD_PROTOCOL_CODE)
  }

  private directoryRef(directoryId: string): UserDocDirectoryRef {
    return {
      directoryId: UserDocDirectoryId(directoryId),
      path: `/root/${directoryId}`,
      name: directoryId.split('/').at(-1) ?? '',
      modifiedAt: 1,
    }
  }
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('user-document seam', () => {
  it('registers under ctx.userDocs so consumers inject one declared key', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryUserDocStore)
    expect(ctx.get('userDocs')).toBeInstanceOf(MemoryUserDocStore)
    expect(ctx.userDocs.limits).toBe(LIMITS)
  })

  it('carries a resolved target from resolveTarget into save', async () => {
    const store = new MemoryUserDocStore(new Context())
    const target = await store.resolveTarget({ name: '年报.pdf' })
    expect(target).toEqual({ path: '/root/年报.pdf', name: '年报.pdf', docId: '年报.pdf' })
    const saved = await store.save(target, streamOf('hello'))
    expect(saved.docId).toBe(target.docId)
    expect(saved.path).toBe(target.path)
  })

  it('reads back through the identifier, not through a caller-held path', async () => {
    const store = new MemoryUserDocStore(new Context())
    const target = await store.resolveTarget({ name: 'notes.txt' })
    await store.save(target, streamOf('abc'))
    await expect(store.read(String(target.docId))).resolves.toMatchObject({
      data: new TextEncoder().encode('abc'),
    })
    await expect(store.stat(String(target.docId))).resolves.toMatchObject({ docId: 'notes.txt' })
    await expect(store.list()).resolves.toHaveLength(1)
  })

  it('streams one document for a download response', async () => {
    const store = new MemoryUserDocStore(new Context())
    const target = await store.resolveTarget({ name: 'stream.txt' })
    await store.save(target, streamOf('xy'))
    const { body } = await store.openRead(String(target.docId))
    const reader = body.getReader()
    const first = await reader.read()
    expect(first.value).toEqual(new TextEncoder().encode('xy'))
  })

  it('tolerates a repeated delete', async () => {
    const store = new MemoryUserDocStore(new Context())
    const target = await store.resolveTarget({ name: 'gone.txt' })
    await store.save(target, streamOf('x'))
    await expect(store.remove(String(target.docId))).resolves.toBeUndefined()
    await expect(store.remove(String(target.docId))).resolves.toBeUndefined()
    await expect(store.stat(String(target.docId))).rejects.toMatchObject({ code: DOCUMENT_NOT_FOUND_CODE })
  })

  it('routes failures on a stable code rather than on the message', () => {
    const cause = new Error('disk full')
    const error = new UserDocError('Unable to store the uploaded document.', DOCUMENT_WRITE_FAILED_CODE, { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('UserDocError')
    expect(error.code).toBe(DOCUMENT_WRITE_FAILED_CODE)
    expect(error.cause).toBe(cause)
  })

  it('brands an identifier without changing its text', () => {
    expect(String(UserDocId('2026-08-14/年报.pdf'))).toBe('2026-08-14/年报.pdf')
  })
})
