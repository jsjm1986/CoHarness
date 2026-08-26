/* jscpd:ignore-start */
/** Browser HTTP client for the optional Host user-document service. */
import type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
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
export interface UserDocDirectoryResponse extends UserDocDirectoryListing {
  readonly limits: UserDocLimits
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
}

/** Optional document route client; all paths are relative to the current host. */
export interface UserDocClient {
  list(signal?: AbortSignal): Promise<UserDocListResponse>
  browse(directoryId: UserDocDirectoryIdType, signal?: AbortSignal): Promise<UserDocDirectoryResponse>
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
  /** Copy snapshots between the current user's personal scope and one project scope. */
  transfer(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  plan(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferPlanResponse>
  commit(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  retry(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  capabilities(signal?: AbortSignal): Promise<UserDocTransferCapabilities>
  listScope(scope: UserDocScope, signal?: AbortSignal): Promise<UserDocTransferListResponse>
  listScopeDirectories(scope: UserDocScope, signal?: AbortSignal): Promise<UserDocTransferDirectoriesResponse>
  createScopeDirectory(
    scope: UserDocScope,
    parentDirectoryId: UserDocDirectoryIdType,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  overview(signal?: AbortSignal): Promise<UserDocCatalogOverview>
  history(signal?: AbortSignal): Promise<UserDocCatalogHistory>
  contentUrl(docId: UserDocIdType): string
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
const OVERVIEW_PATH = `${ROOT}/overview`
const HISTORY_PATH = `${ROOT}/history`
const READ_RETRY_LIMIT = 2
const MAX_RETRY_DELAY_MS = 4000

function contentUrl(docId: UserDocIdType): string {
  return `${ROOT}/content?id=${encodeURIComponent(docId)}`
}

function scopeKey(scope: UserDocScope): string {
  return scope.kind === 'personal' ? 'personal' : `project:${String(scope.projectId)}`
}

function scopeQuery(scope: UserDocScope): string {
  return `?scope=${encodeURIComponent(scopeKey(scope))}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
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
        typeof record.message === 'string' ? record.message : 'Document operation failed.',
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
    typeof body === 'string' && body !== '' ? body : 'Document operation failed.',
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
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
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
    browse: (directoryId, signal) => requestReadJson<UserDocDirectoryResponse>(
      `${ROOT}?directory=${encodeURIComponent(directoryId)}`, requestInit('GET', signal),
    ),
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
    listScope: (scope, signal) => requestReadJson<UserDocTransferListResponse>(LIST_SCOPE_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, scope }),
    }),
    listScopeDirectories: (scope, signal) => requestReadJson<UserDocTransferDirectoriesResponse>(DIRECTORIES_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, scope }),
    }),
    createScopeDirectory: (scope, parentDirectoryId, name, signal) => requestJson<UserDocDirectoryRef>(DIRECTORY_CREATE_PATH, {
      ...requestInit('POST', signal), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, scope, directory: parentDirectoryId, name }),
    }).then(directory => ({ ...directory, path: '' })),
    overview: signal => requestReadJson<UserDocCatalogOverview>(OVERVIEW_PATH, requestInit('GET', signal)),
    history: signal => requestReadJson<UserDocCatalogHistory>(HISTORY_PATH, requestInit('GET', signal)),
    contentUrl,
  }
}

/* jscpd:ignore-end */
