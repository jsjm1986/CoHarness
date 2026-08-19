/* jscpd:ignore-start */
/** Browser HTTP client for the optional Host user-document service.
 *  This plugin owns a local copy because the client bundle purity gate
 *  forbids a value import of conversation's HTTP client. */
import type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
  UserDocRef,
} from '@deepseek-ai/dsh-userdoc'

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

  /** @param status - HTTP status code. @param message - response message. @param code - host error code. */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'UserDocHttpError'
    this.status = status
    this.code = code
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

/** Progress callback for one streaming browser upload. */
export type UserDocUploadProgress = (loaded: number, total: number) => void

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
  createDirectory(
    parentDirectoryId: UserDocDirectoryIdType,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  renameDirectory(
    directoryId: UserDocDirectoryIdType,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryRef>
  removeDirectory(directoryId: UserDocDirectoryIdType, signal?: AbortSignal): Promise<void>
  move(
    docId: UserDocIdType,
    directoryId: UserDocDirectoryIdType,
    signal?: AbortSignal,
  ): Promise<UserDocRef>
  remove(docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  contentUrl(docId: UserDocIdType): string
}

const ROOT = '/api/documents'
const UPLOAD_HEADER = 'x-dsh-document-upload'

function contentUrl(docId: UserDocIdType): string {
  return `${ROOT}/content?id=${encodeURIComponent(docId)}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function errorFrom(status: number, body: unknown): Error {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as { message?: unknown; code?: unknown }
      const message = typeof record.message === 'string' ? record.message : 'Document operation failed.'
      const code = typeof record.code === 'string' ? record.code : undefined
      return new UserDocHttpError(status, message, code)
    }
  }
  if (status === 404) return new UserDocServiceUnavailableError(status)
  return new UserDocHttpError(
    status,
    typeof body === 'string' && body !== '' ? body : 'Document operation failed.',
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
  if (!response.ok) throw errorFrom(response.status, body)
  return body as T
}

function requestInit(method: string, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? { method } : { method, signal }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function xhrUpload(
  file: File,
  directoryId: UserDocDirectoryIdType,
  signal?: AbortSignal,
  onProgress?: UserDocUploadProgress,
): Promise<UserDocRef> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      fn()
    }
    const abort = (): void => {
      xhr.abort()
      finish(() => { reject(abortError(signal)) })
    }
    signal?.addEventListener('abort', abort, { once: true })
    xhr.open('POST', `${ROOT}?name=${encodeURIComponent(file.name)}&directory=${encodeURIComponent(directoryId)}`)
    xhr.setRequestHeader(UPLOAD_HEADER, '1')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total)
      else onProgress?.(event.loaded, file.size)
    }
    xhr.onerror = () => { finish(() => { reject(new Error('Document upload failed.')) }) }
    xhr.onabort = () => { finish(() => { reject(abortError(signal)) }) }
    xhr.onload = () => {
      let body: unknown
      try { body = xhr.responseText === '' ? undefined : JSON.parse(xhr.responseText) as unknown } catch { body = undefined }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(() => { reject(errorFrom(xhr.status, body)) })
        return
      }
      finish(() => { resolve(body as UserDocRef) })
    }
    try {
      xhr.send(file)
    } catch (error) {
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

/**
 * Create the default relative-path document client.
 * @returns a client targeting the current host's document route.
 */
export function createUserDocClient(): UserDocClient {
  return {
    list: signal => requestJson<UserDocListResponse>(ROOT, requestInit('GET', signal)),
    browse: (directoryId, signal) => requestJson<UserDocDirectoryResponse>(
      `${ROOT}?directory=${encodeURIComponent(directoryId)}`,
      requestInit('GET', signal),
    ),
    listDirectories: signal => requestJson<UserDocDirectoriesResponse>(
      `${ROOT}/directories`,
      requestInit('GET', signal),
    ),
    upload: (file, directoryId, signal, onProgress) => xhrUpload(file, directoryId, signal, onProgress),
    createDirectory: (parentDirectoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      `${ROOT}/folders?directory=${encodeURIComponent(parentDirectoryId)}&name=${encodeURIComponent(name)}`,
      requestInit('POST', signal),
    ),
    renameDirectory: (directoryId, name, signal) => requestJson<UserDocDirectoryRef>(
      `${ROOT}/folders?id=${encodeURIComponent(directoryId)}&name=${encodeURIComponent(name)}`,
      requestInit('PATCH', signal),
    ),
    removeDirectory: async (directoryId, signal) => {
      await requestJson<undefined>(
        `${ROOT}/folders?id=${encodeURIComponent(directoryId)}`,
        requestInit('DELETE', signal),
      )
    },
    move: (docId, directoryId, signal) => requestJson<UserDocRef>(
      `${ROOT}/move?id=${encodeURIComponent(docId)}&directory=${encodeURIComponent(directoryId)}`,
      requestInit('POST', signal),
    ),
    remove: async (docId, signal) => {
      try {
        await requestJson<undefined>(`${ROOT}?id=${encodeURIComponent(docId)}`, requestInit('DELETE', signal))
      } catch (error) {
        // Delete is idempotent; a missing route means there is no durable object
        // to clean up, and a 404 from the route has the same convergence result.
        if (error instanceof UserDocServiceUnavailableError) return
        if (error instanceof UserDocHttpError && error.status === 404) return
        throw error
      }
    },
    contentUrl,
  }
}

/* jscpd:ignore-end */
