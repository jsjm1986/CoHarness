/** Streaming HTTP consumer for user-uploaded documents. @module @deepseek-ai/dsh-host-userdoc-http */

import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-collaboration'
import type {} from '@deepseek-ai/dsh-gateway-runtime'
import {
  DOCUMENT_DIRECTORY_CONFLICT_CODE,
  DOCUMENT_DIRECTORY_NOT_EMPTY_CODE,
  DOCUMENT_DIRECTORY_NOT_FOUND_CODE,
  DOCUMENT_DIRECTORY_WRITE_FAILED_CODE,
  DOCUMENT_MIGRATION_FAILED_CODE,
  DOCUMENT_MOVE_FAILED_CODE,
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocDirectoryId,
  UserDocError,
  UserDocId,
  type UserDocErrorCode,
  type UserDocRef,
} from '@deepseek-ai/dsh-userdoc'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Prefix owned by the document HTTP consumer below Connection's trusted route. */
export const USERDOC_HTTP_PATH = '/api/documents'
/** Non-simple request header required before an upload body is accepted. */
export const USERDOC_UPLOAD_HEADER = 'x-dsh-document-upload'
/** Versioned cross-scope snapshot-copy endpoint below the document subtree. */
export const USERDOC_TRANSFER_PATH = `${USERDOC_HTTP_PATH}/transfer`
/** Alternate-scope listing endpoint used by the composer picker. */
export const USERDOC_TRANSFER_LIST_PATH = `${USERDOC_TRANSFER_PATH}/list`

export const name = 'host-userdoc-http'
export const inject = ['connection', 'userDocs']

type DocumentAction = 'read' | 'write'

/** Stable HTTP refusal for a project participant without the requested mode. */
class DocumentAuthorizationError extends Error {
  readonly code = 'COLLABORATION_FORBIDDEN'

  constructor(action: DocumentAction) {
    super(action === 'read'
      ? 'You do not have permission to read project documents.'
      : 'You do not have permission to modify project documents.')
    this.name = 'DocumentAuthorizationError'
  }
}

/** Stable failure when a project runtime cannot obtain its membership authority. */
class DocumentAuthorizationUnavailableError extends Error {
  readonly code = 'COLLABORATION_UNAVAILABLE'

  constructor() {
    super('Project document authorization is temporarily unavailable.')
    this.name = 'DocumentAuthorizationUnavailableError'
  }
}

/** Stable HTTP failure returned by the Gateway document broker. */
class DocumentTransferHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DocumentTransferHttpError'
  }
}

/** Enforce project document access without changing standalone/local mode. */
function authorizeDocumentAction(ctx: Context, action: DocumentAction): void {
  // Handler unit tests and lightweight local compositions may provide only the
  // document store; an actual Cordis Context always exposes `get`.
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return
  const runtime = get.call(ctx, 'gatewayRuntime') as Context['gatewayRuntime'] | undefined
  const collaboration = get.call(ctx, 'collaboration') as Context['collaboration'] | undefined
  if (runtime?.identity.kind === 'project' && collaboration === undefined) {
    throw new DocumentAuthorizationUnavailableError()
  }
  if (collaboration === undefined) return
  let authority: ReturnType<typeof collaboration.capture>
  try {
    authority = collaboration.capture()
  } catch (error) {
    if (error instanceof DocumentAuthorizationError || error instanceof DocumentAuthorizationUnavailableError) throw error
    throw new DocumentAuthorizationUnavailableError()
  }
  if (authority.participant.scope.kind !== 'project') return
  if (action === 'write' && authority.participant.scope.mode !== 'rw') {
    throw new DocumentAuthorizationError(action)
  }
}

interface ErrorBody { error: { code: string; message: string } }

const TRANSFER_BODY_LIMIT = 256 * 1024

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function errorStatus(code: UserDocErrorCode): number {
  if (code === DOCUMENT_NOT_FOUND_CODE) return 404
  if (code === DOCUMENT_DIRECTORY_NOT_FOUND_CODE) return 404
  if (code === DOCUMENT_TOO_LARGE_CODE) return 413
  if (code === DOCUMENT_TARGET_CONFLICT_CODE || code === DOCUMENT_NAME_EXHAUSTED_CODE
    || code === DOCUMENT_DIRECTORY_CONFLICT_CODE || code === DOCUMENT_DIRECTORY_NOT_EMPTY_CODE) return 409
  if (code === INVALID_DOCUMENT_NAME_CODE || code === INVALID_DOCUMENT_REF_CODE
    || code === INVALID_DOCUMENT_DIRECTORY_CODE) return 400
  if (code === DOCUMENT_DIRECTORY_WRITE_FAILED_CODE || code === DOCUMENT_MOVE_FAILED_CODE
    || code === DOCUMENT_MIGRATION_FAILED_CODE) return 500
  return 500
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof DocumentAuthorizationError) {
    json(res, 403, { error: { code: error.code, message: error.message } } satisfies ErrorBody)
    return
  }
  if (error instanceof DocumentAuthorizationUnavailableError) {
    json(res, 503, { error: { code: error.code, message: error.message } } satisfies ErrorBody)
    return
  }
  if (error instanceof DocumentTransferHttpError) {
    json(res, error.status, { error: { code: error.code, message: error.message } } satisfies ErrorBody)
    return
  }
  if (error instanceof UserDocError) {
    const code = error.code
    json(res, errorStatus(code), { error: { code, message: error.message } } satisfies ErrorBody)
    return
  }
  json(res, 500, { error: { code: 'INTERNAL', message: 'Document operation failed.' } } satisfies ErrorBody)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function transferScope(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.kind === 'personal') return { kind: 'personal' }
  if (candidate?.kind === 'project' && typeof candidate.projectId === 'number'
    && Number.isSafeInteger(candidate.projectId) && candidate.projectId > 0) {
    return { kind: 'project', projectId: candidate.projectId }
  }
  throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document transfer scope.')
}

function transferSummary(value: unknown): { kind: 'personal' | 'project'; label: string } {
  const candidate = object(value)
  if ((candidate?.kind !== 'personal' && candidate?.kind !== 'project')
    || typeof candidate.label !== 'string' || candidate.label === '' || candidate.label.length > 200) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid scope metadata.')
  }
  return { kind: candidate.kind, label: candidate.label }
}

function safeTransferDocId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\'))
}

function safeTransferResponse(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || typeof candidate.transferId !== 'string' || candidate.transferId === ''
    || candidate.transferId.length > 128
    || !Array.isArray(candidate.items) || candidate.items.length > 50) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned an invalid response.')
  }
  const source = transferSummary(candidate.source)
  const target = transferSummary(candidate.target)
  const items = candidate.items.map((entry) => {
    const item = object(entry)
    const sourceInfo = object(item?.source)
    if (item?.status === 'copied') {
      const targetInfo = object(item.target)
      if (sourceInfo === undefined || typeof sourceInfo.name !== 'string' || sourceInfo.name === '' || sourceInfo.name.length > 255
        || typeof sourceInfo.bytes !== 'number' || !Number.isSafeInteger(sourceInfo.bytes) || sourceInfo.bytes < 0
        || typeof sourceInfo.mediaType !== 'string' || sourceInfo.mediaType === ''
        || targetInfo === undefined || !safeTransferDocId(targetInfo.docId)
        || typeof targetInfo.name !== 'string' || targetInfo.name === '' || targetInfo.name.length > 255
        || typeof targetInfo.bytes !== 'number' || !Number.isSafeInteger(targetInfo.bytes) || targetInfo.bytes < 0
        || typeof targetInfo.mediaType !== 'string' || targetInfo.mediaType === ''
        || typeof targetInfo.modifiedAt !== 'number' || !Number.isFinite(targetInfo.modifiedAt)) {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid file metadata.')
      }
      return {
        status: 'copied',
        source: { name: sourceInfo.name, bytes: sourceInfo.bytes, mediaType: sourceInfo.mediaType },
        target: {
          docId: targetInfo.docId,
          name: targetInfo.name,
          bytes: targetInfo.bytes,
          mediaType: targetInfo.mediaType,
          modifiedAt: targetInfo.modifiedAt,
        },
      }
    }
    const error = object(item?.error)
    if (item?.status !== 'failed' || sourceInfo === undefined || typeof sourceInfo.name !== 'string'
      || sourceInfo.name === '' || sourceInfo.name.length > 255 || error === undefined || typeof error.code !== 'string'
      || typeof error.message !== 'string' || error.message.length > 240
      || /[\u0000-\u001f\u007f]|[/\\]/u.test(error.message)) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid file metadata.')
    }
    return { status: 'failed', source: { name: sourceInfo.name }, error: { code: error.code, message: error.message } }
  })
  return { version: 1, transferId: candidate.transferId, source, target, items }
}

function safeTransferCapabilities(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.targets) || candidate.targets.length > 50) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document capabilities are invalid.')
  }
  const targets = candidate.targets.map((entry) => {
    const item = object(entry)
    if (typeof item?.canRead !== 'boolean' || typeof item.canWrite !== 'boolean'
      || typeof item.label !== 'string' || item.label === '') {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document capabilities are invalid.')
    }
    let scopeValue: Record<string, unknown>
    try {
      scopeValue = transferScope(item.scope)
    } catch {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document capabilities are invalid.')
    }
    return { scope: scopeValue, label: item.label, canRead: item.canRead, canWrite: item.canWrite }
  })
  return { version: 1, current: transferSummary(candidate.current), targets }
}

function safeTransferList(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.documents) || candidate.documents.length > 50) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing is invalid.')
  }
  const documents = candidate.documents.map((entry) => {
    const item = object(entry)
    if (!safeTransferDocId(item?.docId) || typeof item.name !== 'string' || item.name === '' || item.name.length > 255
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || typeof item.mediaType !== 'string' || item.mediaType === ''
      || typeof item.modifiedAt !== 'number' || !Number.isFinite(item.modifiedAt)) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing contains invalid metadata.')
    }
    return {
      docId: item.docId,
      name: item.name,
      bytes: item.bytes,
      mediaType: item.mediaType,
      modifiedAt: item.modifiedAt,
    }
  })
  return { version: 1, scope: transferSummary(candidate.scope), documents }
}

async function readTransferPayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      bytes += value.byteLength
      if (bytes > TRANSFER_BODY_LIMIT) {
        throw new DocumentTransferHttpError(413, 'DOCUMENT_TRANSFER_TOO_LARGE', 'Document transfer request is too large.')
      }
      chunks.push(value)
    }
  } catch (error) {
    req.resume()
    throw error
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document transfer JSON.')
  }
  const value = object(decoded)
  if (value === undefined || value.version !== 1 || !Array.isArray(value.documents)
    || value.documents.length === 0 || value.documents.length > 50) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document transfer request.')
  }
  const documents = value.documents.map((candidate) => {
    const item = object(candidate)
    if (!safeTransferDocId(item?.docId)) {
      throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid source document id.')
    }
    return { docId: item.docId }
  })
  const directory = value.directory
  if (directory !== undefined && (typeof directory !== 'string' || directory.length > 4096
    || (directory !== '' && !directory.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\'))))) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid target document directory.')
  }
  return {
    version: 1,
    source: transferScope(value.source),
    target: transferScope(value.target),
    ...(directory === undefined ? {} : { directory }),
    documents,
  }
}

async function readTransferPayloadForScope(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      bytes += value.byteLength
      if (bytes > TRANSFER_BODY_LIMIT) {
        throw new DocumentTransferHttpError(413, 'DOCUMENT_TRANSFER_TOO_LARGE', 'Document scope listing request is too large.')
      }
      chunks.push(value)
    }
  } catch (error) {
    req.resume()
    throw error
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing JSON.')
  }
  const value = object(decoded)
  if (value === undefined || value.version !== 1) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing request.')
  }
  return { version: 1, scope: transferScope(value.scope) }
}

async function transferDocuments(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const runtime = typeof get === 'function'
    ? get.call(ctx, 'gatewayRuntime') as Context['gatewayRuntime'] | undefined
    : undefined
  if (runtime === undefined) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  const payload = await readTransferPayload(req)
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
      principal: true,
    })
  } catch (_error) {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned an invalid response.')
  }
  if (!response.ok) {
    const value = object(body)
    const code = typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED'
    const message = typeof value?.message === 'string' ? value.message : 'Document transfer failed.'
    throw new DocumentTransferHttpError(response.status, code, message)
  }
  if (!abort.signal.aborted) json(res, 200, safeTransferResponse(body))
}

async function transferCapabilities(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const runtime = typeof get === 'function'
    ? get.call(ctx, 'gatewayRuntime') as Context['gatewayRuntime'] | undefined
    : undefined
  if (runtime === undefined) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/transfer/capabilities', {
      method: 'GET',
      signal: abort.signal,
      principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned an invalid response.')
  }
  if (!response.ok) {
    const value = object(body)
    const code = typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED'
    const message = typeof value?.message === 'string' ? value.message : 'Document transfer failed.'
    throw new DocumentTransferHttpError(response.status, code, message)
  }
  if (!abort.signal.aborted) json(res, 200, safeTransferCapabilities(body))
}

async function transferList(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const runtime = typeof get === 'function'
    ? get.call(ctx, 'gatewayRuntime') as Context['gatewayRuntime'] | undefined
    : undefined
  if (runtime === undefined) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  const payload = await readTransferPayloadForScope(req)
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/transfer/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
      principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing is unavailable.')
  }
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing returned an invalid response.')
  }
  if (!response.ok) {
    const value = object(body)
    const code = typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED'
    const message = typeof value?.message === 'string' ? value.message : 'Document listing failed.'
    throw new DocumentTransferHttpError(response.status, code, message)
  }
  if (!abort.signal.aborted) json(res, 200, safeTransferList(body))
}

function query(req: IncomingMessage): URL {
  return new URL(req.url ?? USERDOC_HTTP_PATH, 'http://dsh.internal')
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value === '') {
    throw new UserDocError(`Missing ${name}.`, INVALID_DOCUMENT_REF_CODE)
  }
  return value
}

function directoryQuery(url: URL): ReturnType<typeof UserDocDirectoryId> {
  return UserDocDirectoryId(url.searchParams.get('directory') ?? '')
}

function requiredDirectoryQuery(url: URL, name: string): ReturnType<typeof UserDocDirectoryId> {
  return UserDocDirectoryId(requiredQuery(url, name))
}

function abortFor(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController()
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(new Error('HTTP client disconnected.')) }
  req.once('aborted', abort)
  res.once('close', () => { if (!res.writableEnded) abort() })
  return controller
}

function publicRef(ref: UserDocRef): UserDocRef {
  return { ...ref }
}

async function upload(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  if (req.headers[USERDOC_UPLOAD_HEADER] !== '1') {
    json(res, 400, { error: { code: 'UPLOAD_HEADER_REQUIRED', message: `${USERDOC_UPLOAD_HEADER}: 1 is required.` } } satisfies ErrorBody)
    return
  }
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      json(res, 400, { error: { code: 'INVALID_CONTENT_LENGTH', message: 'Content-Length must be a non-negative integer.' } } satisfies ErrorBody)
      return
    }
    if (ctx.userDocs.limits.maxFileBytes !== null && bytes > ctx.userDocs.limits.maxFileBytes) {
      req.resume()
      json(res, 413, { error: { code: DOCUMENT_TOO_LARGE_CODE, message: 'Document exceeds the configured byte limit.' } } satisfies ErrorBody)
      return
    }
  }
  const filename = url.searchParams.get('name')
  if (filename === null) {
    req.resume()
    json(res, 400, { error: { code: INVALID_DOCUMENT_NAME_CODE, message: 'Missing name.' } } satisfies ErrorBody)
    return
  }
  const abort = abortFor(req, res)
  try {
    // IncomingMessage is consumed directly; no Connection/body-envelope buffer exists on this path.
    const target = await ctx.userDocs.resolveTarget({ name: filename, directoryId: directoryQuery(url) })
    const body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    const ref = await ctx.userDocs.save(target, body, abort.signal)
    json(res, 201, publicRef(ref))
  } catch (error) {
    req.resume()
    if (!res.writableEnded && !abort.signal.aborted) failure(res, error)
  }
}

async function createFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const created = await ctx.userDocs.createDirectory(directoryQuery(url), requiredQuery(url, 'name'))
  json(res, 201, { ...created })
}

async function renameFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const renamed = await ctx.userDocs.renameDirectory(
    requiredDirectoryQuery(url, 'id'),
    requiredQuery(url, 'name'),
  )
  json(res, 200, { ...renamed })
}

async function deleteFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  await ctx.userDocs.removeDirectory(requiredDirectoryQuery(url, 'id'))
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

async function moveDocument(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const moved = await ctx.userDocs.move(UserDocId(requiredQuery(url, 'id')), directoryQuery(url))
  json(res, 200, { ...moved })
}

async function download(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'read')
  const docId = UserDocId(requiredQuery(url, 'id'))
  const opened = await ctx.userDocs.openRead(docId)
  const headers = {
    'content-type': opened.ref.mediaType,
    'content-length': String(opened.ref.bytes),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(opened.ref.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    await opened.body.cancel()
    res.end()
    return
  }
  try {
    for await (const chunk of opened.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')])
      if (res.destroyed) break
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (!res.destroyed) res.destroy(error as Error)
  }
}

/**
 * Handle the document subtree after Connection has admitted the request authority.
 * @param ctx - Host context containing Connection and the document store.
 * @param req - incoming HTTP request.
 * @param res - response that the route owns.
 */
export async function handleUserDocHttp(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = query(req)
  try {
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      const abort = abortFor(req, res)
      if (url.searchParams.has('directory')) {
        const listing = await ctx.userDocs.listDirectory(directoryQuery(url), abort.signal)
        if (!abort.signal.aborted) {
          json(res, 200, {
            limits: ctx.userDocs.limits,
            ...listing,
            documents: listing.documents.map(publicRef),
            directories: listing.directories.map(directory => ({ ...directory })),
          })
        }
      } else {
        const documents = await ctx.userDocs.list(abort.signal)
        if (!abort.signal.aborted) json(res, 200, { limits: ctx.userDocs.limits, documents: documents.map(publicRef) })
      }
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/directories` && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      const abort = abortFor(req, res)
      const directories = await ctx.userDocs.listDirectories(abort.signal)
      if (!abort.signal.aborted) json(res, 200, { directories: directories.map(directory => ({ ...directory })) })
      return
    }
    if (url.pathname === USERDOC_TRANSFER_PATH && req.method === 'POST') {
      await transferDocuments(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_LIST_PATH && req.method === 'POST') {
      await transferList(ctx, req, res)
      return
    }
    if (url.pathname === `${USERDOC_TRANSFER_PATH}/capabilities` && req.method === 'GET') {
      await transferCapabilities(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'POST') {
      await upload(ctx, req, res, url)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/content` && (req.method === 'GET' || req.method === 'HEAD')) {
      await download(ctx, req, res, url)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'DELETE') {
      authorizeDocumentAction(ctx, 'write')
      await ctx.userDocs.remove(UserDocId(requiredQuery(url, 'id')))
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/folders` && req.method === 'POST') {
      await createFolder(ctx, res, url)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/folders` && req.method === 'PATCH') {
      await renameFolder(ctx, res, url)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/folders` && req.method === 'DELETE') {
      await deleteFolder(ctx, res, url)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/move` && req.method === 'POST') {
      await moveDocument(ctx, res, url)
      return
    }
    res.writeHead(404)
    res.end('not found')
  } catch (error) {
    if (!res.writableEnded) failure(res, error)
  }
}

/** Register the streaming document subtree in the current Connection transport. */
export function apply(ctx: Context): void {
  ctx.connection.http.handlePrefix(
    USERDOC_HTTP_PATH,
    (req, res) => handleUserDocHttp(ctx, req, res),
    { authority: 'trusted-host' },
  )
}
