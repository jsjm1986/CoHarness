/** Real document files with deterministic short, stalled and interrupted filesystem writes. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { UserDocDirectoryId } from '@deepseek-ai/dsh-userdoc'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  mode: 'normal' as 'normal' | 'short' | 'zero' | 'fail' | 'abort',
  calls: 0,
  afterWrite: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const path = await import('node:path')
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      const name = typeof args[0] === 'string' ? path.basename(args[0]) : ''
      if (name !== 'data.part' && !/^\.userdoc-.+\.part$/u.test(name)) return handle
      const write = handle.write.bind(handle)
      let calls = 0
      Object.defineProperty(handle, 'write', {
        value: async (data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null) => {
          calls += 1
          io.calls += 1
          if (io.mode === 'zero') return { bytesWritten: 0, buffer: data }
          if (io.mode === 'fail' && calls > 1) throw Object.assign(new Error('Injected document write failure'), { code: 'EIO' })
          const written = await write(data, offset, io.mode === 'normal' ? length : Math.min(length, 2), position)
          if (io.mode === 'abort') io.afterWrite?.()
          return written
        },
      })
      return handle
    },
  }
})

const { default: LocalUserDocStore } = await import('../src/index.ts')
const roots: string[] = [], contexts: Context[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-short-write-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const store = new LocalUserDocStore(ctx, { uploadRoot: root, uploadChunkBytes: 65536, uploadMinFreeBytes: 0 })
  await store.list()
  return { root, store }
}

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    controller.close()
  } })
}

function chunk(text: string) {
  return { index: 0, start: 0, end: text.length - 1, total: text.length,
    sha256: createHash('sha256').update(text).digest('hex'), body: body(text) }
}

afterEach(async () => {
  io.mode = 'normal'; io.calls = 0; io.afterWrite = undefined
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('document write progress', () => {
  it('persists every byte of successive streamed chunks after partial writes', async () => {
    const { root, store } = await fixture()
    const target = await store.resolveTarget({ name: 'complete.txt' })
    io.mode = 'short'
    const ref = await store.save(target, body('abcdefgh', 'ijklmnop'))
    expect(await readFile(ref.path, 'utf8')).toBe('abcdefghijklmnop')
    expect(ref.bytes).toBe(16)
    expect(io.calls).toBeGreaterThan(2)
    expect((await readdir(root)).some(name => name.startsWith('.userdoc-'))).toBe(false)
  })

  it('acknowledges a resumable chunk only after all of its bytes are durable', async () => {
    const { root, store } = await fixture(), text = 'abcdefgh'
    const session = await store.beginUpload({ name: 'complete.txt', directoryId: UserDocDirectoryId(''),
      bytes: text.length, fingerprint: 'short' })
    io.mode = 'short'
    const received = await store.writeUploadChunk(session.uploadId, chunk(text))
    expect(received.receivedBytes).toBe(text.length)
    expect(await readFile(join(root, '.upload-sessions', 'v1', session.uploadId, 'data.part'), 'utf8')).toBe(text)
    expect(io.calls).toBeGreaterThan(1)
  })

  it.each(['zero', 'fail', 'abort'] as const)('removes an unpublished direct file after %s write progress', async (mode) => {
    const { root, store } = await fixture()
    const target = await store.resolveTarget({ name: 'stalled.txt' })
    const cancellation = new AbortController(), reason = new Error('Stream cancelled after a partial syscall')
    io.mode = mode
    io.afterWrite = () => { cancellation.abort(reason) }
    const saving = store.save(target, body('abcdefgh'), cancellation.signal)
    if (mode === 'abort') await expect(saving).rejects.toBe(reason)
    else await expect(saving).rejects.toMatchObject({ code: 'DOCUMENT_WRITE_FAILED' })
    expect(io.calls).toBe(mode === 'fail' ? 2 : 1)
    expect((await readdir(root)).filter(name => name.endsWith('.part') || name === target.name)).toEqual([])
  })

  it('publishes an empty streamed file without issuing an empty syscall', async () => {
    const { store } = await fixture()
    const target = await store.resolveTarget({ name: 'empty.txt' })
    io.mode = 'zero'
    const ref = await store.save(target, body(''))
    expect(ref.bytes).toBe(0)
    expect(await readFile(ref.path, 'utf8')).toBe('')
    expect(io.calls).toBe(0)
  })

  it.each(['zero', 'fail', 'abort'] as const)('retains unacknowledged bytes for a safe retry after %s write progress', async (mode) => {
    const { root, store } = await fixture(), text = 'abcdefgh'
    const session = await store.beginUpload({ name: 'retry.txt', directoryId: UserDocDirectoryId(''),
      bytes: text.length, fingerprint: mode })
    const cancellation = new AbortController(), reason = new Error('Upload cancelled after a partial syscall')
    io.mode = mode
    io.afterWrite = () => { cancellation.abort(reason) }
    const writing = store.writeUploadChunk(session.uploadId, chunk(text), cancellation.signal)
    if (mode === 'abort') await expect(writing).rejects.toBe(reason)
    else await expect(writing).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STORAGE' })
    expect((await store.inspectUpload(session.uploadId)).receivedBytes).toBe(0)
    io.mode = 'normal'
    io.afterWrite = undefined
    expect((await store.writeUploadChunk(session.uploadId, chunk(text))).receivedBytes).toBe(text.length)
    expect(await readFile(join(root, '.upload-sessions', 'v1', session.uploadId, 'data.part'), 'utf8')).toBe(text)
  })
})
