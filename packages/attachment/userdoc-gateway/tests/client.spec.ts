/** Admission, reentrant disposal and owned cancellation must settle independently of HTTP success. */
import { Context } from '@deepseek-ai/cordis'
import { ExecutionAuthority, type ExecutionScopeId } from '@deepseek-ai/dsh-execution-authority'
import { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocTrashId } from '@deepseek-ai/dsh-userdoc'
import type { UserDocLimits } from '@deepseek-ai/dsh-userdoc'
import { expect, it, vi } from 'vitest'
import { DocumentTransport } from '../src/client.ts'
import { documentFrame, DocumentStreamCleanupError, readDocumentFrame } from '../src/frame.ts'
import { GatewayUserDocStore } from '../src/index.ts'
import { documentRequestSchema, type DocumentStoreOperation } from '../src/protocol.ts'

const limits: UserDocLimits = { maxFileBytes: null, maxFilesPerMessage: 8, maxMessageBytes: 1024, maxInlineTextBytes: 1024,
  upload: { protocol: 'resumable-v1', chunkBytes: 1024, sessionTtlMs: 60_000, resumable: true } }
const success = { version: 1, kind: 'success', operation: 'describe', result: { root: '/documents', limits } }

function fixture(request: GatewayRuntime['request'], maxPendingRequests = 1) {
  const ctx = new Context()
  // Only the two injected service methods are replaced; stream ownership uses the real transport and Context effects.
  const gateway = Object.create(GatewayRuntime.prototype) as GatewayRuntime
  gateway.request = request
  gateway.interactive = () => undefined
  ctx.provide('gatewayRuntime', gateway)
  const authority = Object.create(ExecutionAuthority.prototype) as ExecutionAuthority
  authority.current = () => ({ parentSessionId: SessionId('captured-session'), scopeId: 'captured-scope' as ExecutionScopeId,
    inputs: [], unverifiedHistory: false, primaryActorUserId: 7 })
  ctx.provide('executionAuthority', authority)
  const transport = new DocumentTransport(ctx, { maxMetadataBytes: 4096, maxPendingRequests, requestTimeoutMs: 60_000 })
  return { ctx, transport }
}

it('carries exact file and trash selections through every managed mutation', async () => {
  const docId = UserDocId('a.txt'), incarnationId = UserDocIncarnationId('incarnation-a')
  const active = { docId, incarnationId, revision: 1 }, trash = { ...active, revision: 2, trashId: UserDocTrashId('trash-a') }
  const folder = { ...active, docId: UserDocId('folder/a.txt') }, operations: DocumentStoreOperation[] = []
  const ref = { docId, path: '/documents/a.txt', name: 'a.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 }
  const { ctx, transport } = fixture(async (_path, options) => {
    if (!(options?.body instanceof ReadableStream)) throw new Error('The provider did not send its framed request stream.')
    const opened = await readDocumentFrame(options.body, 4096)
    const request = documentRequestSchema.parse(opened.metadata)
    await new Response(opened.body).arrayBuffer()
    operations.push(request.operation)
    const kind = request.operation.kind
    const result = kind === 'trash' ? { docId, name: ref.name, bytes: ref.bytes, mediaType: ref.mediaType,
      modifiedAt: ref.modifiedAt, directoryId: '', trashedAt: 1, purgeAfter: 2, trashId: trash.trashId }
      : kind === 'restore' || kind === 'move' ? ref
        : kind === 'renameDirectory' ? { directoryId: 'renamed', path: '/documents/renamed', name: 'renamed', modifiedAt: 1 }
          : null
    return new Response(documentFrame({ version: 1, kind: 'success', operation: kind, result }, 4096))
  })
  transport.bindRoot('/documents', '/documents')
  const store = new GatewayUserDocStore(ctx, transport, { root: '/documents', limits })
  try {
    await store.trash(docId, undefined, active)
    await store.restore(docId, undefined, undefined, undefined, trash)
    await store.purge(docId, undefined, trash)
    await store.move(docId, UserDocDirectoryId('folder'), active)
    await store.renameDirectory(UserDocDirectoryId('folder'), 'renamed', [folder])
    await store.remove(docId, undefined, active)
    expect(operations.map(operation => operation.kind)).toEqual(['trash', 'restore', 'purge', 'move', 'renameDirectory', 'remove'])
    expect(operations.map(operation => 'expected' in operation ? operation.expected : undefined))
      .toEqual([active, trash, trash, active, [folder], active])
  } finally { await ctx.fiber.dispose() }
})

it('publishes one disposal promise before an abort listener reenters disposal', async () => {
  const entered = Promise.withResolvers<undefined>()
  let nested: Promise<void> | undefined
  const request = vi.fn<GatewayRuntime['request']>((_path, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      nested = transport.dispose()
      const reason: unknown = options.signal?.reason
      reject(reason instanceof Error ? reason : new Error('Fixture request aborted.'))
    }, { once: true })
    entered.resolve(undefined)
  }))
  const { ctx, transport } = fixture(request)
  const pending = transport.call({ kind: 'describe' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  try {
    await entered.promise
    const closing = transport.dispose()
    expect(nested).toBe(closing)
    expect(transport.dispose()).toBe(closing)
    await rejected; await closing
    await expect(transport.call({ kind: 'describe' })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
    expect(request).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it('retains its admission slot and awaits cancellation through a metadata response body', async () => {
  const reading = Promise.withResolvers<undefined>(), cancelling = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(undefined) },
    async cancel() { cancelling.resolve(undefined); await release.promise },
  })
  const request = vi.fn<GatewayRuntime['request']>(async () => new Response(documentFrame(success, 4096, body)))
  const { ctx, transport } = fixture(request)
  const pending = transport.call({ kind: 'describe' })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
  let stopped = false
  try {
    await reading.promise
    await expect(transport.call({ kind: 'describe' })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_BUSY' })
    const closing = transport.dispose().then(() => { stopped = true })
    await cancelling.promise
    expect(stopped).toBe(false)
    release.resolve(undefined); await rejected; await closing
    expect(body.locked).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  } finally { release.resolve(undefined); await ctx.fiber.dispose(); await rejected }
})

it('retains an invalid frame and its failed cancellation and refuses further admission', async () => {
  const cleanup = new Error('Owned response cleanup failure')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const prefix = new Uint8Array(4)
      new DataView(prefix.buffer).setUint32(0, 4097)
      controller.enqueue(prefix)
    },
    cancel() { throw cleanup },
  })
  const request = vi.fn<GatewayRuntime['request']>(async () => new Response(body))
  const { ctx, transport } = fixture(request)
  try {
    await expect(transport.call({ kind: 'describe' })).rejects.toBeInstanceOf(DocumentStreamCleanupError)
    expect(body.locked).toBe(false)
    await expect(transport.call({ kind: 'describe' })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
    await expect(transport.dispose()).rejects.toMatchObject({ errors: [cleanup] })
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    // The transport assertion above owns the deliberately failed cancellation; Context invokes that same disposer.
    await Promise.allSettled([ctx.fiber.dispose()])
  }
})

it('joins a rejected upload source and preserves its permission failure when cancellation fails', async () => {
  const cancelling = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const cleanup = new Error('Owned upload source cleanup failure')
  const input = new ReadableStream<Uint8Array>({ async cancel() { cancelling.resolve(undefined); await release.promise; throw cleanup } })
  const request = vi.fn<GatewayRuntime['request']>(async () => new Response(documentFrame({
    version: 1, kind: 'error', error: { code: 'DOCUMENT_PERMISSION_DENIED', message: 'Document access denied.' },
  }, 4096), { status: 403 }))
  const { ctx, transport } = fixture(request)
  const pending = transport.call({ kind: 'save', target: { docId: UserDocId('file.txt'), name: 'file.txt', path: '/documents/file.txt' } }, undefined, input)
  const rejected = expect(pending).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'DOCUMENT_PERMISSION_DENIED' }), cleanup] })
  let stopped = false, closeFailure: Promise<void> | undefined
  try {
    await cancelling.promise
    const closing = transport.dispose().finally(() => { stopped = true })
    closeFailure = expect(closing).rejects.toMatchObject({ errors: [cleanup] })
    expect(stopped).toBe(false)
    release.resolve(undefined); await rejected; await closeFailure
    expect(input.locked).toBe(false)
    expect(request.mock.calls[0]?.[1]?.principal).toBe(false)
  } finally {
    release.resolve(undefined); await rejected; await closeFailure
    await Promise.allSettled([ctx.fiber.dispose()])
  }
})
