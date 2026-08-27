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
  DOCUMENT_UPLOAD_BUSY_CODE,
  DOCUMENT_UPLOAD_EXPIRED_CODE,
  DOCUMENT_UPLOAD_HASH_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_PROTOCOL_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  DOCUMENT_UPLOAD_SIZE_CODE,
  DOCUMENT_UPLOAD_STATE_CODE,
  DOCUMENT_UPLOAD_STORAGE_CODE,
  DOCUMENT_LIST_QUERY_CODE,
  DOCUMENT_RESTORE_CONFLICT_CODE,
  DOCUMENT_TRASH_NOT_FOUND_CODE,
  DOCUMENT_TRASHED_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocDirectoryId,
  UserDocError,
  UserDocId,
  type BeginUserDocUpload,
  type UserDocUploadChunk,
  type UserDocUploadIdType,
  type UserDocUploadSession,
  type UserDocErrorCode,
  type UserDocRef,
  type UserDocDirectoryRef,
  type UserDocTrashRef,
  type UserDocTrashPage,
  type UserDocDirectoryListing,
  type UserDocDirectoryPage,
  type UserDocListSort,
  type UserDocListType,
  type UserDocListQuery,
  type UserDocStore,
} from '@deepseek-ai/dsh-userdoc'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Prefix owned by the document HTTP consumer below Connection's trusted route. */
export const USERDOC_HTTP_PATH = '/api/documents'
/** Versioned cross-scope snapshot-copy endpoint below the document subtree. */
export const USERDOC_TRANSFER_PATH = `${USERDOC_HTTP_PATH}/transfer`
/** Metadata-only transfer planning endpoint. */
export const USERDOC_TRANSFER_PLAN_PATH = `${USERDOC_TRANSFER_PATH}/plan`
/** Permission-rechecking transfer commit endpoint. */
export const USERDOC_TRANSFER_COMMIT_PATH = `${USERDOC_TRANSFER_PATH}/commit`
/** Independent retry endpoint for failed transfer items. */
export const USERDOC_TRANSFER_RETRY_PATH = `${USERDOC_TRANSFER_PATH}/retry`
/** Alternate-scope listing endpoint used by the composer picker. */
export const USERDOC_TRANSFER_LIST_PATH = `${USERDOC_TRANSFER_PATH}/list`
/** Target-folder metadata endpoint for snapshot copies. */
export const USERDOC_TRANSFER_DIRECTORIES_PATH = `${USERDOC_TRANSFER_PATH}/directories`
/** Target-folder creation endpoint for snapshot copies. */
export const USERDOC_TRANSFER_DIRECTORY_CREATE_PATH = `${USERDOC_TRANSFER_PATH}/directories/create`
/** Metadata-only organization overview; file bytes never cross this route. */
export const USERDOC_CATALOG_OVERVIEW_PATH = `${USERDOC_HTTP_PATH}/overview`
/** Current-scope audited metadata history endpoint. */
export const USERDOC_CATALOG_HISTORY_PATH = `${USERDOC_HTTP_PATH}/history`
/** Resumable upload-session creation route. */
export const USERDOC_UPLOADS_PATH = `${USERDOC_HTTP_PATH}/uploads`
/** Recoverable document-trash listing and mutation route. */
export const USERDOC_TRASH_PATH = `${USERDOC_HTTP_PATH}/trash`
/** Restore one document from provider trash. */
export const USERDOC_RESTORE_PATH = `${USERDOC_HTTP_PATH}/restore`
/** Permanently purge one document from provider trash. */
export const USERDOC_PURGE_PATH = `${USERDOC_HTTP_PATH}/purge`

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

/** Catalog authorization failure returned by the Gateway for project mutations. */
class DocumentCatalogAuthorizationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DocumentCatalogAuthorizationError'
  }
}

/** Enforce project document access without changing standalone/local mode. */
function authorizeDocumentAction(ctx: Context, action: DocumentAction, allowDocumentAdmin = false): void {
  if (isDocumentAdminRequest(ctx)) {
    if (allowDocumentAdmin) return
    throw new DocumentAuthorizationError(action)
  }
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

function runtimeForCatalog(ctx: Context): Context['gatewayRuntime'] | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  return typeof get === 'function' ? get.call(ctx, 'gatewayRuntime') as Context['gatewayRuntime'] | undefined : undefined
}

function isDocumentAdminRequest(ctx: Context): boolean {
  const runtime = runtimeForCatalog(ctx)
  // Lightweight Host compositions may expose only the runtime identity (for
  // example while a request handler is unit-tested).  A production
  // `GatewayRuntime` always provides `current`, but the optional check keeps
  // the document ACL independent from that implementation detail.
  const current = runtime === undefined
    ? undefined
    : (runtime as unknown as { current?: () => { claims?: { user?: { role?: string }; purpose?: string } } | undefined }).current
  const principal = typeof current === 'function' ? current.call(runtime) : undefined
  const claims = principal?.claims
  return claims?.user?.role === 'admin' && claims.purpose === 'document-admin'
}

async function syncCatalog(
  ctx: Context,
  documents: readonly UserDocRef[],
  replace: boolean,
  source: 'upload' | 'transfer' | 'legacy' | 'admin' = 'legacy',
  removed: readonly string[] = [],
): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) return
  try {
    await runtime.request('/internal/runtime/documents/catalog/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        replace,
        source,
        documents: documents.map(document => ({
          docId: document.docId,
          name: document.name,
          bytes: document.bytes,
          mediaType: document.mediaType,
          modifiedAt: document.modifiedAt,
          directoryId: String(document.docId).split('/').slice(0, -1).join('/'),
        })),
        ...(removed.length === 0 ? {} : { removed }),
      }),
      principal: true,
    })
  } catch {
    // Runtime writes remain available during a temporary catalog outage; the
    // next full listing reconciles metadata before an ownership decision.
  }
}

const catalogQueues = new WeakMap<object, Promise<void>>()

function queueCatalogSync(
  ctx: Context,
  documents: readonly UserDocRef[],
  replace: boolean,
  source: 'upload' | 'transfer' | 'legacy' | 'admin' = 'legacy',
  removed: readonly string[] = [],
): void {
  const previous = catalogQueues.get(ctx) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => syncCatalog(ctx, documents, replace, source, removed))
    .catch(() => {})
    .finally(() => {
      if (catalogQueues.get(ctx) === next) catalogQueues.delete(ctx)
    })
  catalogQueues.set(ctx, next)
}

/** Reconcile one mutation target before the ownership check can observe a cold catalog. */
async function reconcileCatalogTarget(ctx: Context, docId: UserDocId): Promise<void> {
  try {
    const ref = await ctx.userDocs.stat(docId)
    await syncCatalog(ctx, [ref], false, 'legacy')
  } catch {
    // The following authorization call reports the authoritative retryable error.
  }
}

async function authorizeCatalogMutation(ctx: Context, action: 'delete' | 'move' | 'ownership' | 'restore' | 'purge', docIds: readonly string[]): Promise<void> {
  if (isDocumentAdminRequest(ctx)) return
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) return
  if (runtime.identity.kind !== 'project') return
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/catalog/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, action, docIds }),
      principal: true,
    })
  } catch {
    throw new DocumentCatalogAuthorizationError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document ownership could not be verified.')
  }
  if (response.ok) return
  let body: unknown
  try { body = await responseJson(response) } catch { body = undefined }
  const value = object(body)
  const code = typeof value?.error === 'string' ? value.error : 'DOCUMENT_CATALOG_UNAVAILABLE'
  const message = typeof value?.message === 'string' ? value.message : 'Document ownership could not be verified.'
  throw new DocumentCatalogAuthorizationError(response.status, code, message)
}

/** Authorize a trash request while preserving idempotence for an existing entry. */
async function authorizeTrashRequest(ctx: Context, docId: UserDocId): Promise<UserDocTrashRef | undefined> {
  try {
    await authorizeCatalogMutation(ctx, 'delete', [docId])
    return undefined
  } catch (error) {
    if (!(error instanceof DocumentCatalogAuthorizationError)) throw error
    let existing: UserDocTrashRef | undefined
    try {
      existing = (await ctx.userDocs.listTrash()).find(item => item.docId === docId)
    } catch {
      throw error
    }
    if (existing === undefined) throw error
    // A trash-state ownership check is the safe idempotent equivalent of the
    // active-state delete check; it still rejects another user's entry.
    await authorizeCatalogMutation(ctx, 'restore', [docId])
    return existing
  }
}

interface ErrorBody { error: { code: string; message: string } }

const TRANSFER_BODY_LIMIT = 256 * 1024
const UPLOAD_METADATA_BODY_LIMIT = 64 * 1024
/** Maximum JSON retained from one runtime metadata response before validation. */
const RUNTIME_JSON_RESPONSE_LIMIT = 8 * 1024 * 1024
const RANGE_PATTERN = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u
const DOCUMENT_PAGE_DEFAULT = 20
const DOCUMENT_PAGE_MAX = 100
/** Keep untrusted offset cursors from forcing pathological in-memory slices. */
const DOCUMENT_PAGE_MAX_OFFSET = 1_000_000

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
  if (code === DOCUMENT_UPLOAD_NOT_FOUND_CODE) return 404
  if (code === DOCUMENT_UPLOAD_EXPIRED_CODE) return 410
  if (code === DOCUMENT_TOO_LARGE_CODE) return 413
  if (code === DOCUMENT_UPLOAD_RANGE_CODE) return 416
  if (code === DOCUMENT_UPLOAD_HASH_CODE || code === DOCUMENT_UPLOAD_SIZE_CODE) return 422
  if (code === DOCUMENT_UPLOAD_BUSY_CODE) return 429
  if (code === DOCUMENT_UPLOAD_STORAGE_CODE) return 507
  if (code === DOCUMENT_UPLOAD_PROTOCOL_CODE) return 426
  if (code === DOCUMENT_UPLOAD_STATE_CODE) return 409
  if (code === DOCUMENT_TRASH_NOT_FOUND_CODE) return 404
  if (code === DOCUMENT_TRASHED_CODE || code === DOCUMENT_RESTORE_CONFLICT_CODE) return 409
  if (code === DOCUMENT_TARGET_CONFLICT_CODE || code === DOCUMENT_NAME_EXHAUSTED_CODE
    || code === DOCUMENT_DIRECTORY_CONFLICT_CODE || code === DOCUMENT_DIRECTORY_NOT_EMPTY_CODE) return 409
  if (code === INVALID_DOCUMENT_NAME_CODE || code === INVALID_DOCUMENT_REF_CODE
    || code === INVALID_DOCUMENT_DIRECTORY_CODE || code === DOCUMENT_LIST_QUERY_CODE) return 400
  if (code === DOCUMENT_DIRECTORY_WRITE_FAILED_CODE || code === DOCUMENT_MOVE_FAILED_CODE
    || code === DOCUMENT_MIGRATION_FAILED_CODE) return 500
  return 500
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof DocumentCatalogAuthorizationError) {
    json(res, error.status, { error: { code: error.code, message: error.message } } satisfies ErrorBody)
    return
  }
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

/** Read one runtime JSON response without allowing an unbounded body to reach JSON.parse. */
async function responseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > RUNTIME_JSON_RESPONSE_LIMIT) {
      await Promise.resolve(response.body?.cancel()).catch(() => {})
      throw new DocumentTransferHttpError(502, 'DOCUMENT_RESPONSE_TOO_LARGE', 'The document runtime response is too large.')
    }
  }
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > RUNTIME_JSON_RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {})
        throw new DocumentTransferHttpError(502, 'DOCUMENT_RESPONSE_TOO_LARGE', 'The document runtime response is too large.')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DocumentTransferHttpError(502, 'DOCUMENT_RESPONSE_INVALID', 'The document runtime response is not valid UTF-8.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DocumentTransferHttpError(502, 'DOCUMENT_RESPONSE_INVALID', 'The document runtime response is not valid JSON.')
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      bytes += value.byteLength
      if (bytes > UPLOAD_METADATA_BODY_LIMIT) {
        throw new UserDocError('Upload metadata is too large.', DOCUMENT_UPLOAD_SIZE_CODE)
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
    throw new UserDocError('Upload metadata is not valid JSON.', DOCUMENT_UPLOAD_SIZE_CODE)
  }
  const value = object(decoded)
  if (value === undefined) throw new UserDocError('Upload metadata is invalid.', DOCUMENT_UPLOAD_SIZE_CODE)
  return value
}

function uploadIdFrom(value: string): UserDocUploadIdType {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new UserDocError('Upload identifier is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE) }
  if (!/^[0-9a-f-]{36}$/u.test(decoded)) throw new UserDocError('Upload identifier is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
  return decoded as UserDocUploadIdType
}

function parseUploadBegin(value: Record<string, unknown>): BeginUserDocUpload {
  if (typeof value.name !== 'string' || value.name.length > 4096) {
    throw new UserDocError('Upload name is invalid.', INVALID_DOCUMENT_NAME_CODE)
  }
  if (value.name === '') throw new UserDocError('Upload name is missing.', INVALID_DOCUMENT_NAME_CODE)
  if (value.version !== 1 || typeof value.directory !== 'string' || value.directory.length > 4096
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.fingerprint !== 'string' || value.fingerprint === '' || value.fingerprint.length > 512) {
    throw new UserDocError('Upload metadata is invalid.', DOCUMENT_UPLOAD_SIZE_CODE)
  }
  return {
    name: value.name,
    directoryId: UserDocDirectoryId(value.directory),
    bytes: value.bytes as number,
    fingerprint: value.fingerprint,
  }
}

function parseUploadRange(value: string | undefined): { start: number; end: number; total: number } {
  const match = value === undefined ? null : RANGE_PATTERN.exec(value)
  if (match === null) throw new UserDocError('Upload Content-Range is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total < 0) {
    throw new UserDocError('Upload Content-Range is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
  }
  return { start, end, total }
}

function parseUploadIndex(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/u.test(value)) throw new UserDocError('Upload chunk index is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
  const index = Number(value)
  if (!Number.isSafeInteger(index)) throw new UserDocError('Upload chunk index is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
  return index
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function uploadStatus(res: ServerResponse, session: UserDocUploadSession): void {
  const safe = session.ref === undefined ? session : { ...session, ref: publicRef(session.ref) }
  json(res, session.state === 'complete' ? 200 : session.state === 'verifying' ? 202 : 200, safe)
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
    || typeof candidate.label !== 'string' || candidate.label === '' || candidate.label.length > 200
    || /[\u0000-\u001f\u007f]/u.test(candidate.label)) {
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
        || /[\\/\u0000-\u001f\u007f]/u.test(sourceInfo.name)
        || typeof sourceInfo.bytes !== 'number' || !Number.isSafeInteger(sourceInfo.bytes) || sourceInfo.bytes < 0
        || typeof sourceInfo.mediaType !== 'string' || sourceInfo.mediaType === '' || sourceInfo.mediaType.length > 255
        || /[\u0000-\u001f\u007f]/u.test(sourceInfo.mediaType)
        || targetInfo === undefined || !safeTransferDocId(targetInfo.docId)
        || typeof targetInfo.name !== 'string' || targetInfo.name === '' || targetInfo.name.length > 255
        || /[\\/\u0000-\u001f\u007f]/u.test(targetInfo.name)
        || typeof targetInfo.bytes !== 'number' || !Number.isSafeInteger(targetInfo.bytes) || targetInfo.bytes < 0
        || typeof targetInfo.mediaType !== 'string' || targetInfo.mediaType === '' || targetInfo.mediaType.length > 255
        || /[\u0000-\u001f\u007f]/u.test(targetInfo.mediaType)
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
      || sourceInfo.name === '' || sourceInfo.name.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(sourceInfo.name)
      || error === undefined || typeof error.code !== 'string'
      || typeof error.message !== 'string' || error.message.length > 240
      || /[\u0000-\u001f\u007f]|[/\\]/u.test(error.message)) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid file metadata.')
    }
    return { status: 'failed', source: { name: sourceInfo.name }, error: { code: error.code, message: error.message } }
  })
  let targets: unknown
  if (candidate.targets !== undefined) {
    if (!Array.isArray(candidate.targets) || candidate.targets.length < 2 || candidate.targets.length > 20) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid target results.')
    }
    targets = candidate.targets.map((entry) => {
      const item = object(entry)
      if (typeof item?.transferId !== 'string' || item.transferId === '' || !Array.isArray(item.items)) {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned invalid target results.')
      }
      const targetSummary = transferSummary(item.target)
      const nested = safeTransferResponse({
        version: 1,
        transferId: item.transferId,
        source: candidate.source,
        target: item.target,
        items: item.items,
      })
      return { transferId: item.transferId, target: targetSummary, items: nested.items }
    })
  }
  return { version: 1, transferId: candidate.transferId, source, target, items, ...(targets === undefined ? {} : { targets }) }
}

function safeTransferCapabilities(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.targets) || candidate.targets.length > 50) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document capabilities are invalid.')
  }
  const targets = candidate.targets.map((entry) => {
    const item = object(entry)
    if (typeof item?.canRead !== 'boolean' || typeof item.canWrite !== 'boolean'
      || typeof item.label !== 'string' || item.label === '' || item.label.length > 200
      || /[\u0000-\u001f\u007f]/u.test(item.label)) {
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
  if (candidate?.version !== 1 || !Array.isArray(candidate.documents) || candidate.documents.length > 100) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing is invalid.')
  }
  const documents = candidate.documents.map((entry) => {
    const item = object(entry)
    if (!safeTransferDocId(item?.docId) || typeof item.name !== 'string' || item.name === '' || item.name.length > 255
      || /[\\/\u0000-\u001f\u007f]/u.test(item.name)
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || typeof item.mediaType !== 'string' || item.mediaType === '' || item.mediaType.length > 255
      || /[\u0000-\u001f\u007f]/u.test(item.mediaType)
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
  let limits: unknown
  if (candidate.limits !== undefined) {
    const row = object(candidate.limits)
    const upload = object(row?.upload)
    if (row === undefined || upload === undefined
      || (row.maxFileBytes !== null && (!Number.isSafeInteger(row.maxFileBytes) || (row.maxFileBytes as number) < 1))
      || !Number.isSafeInteger(row.maxFilesPerMessage) || (row.maxFilesPerMessage as number) < 1
      || !Number.isSafeInteger(row.maxMessageBytes) || (row.maxMessageBytes as number) < 1
      || !Number.isSafeInteger(row.maxInlineTextBytes) || (row.maxInlineTextBytes as number) < 1
      || upload.protocol !== 'resumable-v1' || !Number.isSafeInteger(upload.chunkBytes) || (upload.chunkBytes as number) < 1
      || !Number.isSafeInteger(upload.sessionTtlMs) || (upload.sessionTtlMs as number) < 1 || upload.resumable !== true) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing contains invalid limits.')
    }
    limits = {
      maxFileBytes: row.maxFileBytes,
      maxFilesPerMessage: row.maxFilesPerMessage,
      maxMessageBytes: row.maxMessageBytes,
      maxInlineTextBytes: row.maxInlineTextBytes,
      upload: {
        protocol: 'resumable-v1', chunkBytes: upload.chunkBytes, sessionTtlMs: upload.sessionTtlMs, resumable: true,
      },
    }
  }
  const safeRelativeString = (key: string, max: number, allowEmpty = true): string | undefined => {
    const item = candidate[key]
    return typeof item === 'string' && item.length <= max
      && !/[\u0000-\u001f\u007f]/u.test(item)
      && (item === '' ? allowEmpty : item.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\')))
      ? item : undefined
  }
  const directoryId = candidate.directoryId === undefined ? undefined : safeRelativeString('directoryId', 4096)
  const parentDirectoryId = candidate.parentDirectoryId === undefined ? undefined : safeRelativeString('parentDirectoryId', 4096)
  if ((candidate.directoryId !== undefined && directoryId === undefined)
    || (candidate.parentDirectoryId !== undefined && parentDirectoryId === undefined)) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing contains invalid directory metadata.')
  }
  const directories = candidate.directories === undefined ? undefined : Array.isArray(candidate.directories)
    ? candidate.directories.map((entry) => {
      const item = object(entry)
      if (!safeTransferDocId(item?.directoryId) || typeof item.name !== 'string' || item.name === '' || item.name.length > 255
        || /[\\/\u0000-\u001f\u007f]/u.test(item.name)) {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing contains invalid directory metadata.')
      }
      return { directoryId: item.directoryId, name: item.name }
    })
    : (() => { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing contains invalid directories.') })()
  const totalDocuments = candidate.totalDocuments === undefined ? undefined
    : typeof candidate.totalDocuments === 'number' && Number.isSafeInteger(candidate.totalDocuments) && candidate.totalDocuments >= documents.length
      ? candidate.totalDocuments
      : (() => { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing has invalid paging metadata.') })()
  const nextCursor = candidate.nextCursor === undefined ? undefined
    : typeof candidate.nextCursor === 'string' && candidate.nextCursor.length > 0 && candidate.nextCursor.length <= 4096
      ? candidate.nextCursor
      : (() => { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document listing has an invalid cursor.') })()
  return {
    version: 1,
    scope: transferSummary(candidate.scope),
    documents,
    ...(limits === undefined ? {} : { limits }),
    ...(directoryId === undefined ? {} : { directoryId }),
    ...(parentDirectoryId === undefined ? {} : { parentDirectoryId }),
    ...(directories === undefined ? {} : { directories }),
    ...(totalDocuments === undefined ? {} : { totalDocuments }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

function safeTransferDirectories(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.directories) || candidate.directories.length > 2000) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document directories are invalid.')
  }
  const directories = candidate.directories.map((entry) => {
    const item = object(entry)
    if (!safeTransferDocId(item?.directoryId) || typeof item.name !== 'string' || item.name === '' || item.name.length > 255
        || /[\\/\u0000-\u001f\u007f]/u.test(item.name)) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document directories are invalid.')
    }
    return { directoryId: item.directoryId, name: item.name }
  })
  return { version: 1, scope: transferSummary(candidate.scope), directories }
}

function safeTransferPlan(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || typeof candidate.planId !== 'string' || candidate.planId === ''
    || typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)
    || !Array.isArray(candidate.documents) || candidate.documents.length > 50) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Transfer plan is invalid.')
  }
  const source = transferSummary(candidate.source)
  const target = transferSummary(candidate.target)
  const directory = candidate.directory === undefined ? undefined : candidate.directory
  if (directory !== undefined && (typeof directory !== 'string' || !safeRelativeDocumentId(directory, true))) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Transfer plan contains invalid directory metadata.')
  }
  const safeDocuments = (entries: unknown[]): Record<string, unknown>[] => entries.map((entry) => {
    const item = object(entry)
    if (!safeTransferDocId(item?.docId) || typeof item.name !== 'string' || item.name === '' || item.name.length > 255
      || /[\\/\u0000-\u001f\u007f]/u.test(item.name)
      || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || typeof item.mediaType !== 'string' || item.mediaType === '' || item.mediaType.length > 255
      || /[\u0000-\u001f\u007f]/u.test(item.mediaType)
      || typeof item.modifiedAt !== 'number' || !Number.isFinite(item.modifiedAt)) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Transfer plan contains invalid metadata.')
    }
    return { docId: item.docId, name: item.name, bytes: item.bytes, mediaType: item.mediaType, modifiedAt: item.modifiedAt }
  })
  const documents = safeDocuments(candidate.documents)
  let targets: unknown
  if (candidate.targets !== undefined) {
    if (!Array.isArray(candidate.targets) || candidate.targets.length < 2 || candidate.targets.length > 20) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Transfer plan targets are invalid.')
    }
    targets = candidate.targets.map((entry) => {
      const item = object(entry)
      if (item === undefined || !Array.isArray(item.documents)) {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Transfer plan targets are invalid.')
      }
      return { target: transferSummary(item.target), documents: safeDocuments(item.documents) }
    })
  }
  return {
    version: 1,
    planId: candidate.planId,
    source,
    target,
    ...(directory === undefined ? {} : { directory }),
    documents,
    expiresAt: candidate.expiresAt,
    ...(targets === undefined ? {} : { targets }),
  }
}

function safeCatalogOverview(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.documents) || candidate.documents.length > 5000) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata overview is invalid.')
  }
  const documents = candidate.documents.map((entry) => {
    const row = object(entry)
    const scope = object(row?.scope)
    const owner = row?.owner === null ? null : object(row?.owner)
    if (row === undefined || (scope?.kind !== 'personal' && scope?.kind !== 'project')
      || typeof scope.label !== 'string' || scope.label === '' || scope.label.length > 200
      || /[\u0000-\u001f\u007f]/u.test(scope.label)
      || (scope.id !== undefined && (typeof scope.id !== 'number' || !Number.isSafeInteger(scope.id) || scope.id <= 0))
      || (scope.kind === 'project' && (typeof scope.id !== 'number' || !Number.isSafeInteger(scope.id) || scope.id <= 0))
      || (scope.mode !== undefined && scope.mode !== 'ro' && scope.mode !== 'rw')
      || !safeTransferDocId(row.catalogId) || !safeTransferDocId(row.docId)
      || typeof row.directoryId !== 'string' || !safeRelativeDocumentId(row.directoryId, true)
      || typeof row.name !== 'string' || row.name === '' || row.name.length > 255
      || /[\\/\u0000-\u001f\u007f]/u.test(row.name)
      || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || typeof row.mediaType !== 'string' || row.mediaType === ''
      || typeof row.modifiedAt !== 'number' || !Number.isFinite(row.modifiedAt)
      || (owner !== null && (owner === undefined || typeof owner.id !== 'number' || !Number.isSafeInteger(owner.id)
        || typeof owner.displayName !== 'string' || owner.displayName.length > 200
        || /[\u0000-\u001f\u007f]/u.test(owner.displayName)))
      || (row.ownerSource !== undefined && row.ownerSource !== 'upload' && row.ownerSource !== 'transfer'
        && row.ownerSource !== 'legacy' && row.ownerSource !== 'admin')
      || (row.state !== 'active' && row.state !== 'trash' && row.state !== 'purged' && row.state !== 'deleted')
      || (row.trashedAt !== undefined && row.trashedAt !== null && (typeof row.trashedAt !== 'number' || !Number.isFinite(row.trashedAt)))
      || (row.restoredAt !== undefined && row.restoredAt !== null && (typeof row.restoredAt !== 'number' || !Number.isFinite(row.restoredAt)))
      || (row.purgeAfter !== undefined && row.purgeAfter !== null && (typeof row.purgeAfter !== 'number' || !Number.isFinite(row.purgeAfter)))
      || (row.purgedAt !== undefined && row.purgedAt !== null && (typeof row.purgedAt !== 'number' || !Number.isFinite(row.purgedAt)))) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata overview is invalid.')
    }
    return {
      catalogId: row.catalogId,
      scope: { kind: scope.kind, label: scope.label, ...(scope.id === undefined ? {} : { id: scope.id }),
        ...(scope.mode === 'ro' || scope.mode === 'rw' ? { mode: scope.mode } : {}) },
      docId: row.docId, directoryId: row.directoryId, name: row.name, bytes: row.bytes,
      mediaType: row.mediaType, modifiedAt: row.modifiedAt, owner,
      ownerSource: typeof row.ownerSource === 'string' ? row.ownerSource : 'legacy',
      state: row.state,
      ...(row.trashedAt === undefined ? {} : { trashedAt: row.trashedAt }),
      ...(row.restoredAt === undefined ? {} : { restoredAt: row.restoredAt }),
      ...(row.purgeAfter === undefined ? {} : { purgeAfter: row.purgeAfter }),
      ...(row.purgedAt === undefined ? {} : { purgedAt: row.purgedAt }),
      legacy: row.legacy === true, lineageRootId: typeof row.lineageRootId === 'string' ? row.lineageRootId : null,
    }
  })
  let metrics: unknown
  if (candidate.metrics !== undefined) {
    const value = object(candidate.metrics)
    const keys = ['total', 'active', 'deleted', 'personal', 'project', 'bytes', 'operations24h', 'failures24h'] as const
    const lifecycleKeys = ['trash', 'purged'] as const
    if (value === undefined || keys.some(key => typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
      || lifecycleKeys.some(key => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0))) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata metrics are invalid.')
    }
    metrics = Object.fromEntries([
      ...keys.map(key => [key, value[key]]),
      ...lifecycleKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]),
    ])
  } else {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata metrics are missing.')
  }
  const totalDocuments = candidate.totalDocuments === undefined ? undefined
    : typeof candidate.totalDocuments === 'number' && Number.isSafeInteger(candidate.totalDocuments)
      && candidate.totalDocuments >= documents.length ? candidate.totalDocuments : (() => {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata paging is invalid.')
      })()
  const nextCursor = candidate.nextCursor === undefined ? undefined
    : typeof candidate.nextCursor === 'string' && candidate.nextCursor.length > 0 && candidate.nextCursor.length <= 4096
      ? candidate.nextCursor : (() => {
        throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata cursor is invalid.')
      })()
  return {
    version: 1,
    documents,
    ...(metrics === undefined ? {} : { metrics }),
    ...(totalDocuments === undefined ? {} : { totalDocuments }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

function safeRelativeDocumentId(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === 'string' && value.length <= 4096
    && (value === '' ? allowEmpty : value.split('/').every(segment => segment !== '' && segment !== '.'
      && segment !== '..' && !segment.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(segment)))
}

function safeCatalogHistory(value: unknown): Record<string, unknown> {
  const candidate = object(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.items) || candidate.items.length > 500) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document history is invalid.')
  }
  const items = candidate.items.map((entry) => {
    const item = object(entry)
    const actor = item?.actor === null ? null : object(item?.actor)
    if (item === undefined || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0
      || typeof item.eventKind !== 'string' || item.eventKind === '' || item.eventKind.length > 64
      || (item.operationId !== null && item.operationId !== undefined && typeof item.operationId !== 'string')
      || (item.catalogId !== null && item.catalogId !== undefined && typeof item.catalogId !== 'string')
      || (item.documentName !== null && item.documentName !== undefined && (typeof item.documentName !== 'string' || item.documentName.length > 255))
      || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
      || (actor !== null && (actor === undefined || typeof actor.id !== 'number' || !Number.isSafeInteger(actor.id)
        || typeof actor.displayName !== 'string' || actor.displayName.length > 200))) {
      throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document history is invalid.')
    }
    return {
      id: item.id, eventKind: item.eventKind,
      actor: actor === null ? null : { id: actor.id, displayName: actor.displayName },
      operationId: item.operationId ?? null,
      detail: null,
      createdAt: item.createdAt,
      catalogId: item.catalogId ?? null,
      documentName: item.documentName ?? null,
    }
  })
  return { version: 1, items }
}

/* jscpd:ignore-start -- each HTTP phase validates a distinct wire response and owns its abort semantics. */
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
  const planId = value.planId
  if (planId !== undefined && (typeof planId !== 'string' || planId === '' || planId.length > 128)) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid transfer plan id.')
  }
  let targets: Record<string, unknown>[] | undefined
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || value.targets.length < 2 || value.targets.length > 20) {
      throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid transfer targets.')
    }
    targets = value.targets.map(target => transferScope(target))
  }
  return {
    version: 1,
    ...(planId === undefined ? {} : { planId }),
    source: transferScope(value.source),
    target: transferScope(value.target),
    ...(targets === undefined ? {} : { targets }),
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
  const optionalString = (key: string, max: number): string | undefined => {
    const candidate = value[key]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'string' || candidate.length > max) {
      throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', `Invalid document scope listing ${key}.`)
    }
    return candidate
  }
  const directory = optionalString('directory', 4096)
  const cursor = optionalString('cursor', 4096)
  const query = optionalString('query', 255)
  const type = optionalString('type', 16)
  const sort = optionalString('sort', 32)
  const state = optionalString('state', 16)
  const rawLimit = value.limit
  if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 100)) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing limit.')
  }
  if (type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(type)) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing type.')
  }
  if (sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(sort)) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing sort.')
  }
  if (state !== undefined && state !== 'active' && state !== 'trash') {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document scope listing state.')
  }
  return {
    version: 1,
    scope: transferScope(value.scope),
    ...(directory === undefined ? {} : { directory }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(rawLimit === undefined ? {} : { limit: rawLimit }),
    ...(query === undefined ? {} : { query }),
    ...(type === undefined ? {} : { type }),
    ...(sort === undefined ? {} : { sort }),
    ...(state === undefined ? {} : { state }),
  }
}

async function readTransferDirectoryCreatePayload(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of req) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
      bytes += value.byteLength
      if (bytes > TRANSFER_BODY_LIMIT) throw new DocumentTransferHttpError(413, 'DOCUMENT_TRANSFER_TOO_LARGE', 'Document transfer request is too large.')
      chunks.push(value)
    }
  } catch (error) {
    // A rejected oversized body may still have unread keep-alive bytes. Drain
    // them before returning the error so the HTTP parser cannot attach them to
    // the next request on the same socket.
    req.resume()
    throw error
  }
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document directory JSON.')
  }
  const value = object(decoded)
  if (value === undefined || value.version !== 1 || typeof value.name !== 'string' || value.name === ''
    || value.name.length > 255 || typeof value.directory !== 'string' || value.directory.length > 4096) {
    throw new DocumentTransferHttpError(400, 'INVALID_DOCUMENT_TRANSFER', 'Invalid document directory request.')
  }
  return { version: 1, scope: transferScope(value.scope), directory: value.directory, name: value.name }
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
    body = await responseJson(response)
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

async function transferPhase(ctx: Context, req: IncomingMessage, res: ServerResponse, path: string, plan: boolean): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  const payload = await readTransferPayload(req)
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal, principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer is unavailable.')
  }
  let body: unknown
  try { body = await responseJson(response) } catch { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document transfer returned an invalid response.') }
  if (!response.ok) {
    const value = object(body)
    throw new DocumentTransferHttpError(response.status, typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED', typeof value?.message === 'string' ? value.message : 'Document transfer failed.')
  }
  if (!abort.signal.aborted) json(res, 200, plan ? safeTransferPlan(body) : safeTransferResponse(body))
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
    body = await responseJson(response)
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
    body = await responseJson(response)
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

async function transferDirectories(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document directories are unavailable.')
  const payload = await readTransferPayloadForScope(req)
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/transfer/directories', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal, principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document directories are unavailable.')
  }
  let body: unknown
  try { body = await responseJson(response) } catch { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope document directories are invalid.') }
  if (!response.ok) {
    const value = object(body)
    throw new DocumentTransferHttpError(response.status, typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED', typeof value?.message === 'string' ? value.message : 'Document directory listing failed.')
  }
  if (!abort.signal.aborted) json(res, 200, safeTransferDirectories(body))
}

async function transferDirectoryCreate(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope folder creation is unavailable.')
  const payload = await readTransferDirectoryCreatePayload(req)
  const abort = abortFor(req, res)
  let response: Response
  try {
    response = await runtime.request('/internal/runtime/documents/transfer/directories/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal, principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope folder creation is unavailable.')
  }
  let body: unknown
  try { body = await responseJson(response) } catch { throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope folder creation returned an invalid response.') }
  if (!response.ok) {
    const value = object(body)
    throw new DocumentTransferHttpError(response.status, typeof value?.error === 'string' ? value.error : 'DOCUMENT_TRANSFER_FAILED', typeof value?.message === 'string' ? value.message : 'Folder creation failed.')
  }
  const value = object(body)
  const directory = object(value?.directory)
  if (value?.version !== 1 || directory === undefined || !safeTransferDocId(directory.directoryId)
    || typeof directory.name !== 'string' || directory.name === '') {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_TRANSFER_UNAVAILABLE', 'Cross-scope folder creation returned invalid metadata.')
  }
  json(res, 201, {
    version: 1,
    scope: transferSummary(value.scope),
    directory: { directoryId: directory.directoryId, name: directory.name },
  })
}

async function catalogOverview(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata overview is unavailable.')
  }
  const abort = abortFor(req, res)
  let response: Response
  try {
    const runtimePath = new URL(req.url ?? '/', 'http://host')
    const query = new URLSearchParams()
    for (const key of ['q', 'type', 'sort', 'cursor', 'limit'] as const) {
      const value = runtimePath.searchParams.get(key)
      if (value !== null) query.set(key === 'q' ? 'query' : key, value)
    }
    response = await runtime.request(`/internal/runtime/documents/catalog/overview${query.toString() === '' ? '' : `?${query.toString()}`}`, {
      method: 'GET', signal: abort.signal, principal: true,
    })
  } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata overview is unavailable.')
  }
  let body: unknown
  try { body = await responseJson(response) } catch {
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document metadata overview is invalid.')
  }
  if (!response.ok) {
    const value = object(body)
    const code = typeof value?.error === 'string' ? value.error : 'DOCUMENT_CATALOG_UNAVAILABLE'
    const message = typeof value?.message === 'string' ? value.message : 'Document metadata overview is unavailable.'
    throw new DocumentTransferHttpError(response.status, code, message)
  }
  if (!abort.signal.aborted) json(res, 200, safeCatalogOverview(body))
}

async function catalogHistory(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const runtime = runtimeForCatalog(ctx)
  if (runtime === undefined) throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document history is unavailable.')
  const abort = abortFor(req, res)
  let response: Response
  try { response = await runtime.request('/internal/runtime/documents/catalog/history', { method: 'GET', signal: abort.signal, principal: true }) } catch {
    if (abort.signal.aborted) return
    throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document history is unavailable.')
  }
  let body: unknown
  try { body = await responseJson(response) } catch { throw new DocumentTransferHttpError(503, 'DOCUMENT_CATALOG_UNAVAILABLE', 'Document history is invalid.') }
  if (!response.ok) {
    const value = object(body)
    throw new DocumentTransferHttpError(response.status, typeof value?.error === 'string' ? value.error : 'DOCUMENT_CATALOG_UNAVAILABLE', typeof value?.message === 'string' ? value.message : 'Document history is unavailable.')
  }
  if (!abort.signal.aborted) json(res, 200, safeCatalogHistory(body))
}
/* jscpd:ignore-end */

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

interface ParsedListQuery {
  readonly limit: number
  readonly offset: number
  readonly providerCursor?: string
  readonly query: string
  readonly type: UserDocListType
  readonly sort: UserDocListSort
  readonly fingerprint: string
}

function listType(value: string | null): UserDocListType {
  if (value === null || value === '') return 'all'
  if (value === 'all' || value === 'image' || value === 'pdf' || value === 'text' || value === 'other') return value
  throw new UserDocError('Document type filter is invalid.', DOCUMENT_LIST_QUERY_CODE)
}

function listSort(value: string | null): UserDocListSort {
  if (value === null || value === '') return 'date-desc'
  if (value === 'date-desc' || value === 'date-asc' || value === 'name-asc'
    || value === 'name-desc' || value === 'size-desc' || value === 'size-asc') return value
  throw new UserDocError('Document sort is invalid.', DOCUMENT_LIST_QUERY_CODE)
}

function pageCursor(cursor: string | null, fingerprint: string): {
  readonly offset: number
  readonly providerCursor?: string
} {
  if (cursor === null || cursor === '') return { offset: 0 }
  if (cursor.length > 4096) throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
  let decoded: unknown
  try {
    const encoded = Buffer.from(cursor, 'base64url')
    if (encoded.toString('base64url') !== cursor) throw new Error('non-canonical cursor')
    decoded = JSON.parse(encoded.toString('utf8')) as unknown
  } catch {
    throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
  }
  const value = decoded as { version?: unknown; kind?: unknown; offset?: unknown; cursor?: unknown; fingerprint?: unknown }
  if (value.fingerprint !== fingerprint) {
    throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
  }
  if ((value.version === undefined || value.version === 1) && value.kind !== 'provider'
    && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0
    && (value.offset as number) <= DOCUMENT_PAGE_MAX_OFFSET) {
    return { offset: value.offset as number }
  }
  if (value.version === 1 && value.kind === 'provider' && typeof value.cursor === 'string'
    && value.cursor !== '' && value.cursor.length <= 2048) {
    return { offset: 0, providerCursor: value.cursor }
  }
  throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
}

function cursorForOffset(offset: number, fingerprint: string): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > DOCUMENT_PAGE_MAX_OFFSET) {
    throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
  }
  return Buffer.from(JSON.stringify({ version: 1, kind: 'offset', offset, fingerprint }), 'utf8').toString('base64url')
}

function cursorForProvider(cursor: string, fingerprint: string): string {
  if (cursor === '' || cursor.length > 2048) {
    throw new UserDocError('Document provider returned an invalid cursor.', DOCUMENT_LIST_QUERY_CODE)
  }
  return Buffer.from(JSON.stringify({ version: 1, kind: 'provider', cursor, fingerprint }), 'utf8').toString('base64url')
}

function documentBucket(mediaType: string): UserDocListType {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml'
    || mediaType === 'application/x-yaml' || mediaType === 'application/javascript'
    || mediaType.endsWith('+json') || mediaType.endsWith('+xml')) return 'text'
  return 'other'
}

function inlinePreviewMedia(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType === 'application/pdf'
    || mediaType.startsWith('text/') || mediaType === 'application/json'
    || mediaType === 'application/xml' || mediaType === 'application/x-yaml'
    || mediaType === 'application/javascript' || mediaType.endsWith('+json') || mediaType.endsWith('+xml')
}

function parseListQuery(url: URL, state: 'active' | 'trash' = 'active'): ParsedListQuery {
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null || rawLimit === '' ? DOCUMENT_PAGE_DEFAULT : Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_PAGE_MAX) {
    throw new UserDocError('Document page size is invalid.', DOCUMENT_LIST_QUERY_CODE)
  }
  const query = url.searchParams.get('q') ?? ''
  if (query.length > 255) throw new UserDocError('Document search is too long.', DOCUMENT_LIST_QUERY_CODE)
  const requestedState = url.searchParams.get('state')
  if (requestedState !== null && requestedState !== '' && requestedState !== state) {
    throw new UserDocError('Document list state is invalid for this route.', DOCUMENT_LIST_QUERY_CODE)
  }
  const type = listType(url.searchParams.get('type'))
  const sort = listSort(url.searchParams.get('sort'))
  const fingerprint = JSON.stringify({
    directory: url.searchParams.get('directory') ?? '',
    query,
    type,
    sort,
    state,
  })
  const decodedCursor = pageCursor(url.searchParams.get('cursor'), fingerprint)
  return {
    limit,
    offset: decodedCursor.offset,
    ...(decodedCursor.providerCursor === undefined ? {} : { providerCursor: decodedCursor.providerCursor }),
    query,
    type,
    sort,
    fingerprint,
  }
}

function pageListing(listing: UserDocDirectoryListing, options: ParsedListQuery) {
  const needle = options.query.trim().toLowerCase()
  const filtered = listing.documents.filter((document) => {
    if (needle !== '' && !document.name.toLowerCase().includes(needle)) return false
    return options.type === 'all' || documentBucket(document.mediaType) === options.type
  })
  const ordered = [...filtered].sort((left, right) => {
    let result = 0
    if (options.sort.startsWith('date')) result = left.modifiedAt - right.modifiedAt
    else if (options.sort.startsWith('name')) result = left.name.localeCompare(right.name)
    else result = left.bytes - right.bytes
    const direction = options.sort.endsWith('asc') ? 1 : -1
    if (result !== 0) return direction * result
    return left.docId.localeCompare(right.docId)
  })
  const documents = ordered.slice(options.offset, options.offset + options.limit)
  const nextOffset = options.offset + documents.length
  return {
    ...listing,
    documents,
    totalDocuments: ordered.length,
    ...(nextOffset < ordered.length ? { nextCursor: cursorForOffset(nextOffset, options.fingerprint) } : {}),
  }
}

function pageTrashListing(documents: readonly UserDocTrashRef[], options: ParsedListQuery): UserDocTrashPage {
  const needle = options.query.trim().toLowerCase()
  const filtered = documents.filter((document) => {
    if (needle !== '' && !document.name.toLowerCase().includes(needle)) return false
    return options.type === 'all' || documentBucket(document.mediaType) === options.type
  })
  const ordered = [...filtered].sort((left, right) => {
    let result = 0
    if (options.sort.startsWith('date')) result = left.trashedAt - right.trashedAt
    else if (options.sort.startsWith('name')) result = left.name.localeCompare(right.name)
    else result = left.bytes - right.bytes
    const direction = options.sort.endsWith('asc') ? 1 : -1
    if (result !== 0) return direction * result
    return left.docId.localeCompare(right.docId)
  })
  const page = ordered.slice(options.offset, options.offset + options.limit)
  const nextOffset = options.offset + page.length
  return {
    documents: page,
    totalDocuments: ordered.length,
    ...(nextOffset < ordered.length ? { nextCursor: cursorForOffset(nextOffset, options.fingerprint) } : {}),
  }
}

function wrapProviderCursor<T extends { readonly nextCursor?: string }>(
  page: T,
  options: ParsedListQuery,
): Omit<T, 'nextCursor'> & { readonly nextCursor?: string } {
  const { nextCursor, ...rest } = page
  return {
    ...rest,
    ...(nextCursor === undefined ? {} : { nextCursor: cursorForProvider(nextCursor, options.fingerprint) }),
  }
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
  // A browser only needs the opaque id and display metadata. The real path is
  // retained inside the runtime for prompt/file-tool access and never crosses
  // the HTTP response boundary.
  return { ...ref, path: '' }
}

function publicDirectoryRef(ref: UserDocDirectoryRef): UserDocDirectoryRef {
  return { ...ref, path: '' }
}

async function beginUpload(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const input = parseUploadBegin(await readJsonBody(req))
  uploadStatus(res, await ctx.userDocs.beginUpload(input))
}

async function inspectUpload(ctx: Context, res: ServerResponse, rawId: string): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const session = await ctx.userDocs.inspectUpload(uploadIdFrom(rawId))
  if (session.state === 'complete' && session.ref !== undefined) await syncCatalog(ctx, [session.ref], false, 'upload')
  uploadStatus(res, session)
}

async function writeUploadChunk(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
  rawIndex: string,
): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const uploadId = uploadIdFrom(rawId)
  const index = parseUploadIndex(rawIndex)
  const session = await ctx.userDocs.inspectUpload(uploadId)
  if (session.state !== 'uploading') {
    req.resume()
    uploadStatus(res, session)
    return
  }
  const range = parseUploadRange(singleHeader(req.headers['content-range']))
  const expectedLength = range.end - range.start + 1
  const declared = singleHeader(req.headers['content-length'])
  const contentLength = declared === undefined ? NaN : Number(declared)
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedLength
    || expectedLength > session.chunkBytes) {
    req.resume()
    throw new UserDocError('Upload chunk length is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
  }
  const sha256 = singleHeader(req.headers['x-dsh-chunk-sha256'])
  if (typeof sha256 !== 'string') {
    req.resume()
    throw new UserDocError('Upload chunk hash is missing.', DOCUMENT_UPLOAD_HASH_CODE)
  }
  const abort = abortFor(req, res)
  try {
    const updated = await ctx.userDocs.writeUploadChunk(uploadId, {
      index,
      start: range.start,
      end: range.end,
      total: range.total,
      sha256: sha256.toLowerCase(),
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    } satisfies UserDocUploadChunk, abort.signal)
    if (!abort.signal.aborted) uploadStatus(res, updated)
  } catch (error) {
    req.resume()
    if (!res.writableEnded && !abort.signal.aborted) failure(res, error)
  }
}

async function completeUpload(ctx: Context, req: IncomingMessage, res: ServerResponse, rawId: string): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const value = await readJsonBody(req)
  if (value.version !== 1 || typeof value.sha256 !== 'string') {
    throw new UserDocError('Final upload metadata is invalid.', DOCUMENT_UPLOAD_HASH_CODE)
  }
  const session = await ctx.userDocs.completeUpload(uploadIdFrom(rawId), value.sha256.toLowerCase())
  if (session.state === 'complete' && session.ref !== undefined) await syncCatalog(ctx, [session.ref], false, 'upload')
  uploadStatus(res, session)
}

async function cancelUpload(ctx: Context, res: ServerResponse, rawId: string): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  await ctx.userDocs.cancelUpload(uploadIdFrom(rawId))
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

function removedOneShotUpload(req: IncomingMessage, res: ServerResponse): void {
  req.resume()
  json(res, 426, {
    error: {
      code: DOCUMENT_UPLOAD_PROTOCOL_CODE,
      message: 'Use the resumable document upload protocol.',
    },
  } satisfies ErrorBody)
}

async function createFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const created = await ctx.userDocs.createDirectory(directoryQuery(url), requiredQuery(url, 'name'))
  json(res, 201, publicDirectoryRef(created))
}

async function renameFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const renamed = await ctx.userDocs.renameDirectory(
    requiredDirectoryQuery(url, 'id'),
    requiredQuery(url, 'name'),
  )
  await syncCatalog(ctx, await ctx.userDocs.list(), true, 'legacy')
  json(res, 200, publicDirectoryRef(renamed))
}

async function deleteFolder(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const directoryId = requiredDirectoryQuery(url, 'id')
  const listing = await ctx.userDocs.listDirectory(directoryId)
  if (listing.documents.length > 0) {
    await authorizeCatalogMutation(ctx, 'delete', listing.documents.map(document => document.docId))
  }
  await ctx.userDocs.removeDirectory(directoryId)
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

async function moveDocument(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write')
  const docId = UserDocId(requiredQuery(url, 'id'))
  await reconcileCatalogTarget(ctx, docId)
  await authorizeCatalogMutation(ctx, 'move', [docId])
  const moved = await ctx.userDocs.move(docId, directoryQuery(url))
  await syncCatalog(ctx, [moved], false, 'legacy')
  json(res, 200, publicRef(moved))
}

async function download(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'read')
  const docId = UserDocId(requiredQuery(url, 'id'))
  const controller = new AbortController()
  const requestState: { disconnected: unknown } = { disconnected: false }
  const responseDestroyed = (): boolean => (res as unknown as { destroyed?: unknown }).destroyed === true
  let opened: Awaited<ReturnType<UserDocStore['openRead']>> | undefined
  const abort = (): void => {
    requestState.disconnected = true
    if (!controller.signal.aborted) controller.abort(new Error('HTTP client disconnected.'))
    void opened?.body.cancel().catch(() => {})
  }
  const onResponseClose = (): void => { if (!res.writableEnded) abort() }
  req.once('aborted', abort)
  res.once('close', onResponseClose)
  try {
    opened = await ctx.userDocs.openRead(docId)
    if (requestState.disconnected === true) return
    const inline = url.searchParams.get('inline') === '1' && inlinePreviewMedia(opened.ref.mediaType)
    const headers = {
      'content-type': opened.ref.mediaType,
      'content-length': String(opened.ref.bytes),
      'content-disposition': inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(opened.ref.name)}`,
      'x-content-type-options': 'nosniff',
      ...(inline ? { 'content-security-policy': "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox" } : {}),
      'cache-control': 'private, no-store',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      await opened.body.cancel()
      res.end()
      return
    }
    for await (const chunk of opened.body as unknown as AsyncIterable<Uint8Array>) {
      if (requestState.disconnected === true || responseDestroyed()) break
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')])
      if (requestState.disconnected === true || responseDestroyed()) break
    }
    if (requestState.disconnected !== true && !res.writableEnded) res.end()
  } catch (error) {
    // Opening the document happens before any response headers are committed;
    // let the outer route map provider errors to its stable JSON envelope.
    if (opened === undefined) throw error
    if (requestState.disconnected !== true && !responseDestroyed()) res.destroy(error as Error)
  } finally {
    req.removeListener('aborted', abort)
    res.removeListener('close', onResponseClose)
    if (requestState.disconnected === true) await opened?.body.cancel().catch(() => {})
  }
}

async function listTrashDocuments(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  authorizeDocumentAction(ctx, 'read')
  const abort = abortFor(req, res)
  const paged = req.url !== undefined && new URL(req.url, 'http://dsh.internal').searchParams.toString() !== ''
  if (!paged) {
    const documents = await ctx.userDocs.listTrash(abort.signal)
    if (!abort.signal.aborted) json(res, 200, { version: 1, documents })
    return
  }
  const url = query(req)
  const options = parseListQuery(url, 'trash')
  const listPage = (ctx.userDocs as unknown as { listTrashPage?: unknown }).listTrashPage
  let page: UserDocTrashPage
  if (typeof listPage === 'function') {
    const providerPage = await (listPage as (
      this: UserDocStore,
      query: UserDocListQuery,
      signal?: AbortSignal,
    ) => Promise<UserDocTrashPage>).call(ctx.userDocs, {
      ...(options.providerCursor === undefined ? {} : { cursor: options.providerCursor }),
      limit: options.limit,
      query: options.query,
      type: options.type,
      sort: options.sort,
      state: 'trash',
    }, abort.signal)
    page = wrapProviderCursor(providerPage, options)
  } else {
    const documents = await ctx.userDocs.listTrash(abort.signal)
    page = pageTrashListing(documents, options)
  }
  if (!abort.signal.aborted) json(res, 200, { version: 1, ...page })
}

async function trashDocument(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write', true)
  const docId = UserDocId(requiredQuery(url, 'id'))
  await reconcileCatalogTarget(ctx, docId)
  const alreadyTrashed = await authorizeTrashRequest(ctx, docId)
  if (alreadyTrashed !== undefined) {
    json(res, 200, { version: 1, document: alreadyTrashed })
    return
  }
  let trashed: UserDocTrashRef
  try {
    trashed = await ctx.userDocs.trash(docId)
  } catch (error) {
    if (!(error instanceof UserDocError) || error.code !== DOCUMENT_TRASHED_CODE) throw error
    const existing = (await ctx.userDocs.listTrash()).find(item => item.docId === docId)
    if (existing === undefined) throw error
    trashed = existing
  }
  queueCatalogSync(ctx, [], false, 'legacy', [docId])
  json(res, 200, { version: 1, document: trashed })
}

async function restoreDocument(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write', true)
  const docId = UserDocId(requiredQuery(url, 'id'))
  await authorizeCatalogMutation(ctx, 'restore', [docId])
  const directory = url.searchParams.get('directory') ?? undefined
  const name = url.searchParams.get('name') ?? undefined
  const restored = await ctx.userDocs.restore(
    docId,
    directory === undefined ? undefined : UserDocDirectoryId(directory),
    name,
  )
  queueCatalogSync(ctx, [restored], false, 'legacy')
  json(res, 200, { version: 1, document: publicRef(restored) })
}

async function purgeDocument(ctx: Context, res: ServerResponse, url: URL): Promise<void> {
  authorizeDocumentAction(ctx, 'write', true)
  const docId = UserDocId(requiredQuery(url, 'id'))
  await authorizeCatalogMutation(ctx, 'purge', [docId])
  await ctx.userDocs.purge(docId)
  const runtime = runtimeForCatalog(ctx)
  if (runtime?.request !== undefined) {
    try {
      await runtime.request('/internal/runtime/documents/catalog/purge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, docIds: [docId] }),
        principal: true,
      })
    } catch {
      // A later full reconciliation keeps the catalog from blocking the file purge.
    }
  } else {
    queueCatalogSync(ctx, [], false, 'legacy', [docId])
  }
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
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
    if (url.pathname === USERDOC_UPLOADS_PATH && req.method === 'POST') {
      await beginUpload(ctx, req, res)
      return
    }
    const uploadChunk = new RegExp(`^${USERDOC_UPLOADS_PATH}/([^/]+)/chunks/([^/]+)$`, 'u').exec(url.pathname)
    if (uploadChunk !== null && req.method === 'PUT') {
      await writeUploadChunk(ctx, req, res, uploadChunk[1] ?? '', uploadChunk[2] ?? '')
      return
    }
    const uploadComplete = new RegExp(`^${USERDOC_UPLOADS_PATH}/([^/]+)/complete$`, 'u').exec(url.pathname)
    if (uploadComplete !== null && req.method === 'POST') {
      await completeUpload(ctx, req, res, uploadComplete[1] ?? '')
      return
    }
    const uploadSession = new RegExp(`^${USERDOC_UPLOADS_PATH}/([^/]+)$`, 'u').exec(url.pathname)
    if (uploadSession !== null && req.method === 'GET') {
      await inspectUpload(ctx, res, uploadSession[1] ?? '')
      return
    }
    if (uploadSession !== null && req.method === 'DELETE') {
      await cancelUpload(ctx, res, uploadSession[1] ?? '')
      return
    }
    if (url.pathname === USERDOC_TRASH_PATH && req.method === 'GET') {
      await listTrashDocuments(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_TRASH_PATH && req.method === 'POST') {
      await trashDocument(ctx, res, url)
      return
    }
    if (url.pathname === USERDOC_RESTORE_PATH && req.method === 'POST') {
      await restoreDocument(ctx, res, url)
      return
    }
    if (url.pathname === USERDOC_PURGE_PATH && req.method === 'DELETE') {
      await purgeDocument(ctx, res, url)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      const abort = abortFor(req, res)
      const paged = url.searchParams.has('cursor') || url.searchParams.has('limit')
        || url.searchParams.has('q') || url.searchParams.has('type') || url.searchParams.has('sort')
        || url.searchParams.has('state')
      const listOptions = paged ? parseListQuery(url, 'active') : undefined
      if (url.searchParams.has('directory')) {
        const directoryId = directoryQuery(url)
        const pageMethod = (ctx.userDocs as unknown as { listDirectoryPage?: unknown }).listDirectoryPage
        const usesProviderPage = listOptions !== undefined && typeof pageMethod === 'function'
        const providerListing = listOptions === undefined
          ? await ctx.userDocs.listDirectory(directoryId, abort.signal)
          : typeof pageMethod === 'function'
            ? await (pageMethod as (
              this: UserDocStore,
              id: UserDocDirectoryId,
              query: UserDocListQuery,
              signal?: AbortSignal,
            ) => Promise<UserDocDirectoryPage>).call(ctx.userDocs, directoryId, {
              ...(listOptions.providerCursor === undefined ? {} : { cursor: listOptions.providerCursor }),
              limit: listOptions.limit,
              query: listOptions.query,
              type: listOptions.type,
              sort: listOptions.sort,
              state: 'active',
            }, abort.signal)
            : pageListing(await ctx.userDocs.listDirectory(directoryId, abort.signal), listOptions)
        const listing = listOptions === undefined || !usesProviderPage
          ? providerListing
          : wrapProviderCursor(providerListing as UserDocDirectoryPage, listOptions)
        if (!abort.signal.aborted) {
          const response = listOptions === undefined ? {
            ...listing,
            totalDocuments: listing.documents.length,
          } : listing
          json(res, 200, {
            limits: ctx.userDocs.limits,
            ...response,
            ...(listOptions !== undefined && 'nextCursor' in response && response.nextCursor !== undefined
              ? { nextCursor: response.nextCursor }
              : {}),
            documents: response.documents.map(publicRef),
            directories: response.directories.map(publicDirectoryRef),
          })
          // Catalog reconciliation is metadata maintenance and must not delay
          // the document page that the user is waiting to see.
          queueCatalogSync(ctx, providerListing.documents, false)
        }
      } else {
        const documents = listOptions === undefined ? await ctx.userDocs.list(abort.signal) : undefined
        if (!abort.signal.aborted) {
          const response = listOptions === undefined
            ? {
              documents: documents ?? [],
              totalDocuments: documents?.length ?? 0,
            }
            : await (typeof (ctx.userDocs as unknown as { listDirectoryPage?: unknown }).listDirectoryPage === 'function'
              ? ctx.userDocs.listDirectoryPage(UserDocDirectoryId(''), {
                ...(listOptions.providerCursor === undefined ? {} : { cursor: listOptions.providerCursor }),
                limit: listOptions.limit,
                query: listOptions.query,
                type: listOptions.type,
                sort: listOptions.sort,
                state: 'active',
              }, abort.signal).then(page => wrapProviderCursor(page, listOptions))
              : pageListing({
                directoryId: UserDocDirectoryId(''), directories: [], documents: await ctx.userDocs.list(abort.signal),
              }, listOptions))
          json(res, 200, { limits: ctx.userDocs.limits, ...response, documents: response.documents.map(publicRef) })
          // A full reconciliation runs after the response; mutation
          // authorization remains synchronous on its dedicated path.
          queueCatalogSync(ctx, documents ?? response.documents, listOptions === undefined)
        }
      }
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/directories` && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      const abort = abortFor(req, res)
      const directories = await ctx.userDocs.listDirectories(abort.signal)
      if (!abort.signal.aborted) json(res, 200, { directories: directories.map(publicDirectoryRef) })
      return
    }
    if (url.pathname === USERDOC_TRANSFER_PATH && req.method === 'POST') {
      await transferDocuments(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_PLAN_PATH && req.method === 'POST') {
      await transferPhase(ctx, req, res, '/internal/runtime/documents/transfer/plan', true)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_COMMIT_PATH && req.method === 'POST') {
      await transferPhase(ctx, req, res, '/internal/runtime/documents/transfer/commit', false)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_RETRY_PATH && req.method === 'POST') {
      await transferPhase(ctx, req, res, '/internal/runtime/documents/transfer/retry', false)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_LIST_PATH && req.method === 'POST') {
      await transferList(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_DIRECTORIES_PATH && req.method === 'POST') {
      await transferDirectories(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_TRANSFER_DIRECTORY_CREATE_PATH && req.method === 'POST') {
      await transferDirectoryCreate(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_CATALOG_OVERVIEW_PATH && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      await catalogOverview(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_CATALOG_HISTORY_PATH && req.method === 'GET') {
      authorizeDocumentAction(ctx, 'read')
      await catalogHistory(ctx, req, res)
      return
    }
    if (url.pathname === `${USERDOC_TRANSFER_PATH}/capabilities` && req.method === 'GET') {
      await transferCapabilities(ctx, req, res)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'POST') {
      authorizeDocumentAction(ctx, 'write')
      removedOneShotUpload(req, res)
      return
    }
    if (url.pathname === `${USERDOC_HTTP_PATH}/content` && (req.method === 'GET' || req.method === 'HEAD')) {
      await download(ctx, req, res, url)
      return
    }
    if (url.pathname === USERDOC_HTTP_PATH && req.method === 'DELETE') {
      authorizeDocumentAction(ctx, 'write')
      const docId = UserDocId(requiredQuery(url, 'id'))
      await reconcileCatalogTarget(ctx, docId)
      const alreadyTrashed = await authorizeTrashRequest(ctx, docId)
      if (alreadyTrashed !== undefined) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const trash = (ctx.userDocs as unknown as { trash?: (id: UserDocId) => Promise<unknown> }).trash
      if (typeof trash === 'function') {
        try {
          await trash.call(ctx.userDocs, docId)
        } catch (error) {
          if (!(error instanceof UserDocError)
            || (error.code !== DOCUMENT_NOT_FOUND_CODE && error.code !== DOCUMENT_TRASHED_CODE
              && error.code !== DOCUMENT_UPLOAD_PROTOCOL_CODE)) throw error
          if (error.code === DOCUMENT_UPLOAD_PROTOCOL_CODE) await ctx.userDocs.remove(docId)
        }
      } else await ctx.userDocs.remove(docId)
      const runtime = runtimeForCatalog(ctx)
      if (runtime !== undefined) {
        try {
          const response = await runtime.request('/internal/runtime/documents/catalog/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: 1, source: 'legacy', documents: [], removed: [docId] }), principal: true,
          })
          void response
        } catch { /* the next full listing reconciles a deletion after an outage */ }
      }
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
  const warm = (ctx.userDocs as unknown as { warm?: () => Promise<void> }).warm
  if (typeof warm === 'function') {
    ctx.effect(() => {
      void warm.call(ctx.userDocs).catch(() => {
        // The first request will surface the authoritative runtime error and
        // the next boot/request retries initialization.
      })
      return () => {}
    }, 'host-userdoc-http: prewarm document store')
  }
  ctx.connection.http.handlePrefix(
    USERDOC_HTTP_PATH,
    (req, res) => handleUserDocHttp(ctx, req, res),
    { authority: 'trusted-host' },
  )
}
