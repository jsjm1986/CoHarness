/** Gateway broker for copying document snapshots between authorized personal and project scopes. */

import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import type { UserRow } from './auth.ts'
import type { GatewayPrincipalClaims, GatewayPrincipalSigner } from './principal.ts'
import { PRINCIPAL_HEADER } from './principal.ts'
import type {
  GatewayAuditService,
  GatewayCollaborationService,
  GatewayInstanceService,
  GatewayProjectService,
  GatewayUserService,
} from './services.ts'
import { RuntimeLeaseUnavailableError, type ProjectRuntime, type RuntimeTarget } from './instances.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'
import { readResponseJson, ResponseBodyTooLargeError } from './response-budget.ts'

const MAX_TRANSFER_FILES = 50
const MAX_DOCUMENT_ID_BYTES = 4096
const TRANSFER_PLAN_TTL_MS = 300_000
/** Upper bound for a target's asynchronous checksum/publication phase. */
const TRANSFER_VERIFY_MAX_WAIT_MS = TRANSFER_PLAN_TTL_MS
const MAX_TRANSFER_PLANS = 10_000
const DEFAULT_TRANSFER_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024
/** Default deadline for metadata operations forwarded to a document runtime. */
const DEFAULT_DOCUMENT_SCOPE_TIMEOUT_MS = 30_000
/** Bound one buffered transfer chunk even when a runtime advertises a bad value. */
const MAX_TRANSFER_CHUNK_BYTES = 64 * 1024 * 1024
/** Public Gateway path for resumable uploads into a non-current scope. */
export const DOCUMENT_TRANSFER_UPLOADS_PATH = '/api/documents/transfer/uploads'

interface TransferPlanRecord {
  readonly actorId: number
  readonly source: DocumentTransferScope
  readonly target: DocumentTransferScope
  readonly targets?: readonly DocumentTransferScope[]
  readonly directory?: string
  readonly documents: readonly DocumentTransferSelection[]
  readonly expiresAt: number
}

const transferPlans = new Map<string, TransferPlanRecord>()
let transferPlanCleanupTimer: ReturnType<typeof setTimeout> | undefined

function pruneTransferPlans(now = Date.now()): void {
  for (const [id, record] of transferPlans) {
    if (record.expiresAt <= now) transferPlans.delete(id)
  }
}

function scheduleTransferPlanCleanup(): void {
  if (transferPlanCleanupTimer !== undefined) return
  const nextExpiry = [...transferPlans.values()].reduce<number | undefined>(
    (earliest, record) => earliest === undefined ? record.expiresAt : Math.min(earliest, record.expiresAt),
    undefined,
  )
  if (nextExpiry === undefined) return
  const delay = Math.max(0, nextExpiry - Date.now())
  transferPlanCleanupTimer = setTimeout(() => {
    transferPlanCleanupTimer = undefined
    pruneTransferPlans()
    scheduleTransferPlanCleanup()
  }, delay)
  transferPlanCleanupTimer.unref?.()
}

/** Versioned scope selector accepted by the document transfer endpoint. */
export type DocumentTransferScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'project'; readonly projectId: number }

/** One source document selected for a snapshot copy. */
export interface DocumentTransferSelection {
  readonly docId: string
}

/** Validated transfer request after JSON decoding. */
export interface DocumentTransferRequest {
  readonly version: 1
  readonly planId?: string
  readonly source: DocumentTransferScope
  readonly target: DocumentTransferScope
  /** Administrator-only fan-out targets; absent for the ordinary one-target form. */
  readonly targets?: readonly DocumentTransferScope[]
  readonly directory?: string
  readonly documents: readonly DocumentTransferSelection[]
}

/** Safe target metadata returned after one document is copied. */
export interface DocumentTransferTargetRef {
  readonly docId: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
}

/** Per-file transfer outcome; a failed item never prevents later items from running. */
export type DocumentTransferItem =
  | {
    readonly status: 'copied'
    readonly source: { readonly name: string; readonly bytes: number; readonly mediaType: string }
    readonly target: DocumentTransferTargetRef
  }
  | {
    readonly status: 'failed'
    readonly source: { readonly name: string }
    readonly error: { readonly code: string; readonly message: string }
  }

/** Safe source/target label shown to a browser; ids and host paths stay out of this value. */
export interface DocumentTransferScopeSummary {
  readonly kind: 'personal' | 'project'
  readonly label: string
}

/** Versioned transfer response returned to the current runtime and browser client. */
export interface DocumentTransferResponse {
  readonly version: 1
  readonly transferId: string
  readonly source: DocumentTransferScopeSummary
  readonly target: DocumentTransferScopeSummary
  readonly items: readonly DocumentTransferItem[]
  /** Per-target results for an administrator fan-out operation. */
  readonly targets?: readonly {
    readonly transferId: string
    readonly target: DocumentTransferScopeSummary
    readonly items: readonly DocumentTransferItem[]
  }[]
}

/** Safe scope capability returned before a copy is started. */
export interface DocumentTransferCapability {
  readonly scope: DocumentTransferScope
  readonly label: string
  readonly canRead: boolean
  readonly canWrite: boolean
}

/** Versioned capabilities response for the active runtime principal. */
export interface DocumentTransferCapabilities {
  readonly version: 1
  readonly current: DocumentTransferScopeSummary
  readonly targets: readonly DocumentTransferCapability[]
}

/** Stable refusal raised by the broker before or during a transfer. */
export class DocumentTransferError extends Error {
  /** @param code - stable wire code. @param status - HTTP status for the runtime endpoint. */
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'DocumentTransferError'
  }
}

/** Runtime callback shape consumed by `createRuntimeApiHandler`. */
export interface RuntimeDocumentTransferHandler {
  (input: {
    readonly request: IncomingMessage
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    readonly signal: AbortSignal
  }): Promise<DocumentTransferResponse>
}

/** Runtime callback shape for the capability endpoint. */
export interface RuntimeDocumentTransferCapabilitiesHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    /** Aborts when the loopback caller disconnects. */
    readonly signal?: AbortSignal
  }): Promise<DocumentTransferCapabilities>
}

/** Runtime callback shape for an authorized alternate-scope listing. */
export interface RuntimeDocumentTransferListHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    /** Aborts when the loopback caller disconnects. */
    readonly signal?: AbortSignal
  }): Promise<DocumentTransferListResponse>
}

/** Safe metadata returned for one authorized alternate scope. */
export interface DocumentTransferListResponse {
  readonly version: 1
  readonly scope: DocumentTransferScopeSummary
  readonly documents: readonly DocumentTransferTargetRef[]
  /** Limits advertised by the selected runtime, when available. */
  readonly limits?: {
    readonly maxFileBytes: number | null
    readonly maxFilesPerMessage: number
    readonly maxMessageBytes: number
    readonly maxInlineTextBytes: number
    readonly upload: {
      readonly protocol: 'resumable-v1'
      readonly chunkBytes: number
      readonly sessionTtlMs: number
      readonly resumable: true
    }
  }
  readonly directoryId?: string
  readonly parentDirectoryId?: string
  readonly directories?: readonly { readonly directoryId: string; readonly name: string }[]
  readonly totalDocuments?: number
  readonly nextCursor?: string
}

/** Public Gateway callback for the browser-facing alternate-scope listing. */
export interface GatewayDocumentTransferListHandler {
  (input: {
    readonly user: UserRow
    readonly payload: unknown
    readonly signal: AbortSignal
  }): Promise<DocumentTransferListResponse>
}

/** Public Gateway callback for a target-scope resumable upload request. */
export interface GatewayDocumentTransferUploadHandler {
  (input: {
    /** Authenticated browser account. */
    readonly user: UserRow
    /** Original request stream; chunk bodies are forwarded without buffering. */
    readonly request: IncomingMessage
    /** Public upload pathname, validated by the Gateway server. */
    readonly pathname: string
    /** Target scope parsed from the public query string. */
    readonly scope: DocumentTransferScope
    /** Aborts when the browser disconnects. */
    readonly signal: AbortSignal
  }): Promise<Response>
}

/** Operations exposed by the authenticated full-scope document broker. */
export type GatewayDocumentScopeOperation = 'list' | 'directories' | 'content' | 'trash' | 'restore' | 'purge' | 'folders' | 'move' | 'delete'

/** Public Gateway callback for browsing or mutating one authorized scope. */
export interface GatewayDocumentScopeHandler {
  (input: {
    readonly user: UserRow
    readonly request: IncomingMessage
    readonly pathname: string
    readonly operation: GatewayDocumentScopeOperation
    readonly scope: DocumentTransferScope
    readonly signal: AbortSignal
  }): Promise<Response>
}

/** Administrator lifecycle operation forwarded to the catalog row's runtime. */
export interface GatewayDocumentAdminHandler {
  (input: {
    readonly user: UserRow
    readonly scope: DocumentTransferScope
    readonly personalOwnerId?: number
    readonly docId: string
    readonly action: 'trash' | 'restore' | 'purge'
    readonly signal: AbortSignal
  }): Promise<Response>
}

/** Runtime callback for target-folder metadata in an authorized scope. */
export interface RuntimeDocumentTransferDirectoriesHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    /** Aborts when the loopback caller disconnects. */
    readonly signal?: AbortSignal
  }): Promise<{
    readonly version: 1
    readonly scope: DocumentTransferScopeSummary
    readonly directories: readonly { readonly directoryId: string; readonly name: string }[]
  }>
}

/** Runtime callback for creating a folder in a writable target scope. */
export interface RuntimeDocumentTransferDirectoryCreateHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    /** Aborts when the loopback caller disconnects. */
    readonly signal?: AbortSignal
  }): Promise<{ readonly version: 1; readonly scope: DocumentTransferScopeSummary; readonly directory: { readonly directoryId: string; readonly name: string } }>
}

/** Runtime callback for a metadata-only copy plan. */
export interface RuntimeDocumentTransferPlanHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
    /** Aborts when the loopback caller disconnects. */
    readonly signal?: AbortSignal
  }): Promise<{
    readonly version: 1
    readonly planId: string
    readonly source: DocumentTransferScopeSummary
    readonly target: DocumentTransferScopeSummary
    readonly directory?: string
    readonly documents: readonly DocumentTransferTargetRef[]
    readonly expiresAt: number
    readonly targets?: readonly { readonly target: DocumentTransferScopeSummary; readonly documents: readonly DocumentTransferTargetRef[] }[]
  }>
}

/** Dependencies needed to authorize and stream one cross-scope transfer. */
export interface DocumentTransferDependencies {
  readonly instances: Pick<GatewayInstanceService, 'ensureRunning'> & Partial<Pick<GatewayInstanceService, 'operationRef'>>
  readonly users: Pick<GatewayUserService, 'getById'>
  readonly projects: Pick<GatewayProjectService, 'getById'>
  readonly collaboration: Pick<GatewayCollaborationService, 'projectForUser'>
    & Partial<Pick<GatewayCollaborationService, 'projectsForUser'>>
  readonly principals: GatewayPrincipalSigner
  readonly audit?: Pick<GatewayAuditService, 'write'>
  /** Optional metadata catalog; transfer remains functional during catalog maintenance. */
  readonly catalog?: Pick<PostgresDocumentCatalogService, 'recordCopy'>
  /** Maximum bytes retained from one runtime JSON response. */
  readonly maxResponseBytes?: number
  /** Deadline for one forwarded document metadata operation. */
  readonly upstreamTimeoutMs?: number
}

interface ScopeIdentity {
  readonly kind: 'personal' | 'project'
  readonly id: number
  readonly label: string
  readonly projectName?: string
  readonly mode?: 'ro' | 'rw'
}

interface RuntimeHandle {
  readonly target: RuntimeTarget
  readonly port: number
  readonly generation: number
  readonly scope: ScopeIdentity
}

/** Hold an instance operation lease across all work that uses a runtime. */
async function withRuntimeLeases<T>(
  deps: Pick<DocumentTransferDependencies, 'instances'>,
  runtimes: readonly RuntimeHandle[],
  operation: () => Promise<T>,
): Promise<T> {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const runtime of runtimes) {
      releases.push(await acquireRuntimeLease(deps, runtime))
    }
    return await operation()
  } finally {
    for (const release of releases.reverse()) await release().catch(() => {})
  }
}

/** Acquire one idempotent runtime lease for a request that may stream. */
async function acquireRuntimeLease(
  deps: Pick<DocumentTransferDependencies, 'instances'>,
  runtime: RuntimeHandle,
): Promise<() => Promise<void>> {
  try {
    await deps.instances.operationRef?.(runtime.target, 1, runtime.generation)
  } catch (error) {
    if (error instanceof RuntimeLeaseUnavailableError) {
      throw new DocumentTransferError(
        'COLLABORATION_UNAVAILABLE',
        503,
        'The document runtime is restarting; retry the operation.',
      )
    }
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await deps.instances.operationRef?.(runtime.target, -1, runtime.generation)
  }
}

/** Keep a runtime lease until a returned streaming response reaches EOF/cancel. */
function leaseResponse(response: Response, release: () => Promise<void>): Response {
  if (response.body === null) {
    void release().catch(() => {})
    return response
  }
  let released = false
  const finish = async (): Promise<void> => {
    if (released) return
    released = true
    await release().catch(() => {})
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await finish()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
      await finish()
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validRelativeId(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_DOCUMENT_ID_BYTES
    || (!allowEmpty && value === '')) return false
  if (value === '') return allowEmpty
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && !segment.includes('\\') && !segment.includes('\u0000'))
}

function scope(value: unknown): DocumentTransferScope {
  const candidate = record(value)
  if (candidate?.kind === 'personal') return { kind: 'personal' }
  if (candidate?.kind === 'project' && positiveInteger(candidate.projectId)) {
    return { kind: 'project', projectId: candidate.projectId }
  }
  throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document transfer scope.')
}

/** Decode the compact scope key used by the browser-facing upload route. */
export function parseDocumentScopeKey(value: unknown): DocumentTransferScope {
  if (value === 'personal') return { kind: 'personal' }
  if (typeof value === 'string' && /^project:[1-9][0-9]*$/u.test(value)) {
    const projectId = Number(value.slice('project:'.length))
    if (Number.isSafeInteger(projectId) && projectId > 0) return { kind: 'project', projectId }
  }
  throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document upload scope.')
}

function requestValue(value: unknown): DocumentTransferRequest {
  const candidate = record(value)
  if (candidate?.version !== 1 || !Array.isArray(candidate.documents)
    || candidate.documents.length === 0 || candidate.documents.length > MAX_TRANSFER_FILES) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document transfer request.')
  }
  const source = scope(candidate.source)
  if (candidate.planId !== undefined && (typeof candidate.planId !== 'string' || candidate.planId === '' || candidate.planId.length > 128)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid transfer plan id.')
  }
  const rawTargets = candidate.targets
  if (rawTargets !== undefined && (!Array.isArray(rawTargets) || rawTargets.length < 2 || rawTargets.length > 20)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document transfer targets.')
  }
  const targets = rawTargets === undefined ? undefined : rawTargets.map(scope)
  if (targets !== undefined) {
    const keys = targets.map(item => item.kind === 'personal' ? 'personal' : `project:${String(item.projectId)}`)
    if (new Set(keys).size !== keys.length) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Duplicate document transfer target.')
    }
  }
  const target = scope(candidate.target ?? targets?.[0])
  if (targets !== undefined && candidate.target !== undefined && !sameScope(target, targets[0]!)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'The primary transfer target must match the first target.')
  }
  if (sameScope(source, target)) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_SAME_SCOPE', 409, 'The source and target scopes must differ.')
  }
  const directory = candidate.directory
  if (directory !== undefined && !validRelativeId(directory, true)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid target document directory.')
  }
  const seen = new Set<string>()
  const documents = candidate.documents.map((entry) => {
    const item = record(entry)
    if (!validRelativeId(item?.docId, false) || seen.has(item.docId)) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid or duplicate source document id.')
    }
    seen.add(item.docId)
    return { docId: item.docId }
  })
  return {
    version: 1,
    ...(typeof candidate.planId === 'string' && candidate.planId !== '' ? { planId: candidate.planId } : {}),
    source,
    target,
    ...(targets === undefined ? {} : { targets }),
    ...(directory === undefined ? {} : { directory }),
    documents,
  }
}

function sameScope(left: DocumentTransferScope, right: DocumentTransferScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'personal' || right.kind === 'personal') return true
  return left.projectId === right.projectId
}

function sourceName(docId: string): string {
  const leaf = basename(docId)
  return leaf === '' ? 'document' : leaf
}

function responseError(value: unknown): { code: string; message: string } {
  const body = record(value)
  const error = record(body?.error)
  const rawCode = typeof error?.code === 'string' ? error.code : ''
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'DOCUMENT_TRANSFER_FAILED'
  const rawMessage = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : 'Document transfer failed.'
  const message = rawMessage.length <= 240 && !/[\u0000-\u001f\u007f]|[/\\]/u.test(rawMessage)
    ? rawMessage
    : 'Document transfer failed.'
  return { code, message }
}

function responseLimit(deps: Pick<DocumentTransferDependencies, 'maxResponseBytes'>): number {
  return deps.maxResponseBytes ?? DEFAULT_TRANSFER_RESPONSE_LIMIT_BYTES
}

function documentScopeTimeoutMs(
  deps: Pick<DocumentTransferDependencies, 'upstreamTimeoutMs'>,
): number {
  return deps.upstreamTimeoutMs ?? DEFAULT_DOCUMENT_SCOPE_TIMEOUT_MS
}

function documentScopeLogKey(scope: DocumentTransferScope): string {
  return scope.kind === 'personal' ? 'personal' : `project:${String(scope.projectId)}`
}

function documentScopeTimeoutError(
  operation: GatewayDocumentScopeOperation,
  scope: DocumentTransferScope,
  startedAt: number,
): DocumentTransferError {
  console.warn(
    `[gateway] document scope upstream timeout operation=${operation} scope=${documentScopeLogKey(scope)} elapsedMs=${String(Date.now() - startedAt)}`,
  )
  return new DocumentTransferError('DOCUMENT_SCOPE_TIMEOUT', 504, 'Document scope request timed out.')
}

async function responseJson(response: Response, limit = DEFAULT_TRANSFER_RESPONSE_LIMIT_BYTES): Promise<unknown> {
  return readResponseJson(response, limit)
}

interface StartedSnapshotUpload {
  readonly uploadId: string
  readonly chunkBytes: number
  readonly receivedBytes: number
  readonly state: 'uploading' | 'verifying' | 'complete' | 'failed'
  readonly ref?: unknown
}

/** Wait for a short polling interval without losing request cancellation. */
function waitForTransferPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => finish(signal.reason)
    timer = setTimeout(() => finish(), delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Start a target upload and release the source body when setup fails. */
async function startSnapshotUpload(
  targetRuntime: RuntimeHandle,
  targetAssertion: string,
  source: Response,
  name: string,
  directory: string,
  bytes: number,
  fingerprint: string,
  signal: AbortSignal,
  responseLimit: number,
): Promise<StartedSnapshotUpload> {
  try {
    const base = `http://127.0.0.1:${String(targetRuntime.port)}/api/documents/uploads`
    const authHeaders = headersFor(targetRuntime, targetAssertion)
    authHeaders.set('content-type', 'application/json')
    const started = await fetch(base, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ version: 1, name, directory, bytes, fingerprint }),
      signal,
    })
    const startedBody = await responseJson(started, responseLimit)
    if (!started.ok) {
      const error = responseError(startedBody)
      throw new DocumentTransferError(error.code, started.status, error.message)
    }
    const startedValue = record(startedBody)
    if (typeof startedValue?.uploadId !== 'string' || !/^[0-9a-f-]{36}$/u.test(startedValue.uploadId)
      || typeof startedValue.chunkBytes !== 'number'
      || !Number.isSafeInteger(startedValue.chunkBytes) || startedValue.chunkBytes <= 0
      || startedValue.chunkBytes > MAX_TRANSFER_CHUNK_BYTES
      || typeof startedValue.receivedBytes !== 'number' || !Number.isSafeInteger(startedValue.receivedBytes)
      || startedValue.receivedBytes < 0 || startedValue.receivedBytes > bytes
      || (startedValue.state !== 'uploading' && startedValue.state !== 'verifying'
        && startedValue.state !== 'complete' && startedValue.state !== 'failed')) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid upload session metadata.')
    }
    if (startedValue.state === 'failed') {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime rejected the upload session.')
    }
    return {
      uploadId: startedValue.uploadId,
      chunkBytes: startedValue.chunkBytes,
      receivedBytes: startedValue.receivedBytes,
      state: startedValue.state,
      ...(startedValue.ref === undefined ? {} : { ref: startedValue.ref }),
    }
  } catch (error) {
    // The target can reject setup before it reads the source response. Cancel
    // that body explicitly so its keep-alive socket is reusable and no stream
    // remains attached to the transfer operation.
    await source.body?.cancel().catch(() => {})
    throw error
  }
}

function targetRef(value: unknown): DocumentTransferTargetRef {
  const candidate = record(value)
  if (!validRelativeId(candidate?.docId, false) || !nonEmptyString(candidate.name)
    || candidate.name.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(candidate.name)
    || typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0
    || !nonEmptyString(candidate.mediaType) || candidate.mediaType.length > 255 || /[\u0000-\u001f\u007f]/u.test(candidate.mediaType)
    || typeof candidate.modifiedAt !== 'number' || !Number.isFinite(candidate.modifiedAt)) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid document metadata.')
  }
  return {
    docId: candidate.docId,
    name: candidate.name,
    bytes: candidate.bytes,
    mediaType: candidate.mediaType,
    modifiedAt: candidate.modifiedAt,
  }
}

function documentLimits(value: unknown): DocumentTransferListResponse['limits'] {
  if (value === undefined) return undefined
  const row = record(value)
  const upload = record(row?.upload)
  if (row === undefined || upload === undefined
    || (row.maxFileBytes !== null && (!Number.isSafeInteger(row.maxFileBytes) || (row.maxFileBytes as number) < 1))
    || !Number.isSafeInteger(row.maxFilesPerMessage) || (row.maxFilesPerMessage as number) < 1
    || !Number.isSafeInteger(row.maxMessageBytes) || (row.maxMessageBytes as number) < 1
    || !Number.isSafeInteger(row.maxInlineTextBytes) || (row.maxInlineTextBytes as number) < 1
    || upload.protocol !== 'resumable-v1' || !Number.isSafeInteger(upload.chunkBytes) || (upload.chunkBytes as number) < 1
    || !Number.isSafeInteger(upload.sessionTtlMs) || (upload.sessionTtlMs as number) < 1 || upload.resumable !== true) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid document limits.')
  }
  return {
    maxFileBytes: row.maxFileBytes as number | null,
    maxFilesPerMessage: row.maxFilesPerMessage as number,
    maxMessageBytes: row.maxMessageBytes as number,
    maxInlineTextBytes: row.maxInlineTextBytes as number,
    upload: {
      protocol: 'resumable-v1',
      chunkBytes: upload.chunkBytes as number,
      sessionTtlMs: upload.sessionTtlMs as number,
      resumable: true,
    },
  }
}

async function uploadSnapshotToRuntime(
  targetRuntime: RuntimeHandle,
  targetAssertion: string,
  source: Response,
  name: string,
  directory: string,
  bytes: number,
  fingerprint: string,
  signal: AbortSignal,
  responseLimit: number,
): Promise<DocumentTransferTargetRef> {
  if (source.body === null || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The source runtime did not provide a usable document body.')
  }
  const base = `http://127.0.0.1:${String(targetRuntime.port)}/api/documents/uploads`
  const startedValue = await startSnapshotUpload(
    targetRuntime, targetAssertion, source, name, directory, bytes, fingerprint, signal, responseLimit,
  )
  const uploadId = startedValue.uploadId
  if (startedValue.state === 'complete') {
    await source.body.cancel()
    const completed = targetRef(startedValue.ref)
    if (completed.bytes !== bytes) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned an unexpected document size.')
    }
    return completed
  }
  const reader = source.body.getReader()
  const finalHash = createHash('sha256')
  const pendingChunks: Buffer[] = []
  let pendingHead = 0
  let pendingBytes = 0
  let done = false
  let offset = 0
  let index = 0
  if (startedValue.receivedBytes !== bytes
    && startedValue.receivedBytes % startedValue.chunkBytes !== 0) {
    await reader.cancel().catch(() => {})
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned an invalid upload offset.')
  }
  const takePending = (maximum: number): Buffer => {
    const length = Math.min(maximum, pendingBytes)
    const first = pendingChunks[pendingHead]
    if (first !== undefined && first.byteLength === length) {
      pendingHead += 1
      pendingBytes -= length
      if (pendingHead === pendingChunks.length) {
        pendingChunks.length = 0
        pendingHead = 0
      }
      return first
    }
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      const chunk = pendingChunks[pendingHead]
      if (chunk === undefined) break
      const count = Math.min(chunk.byteLength, length - written)
      chunk.copy(output, written, 0, count)
      written += count
      pendingBytes -= count
      if (count === chunk.byteLength) pendingHead += 1
      else pendingChunks[pendingHead] = chunk.subarray(count)
    }
    if (pendingHead === pendingChunks.length) {
      pendingChunks.length = 0
      pendingHead = 0
    }
    return output
  }
  try {
    while (offset < bytes) {
      while (!done && pendingBytes < startedValue.chunkBytes) {
        const next = await reader.read()
        if (next.done) { done = true; break }
        const chunk = Buffer.from(next.value)
        if (chunk.byteLength > 0) {
          const remaining = bytes - offset - pendingBytes
          if (chunk.byteLength > remaining) {
            throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The source document byte count changed during transfer.')
          }
          pendingChunks.push(chunk)
          pendingBytes += chunk.byteLength
        }
      }
      if (pendingBytes === 0) break
      const chunk = takePending(startedValue.chunkBytes)
      finalHash.update(chunk)
      const chunkHash = createHash('sha256').update(chunk).digest('hex')
      if (offset >= startedValue.receivedBytes) {
        const headers = headersFor(targetRuntime, targetAssertion)
        headers.set('content-range', `bytes ${String(offset)}-${String(offset + chunk.byteLength - 1)}/${String(bytes)}`)
        headers.set('content-length', String(chunk.byteLength))
        headers.set('x-dsh-chunk-sha256', chunkHash)
        const response = await fetch(`${base}/${encodeURIComponent(uploadId)}/chunks/${String(index)}`, {
          method: 'PUT', headers, body: chunk, signal, duplex: 'half',
        } as RequestInit & { duplex: 'half' })
        const body = await responseJson(response, responseLimit)
        if (!response.ok) {
          const error = responseError(body)
          throw new DocumentTransferError(error.code, response.status, error.message)
        }
        const chunkState = record(body)
        if (typeof chunkState?.receivedBytes !== 'number' || !Number.isSafeInteger(chunkState.receivedBytes)
          || chunkState.receivedBytes < offset + chunk.byteLength || chunkState.receivedBytes > bytes
          || (chunkState.state !== undefined && chunkState.state !== 'uploading'
            && chunkState.state !== 'verifying' && chunkState.state !== 'complete')) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid chunk progress.')
        }
      }
      offset += chunk.byteLength
      index += 1
    }
    if (offset !== bytes || pendingBytes !== 0) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The source document byte count changed during transfer.')
    }
    const completeHeaders = headersFor(targetRuntime, targetAssertion)
    completeHeaders.set('content-type', 'application/json')
    let currentResponse = await fetch(`${base}/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST', headers: completeHeaders,
      body: JSON.stringify({ version: 1, sha256: finalHash.digest('hex') }), signal,
    })
    let currentBody = await responseJson(currentResponse, responseLimit)
    if (!currentResponse.ok) {
      const error = responseError(currentBody)
      throw new DocumentTransferError(error.code, currentResponse.status, error.message)
    }
    const verifyDeadline = Date.now() + TRANSFER_VERIFY_MAX_WAIT_MS
    for (;;) {
      const value = record(currentBody)
      if (value?.state !== 'verifying') break
      const remaining = verifyDeadline - Date.now()
      if (remaining <= 0) {
        throw new DocumentTransferError(
          'DOCUMENT_TRANSFER_VERIFY_TIMEOUT',
          504,
          'The target runtime did not finish verifying the document in time.',
        )
      }
      await waitForTransferPoll(Math.min(100, remaining), signal)
      currentResponse = await fetch(`${base}/${encodeURIComponent(uploadId)}`, { headers: headersFor(targetRuntime, targetAssertion), signal })
      currentBody = await responseJson(currentResponse, responseLimit)
      if (!currentResponse.ok) {
        const error = responseError(currentBody)
        throw new DocumentTransferError(error.code, currentResponse.status, error.message)
      }
    }
    const finalValue = record(currentBody)
    if (finalValue?.state !== 'complete') {
      const error = responseError({ error: finalValue?.error })
      throw new DocumentTransferError(error.code, 502, error.message)
    }
    const completed = targetRef(finalValue.ref)
    if (completed.bytes !== bytes) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned an unexpected document size.')
    }
    return completed
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    await fetch(`${base}/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE', headers: headersFor(targetRuntime, targetAssertion), signal: undefined,
    }).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

function syntheticUser(principal: GatewayPrincipalClaims): UserRow {
  return {
    id: principal.user.id,
    username: principal.user.username,
    displayName: principal.user.displayName,
    role: principal.user.role,
    status: 'active',
    homePath: '',
    mustChangePassword: false,
  }
}

async function runtimeFor(
  deps: DocumentTransferDependencies,
  identity: ScopeIdentity,
  actor: UserRow,
): Promise<RuntimeHandle> {
  if (identity.kind === 'personal') {
    let user: UserRow | null
    try {
      user = await deps.users.getById(actor.id)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document scope lookup is unavailable.')
    }
    if (user === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
    let running: { port: number; generation: number }
    try {
      running = await deps.instances.ensureRunning(user)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Personal document runtime is unavailable.')
    }
    return {
      target: { kind: 'user', id: actor.id },
      port: running.port,
      generation: running.generation,
      scope: identity,
    }
  }
  let project: Awaited<ReturnType<GatewayProjectService['getById']>>
  try {
    project = await deps.projects.getById(identity.id)
  } catch {
    throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document scope lookup is unavailable.')
  }
  if (project === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Project document scope is unavailable.')
  let running: { port: number; generation: number }
  try {
    running = await deps.instances.ensureRunning({
      kind: 'project',
      id: project.id,
      name: project.name,
      path: project.path,
    } satisfies ProjectRuntime)
  } catch {
    throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document runtime is unavailable.')
  }
  return {
    target: { kind: 'project', id: project.id },
    port: running.port,
    generation: running.generation,
    scope: identity,
  }
}

function headersFor(handle: RuntimeHandle, assertion: string): Headers {
  const authority = `127.0.0.1:${String(handle.port)}`
  return new Headers({
    host: authority,
    origin: `http://${authority}`,
    [PRINCIPAL_HEADER]: assertion,
  })
}

interface AuthorizedScope {
  readonly identity: ScopeIdentity
  readonly runtime: RuntimeHandle
  readonly assertion: string
}

/** Resolve one browser-requested scope and issue a principal for its runtime. */
async function authorizedScope(
  deps: DocumentTransferDependencies,
  actor: UserRow,
  requested: DocumentTransferScope,
  action: 'read' | 'write',
): Promise<AuthorizedScope> {
  if (requested.kind === 'personal') {
    const identity: ScopeIdentity = { kind: 'personal', id: actor.id, label: 'Personal documents' }
    const runtime = await runtimeFor(deps, identity, actor)
    return {
      identity,
      runtime,
      assertion: deps.principals.issue({
        user: actor,
        scope: { kind: 'personal' },
        runtime: { kind: runtime.target.kind, id: runtime.target.id, generation: runtime.generation },
      }),
    }
  }

  let membership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>>
  try {
    membership = await deps.collaboration.projectForUser(requested.projectId, actor.id)
  } catch {
    throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Project document authorization is unavailable.')
  }
  if (membership === null) {
    throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot access this project document scope.')
  }
  if (action === 'write' && membership.mode !== 'rw' && !membership.administrator) {
    throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot modify this project document scope.')
  }
  const identity: ScopeIdentity = {
    kind: 'project',
    id: requested.projectId,
    label: membership.name,
    projectName: membership.name,
    mode: membership.mode,
  }
  const runtime = await runtimeFor(deps, identity, actor)
  return {
    identity,
    runtime,
    assertion: deps.principals.issue({
      user: actor,
      scope: {
        kind: 'project',
        projectId: requested.projectId,
        projectName: membership.name,
        mode: action === 'write' ? 'rw' : membership.mode,
      },
      runtime: { kind: runtime.target.kind, id: runtime.target.id, generation: runtime.generation },
    }),
  }
}

async function audit(
  deps: DocumentTransferDependencies,
  principal: GatewayPrincipalClaims,
  transferId: string,
  source: ScopeIdentity,
  target: ScopeIdentity,
  item: { docId: string; name: string; status: string; targetDocId?: string; bytes?: number; code?: string },
): Promise<void> {
  if (deps.audit === undefined) return
  await deps.audit.write({
    userId: principal.user.id,
    action: 'documents.transfer',
    status: item.status === 'copied' ? 201 : 502,
    detail: JSON.stringify({
      version: 1,
      transferId,
      source: { kind: source.kind, id: source.id, documentId: item.docId, name: item.name },
      target: {
        kind: target.kind,
        id: target.id,
        ...(item.targetDocId === undefined ? {} : { documentId: item.targetDocId }),
      },
      status: item.status,
      ...(item.bytes === undefined ? {} : { bytes: item.bytes }),
      ...(item.code === undefined ? {} : { code: item.code }),
    }),
  })
}

/** Create the authenticated Gateway broker used by runtime document consumers. */
function createSingleDocumentTransferHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferHandler {
  return async ({ subject, principal, payload, signal }) => {
    const input = requestValue(payload)
    const actor = syntheticUser(principal)
    // The signed principal identifies the actor; scope membership checks below
    // authorize arbitrary project pairs without requiring a scope switch first.

    let sourceMembership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>> = null
    if (input.source.kind === 'project') {
      try {
        sourceMembership = await deps.collaboration.projectForUser(input.source.projectId, actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Source project authorization is unavailable.')
      }
    }
    if (input.source.kind === 'project' && sourceMembership === null) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot read this project document scope.')
    }
    let targetMembership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>> = null
    if (input.target.kind === 'project') {
      try {
        targetMembership = await deps.collaboration.projectForUser(input.target.projectId, actor.id)
      } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Target project authorization is unavailable.')
      }
    }
    if (input.target.kind === 'project'
      && (targetMembership === null || (targetMembership.mode !== 'rw' && !targetMembership.administrator))) {
      throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot add documents to this project scope.')
    }

    const sourceIdentity: ScopeIdentity = input.source.kind === 'personal'
      ? { kind: 'personal', id: actor.id, label: 'Personal documents' }
      : {
        kind: 'project',
        id: input.source.projectId,
        label: sourceMembership?.name ?? 'Project documents',
        projectName: sourceMembership?.name,
        mode: sourceMembership?.mode,
      }
    const targetIdentity: ScopeIdentity = input.target.kind === 'personal'
      ? { kind: 'personal', id: actor.id, label: 'Personal documents' }
      : {
        kind: 'project',
        id: input.target.projectId,
        label: targetMembership?.name ?? 'Project documents',
        projectName: targetMembership?.name,
        mode: targetMembership?.mode,
      }

    const [sourceRuntime, targetRuntime] = await Promise.all([
      runtimeFor(deps, sourceIdentity, actor),
      runtimeFor(deps, targetIdentity, actor),
    ])
    const sourceAssertion = deps.principals.issue({
      user: actor,
      scope: sourceIdentity.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: sourceIdentity.id,
          projectName: sourceIdentity.projectName ?? sourceIdentity.label,
          mode: sourceIdentity.mode ?? 'ro',
        },
      runtime: { kind: sourceRuntime.target.kind, id: sourceRuntime.target.id, generation: sourceRuntime.generation },
    })
    const targetAssertion = deps.principals.issue({
      user: actor,
      scope: targetIdentity.kind === 'personal'
        ? { kind: 'personal' }
        : {
          kind: 'project',
          projectId: targetIdentity.id,
          projectName: targetIdentity.projectName ?? targetIdentity.label,
          mode: targetIdentity.mode ?? 'rw',
        },
      runtime: { kind: targetRuntime.target.kind, id: targetRuntime.target.id, generation: targetRuntime.generation },
    })
    return withRuntimeLeases(deps, [sourceRuntime, targetRuntime], async () => {
      const transferId = randomUUID()
      const items: DocumentTransferItem[] = []
      for (const document of input.documents) {
      signal.throwIfAborted()
      const name = sourceName(document.docId)
      try {
        const sourceUrl = `http://127.0.0.1:${String(sourceRuntime.port)}/api/documents/content?id=${encodeURIComponent(document.docId)}`
        const sourceResponse = await fetch(sourceUrl, {
          method: 'GET',
          headers: headersFor(sourceRuntime, sourceAssertion),
          signal,
        })
        if (!sourceResponse.ok || sourceResponse.body === null) {
          const error = responseError(await responseJson(sourceResponse, responseLimit(deps)))
          const status = sourceResponse.status >= 400 && sourceResponse.status < 500 ? sourceResponse.status : 502
          throw new DocumentTransferError(error.code, status, error.message)
        }
        const mediaType = (sourceResponse.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0] ?? 'application/octet-stream'
        const lengthHeader = sourceResponse.headers.get('content-length')
        const declaredBytes = lengthHeader === null ? undefined : Number(lengthHeader)
        if (declaredBytes === undefined || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The source runtime did not provide a stable document size.')
        }
        const ref = await uploadSnapshotToRuntime(
          targetRuntime,
          targetAssertion,
          sourceResponse,
          name,
          input.directory ?? '',
          declaredBytes,
          createHash('sha256').update(`${transferId}\u0000${document.docId}`).digest('hex'),
          signal,
          responseLimit(deps),
        )
        const bytes = declaredBytes !== undefined && Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
          ? declaredBytes
          : ref.bytes
        items.push({ status: 'copied', source: { name, bytes, mediaType }, target: ref })
        await deps.catalog?.recordCopy({
          actorUserId: principal.user.id,
          source: input.source.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.source.projectId },
          targetScope: input.target.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.target.projectId },
          sourceDocId: document.docId,
          sourceName: name,
          target: {
            docId: ref.docId,
            directoryId: String(ref.docId).split('/').slice(0, -1).join('/'),
            name: ref.name,
            bytes: ref.bytes,
            mediaType: ref.mediaType,
            modifiedAt: ref.modifiedAt,
          },
          operationId: transferId,
        }).catch(() => {})
        await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
          docId: document.docId, name, status: 'copied', targetDocId: ref.docId, bytes,
        })
      } catch (error) {
        if (error instanceof DocumentTransferError && error.status === 404) {
          const item = { status: 'failed' as const, source: { name }, error: { code: error.code, message: error.message } }
          items.push(item)
          await deps.catalog?.recordCopy({
            actorUserId: principal.user.id,
            source: input.source.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.source.projectId },
            targetScope: input.target.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.target.projectId },
            sourceDocId: document.docId,
            sourceName: name,
            error: item.error,
            operationId: transferId,
          }).catch(() => {})
          await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
            docId: document.docId, name, status: 'failed', code: error.code,
          })
          continue
        }
        if (signal.aborted) throw signal.reason
        const item = {
          status: 'failed' as const,
          source: { name },
          error: error instanceof DocumentTransferError
            ? { code: error.code, message: error.message }
            : { code: 'DOCUMENT_TRANSFER_FAILED', message: 'Document transfer failed.' },
        }
        items.push(item)
        await deps.catalog?.recordCopy({
          actorUserId: principal.user.id,
          source: input.source.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.source.projectId },
          targetScope: input.target.kind === 'personal' ? { kind: 'personal', userId: principal.user.id } : { kind: 'project', projectId: input.target.projectId },
          sourceDocId: document.docId,
          sourceName: name,
          error: item.error,
          operationId: transferId,
        }).catch(() => {})
        await audit(deps, principal, transferId, sourceIdentity, targetIdentity, {
          docId: document.docId, name, status: 'failed', code: item.error.code,
        })
      }
      }
      return {
        version: 1,
        transferId,
        source: { kind: sourceIdentity.kind, label: sourceIdentity.label },
        target: { kind: targetIdentity.kind, label: targetIdentity.label },
        items,
      }
    })
  }
}

/** Create the transfer broker, including administrator fan-out targets. */
export function createDocumentTransferHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferHandler {
  const single = createSingleDocumentTransferHandler(deps)
  return async (input) => {
    const request = requestValue(input.payload)
    if (request.targets === undefined || request.targets.length <= 1) return single(input)
    if (input.principal.user.role !== 'admin') {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN', 403, 'Only organization administrators can copy to multiple project targets.')
    }
    const seenTargets = new Set(request.targets.map(target => target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`))
    if (seenTargets.size !== request.targets.length) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Duplicate document transfer target.')
    }
    const results: Array<{
      readonly transferId: string
      readonly source: DocumentTransferScopeSummary
      readonly target: DocumentTransferScopeSummary
      readonly items: readonly DocumentTransferItem[]
    }> = []
    for (const target of request.targets) {
      try {
        const result = await single({
          ...input,
          payload: {
            version: 1,
            source: request.source,
            target,
            ...(request.directory === undefined ? {} : { directory: request.directory }),
            documents: request.documents,
          },
        })
        results.push({ transferId: result.transferId, source: result.source, target: result.target, items: result.items })
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason
        if (!(error instanceof DocumentTransferError)) throw error
        const targetLabel = target.kind === 'personal' ? 'Personal documents' : 'Project documents'
        results.push({
          transferId: randomUUID(),
          source: { kind: request.source.kind, label: request.source.kind === 'personal' ? 'Personal documents' : 'Project documents' },
          target: { kind: target.kind, label: targetLabel },
          items: request.documents.map(document => ({
            status: 'failed' as const,
            source: { name: sourceName(document.docId) },
            error: { code: error.code, message: error.message },
          })),
        })
      }
    }
    const first = results[0]
    if (first === undefined) throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'No transfer target was supplied.')
    return {
      version: 1,
      transferId: randomUUID(),
      source: first.source,
      target: first.target,
      items: first.items,
      targets: results,
    }
  }
}

/** Create a commit wrapper that consumes a metadata-only plan token. */
export function createDocumentTransferCommitHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferHandler {
  const transfer = createDocumentTransferHandler(deps)
  return async (input) => {
    const request = requestValue(input.payload)
    if (request.planId === undefined) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_PLAN_REQUIRED', 400, 'A transfer plan is required before commit.')
    }
    const plan = transferPlans.get(request.planId)
    if (plan === undefined || plan.expiresAt <= Date.now() || plan.actorId !== input.principal.user.id) {
      transferPlans.delete(request.planId)
      scheduleTransferPlanCleanup()
      throw new DocumentTransferError('DOCUMENT_TRANSFER_PLAN_EXPIRED', 409, 'The transfer plan has expired or belongs to another actor.')
    }
    if (JSON.stringify(plan.source) !== JSON.stringify(request.source)
      || JSON.stringify(plan.target) !== JSON.stringify(request.target)
      || JSON.stringify(plan.targets) !== JSON.stringify(request.targets)
      || plan.directory !== request.directory
      || JSON.stringify(plan.documents) !== JSON.stringify(request.documents)) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_PLAN_MISMATCH', 409, 'The transfer request does not match its plan.')
    }
    transferPlans.delete(request.planId)
    scheduleTransferPlanCleanup()
    return transfer({ ...input, payload: { ...record(input.payload), planId: undefined } })
  }
}

/** Create the safe scope-capability projection used by document-manager clients. */
export function createDocumentTransferCapabilitiesHandler(
  deps: Pick<DocumentTransferDependencies, 'collaboration'>,
): RuntimeDocumentTransferCapabilitiesHandler {
  return async ({ subject, principal }) => {
    const current = subject.target.kind === 'user'
      ? { kind: 'personal' as const, label: 'Personal documents' }
      : {
        kind: 'project' as const,
        label: principal.scope.kind === 'project' ? principal.scope.projectName : 'Project documents',
      }
    if (deps.collaboration.projectsForUser === undefined) {
      return {
        version: 1,
        current,
        targets: subject.target.kind === 'user'
          ? []
          : [{ scope: { kind: 'personal' }, label: 'Personal documents', canRead: true, canWrite: true }],
      }
    }
    let projects: Awaited<ReturnType<GatewayCollaborationService['projectsForUser']>>
    try {
      projects = await deps.collaboration.projectsForUser(principal.user.id)
    } catch {
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope capabilities are unavailable.')
    }
    const projectTargets = projects.filter(project => subject.target.kind !== 'project' || project.projectId !== subject.target.id).map(project => ({
      scope: { kind: 'project' as const, projectId: project.projectId },
      label: project.name,
      canRead: true,
      canWrite: project.mode === 'rw' || principal.user.role === 'admin',
    }))
    // Include the active scope as a candidate. The client removes same-scope
    // choices after it knows the source document, while keeping this entry is
    // necessary for project-to-current-project and project-to-personal copies
    // launched from the all-scope overview.
    const currentTarget: DocumentTransferCapability = subject.target.kind === 'user'
      ? { scope: { kind: 'personal' }, label: 'Personal documents', canRead: true, canWrite: true }
      : {
        scope: { kind: 'project', projectId: subject.target.id },
        label: current.label,
        canRead: true,
        canWrite: principal.user.role === 'admin'
          || (principal.scope.kind === 'project' && principal.scope.mode === 'rw'),
      }
    const targets: DocumentTransferCapability[] = subject.target.kind === 'user'
      ? [currentTarget, ...projectTargets]
      : [currentTarget, { scope: { kind: 'personal' as const }, label: 'Personal documents', canRead: true, canWrite: true }, ...projectTargets]
    return {
      version: 1,
      current,
      targets,
    }
  }
}

/** Create the Gateway list operation for one authorized alternate scope. */
async function listDocumentsForActor(
  deps: DocumentTransferDependencies,
  actor: UserRow,
  payload: unknown,
  signal?: AbortSignal,
): Promise<DocumentTransferListResponse> {
  signal?.throwIfAborted()
  const candidate = record(payload)
  if (candidate?.version !== 1) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope listing request.')
  }
  const requested = scope(candidate.scope)
  if (candidate.directory !== undefined && !validRelativeId(candidate.directory, true)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope directory.')
  }
  if (candidate.cursor !== undefined && (typeof candidate.cursor !== 'string' || candidate.cursor.length === 0 || candidate.cursor.length > 4096)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope cursor.')
  }
  if (candidate.limit !== undefined && (!Number.isSafeInteger(candidate.limit) || (candidate.limit as number) < 1 || (candidate.limit as number) > 100)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope page size.')
  }
  if (candidate.query !== undefined && (typeof candidate.query !== 'string' || candidate.query.length > 255)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope search.')
  }
  if (candidate.type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(candidate.type as string)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope type.')
  }
  if (candidate.sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(candidate.sort as string)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope sort.')
  }
  if (candidate.state !== undefined && candidate.state !== 'active' && candidate.state !== 'trash') {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document scope state.')
  }
  const authorized = await authorizedScope(deps, actor, requested, 'read')
  return withRuntimeLeases(deps, [authorized.runtime], async () => {
    const runtimeUrl = new URL(`http://127.0.0.1:${String(authorized.runtime.port)}/api/documents`)
    if (typeof candidate.directory === 'string') runtimeUrl.searchParams.set('directory', candidate.directory)
    if (typeof candidate.cursor === 'string') runtimeUrl.searchParams.set('cursor', candidate.cursor)
    if (typeof candidate.limit === 'number') runtimeUrl.searchParams.set('limit', String(candidate.limit))
    if (typeof candidate.query === 'string' && candidate.query !== '') runtimeUrl.searchParams.set('q', candidate.query)
    if (typeof candidate.type === 'string' && candidate.type !== 'all') runtimeUrl.searchParams.set('type', candidate.type)
    if (typeof candidate.sort === 'string') runtimeUrl.searchParams.set('sort', candidate.sort)
    if (typeof candidate.state === 'string' && candidate.state !== 'active') runtimeUrl.searchParams.set('state', candidate.state)
    let response: Response
    try {
      response = await fetch(runtimeUrl.toString(), {
        method: 'GET',
        headers: headersFor(authorized.runtime, authorized.assertion),
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope listing is unavailable.')
    }
    const body = await responseJson(response, responseLimit(deps))
    if (!response.ok) {
      const error = responseError(body)
      const status = response.status >= 400 && response.status < 500 ? response.status : 503
      throw new DocumentTransferError(error.code, status, error.message)
    }
    const value = record(body)
    if (!Array.isArray(value?.documents)) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned an invalid listing.')
    }
    const documents = value.documents.map(targetRef)
    const directories = value.directories === undefined ? undefined : Array.isArray(value.directories)
      ? value.directories.map((entry) => {
        const item = record(entry)
        if (!validRelativeId(item?.directoryId, true) || !nonEmptyString(item.name) || item.name.length > 255
          || /[\\/\u0000-\u001f\u007f]/u.test(item.name)) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid directory metadata.')
        }
        return { directoryId: item.directoryId, name: item.name }
      })
      : (() => { throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid directories.') })()
    const directoryId = value.directoryId === undefined ? undefined : value.directoryId
    const parentDirectoryId = value.parentDirectoryId === undefined ? undefined : value.parentDirectoryId
    if ((directoryId !== undefined && !validRelativeId(directoryId, true))
      || (parentDirectoryId !== undefined && !validRelativeId(parentDirectoryId, true))) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid directory metadata.')
    }
    const limits = value.limits === undefined ? undefined : documentLimits(value.limits)
    const totalDocuments = value.totalDocuments === undefined ? undefined
      : Number.isSafeInteger(value.totalDocuments) && (value.totalDocuments as number) >= documents.length
        ? value.totalDocuments as number
        : (() => { throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid paging metadata.') })()
    const nextCursor = value.nextCursor === undefined ? undefined
      : typeof value.nextCursor === 'string' && value.nextCursor !== '' && value.nextCursor.length <= 4096
        ? value.nextCursor
        : (() => { throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned an invalid cursor.') })()
    return {
      version: 1,
      scope: { kind: authorized.identity.kind, label: authorized.identity.label },
      documents,
      ...(limits === undefined ? {} : { limits }),
      ...(directoryId === undefined ? {} : { directoryId }),
      ...(parentDirectoryId === undefined ? {} : { parentDirectoryId }),
      ...(directories === undefined ? {} : { directories }),
      ...(totalDocuments === undefined ? {} : { totalDocuments }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  })
}

/** Create the authenticated Gateway broker used by runtime document consumers. */
export function createDocumentTransferListHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferListHandler {
  return ({ principal, payload, signal }) => listDocumentsForActor(deps, syntheticUser(principal), payload, signal)
}

/** Create the same broker for the public Gateway document route. */
export function createGatewayDocumentTransferListHandler(
  deps: DocumentTransferDependencies,
): GatewayDocumentTransferListHandler {
  return ({ user, payload, signal }) => listDocumentsForActor(deps, user, payload, signal)
}

function safeUploadSession(value: unknown): Record<string, unknown> {
  const candidate = record(value)
  const validState = candidate?.state === 'uploading' || candidate?.state === 'verifying'
    || candidate?.state === 'complete' || candidate?.state === 'failed'
  if (candidate === undefined || typeof candidate.uploadId !== 'string' || !/^[0-9a-f-]{36}$/u.test(candidate.uploadId)
    || typeof candidate.name !== 'string' || candidate.name === '' || candidate.name.length > 4096
    || /[\\/\u0000-\u001f\u007f]/u.test(candidate.name)
    || !validRelativeId(candidate.directoryId, true)
    || typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0
    || typeof candidate.fingerprint !== 'string' || candidate.fingerprint === '' || candidate.fingerprint.length > 512
    || typeof candidate.chunkBytes !== 'number' || !Number.isSafeInteger(candidate.chunkBytes) || candidate.chunkBytes <= 0
    || candidate.chunkBytes > MAX_TRANSFER_CHUNK_BYTES
    || typeof candidate.receivedBytes !== 'number' || !Number.isSafeInteger(candidate.receivedBytes)
    || candidate.receivedBytes < 0 || candidate.receivedBytes > candidate.bytes
    || typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)
    || !validState) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid upload metadata.')
  }
  const result: Record<string, unknown> = {
    uploadId: candidate.uploadId,
    name: candidate.name,
    directoryId: candidate.directoryId,
    bytes: candidate.bytes,
    fingerprint: candidate.fingerprint,
    chunkBytes: candidate.chunkBytes,
    receivedBytes: candidate.receivedBytes,
    expiresAt: candidate.expiresAt,
    state: candidate.state,
  }
  if (candidate.ref !== undefined) {
    const ref = record(candidate.ref)
    if (ref === undefined || !validRelativeId(ref.docId, false) || typeof ref.name !== 'string' || ref.name === ''
      || ref.name.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(ref.name)
      || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
      || typeof ref.mediaType !== 'string' || ref.mediaType === '' || ref.mediaType.length > 200
      || typeof ref.modifiedAt !== 'number' || !Number.isFinite(ref.modifiedAt)) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid document metadata.')
    }
    result.ref = {
      docId: ref.docId,
      name: ref.name,
      bytes: ref.bytes,
      mediaType: ref.mediaType,
      modifiedAt: ref.modifiedAt,
      path: '',
    }
  }
  if (candidate.error !== undefined) {
    const error = record(candidate.error)
    if (error === undefined || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
      || typeof error.message !== 'string' || error.message.length > 240
      || /[\u0000-\u001f\u007f]|[/\\]/u.test(error.message)) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid upload error metadata.')
    }
    result.error = { code: error.code, message: error.message }
  }
  if (result.state === 'complete' && result.ref === undefined) {
    throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime completed an upload without a document reference.')
  }
  return result
}

function runtimeUploadPath(pathname: string): string {
  const suffix = pathname.slice(DOCUMENT_TRANSFER_UPLOADS_PATH.length)
  if (suffix !== '' && !/^\/[0-9a-f-]{36}(?:\/complete|\/chunks\/[0-9]+)?$/u.test(suffix)) {
    throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document upload path.')
  }
  return `/api/documents/uploads${suffix}`
}

function uploadHeaders(request: IncomingMessage, runtime: RuntimeHandle, assertion: string): Headers {
  const headers = headersFor(runtime, assertion)
  for (const name of ['content-type', 'content-length', 'content-range', 'x-dsh-chunk-sha256']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

/** Drain bytes the upstream stopped reading so the browser connection cannot strand them. */
function drainForwardedRequest(request: IncomingMessage, hasBody: boolean): void {
  if (hasBody && request.complete !== true && !request.destroyed) request.resume()
}

function uploadErrorEnvelope(value: unknown): Record<string, unknown> {
  const error = responseError(value)
  return { error: { code: error.code, message: error.message } }
}

/** Create the Gateway broker for resumable uploads into an authorized target scope. */
export function createGatewayDocumentTransferUploadHandler(
  deps: DocumentTransferDependencies,
): GatewayDocumentTransferUploadHandler {
  return async ({ user, request, pathname, scope: requested, signal }) => {
    const targetPath = runtimeUploadPath(pathname)
    const authorized = await authorizedScope(deps, user, requested, 'write')
    return withRuntimeLeases(deps, [authorized.runtime], async () => {
      const method = request.method ?? 'GET'
      const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
      try {
        let response: Response
        try {
          response = await fetch(`http://127.0.0.1:${String(authorized.runtime.port)}${targetPath}`, {
            method,
            headers: uploadHeaders(request, authorized.runtime, authorized.assertion),
            ...(hasBody ? {
              body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
              duplex: 'half' as const,
            } : {}),
            redirect: 'error',
            signal,
          } as RequestInit & { duplex?: 'half' })
        } catch (error) {
          if (signal.aborted) throw signal.reason
          throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Target document runtime is unavailable.')
        }
        if (response.status === 204) return new Response(null, { status: 204 })
        let body: unknown
        try {
          body = await responseJson(response, responseLimit(deps))
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) {
            throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime response is too large.')
          }
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid upload JSON.')
        }
        if (!response.ok) {
          return new Response(JSON.stringify(uploadErrorEnvelope(body)), {
            status: response.status,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        return new Response(JSON.stringify(safeUploadSession(body)), {
          status: response.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      } finally {
        drainForwardedRequest(request, hasBody)
      }
    })
  }
}

/** Public prefix for full-scope document operations. */
export const DOCUMENT_SCOPE_PATH = '/api/documents/scope'

function scopeRuntimePath(operation: GatewayDocumentScopeOperation): string {
  switch (operation) {
    case 'list': return '/api/documents'
    case 'directories': return '/api/documents/directories'
    case 'content': return '/api/documents/content'
    case 'trash': return '/api/documents/trash'
    case 'restore': return '/api/documents/restore'
    case 'purge': return '/api/documents/purge'
    case 'folders': return '/api/documents/folders'
    case 'move': return '/api/documents/move'
    case 'delete': return '/api/documents/trash'
    default:
      return assertNeverScopeOperation(operation)
  }
}

function assertNeverScopeOperation(value: never): never {
  throw new Error(`unexpected document scope operation: ${String(value)}`)
}

function publicDocumentBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => publicDocumentBody(item))
  if (value === null || typeof value !== 'object') return value
  const row = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(row)) {
    if (key === 'path' || key === 'trashPath') {
      result[key] = ''
      continue
    }
    result[key] = publicDocumentBody(item)
  }
  return result
}

function responseWithSafeJson(response: Response, body: unknown): Response {
  return new Response(JSON.stringify(publicDocumentBody(body)), {
    status: response.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function inlinePreviewMedia(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType === 'application/pdf'
    || mediaType.startsWith('text/') || mediaType === 'application/json'
    || mediaType === 'application/xml' || mediaType === 'application/x-yaml'
    || mediaType === 'application/javascript' || mediaType.endsWith('+json') || mediaType.endsWith('+xml')
}

/**
 * Create a Gateway broker for complete operations in a selected document scope.
 * Every request is authorized independently; the runtime never receives a
 * browser-visible URL or an unverified path.
 */
export function createGatewayDocumentScopeHandler(
  deps: DocumentTransferDependencies,
): GatewayDocumentScopeHandler {
  return async ({ user, request, operation, scope: requested, signal }) => {
    const read = operation === 'list' || operation === 'directories' || operation === 'content'
      || (operation === 'trash' && (request.method ?? 'GET') === 'GET')
    const authorized = await authorizedScope(deps, user, requested, read ? 'read' : 'write')
    const releaseLease = await acquireRuntimeLease(deps, authorized.runtime)
    let handedOff = false
    const incoming = new URL(request.url ?? '/', 'http://gateway')
    incoming.searchParams.delete('scope')
    const target = new URL(scopeRuntimePath(operation), `http://127.0.0.1:${String(authorized.runtime.port)}`)
    for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value)
    const headers = headersFor(authorized.runtime, authorized.assertion)
    const method = request.method ?? 'GET'
    const forwardMethod = operation === 'delete' && method === 'DELETE' ? 'POST' : method
    const hasBody = forwardMethod !== 'GET' && forwardMethod !== 'HEAD' && forwardMethod !== 'DELETE'
    const startedAt = Date.now()
    // Content responses are handed off as streams and may legitimately outlive
    // the metadata deadline; all JSON document operations get the bounded
    // Gateway timeout so a stalled runtime cannot leave the browser loading
    // forever.
    const timeoutSignal = operation === 'content' ? undefined : AbortSignal.timeout(documentScopeTimeoutMs(deps))
    const upstreamSignal = timeoutSignal === undefined ? signal : AbortSignal.any([signal, timeoutSignal])
    let response: Response
    try {
      try {
        response = await fetch(target, {
          method: forwardMethod,
          headers,
          ...(hasBody ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: 'half' as const } : {}),
          redirect: 'error',
          signal: upstreamSignal,
        } as RequestInit & { duplex?: 'half' })
      } catch {
        if (signal.aborted) throw signal.reason
        if (timeoutSignal?.aborted === true) throw documentScopeTimeoutError(operation, requested, startedAt)
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document scope is temporarily unavailable.')
      }
      if (operation === 'content' && response.ok) {
        const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0] ?? ''
        const inline = incoming.searchParams.get('inline') === '1' && inlinePreviewMedia(mediaType)
        const contentDisposition = response.headers.get('content-disposition')
        const outputHeaders = new Headers(response.headers)
        outputHeaders.set('cache-control', 'private, no-store')
        outputHeaders.set('x-content-type-options', 'nosniff')
        outputHeaders.set('content-security-policy', "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'; sandbox")
        if (inline) outputHeaders.set('content-disposition', 'inline')
        else if (contentDisposition === null) outputHeaders.set('content-disposition', 'attachment')
        handedOff = true
        return leaseResponse(new Response(response.body, { status: response.status, headers: outputHeaders }), releaseLease)
      }
      if (response.status === 204) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      let body: unknown
      try {
        body = await responseJson(response, responseLimit(deps))
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (timeoutSignal?.aborted === true) throw documentScopeTimeoutError(operation, requested, startedAt)
        if (error instanceof ResponseBodyTooLargeError) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime response is too large.')
        }
        // A malformed runtime body may contain a private path or other
        // implementation detail. Never pass it through the browser broker.
        throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The target runtime returned invalid document metadata.')
      }
      return responseWithSafeJson(response, body)
    } finally {
      drainForwardedRequest(request, hasBody)
      if (!handedOff) await releaseLease().catch(() => {})
    }
  }
}

async function authorizedAdministratorScope(
  deps: DocumentTransferDependencies,
  actor: UserRow,
  requested: DocumentTransferScope,
  personalOwnerId: number | undefined,
): Promise<AuthorizedScope> {
  if (actor.role !== 'admin') {
    throw new DocumentTransferError('DOCUMENT_ADMIN_FORBIDDEN', 403, 'Only organization administrators can manage document lifecycle.')
  }
  if (requested.kind !== 'personal' || personalOwnerId === undefined || personalOwnerId === actor.id) {
    return authorizedScope(deps, actor, requested, 'write')
  }
  const owner = await deps.users.getById(personalOwnerId)
  if (owner === null) throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
  const identity: ScopeIdentity = { kind: 'personal', id: owner.id, label: 'Personal documents' }
  const runtime = await runtimeFor(deps, identity, owner)
  return {
    identity,
    runtime,
    assertion: deps.principals.issue({
      user: actor,
      scope: { kind: 'personal' },
      runtime: { kind: runtime.target.kind, id: runtime.target.id, generation: runtime.generation },
      purpose: 'document-admin',
    }),
  }
}

/** Create a Gateway broker for administrator document recovery actions. */
export function createGatewayDocumentAdminHandler(
  deps: DocumentTransferDependencies,
): GatewayDocumentAdminHandler {
  return async ({ user, scope: requested, personalOwnerId, docId, action, signal }) => {
    const authorized = await authorizedAdministratorScope(deps, user, requested, personalOwnerId)
    const release = await acquireRuntimeLease(deps, authorized.runtime)
    let handedOff = false
    try {
      const path = action === 'trash' ? '/api/documents/trash'
        : action === 'restore' ? '/api/documents/restore' : '/api/documents/purge'
      const target = new URL(path, `http://127.0.0.1:${String(authorized.runtime.port)}`)
      target.searchParams.set('id', docId)
      const method = action === 'purge' ? 'DELETE' : 'POST'
      let response: Response
      try {
        response = await fetch(target, {
          method,
          headers: headersFor(authorized.runtime, authorized.assertion),
          redirect: 'error',
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document runtime is unavailable.')
      }
      if (response.status === 204) {
        await release().catch(() => {})
        handedOff = true
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      let body: unknown
      try { body = await responseJson(response, responseLimit(deps)) } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The runtime response is too large.')
        throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The runtime returned invalid document metadata.')
      }
      const result = responseWithSafeJson(response, body)
      await release().catch(() => {})
      handedOff = true
      return result
    } finally {
      if (!handedOff) await release().catch(() => {})
    }
  }
}

/** Create a safe target-folder listing for one authorized alternate scope. */
export function createDocumentTransferDirectoriesHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferDirectoriesHandler {
  return async ({ principal, payload, signal }) => {
    const candidate = record(payload)
    if (candidate?.version !== 1) throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document directory request.')
    const requested = scope(candidate.scope)
    const actor = syntheticUser(principal)
    const authorized = await authorizedScope(deps, actor, requested, 'read')
    return withRuntimeLeases(deps, [authorized.runtime], async () => {
      let response: Response
      try {
        response = await fetch(`http://127.0.0.1:${String(authorized.runtime.port)}/api/documents/directories`, {
          method: 'GET', headers: headersFor(authorized.runtime, authorized.assertion),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document directory listing is unavailable.')
      }
      const body = await responseJson(response, responseLimit(deps))
      if (!response.ok) throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document directory listing is unavailable.')
      const value = record(body)
      if (!Array.isArray(value?.directories) || value.directories.length > 2000) {
        throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned an invalid directory listing.')
      }
      const directories = value.directories.map(entry => {
        const item = record(entry)
        if (!validRelativeId(item?.directoryId, true) || !nonEmptyString(item?.name) || item.name.length > 255
          || /[\\/\u0000-\u001f\u007f]/u.test(item.name)) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid directory metadata.')
        }
        return { directoryId: item.directoryId, name: item.name }
      })
      return { version: 1, scope: { kind: authorized.identity.kind, label: authorized.identity.label }, directories }
    })
  }
}

/** Create one folder after checking target project write authority. */
export function createDocumentTransferDirectoryCreateHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferDirectoryCreateHandler {
  return async ({ principal, payload, signal }) => {
    const candidate = record(payload)
    if (candidate?.version !== 1 || typeof candidate.name !== 'string' || candidate.name === ''
      || candidate.name.length > 255 || !validRelativeId(candidate.directory, true)) {
      throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid target document directory.')
    }
    const requested = scope(candidate.scope)
    const actor = syntheticUser(principal)
    const authorized = await authorizedScope(deps, actor, requested, 'write')
    const directory = candidate.directory as string
    const name = candidate.name as string
    return withRuntimeLeases(deps, [authorized.runtime], async () => {
      let response: Response
      try {
        response = await fetch(`http://127.0.0.1:${String(authorized.runtime.port)}/api/documents/folders?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(name)}`, {
          method: 'POST', headers: headersFor(authorized.runtime, authorized.assertion),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Target folder creation is unavailable.')
      }
      const body = await responseJson(response, responseLimit(deps))
      if (!response.ok) {
        const error = responseError(body)
        throw new DocumentTransferError(error.code, response.status, error.message)
      }
      const row = record(body)
      if (!validRelativeId(row?.directoryId, false) || !nonEmptyString(row.name)) {
        throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The document runtime returned invalid folder metadata.')
      }
      return { version: 1, scope: { kind: authorized.identity.kind, label: authorized.identity.label }, directory: { directoryId: row.directoryId, name: row.name } }
    })
  }
}

/** Build a short-lived metadata-only plan; commit rechecks every permission. */
export function createDocumentTransferPlanHandler(
  deps: DocumentTransferDependencies,
): RuntimeDocumentTransferPlanHandler {
  const list = createDocumentTransferListHandler(deps)
  return async ({ subject, principal, payload, signal }) => {
    const input = requestValue(payload)
    if (input.targets !== undefined && input.targets.length > 1 && principal.user.role !== 'admin') {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_MULTI_TARGET_FORBIDDEN', 403, 'Only organization administrators can create multi-target plans.')
    }
    const targetScopes = input.targets ?? [input.target]
    const targetSummaries: DocumentTransferScopeSummary[] = []
    for (const target of targetScopes) {
      if (target.kind === 'personal') {
        targetSummaries.push({ kind: 'personal', label: 'Personal documents' })
        continue
      }
      let membership: Awaited<ReturnType<GatewayCollaborationService['projectForUser']>>
      try { membership = await deps.collaboration.projectForUser(target.projectId, principal.user.id) } catch {
        throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Target project authorization is unavailable.')
      }
      if (membership === null || (membership.mode !== 'rw' && !membership.administrator)) {
        throw new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'You cannot add documents to this project scope.')
      }
      targetSummaries.push({ kind: 'project', label: membership.name })
    }
    const wanted = new Set(input.documents.map(document => document.docId))
    const found = new Map<string, DocumentTransferTargetRef>()
    let sourceSummary: DocumentTransferScopeSummary | undefined
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    let pages = 0
    do {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor) || pages >= 500) {
          throw new DocumentTransferError('DOCUMENT_TRANSFER_FAILED', 502, 'The source runtime returned a repeating document cursor.')
        }
        seenCursors.add(cursor)
      }
      pages += 1
      const listed = await list({
        subject,
        principal,
        signal,
        payload: {
          version: 1,
          scope: input.source,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      })
      sourceSummary = listed.scope
      for (const document of listed.documents) {
        if (wanted.has(document.docId)) found.set(document.docId, document)
      }
      cursor = listed.nextCursor
    } while (cursor !== undefined && found.size < wanted.size)
    if (found.size !== wanted.size) {
      throw new DocumentTransferError('DOCUMENT_NOT_FOUND', 404, 'One or more source documents are unavailable.')
    }
    const documents = input.documents.map(document => found.get(document.docId)!)
    const now = Date.now()
    pruneTransferPlans(now)
    if (transferPlans.size >= MAX_TRANSFER_PLANS) {
      throw new DocumentTransferError('DOCUMENT_TRANSFER_PLAN_LIMIT', 503, 'Too many transfer plans are pending; retry shortly.')
    }
    const planId = randomUUID()
    const expiresAt = now + TRANSFER_PLAN_TTL_MS
    transferPlans.set(planId, {
      actorId: principal.user.id,
      source: input.source,
      target: input.target,
      ...(input.targets === undefined ? {} : { targets: input.targets }),
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      documents: input.documents,
      expiresAt,
    })
    scheduleTransferPlanCleanup()
    return {
      version: 1,
      planId,
      source: sourceSummary!,
      target: targetSummaries[0]!,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      documents,
      expiresAt,
      ...(targetSummaries.length <= 1 ? {} : { targets: targetSummaries.map(target => ({ target, documents })) }),
    }
  }
}
