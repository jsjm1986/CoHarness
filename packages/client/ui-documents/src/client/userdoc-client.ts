/* jscpd:ignore-start */
/** Browser HTTP client for the optional Host user-document service. */
import type {
  UserDocDirectoryIdType,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
  UserDocListQuery,
  UserDocRef,
  UserDocScope,
  UserDocTransferRequest,
  UserDocTransferCapabilities,
  UserDocTransferListResponse,
  UserDocTransferDirectoriesResponse,
  UserDocTransferResponse,
  UserDocTransferPlanResponse,
  UserDocCatalogHistory,
  UserDocCatalogHistoryItem,
  UserDocCatalogMetrics,
  UserDocCatalogOverview,
  UserDocCatalogRow,
  UserDocTrashPage,
  UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
import {
  resumableUpload,
  type UserDocUploadPhase,
  type UserDocUploadProgress,
} from '@deepseek-ai/dsh-client-userdoc-upload'

/** Stable error surfaced when the deployment does not mount the document route. */
export class UserDocServiceUnavailableError extends Error {
  /** HTTP status that indicated the route was absent, when known. */
  readonly status: number | undefined

  /** @param status - HTTP status that indicated the route was absent. */
  constructor(status?: number) {
    super('Document upload service is unavailable.')
    this.name = 'UserDocServiceUnavailableError'
    this.status = status
  }
}

/** HTTP failure returned by the document route. */
export class UserDocHttpError extends Error {
  /** HTTP status code. */
  readonly status: number
  /** Stable host error code, when the response carried one. */
  readonly code: string | undefined
  /** Server-advised delay before retrying a transient read, in milliseconds. */
  readonly retryAfterMs: number | undefined

  /**
   * @param status - HTTP status code.
   * @param message - response message.
   * @param code - host error code.
   * @param retryAfterMs - server-advised retry delay.
   */
  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message)
    this.name = 'UserDocHttpError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** Response from the document list endpoint. */
export interface UserDocListResponse {
  readonly limits: UserDocLimits
  readonly documents: readonly UserDocRef[]
}

/** Response from one immediate document-directory listing. */
export interface UserDocDirectoryResponse extends Omit<UserDocDirectoryPage, 'totalDocuments'> {
  /** Older providers omit paging metadata and are paged in the browser. */
  readonly totalDocuments?: number
  /** Older metadata-only scope brokers may not disclose target limits. */
  readonly limits?: UserDocLimits
}

/** Response containing every available move destination. */
export interface UserDocDirectoriesResponse {
  readonly directories: readonly UserDocDirectoryRef[]
}

export type {
  UserDocCatalogHistory,
  UserDocCatalogHistoryItem,
  UserDocCatalogMetrics,
  UserDocCatalogOverview,
  UserDocCatalogRow,
  UserDocUploadPhase,
  UserDocUploadProgress,
  UserDocTrashRef,
  UserDocTrashPage,
}

/** Optional document route client; all paths are relative to the current host. */
export interface UserDocClient {
  list(signal?: AbortSignal): Promise<UserDocListResponse>
  browse(directoryId: UserDocDirectoryIdType, signal?: AbortSignal, query?: UserDocListQuery): Promise<UserDocDirectoryResponse>
  /** Browse any authorized scope without changing the active runtime scope. */
  browseScope(
    scope: UserDocScope,
    directoryId: UserDocDirectoryIdType,
    signal?: AbortSignal,
    query?: UserDocListQuery,
  ): Promise<UserDocDirectoryResponse>
  listDirectories(signal?: AbortSignal): Promise<UserDocDirectoriesResponse>
  upload(
    file: File,
    directoryId: UserDocDirectoryIdType,
    signal?: AbortSignal,
    onProgress?: UserDocUploadProgress,
  ): Promise<UserDocRef>
  /** Upload into a selected personal or writable project scope without changing the active runtime. */
  uploadToScope(
    scope: UserDocScope,
    file: File,
    directoryId: UserDocDirectoryIdType,
    signal?: AbortSignal,
    onProgress?: UserDocUploadProgress,
  ): Promise<UserDocRef>
  createDirectory(parentDirectoryId: UserDocDirectoryIdType, name: string, signal?: AbortSignal): Promise<UserDocDirectoryRef>
  renameDirectory(directoryId: UserDocDirectoryIdType, name: string, signal?: AbortSignal): Promise<UserDocDirectoryRef>
  removeDirectory(directoryId: UserDocDirectoryIdType, signal?: AbortSignal): Promise<void>
  move(docId: UserDocIdType, directoryId: UserDocDirectoryIdType, signal?: AbortSignal): Promise<UserDocRef>
  remove(docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  moveInScope(
    scope: UserDocScope, docId: UserDocIdType, directoryId: UserDocDirectoryIdType, signal?: AbortSignal,
  ): Promise<UserDocRef>
  removeInScope(scope: UserDocScope, docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  createDirectoryInScope(
    scope: UserDocScope, parentDirectoryId: UserDocDirectoryIdType, name: string, signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  renameDirectoryInScope(
    scope: UserDocScope, directoryId: UserDocDirectoryIdType, name: string, signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  removeDirectoryInScope(
    scope: UserDocScope, directoryId: UserDocDirectoryIdType, signal?: AbortSignal,
  ): Promise<void>
  listTrash(signal?: AbortSignal): Promise<{ readonly version: 1; readonly documents: readonly UserDocTrashRef[] }>
  listTrashPage?(query?: UserDocListQuery, signal?: AbortSignal): Promise<{ readonly version: 1 } & UserDocTrashPage>
  trash(docId: UserDocIdType, signal?: AbortSignal): Promise<UserDocTrashRef>
  restore(docId: UserDocIdType, directoryId?: UserDocDirectoryIdType, name?: string, signal?: AbortSignal): Promise<UserDocRef>
  purge(docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  listTrashInScope(
    scope: UserDocScope, signal?: AbortSignal,
  ): Promise<{ readonly version: 1; readonly documents: readonly UserDocTrashRef[] }>
  listTrashInScopePage?(
    scope: UserDocScope, query?: UserDocListQuery, signal?: AbortSignal,
  ): Promise<{ readonly version: 1 } & UserDocTrashPage>
  trashInScope(scope: UserDocScope, docId: UserDocIdType, signal?: AbortSignal): Promise<UserDocTrashRef>
  restoreInScope(
    scope: UserDocScope, docId: UserDocIdType, directoryId?: UserDocDirectoryIdType, name?: string, signal?: AbortSignal,
  ): Promise<UserDocRef>
  purgeInScope(scope: UserDocScope, docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  /** Copy snapshots between the current user's personal scope and one project scope. */
  transfer(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  plan(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferPlanResponse>
  commit(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  retry(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  capabilities(signal?: AbortSignal): Promise<UserDocTransferCapabilities>
  listScope(
    scope: UserDocScope, signal?: AbortSignal, directoryId?: UserDocDirectoryIdType, query?: UserDocListQuery,
  ): Promise<UserDocTransferListResponse>
  listScopeDirectories(scope: UserDocScope, signal?: AbortSignal): Promise<UserDocTransferDirectoriesResponse>
  createScopeDirectory(
    scope: UserDocScope,
    parentDirectoryId: UserDocDirectoryIdType,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  overview(signal?: AbortSignal): Promise<UserDocCatalogOverview>
  overviewPage?(query?: UserDocListQuery, signal?: AbortSignal): Promise<UserDocCatalogOverview>
  history(signal?: AbortSignal): Promise<UserDocCatalogHistory>
  contentUrl(docId: UserDocIdType, inline?: boolean): string
  scopedContentUrl(scope: UserDocScope, docId: UserDocIdType, inline?: boolean): string
}

const ROOT = '/api/documents'
const TRANSFER_PATH = `${ROOT}/transfer`
const PLAN_PATH = `${TRANSFER_PATH}/plan`
const COMMIT_PATH = `${TRANSFER_PATH}/commit`
const RETRY_PATH = `${TRANSFER_PATH}/retry`
const CAPABILITIES_PATH = `${TRANSFER_PATH}/capabilities`
const LIST_SCOPE_PATH = `${TRANSFER_PATH}/list`
const DIRECTORIES_PATH = `${TRANSFER_PATH}/directories`
const DIRECTORY_CREATE_PATH = `${TRANSFER_PATH}/directories/create`
const SCOPED_UPLOAD_PATH = TRANSFER_PATH
const SCOPE_PATH = `${ROOT}/scope`
const TRASH_PATH = `${ROOT}/trash`
const RESTORE_PATH = `${ROOT}/restore`
const PURGE_PATH = `${ROOT}/purge`
const OVERVIEW_PATH = `${ROOT}/overview`
const HISTORY_PATH = `${ROOT}/history`
const READ_RETRY_LIMIT = 2
const MAX_RETRY_DELAY_MS = 4000
/** Maximum JSON bytes retained from one document-control response. */
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024

function contentUrl(docId: UserDocIdType, inline = false): string {
  const suffix = inline ? '&inline=1' : ''
  return `${ROOT}/content?id=${encodeURIComponent(docId)}${suffix}`
}

function scopedContentUrl(scope: UserDocScope, docId: UserDocIdType, inline = false): string {
  const params = new URLSearchParams({ scope: scopeKey(scope), id: String(docId) })
  if (inline) params.set('inline', '1')
  return `${SCOPE_PATH}/content?${params.toString()}`
}

function scopeKey(scope: UserDocScope): string {
  return scope.kind === 'personal' ? 'personal' : `project:${String(scope.projectId)}`
}

function scopeQuery(scope: UserDocScope): string {
  return `?scope=${encodeURIComponent(scopeKey(scope))}`
}

function scopedPath(path: string, scope: UserDocScope, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ scope: scopeKey(scope), ...params })
  return `${SCOPE_PATH}${path}?${query.toString()}`
}

function listingSuffix(query: UserDocListQuery | undefined): string {
  if (query === undefined) return ''
  const params = new URLSearchParams()
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.query !== undefined && query.query !== '') params.set('q', query.query)
  if (query.type !== undefined && query.type !== 'all') params.set('type', query.type)
  if (query.sort !== undefined) params.set('sort', query.sort)
  if (query.state !== undefined && query.state !== 'active') params.set('state', query.state)
  const encoded = params.toString()
  return encoded === '' ? '' : `&${encoded}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const responseLike = response as unknown as {
    headers?: Pick<Headers, 'get'>
    body?: ReadableStream<Uint8Array> | null
    text: () => Promise<string>
  }
  const declared = responseLike.headers?.get('content-length') ?? null
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_RESPONSE_BYTES) {
      await responseLike.body?.cancel().catch(() => {})
      throw new UserDocHttpError(502, 'Document operation response is too large.', 'DOCUMENT_RESPONSE_TOO_LARGE')
    }
  }
  const body = responseLike.body
  let text: string
  if (body === null || body === undefined) {
    // Test/in-process fetch adapters may implement only `text()`. Real Fetch
    // responses always expose a body stream, so this fallback does not weaken
    // the bounded path used in production browsers.
    text = ''
    if (body === undefined) {
      text = await responseLike.text()
      if (new TextEncoder().encode(text).byteLength > MAX_JSON_RESPONSE_BYTES) {
        throw new UserDocHttpError(502, 'Document operation response is too large.', 'DOCUMENT_RESPONSE_TOO_LARGE')
      }
    }
  } else {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_JSON_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new UserDocHttpError(502, 'Document operation response is too large.', 'DOCUMENT_RESPONSE_TOO_LARGE')
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
    text = new TextDecoder().decode(bytes)
  }
  if (text === '') return undefined
  try { return JSON.parse(text) as unknown } catch { return text }
}

function retryAfterMs(response: Response): number | undefined {
  const headers = (response as unknown as { headers?: Pick<Headers, 'get'> }).headers
  const raw = headers === undefined ? null : headers.get('retry-after')
  if (raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000))
}

function errorCodeFromString(value: string): string | undefined {
  if (value === 'instance-starting') return 'INSTANCE_STARTING'
  if (value === 'instance-unreachable') return 'INSTANCE_UNREACHABLE'
  return undefined
}

function errorFrom(status: number, body: unknown, retryDelay?: number): Error {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as { message?: unknown; code?: unknown }
      return new UserDocHttpError(
        status,
        typeof record.message === 'string' ? record.message.slice(0, 240) : 'Document operation failed.',
        typeof record.code === 'string' ? record.code : undefined,
        retryDelay,
      )
    }
    if (typeof error === 'string' && error !== '') {
      const code = errorCodeFromString(error)
      return new UserDocHttpError(
        status,
        code === 'INSTANCE_STARTING'
          ? 'The document runtime is starting. Retry shortly.'
          : code === 'INSTANCE_UNREACHABLE'
            ? 'The document runtime is unavailable. Retry shortly.'
            : 'Document operation failed.',
        code,
        retryDelay,
      )
    }
  }
  if (status === 404) return new UserDocServiceUnavailableError(status)
  return new UserDocHttpError(
    status,
    typeof body === 'string' && body !== '' ? body.slice(0, 240) : 'Document operation failed.',
    undefined,
    retryDelay,
  )
}

async function requestJson<T>(input: RequestInfo | URL, init: RequestInit | undefined): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, { cache: 'no-store', ...init })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw error instanceof Error ? error : new Error(String(error))
  }
  const body = await parseResponse(response)
  if (!response.ok) throw errorFrom(response.status, body, retryAfterMs(response))
  return body as T
}

function transientReadError(error: unknown): error is UserDocHttpError {
  return error instanceof UserDocHttpError
    && (error.status === 503 || error.code === 'INSTANCE_STARTING' || error.code === 'INSTANCE_UNREACHABLE')
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

async function requestReadJson<T>(input: RequestInfo | URL, init: RequestInit | undefined): Promise<T> {
  const signal = init?.signal ?? undefined
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJson<T>(input, init)
    } catch (error) {
      if (!transientReadError(error) || attempt >= READ_RETRY_LIMIT) throw error
      const delayMs = error.retryAfterMs ?? Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** attempt))
      await waitForRetry(delayMs, signal)
    }
  }
}

function requestInit(method: string, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? { method } : { method, signal }
}

function uploadNetworkError(status: number): Error {
  return status === 0
    ? new Error('Document upload failed because the connection was interrupted before the server responded. Check the network or tunnel and retry.')
    : new Error('Document upload failed.')
}

/**
 * Create the default relative-path document client.
 * @returns a client targeting the current host's document route.
 */
export function createUserDocClient(): UserDocClient {
  return {
    list: signal => requestReadJson<UserDocListResponse>(ROOT, requestInit('GET', signal)),
    browse: (directoryId, signal, query) => requestReadJson<UserDocDirectoryResponse>(
      `${ROOT}?directory=${encodeURIComponent(directoryId)}${listingSuffix(query)}`, requestInit('GET', signal),
    ),
    browseScope: async (scope, directoryId, signal, query) => {
      try {
        return await requestReadJson<UserDocDirectoryResponse>(
          `${SCOPE_PATH}?scope=${encodeURIComponent(scopeKey(scope))}&directory=${encodeURIComponent(directoryId)}${listingSuffix(query)}`,
          requestInit('GET', signal),
        )
      } catch (error) {
        // Older/standalone hosts expose the metadata-only transfer listing;
        // retain that path while the full scope broker is rolling out.
        if (!(error instanceof UserDocServiceUnavailableError)) throw error
        const fallback = await requestReadJson<UserDocTransferListResponse>(LIST_SCOPE_PATH, {
          ...requestInit('POST', signal),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            scope,
            ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query?.limit === undefined ? {} : { limit: query.limit }),
            ...(query?.query === undefined ? {} : { query: query.query }),
            ...(query?.type === undefined ? {} : { type: query.type }),
            ...(query?.sort === undefined ? {} : { sort: query.sort }),
            ...(query?.state === undefined ? {} : { state: query.state }),
            directory: String(directoryId),
          }),
        })
        return {
          version: 1,
          directoryId: (fallback.directoryId) ?? directoryId,
          ...(fallback.parentDirectoryId === undefined ? {} : { parentDirectoryId: fallback.parentDirectoryId }),
          directories: (fallback.directories ?? []).map(directory => ({
            directoryId: directory.directoryId,
            path: '',
            name: directory.name,
            modifiedAt: 0,
          })),
          documents: fallback.documents.map(document => ({ ...document, path: '' })),
          ...(fallback.limits === undefined ? {} : { limits: fallback.limits }),
          ...(fallback.nextCursor === undefined ? {} : {
            nextCursor: fallback.nextCursor,
            ...(fallback.totalDocuments === undefined ? {} : { totalDocuments: fallback.totalDocuments }),
          }),
        }
      }
    },
    listDirectories: signal => requestReadJson<UserDocDirectoriesResponse>(`${ROOT}/directories`, requestInit('GET', signal)),
    upload: (file, directoryId, signal, onProgress) => resumableUpload(file, directoryId, signal, onProgress, {
      root: ROOT,
      requestJson,
      networkError: uploadNetworkError,
      responseError: errorFrom,
    }),
    uploadToScope: (scope, file, directoryId, signal, onProgress) => resumableUpload(file, directoryId, signal, onProgress, {
      root: SCOPED_UPLOAD_PATH,
      query: scopeQuery(scope),
      resumeNamespace: scopeKey(scope),
      requestJson,
      networkError: uploadNetworkError,
      responseError: errorFrom,
    }),
    createDirectory: (parentDirectoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      `${ROOT}/folders?directory=${encodeURIComponent(parentDirectoryId)}&name=${encodeURIComponent(name)}`,
      requestInit('POST', signal),
    ),
    renameDirectory: (directoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      `${ROOT}/folders?id=${encodeURIComponent(directoryId)}&name=${encodeURIComponent(name)}`,
      requestInit('PATCH', signal),
    ),
    removeDirectory: async (directoryId, signal) => {
      await requestJson<undefined>(`${ROOT}/folders?id=${encodeURIComponent(directoryId)}`, requestInit('DELETE', signal))
    },
    move: (docId, directoryId, signal) => requestJson<UserDocRef>(
      `${ROOT}/move?id=${encodeURIComponent(docId)}&directory=${encodeURIComponent(directoryId)}`,
      requestInit('POST', signal),
    ),
    remove: async (docId, signal) => {
      try {
        await requestJson<undefined>(`${ROOT}?id=${encodeURIComponent(docId)}`, requestInit('DELETE', signal))
      } catch (error) {
        if (error instanceof UserDocServiceUnavailableError) return
        if (error instanceof UserDocHttpError && error.status === 404) return
        throw error
      }
    },
    moveInScope: (scope, docId, directoryId, signal) => requestJson<UserDocRef>(
      scopedPath('/move', scope, { id: String(docId), directory: String(directoryId) }), requestInit('POST', signal)),
    removeInScope: async (scope, docId, signal) => {
      await requestJson<undefined>(scopedPath('', scope, { id: String(docId) }), requestInit('DELETE', signal))
    },
    createDirectoryInScope: (scope, parentDirectoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      scopedPath('/folders', scope, { directory: String(parentDirectoryId), name }), requestInit('POST', signal)),
    renameDirectoryInScope: (scope, directoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      scopedPath('/folders', scope, { id: String(directoryId), name }), requestInit('PATCH', signal)),
    removeDirectoryInScope: async (scope, directoryId, signal) => {
      await requestJson<undefined>(scopedPath('/folders', scope, { id: String(directoryId) }), requestInit('DELETE', signal))
    },
    listTrash: signal => requestReadJson<{ version: 1; documents: readonly UserDocTrashRef[] }>(TRASH_PATH, requestInit('GET', signal)),
    listTrashPage: (query, signal) => requestReadJson<{ version: 1 } & UserDocTrashPage>(
      `${TRASH_PATH}${listingSuffix(query).replace(/^&/u, '?')}`, requestInit('GET', signal),
    ),
    trash: async (docId, signal) => {
      const response = await requestJson<{ version: 1; document: UserDocTrashRef }>(
        `${TRASH_PATH}?id=${encodeURIComponent(docId)}`, requestInit('POST', signal),
      )
      return response.document
    },
    restore: async (docId, directoryId, name, signal) => {
      const params: Record<string, string> = { id: String(docId) }
      if (directoryId !== undefined) params.directory = String(directoryId)
      if (name !== undefined) params.name = name
      const response = await requestJson<{ version: 1; document: UserDocRef }>(
        `${RESTORE_PATH}?${new URLSearchParams(params).toString()}`, requestInit('POST', signal),
      )
      return response.document
    },
    purge: async (docId, signal) => {
      await requestJson<undefined>(`${PURGE_PATH}?id=${encodeURIComponent(docId)}`, requestInit('DELETE', signal))
    },
    listTrashInScope: (scope, signal) => requestReadJson<{ version: 1; documents: readonly UserDocTrashRef[] }>(
      scopedPath('/trash', scope), requestInit('GET', signal),
    ),
    listTrashInScopePage: (scope, query, signal) => requestReadJson<{ version: 1 } & UserDocTrashPage>(
      scopedPath('/trash', scope, {
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query?.limit === undefined ? {} : { limit: String(query.limit) }),
        ...(query?.query === undefined ? {} : { q: query.query }),
        ...(query?.type === undefined ? {} : { type: query.type }),
        ...(query?.sort === undefined ? {} : { sort: query.sort }),
        state: 'trash',
      }), requestInit('GET', signal),
    ),
    trashInScope: async (scope, docId, signal) => {
      const response = await requestJson<{ version: 1; document: UserDocTrashRef }>(
        scopedPath('/trash', scope, { id: String(docId) }), requestInit('POST', signal),
      )
      return response.document
    },
    restoreInScope: async (scope, docId, directoryId, name, signal) => {
      const params: Record<string, string> = { id: String(docId) }
      if (directoryId !== undefined) params.directory = String(directoryId)
      if (name !== undefined) params.name = name
      const response = await requestJson<{ version: 1; document: UserDocRef }>(
        scopedPath('/restore', scope, params), requestInit('POST', signal),
      )
      return response.document
    },
    purgeInScope: async (scope, docId, signal) => {
      await requestJson<undefined>(scopedPath('/purge', scope, { id: String(docId) }), requestInit('DELETE', signal))
    },
    transfer: (request, signal) => requestJson<UserDocTransferResponse>(TRANSFER_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }),
    plan: (request, signal) => requestJson<UserDocTransferPlanResponse>(PLAN_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }),
    commit: (request, signal) => requestJson<UserDocTransferResponse>(COMMIT_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }),
    retry: (request, signal) => requestJson<UserDocTransferResponse>(RETRY_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }),
    capabilities: signal => requestJson<UserDocTransferCapabilities>(CAPABILITIES_PATH, requestInit('GET', signal)),
    listScope: (scope, signal, directoryId, query) => requestReadJson<UserDocTransferListResponse>(LIST_SCOPE_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        version: 1,
        scope,
        ...(directoryId === undefined ? {} : { directory: directoryId }),
        ...(query?.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query?.limit === undefined ? {} : { limit: query.limit }),
        ...(query?.query === undefined ? {} : { query: query.query }),
        ...(query?.type === undefined ? {} : { type: query.type }),
        ...(query?.sort === undefined ? {} : { sort: query.sort }),
        ...(query?.state === undefined ? {} : { state: query.state }),
      }),
    }),
    listScopeDirectories: (scope, signal) => requestReadJson<UserDocTransferDirectoriesResponse>(DIRECTORIES_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, scope }),
    }),
    createScopeDirectory: (scope, parentDirectoryId, name, signal) => requestJson<UserDocDirectoryRef>(DIRECTORY_CREATE_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, scope, directory: parentDirectoryId, name }),
    }).then(directory => ({ ...directory, path: '' })),
    overview: signal => requestReadJson<UserDocCatalogOverview>(OVERVIEW_PATH, requestInit('GET', signal)),
    overviewPage: (query, signal) => requestReadJson<UserDocCatalogOverview>(
      `${OVERVIEW_PATH}${listingSuffix(query).replace(/^&/u, '?')}`, requestInit('GET', signal),
    ),
    history: signal => requestReadJson<UserDocCatalogHistory>(HISTORY_PATH, requestInit('GET', signal)),
    contentUrl,
    scopedContentUrl,
  }
}

/* jscpd:ignore-end */
