/** Streaming server adapter; its Gateway owner supplies runtime authentication and live per-operation authorization. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE, DOCUMENT_TRANSPORT_PROTOCOL_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE, UserDocError, userDocErrorStatus, defaultUserDocDirectoryPage, defaultUserDocTrashPage,
  type UserDocStore, type UserDocUploadOwnerId,
} from '@deepseek-ai/dsh-userdoc'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { assertDocumentBodyEmpty, DocumentFrameError, documentFrame, readDocumentFrame } from './frame.ts'
import { documentRequestSchema, type DocumentStoreOperation, type DocumentStoreRequest, type DocumentStoreResult } from './protocol.ts'

type BackendMethod = Exclude<DocumentStoreOperation['kind'], 'describe' | 'listDirectoryPage' | 'listTrashPage'>

/** Context-free document implementation selected from the authenticated runtime, never from caller paths. */
export type GatewayDocumentBackend = Pick<UserDocStore, BackendMethod | 'limits'> & { readonly root: string }

/** Result of one physical operation before its owner commits catalog or delivery effects. */
export type DocumentStoreCompletion = {
  [K in DocumentStoreOperation['kind']]: Extract<DocumentStoreOperation, { kind: K }> & {
    readonly result: DocumentStoreResult<K>
    readonly body?: ReadableStream<Uint8Array>
  }
}[DocumentStoreOperation['kind']]

/** One request's backend and authenticated actor; a callback cannot borrow a subsequent request's authority. */
export interface DocumentStoreAccess {
  readonly store: GatewayDocumentBackend
  /** Request and live-authorization cancellation retained through response delivery. */
  readonly signal: AbortSignal
  /** Absent only for infrastructure descriptor requests. */
  readonly ownerId?: UserDocUploadOwnerId
  /**
   * Settle the operation's required catalog or durable delivery effects before acknowledging it.
   * @param completion - actual operation and result produced by the selected backend.
   * @returns after all effects owned by this request settle.
   */
  finish(completion: DocumentStoreCompletion): Promise<void>
}

/** Runtime-token validation and shutdown admission belong to the owner before this adapter reads a prefix. */
export interface GatewayDocumentServerOptions {
  readonly maxMetadataBytes: number
  readonly signal: AbortSignal
  /**
   * Authorize the parser-validated operation and keep its authority alive through response delivery.
   * @param request - bounded protocol request; identity fields alone grant no access.
   * @param signal - request and owner cancellation.
   * @param work - callback using only the authenticated runtime's backend.
   * @returns after the callback and its owned raw streams settle.
   */
  withStore<T>(request: DocumentStoreRequest, signal: AbortSignal, work: (access: DocumentStoreAccess) => Promise<T>): Promise<T>
}

/**
 * Classify the privilege required by every private operation.
 * @param operation - parser-validated closed store operation.
 * @returns read for metadata/content inspection, otherwise write, including upload-session inspection.
 */
export function documentOperationAccess(operation: DocumentStoreOperation): 'read' | 'write' {
  switch (operation.kind) {
    case 'describe': case 'list': case 'listDirectory': case 'listDirectoryPage': case 'listTrash': case 'listTrashPage':
    case 'listDirectories': case 'stat': case 'openRead': return 'read'
    case 'resolveTarget': case 'save': case 'beginUpload': case 'inspectUpload': case 'writeUploadChunk': case 'completeUpload':
    case 'cancelUpload': case 'trash': case 'restore': case 'purge': case 'createDirectory': case 'renameDirectory':
    case 'removeDirectory': case 'move': case 'remove': return 'write'
    default: return assertNever(operation)
  }
}

/** Cancelling the store's body reader must leave the HTTP response usable until its error is delivered. */
function incomingBody(request: IncomingMessage): { body: ReadableStream<Uint8Array>; finish(): Promise<void> } {
  const done = Promise.withResolvers<void>()
  let stop = (): void => {}, detach = (): void => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true
      const onData = (bytes: Buffer): void => {
        if (!active) return
        controller.enqueue(bytes)
        if ((controller.desiredSize ?? 0) <= 0) request.pause()
      }
      stop = (): void => {
        if (!active) return
        active = false; request.pause(); request.removeListener('data', onData)
      }
      const onEnd = (): void => {
        if (active) { stop(); controller.close() }
        done.resolve(); detach()
      }
      const onError = (error: Error): void => { if (active) { stop(); controller.error(error) } }
      const onClose = (): void => {
        if (active) { stop(); controller.error(new Error('Document request closed before its body ended.')) }
        done.resolve(); detach()
      }
      detach = (): void => {
        request.removeListener('data', onData); request.removeListener('end', onEnd)
        request.removeListener('error', onError); request.removeListener('close', onClose)
      }
      request.on('data', onData); request.once('end', onEnd); request.on('error', onError); request.once('close', onClose)
      request.pause()
      if (request.readableEnded) onEnd()
      else if (request.closed) onClose()
    },
    pull() { request.resume() },
    cancel() { stop() },
  })
  return { body, async finish() {
    stop()
    // An unfinished sender cannot retain the request after its response has settled.
    if (!request.readableEnded && !request.closed) { request.destroy(); await done.promise }
    detach()
  } }
}

function uploadOwner(operation: DocumentStoreOperation, access: DocumentStoreAccess): UserDocUploadOwnerId {
  const owner = access.ownerId
  if (owner === undefined) throw new UserDocError('Document upload authority is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
  if ('ownerId' in operation && operation.ownerId !== owner) {
    throw new UserDocError('Document upload session not found.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
  }
  return owner
}

async function dispatch(
  operation: DocumentStoreOperation, access: DocumentStoreAccess, body: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<DocumentStoreCompletion> {
  const store = access.store
  switch (operation.kind) {
    case 'describe': return { ...operation, result: { root: store.root, limits: store.limits } }
    case 'resolveTarget': return { ...operation, result: await store.resolveTarget(operation.input) }
    case 'save': return { ...operation, result: await store.save(operation.target, body, signal) }
    case 'beginUpload': return { ...operation, result: await store.beginUpload(operation.input, uploadOwner(operation, access)) }
    case 'inspectUpload': return { ...operation, result: await store.inspectUpload(operation.uploadId, signal, uploadOwner(operation, access)) }
    case 'writeUploadChunk': return { ...operation, result: await store.writeUploadChunk(operation.uploadId,
      { ...operation.chunk, body }, signal, uploadOwner(operation, access)) }
    case 'completeUpload': return { ...operation, result: await store.completeUpload(operation.uploadId, operation.sha256, signal, uploadOwner(operation, access)) }
    case 'cancelUpload': await store.cancelUpload(operation.uploadId, signal, uploadOwner(operation, access)); return { ...operation, result: null }
    case 'list': return { ...operation, result: await store.list(signal) }
    case 'listDirectory': return { ...operation, result: await store.listDirectory(operation.directoryId, signal) }
    case 'listDirectoryPage': return { ...operation, result: await defaultUserDocDirectoryPage(store, operation.directoryId, operation.query, signal) }
    case 'listTrash': return { ...operation, result: await store.listTrash(signal) }
    case 'listTrashPage': {
      const page = await defaultUserDocTrashPage(store, operation.query, signal)
      return { ...operation, result: { ...page, documents: [...page.documents] } }
    }
    case 'trash': return { ...operation, result: await store.trash(operation.docId, signal, operation.expected) }
    case 'restore': return { ...operation, result: await store.restore(operation.docId, operation.directoryId, operation.name, signal, operation.expected) }
    case 'purge': await store.purge(operation.docId, signal, operation.expected); return { ...operation, result: null }
    case 'listDirectories': return { ...operation, result: await store.listDirectories(signal) }
    case 'createDirectory': return { ...operation, result: await store.createDirectory(operation.parentDirectoryId, operation.name) }
    case 'renameDirectory': return { ...operation, result: await store.renameDirectory(operation.directoryId, operation.name, operation.expected) }
    case 'removeDirectory': await store.removeDirectory(operation.directoryId); return { ...operation, result: null }
    case 'move': return { ...operation, result: await store.move(operation.docId, operation.directoryId, operation.expected) }
    case 'stat': return { ...operation, result: await store.stat(operation.docId, signal) }
    case 'openRead': { const opened = await store.openRead(operation.docId); return { ...operation, result: opened.ref, body: opened.body } }
    case 'remove': await store.remove(operation.docId, signal, operation.expected); return { ...operation, result: null }
    default: return assertNever(operation)
  }
}

/**
 * Serve one already authenticated document-store request without buffering file bodies.
 * @param request - live Node request admitted by its runtime-token and shutdown owners.
 * @param response - live response retained through raw-body delivery and cleanup.
 * @param options - explicit metadata bound and operation authorization owner.
 * @returns after response delivery, request cancellation and acquired streams settle.
 */
export async function serveGatewayDocumentStore(
  request: IncomingMessage, response: ServerResponse, options: GatewayDocumentServerOptions,
): Promise<void> {
  const abort = new AbortController(), signal = AbortSignal.any([options.signal, abort.signal])
  const onAbort = (): void => { abort.abort(new Error('Document request disconnected.')) }
  const onClose = (): void => { if (!response.writableFinished) onAbort() }
  request.once('aborted', onAbort); response.once('close', onClose)
  if (request.destroyed && !request.complete) onAbort()
  const source = incomingBody(request)
  let discard: (() => Promise<void>) | undefined, failure: unknown, failed = false
  const send = async (metadata: unknown, status: number, body?: ReadableStream<Uint8Array>, responseSignal = signal): Promise<void> => {
    let framed: ReadableStream<Uint8Array>
    try { framed = documentFrame(metadata, options.maxMetadataBytes, body) } catch (error) {
      if (error instanceof DocumentFrameError) {
        throw new UserDocError('Document service metadata exceeds its configured byte limit.', DOCUMENT_STORE_UNAVAILABLE_CODE, { cause: error })
      }
      throw error
    }
    response.writeHead(status, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
    // Node and DOM declarations use different BYOB generics for the same runtime stream.
    await pipeline(Readable.fromWeb(framed as NodeReadableStream<Uint8Array>), response, { signal: responseSignal })
  }
  try {
    if (request.method !== 'POST') throw new DocumentFrameError('Document store requests require POST.')
    const opened = await readDocumentFrame(source.body, options.maxMetadataBytes, signal)
    discard = () => opened.discard()
    const parsed = documentRequestSchema.safeParse(opened.metadata)
    if (!parsed.success) throw new DocumentFrameError('Document request metadata is invalid.')
    const envelope = parsed.data
    if (envelope.authority.kind === 'runtime' && envelope.operation.kind !== 'describe') {
      throw new UserDocError('Document operations require verified user authority.', DOCUMENT_PERMISSION_DENIED_CODE)
    }
    await options.withStore(envelope, signal, async (access) => {
      const current = AbortSignal.any([signal, access.signal])
      current.throwIfAborted()
      if (envelope.operation.kind !== 'save' && envelope.operation.kind !== 'writeUploadChunk') {
        await assertDocumentBodyEmpty(opened.body, current)
      }
      const completed = await dispatch(envelope.operation, access, opened.body, current)
      const cancelResponse = async (): Promise<void> => {
        if (completed.body !== undefined && !completed.body.locked) await completed.body.cancel()
      }
      try {
        await access.finish(completed)
        current.throwIfAborted()
        await send({ version: 1, kind: 'success', operation: completed.kind, result: completed.result }, 200, completed.body, current)
      } catch (error) {
        try { await cancelResponse() } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Document response and source cleanup failed.')
        }
        throw error
      }
      await cancelResponse()
    })
  } catch (error) {
    failure = error; failed = true
    if (!response.headersSent && !response.destroyed && !signal.aborted) {
      const domain = error instanceof UserDocError ? error
        : error instanceof DocumentFrameError
          ? new UserDocError('Document service request is invalid.', DOCUMENT_TRANSPORT_PROTOCOL_CODE)
          : new UserDocError('Document service is unavailable.', DOCUMENT_STORE_UNAVAILABLE_CODE)
      response.setHeader('connection', 'close')
      await send({ version: 1, kind: 'error', error: { code: domain.code, message: domain.message } }, userDocErrorStatus(domain.code))
    } else if (!response.destroyed) response.destroy()
    if (!(error instanceof UserDocError) && !(error instanceof DocumentFrameError) && !signal.aborted) throw error
  } finally {
    const cleanup: unknown[] = []
    try {
      if (discard !== undefined) await discard()
      else if (!source.body.locked) await source.body.cancel()
    } catch (error) { cleanup.push(error) }
    try { await source.finish() } catch (error) { cleanup.push(error) }
    request.removeListener('aborted', onAbort); response.removeListener('close', onClose)
    if (cleanup.length > 0) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, 'Document operation and request cleanup failed.')
  }
}
