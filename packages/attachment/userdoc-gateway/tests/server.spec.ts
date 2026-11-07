/** Real HTTP parsing, raw-file streaming and backend failure cleanup share one request lifetime. */
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ExecutionAuthority, type ExecutionScopeId } from '@deepseek-ai/dsh-execution-authority'
import { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UserDocDirectoryId, UserDocError, UserDocId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { LocalUserDocFs } from '@deepseek-ai/dsh-userdoc-local'
import { DocumentIdentityStore } from '../../userdoc-local/src/identity.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { documentFrame, readDocumentFrame } from '../src/frame.ts'
import type { DocumentStoreRequest } from '../src/protocol.ts'
import { documentOperationAccess, serveGatewayDocumentStore, type DocumentStoreAccess } from '../src/server.ts'
import { apply } from '../src/index.ts'

const fixtures = new Set<() => Promise<void>>()
afterEach(async () => {
  const results = await Promise.allSettled([...fixtures].map(close => close()))
  const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'Document server fixture cleanup failed.')
})

async function fixture(configure?: (access: DocumentStoreAccess, request: DocumentStoreRequest) => DocumentStoreAccess, identity = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-wire-')), lifetime = new AbortController()
  const documents = join(root, 'documents')
  await mkdir(documents)
  if (identity) await mkdir(join(root, 'objects'), { mode: 0o700 })
  const engine = new LocalUserDocFs({ root: documents,
    ...identity ? { controlRoot: join(root, 'objects'), identityLocations: { root: documents, stateRoot: join(root, 'identity'), filesRoot: join(root, 'objects') },
      identityActor: () => UserDocUploadOwnerId('user:7') } : {},
    limits: { maxFileBytes: null, maxFilesPerMessage: 8, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
      upload: { protocol: 'resumable-v1', chunkBytes: 4096, sessionTtlMs: 60_000, resumable: true } },
    upload: { chunkBytes: 4096, sessionTtlMs: 60_000, minFreeBytes: 0, maxConcurrent: 8,
      cleanupIntervalMs: 60_000, manifestMaxBytes: 64 * 1024 },
    sweepIntervalMs: 60_000, trashRetentionMs: 60_000,
  })
  const failures: unknown[] = [], work = new Set<Promise<void>>(), completed: string[] = []
  const server = createServer((request, response) => {
    const pending = serveGatewayDocumentStore(request, response, { maxMetadataBytes: 4096, signal: lifetime.signal,
      async withStore(envelope, signal, operation) {
        const access: DocumentStoreAccess = { store: engine, signal, ownerId: UserDocUploadOwnerId('user:7'),
          async finish(value) { completed.push(value.kind) } }
        return operation(configure?.(access, envelope) ?? access)
      },
    })
    work.add(pending)
    void pending.then(() => { work.delete(pending) }, (error: unknown) => { failures.push(error); work.delete(pending) })
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    lifetime.abort()
    const errors: unknown[] = []
    const stopped = server.listening
      ? new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      : Promise.resolve()
    server.closeAllConnections()
    try {
      try { await stopped } catch (error) { errors.push(error) }
      await Promise.allSettled([...work])
      try { await engine.dispose() } catch (error) { errors.push(error) }
      try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(errors, 'Document server fixture cleanup failed.')
    } finally { fixtures.delete(close) }
  })
  fixtures.add(close)
  try {
    engine.attach(); await engine.warm()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture did not acquire a TCP address.')
    const url = `http://127.0.0.1:${address.port}/internal/runtime/documents/store`
    return { engine, failures, completed, url,
      async settle() { await Promise.allSettled([...work]) },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

function requestBody(operation: DocumentStoreRequest['operation'], body?: ReadableStream<Uint8Array>) {
  return documentFrame({ version: 1, authority: { kind: 'request' }, operation }, 4096, body)
}
function post(url: string, body: ReadableStream<Uint8Array>) {
  return fetch(url, { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

it('returns a recoverable conflict when the directory inventory changes after admission', async () => {
  const server = await fixture(undefined, true)
  const directory = await server.engine.createDirectory(UserDocDirectoryId(''), 'folder')
  const target = await server.engine.resolveTarget({ name: 'selected.txt', directoryId: directory.directoryId })
  const saved = await server.engine.save(target, new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('selected bytes')); controller.close()
  } }))
  // oxlint-disable-next-line typescript/unbound-method -- the original method is explicitly rebound to each fixture receiver below.
  const retain = DocumentIdentityStore.prototype.retain
  const spy = vi.spyOn(DocumentIdentityStore.prototype, 'retain').mockImplementation(function (this: DocumentIdentityStore, pending) {
    const result = retain.call(this, pending)
    writeFileSync(join(directory.path, 'concurrent.txt'), 'concurrent bytes')
    return result
  })
  try {
    const response = await post(server.url, requestBody({ kind: 'renameDirectory', directoryId: directory.directoryId, name: 'renamed' }))
    expect(response.status).toBe(409)
    const result = await readDocumentFrame(response.body!, 4096)
    expect(result.metadata).toMatchObject({ error: { code: 'DOCUMENT_TARGET_CONFLICT' } })
    await result.body.cancel()
  } finally { spy.mockRestore() }
  expect(await readFile(saved.path, 'utf8')).toBe('selected bytes')
  expect(await readFile(join(directory.path, 'concurrent.txt'), 'utf8')).toBe('concurrent bytes')
  expect((await server.engine.list()).map(ref => ref.name).sort()).toEqual(['concurrent.txt', 'selected.txt'])
})

it('runs the managed provider through real HTTP storage, pagination, upload ownership and lifecycle operations', async () => {
  const server = await fixture(), ctx = new Context(), owner = UserDocUploadOwnerId('user:7')
  const runtime = Object.create(GatewayRuntime.prototype) as GatewayRuntime
  runtime.interactive = () => undefined
  runtime.request = async (_path, options) => {
    if (!(options?.body instanceof ReadableStream)) throw new Error('The managed provider must stream its request frame.')
    return fetch(server.url, { method: 'POST', body: options.body, signal: options.signal, duplex: 'half' } as RequestInit & { duplex: 'half' })
  }
  ctx.provide('gatewayRuntime', runtime)
  const authority = Object.create(ExecutionAuthority.prototype) as ExecutionAuthority
  authority.current = () => ({ parentSessionId: SessionId('wire-session'), scopeId: 'wire-scope' as ExecutionScopeId,
    inputs: [], unverifiedHistory: false, primaryActorUserId: 7 })
  ctx.provide('executionAuthority', authority)
  const source = (text: string) => new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text)); controller.close()
  } })
  try {
    await apply(ctx, { documentRoot: server.engine.root, maxMetadataBytes: 4096, maxPendingRequests: 8, requestTimeoutMs: 60000 })
    const store = ctx.get('userDocs')!
    const directory = await store.createDirectory(UserDocDirectoryId(''), 'folder')
    const target = await store.resolveTarget({ name: 'wire.txt', directoryId: directory.directoryId })
    const saved = await store.save(target, source('wire content'))
    expect(await store.stat(saved.docId)).toEqual(saved)
    expect((await store.read(saved.docId)).data).toEqual(new TextEncoder().encode('wire content'))
    const opened = await store.openRead(saved.docId)
    expect(await new Response(opened.body).text()).toBe('wire content')
    expect((await store.listDirectory(directory.directoryId)).documents).toEqual([saved])
    expect((await store.listDirectoryPage(directory.directoryId)).documents).toEqual([saved])
    expect((await store.listDirectoryPage(directory.directoryId, { limit: 1 })).documents).toEqual([saved])
    expect((await store.listDirectories()).map(item => ({ directoryId: item.directoryId, path: item.path, name: item.name })))
      .toEqual([{ directoryId: directory.directoryId, path: directory.path, name: directory.name }])
    expect(await store.list()).toEqual([saved])
    const moved = await store.move(saved.docId, UserDocDirectoryId(''))
    await store.renameDirectory(directory.directoryId, 'renamed')
    const renamed = (await store.listDirectories())[0]!
    await store.removeDirectory(renamed.directoryId)
    const trashed = await store.trash(moved.docId)
    expect(await store.listTrash()).toEqual([trashed])
    expect((await store.listTrashPage()).documents).toEqual([trashed])
    expect((await store.listTrashPage({ limit: 1 })).documents).toEqual([trashed])
    const restored = await store.restore(trashed.docId, UserDocDirectoryId(''), 'restored.txt')
    const again = await store.trash(restored.docId)
    await store.purge(again.docId)
    expect(await store.listTrash()).toEqual([])
    const removable = await store.save(await store.resolveTarget({ name: 'remove.txt' }), source('remove'))
    await store.remove(removable.docId)
    expect(await store.list()).toEqual([])
    const input = { name: 'upload.txt', directoryId: UserDocDirectoryId(''), bytes: 4, fingerprint: 'wire-owned-upload' }
    const upload = await store.beginUpload(input, owner)
    expect((await store.inspectUpload(upload.uploadId, undefined, owner)).state).toBe('uploading')
    await expect(store.inspectUpload(upload.uploadId, undefined, UserDocUploadOwnerId('user:8')))
      .rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
    const sha256 = createHash('sha256').update('DATA').digest('hex')
    await store.writeUploadChunk(upload.uploadId, { index: 0, start: 0, end: 3, total: 4, sha256, body: source('DATA') }, undefined, owner)
    await store.completeUpload(upload.uploadId, sha256, undefined, owner)
    await vi.waitFor(async () => { expect((await store.inspectUpload(upload.uploadId)).state).toBe('complete') }, { timeout: 10000 })
    const cancelled = await store.beginUpload({ ...input, name: 'cancel.txt', fingerprint: 'cancel-upload' })
    await store.cancelUpload(cancelled.uploadId)
    const cancelledWithOwner = await store.beginUpload({ ...input, name: 'cancel-owner.txt', fingerprint: 'cancel-owned-upload' }, owner)
    await store.cancelUpload(cancelledWithOwner.uploadId, undefined, owner)
    expect(documentOperationAccess({ kind: 'openRead', docId: saved.docId })).toBe('read')
    expect(documentOperationAccess({ kind: 'completeUpload', uploadId: upload.uploadId, sha256 })).toBe('write')
    await server.settle()
    expect(server.failures).toEqual([])
  } finally { await ctx.fiber.dispose(); await server.close() }
})

it('streams a real file larger than the metadata budget and preserves its absolute path', async () => {
  const server = await fixture()
  try {
    const target = await server.engine.resolveTarget({ name: 'large.bin', directoryId: UserDocDirectoryId('') })
    const bytes = new Uint8Array(256 * 1024).fill(173)
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    const saved = await post(server.url, requestBody({ kind: 'save', target }, source))
    const publication = await readDocumentFrame(saved.body!, 4096)
    expect(saved.status).toBe(200)
    expect(publication.metadata).toMatchObject({ result: { docId: target.docId, path: target.path, bytes: bytes.length } })
    expect(await new Response(publication.body).text()).toBe('')
    const read = await post(server.url, requestBody({ kind: 'openRead', docId: target.docId }))
    const content = await readDocumentFrame(read.body!, 4096)
    expect(read.status).toBe(200)
    expect(new Uint8Array(await new Response(content.body).arrayBuffer())).toEqual(bytes)
    await server.settle()
    expect(server.completed).toEqual(['save', 'openRead'])
    expect(server.failures).toEqual([])
  } finally { await server.close() }
})

it('refuses trailing bytes for a metadata-only mutation before invoking its backend', async () => {
  const server = await fixture()
  try {
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } })
    const response = await post(server.url, requestBody({
      kind: 'createDirectory', parentDirectoryId: UserDocDirectoryId(''), name: 'refused',
    }, source))
    const opened = await readDocumentFrame(response.body!, 4096)
    expect(response.status).toBe(400)
    expect(opened.metadata).toMatchObject({ kind: 'error', error: { code: 'DOCUMENT_TRANSPORT_PROTOCOL' } })
    await opened.discard(); await server.settle()
    expect(await server.engine.listDirectories()).toEqual([])
    expect(server.completed).toEqual([])
    expect(server.failures).toEqual([])
  } finally { await server.close() }
})

it('sends a permission refusal before a raw upload source reaches EOF', async () => {
  const server = await fixture(() => { throw new UserDocError('Document access denied.', 'DOCUMENT_PERMISSION_DENIED') })
  const client = httpRequest(server.url, { method: 'POST' }), received = Promise.withResolvers<IncomingMessage>()
  client.once('response', received.resolve); client.once('error', received.reject)
  try {
    const prefix = await new Response(requestBody({ kind: 'save', target: {
      docId: UserDocId('refused.txt'), name: 'refused.txt', path: join(server.engine.root, 'refused.txt'),
    } })).arrayBuffer()
    client.write(new Uint8Array(prefix))
    const response = await received.promise, chunks: Buffer[] = []
    for await (const chunk of response) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Fixture response must contain byte buffers.')
      chunks.push(chunk)
    }
    const opened = await readDocumentFrame(new Response(new Uint8Array(Buffer.concat(chunks))).body!, 4096)
    expect(response.statusCode).toBe(403)
    expect(opened.metadata).toMatchObject({ kind: 'error', error: { code: 'DOCUMENT_PERMISSION_DENIED' } })
    await opened.discard(); client.destroy(); await server.settle()
    expect(await server.engine.list()).toEqual([])
    expect(server.completed).toEqual([])
    expect(server.failures).toEqual([])
  } finally { client.destroy(); await server.close() }
})

it('retains both the backend completion failure and a failed response-source cancellation', async () => {
  const failure = new Error('Owned catalog completion failure'), cleanup = new Error('Owned document read cancellation failure')
  const server = await fixture(access => ({ ...access, async finish() { throw failure } }))
  server.engine.openRead = async () => ({ ref: { docId: UserDocId('file.txt'), path: join(server.engine.root, 'file.txt'), name: 'file.txt',
    bytes: 1, mediaType: 'text/plain', modifiedAt: 0 }, body: new ReadableStream<Uint8Array>({ cancel() { throw cleanup } }) })
  try {
    const response = await post(server.url, requestBody({ kind: 'openRead', docId: UserDocId('file.txt') }))
    const opened = await readDocumentFrame(response.body!, 4096)
    expect(response.status).toBe(503)
    expect(opened.metadata).toMatchObject({ kind: 'error', error: { code: 'DOCUMENT_STORE_UNAVAILABLE' } })
    await opened.discard(); await server.settle()
    expect(server.failures).toMatchObject([{ errors: [failure, cleanup] }])
  } finally { await server.close() }
})
