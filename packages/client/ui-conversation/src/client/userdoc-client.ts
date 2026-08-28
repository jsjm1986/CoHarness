/** Browser HTTP client for the optional Host user-document service. */
import type {
  UserDocIdType,
  UserDocLimits,
  UserDocRef,
  UserDocTransferRequest,
  UserDocTransferResponse,
  UserDocDirectoryIdType,
} from '@deepseek-ai/dsh-userdoc'
import {
  resumableUpload,
  type UserDocUploadPhase,
  type UserDocUploadProgress,
} from '@deepseek-ai/dsh-client-userdoc-upload'
import { readApiResponseText } from '@deepseek-ai/dsh-client-runtime/client'

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

  /** @param status - HTTP status. @param message - response message. @param code - host error code. */
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

/** Progress callback for the shared resumable upload state machine. */
export type { UserDocUploadPhase, UserDocUploadProgress }

/** Optional document route client used by the conversation composer. */
export interface UserDocClient {
  list(signal?: AbortSignal): Promise<UserDocListResponse>
  upload(file: File, signal?: AbortSignal, onProgress?: UserDocUploadProgress): Promise<UserDocRef>
  remove(docId: UserDocIdType, signal?: AbortSignal): Promise<void>
  transfer(request: UserDocTransferRequest, signal?: AbortSignal): Promise<UserDocTransferResponse>
  contentUrl(docId: UserDocIdType): string
}

const ROOT = '/api/documents'
const TRANSFER_PATH = `${ROOT}/transfer`

function contentUrl(docId: UserDocIdType): string {
  return `${ROOT}/content?id=${encodeURIComponent(docId)}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await readApiResponseText(response)
  if (text === '') return undefined
  try { return JSON.parse(text) as unknown } catch { return { error: { message: text } } }
}

function errorFrom(status: number, body: unknown): Error {
  if (status === 404) return new UserDocServiceUnavailableError(status)
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as { message?: unknown; code?: unknown }
      return new UserDocHttpError(
        status,
        typeof record.message === 'string' ? record.message.slice(0, 240) : 'Document operation failed.',
        typeof record.code === 'string' ? record.code : undefined,
      )
    }
    if (typeof error === 'string' && error !== '') {
      const code = error === 'instance-starting' ? 'INSTANCE_STARTING'
        : error === 'instance-unreachable' ? 'INSTANCE_UNREACHABLE'
          : undefined
      return new UserDocHttpError(
        status,
        code === 'INSTANCE_STARTING'
          ? 'The document runtime is starting. Retry shortly.'
          : code === 'INSTANCE_UNREACHABLE'
            ? 'The document runtime is unavailable. Retry shortly.'
            : 'Document operation failed.',
        code,
      )
    }
  }
  return new UserDocHttpError(
    status,
    typeof body === 'string' && body !== '' ? body.slice(0, 240) : 'Document operation failed.',
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

function uploadNetworkError(status: number): Error {
  return status === 0
    ? new Error('Document upload failed because the connection was interrupted before the server responded. Check the network or tunnel and retry.')
    : new Error('Document upload failed.')
}

/**
 * Create the conversation's relative-path document client.
 * @returns a client targeting the current host's document route.
 */
export function createUserDocClient(): UserDocClient {
  return {
    list: signal => requestJson<UserDocListResponse>(ROOT, signal === undefined ? {} : { signal }),
    upload: (file, signal, onProgress) => resumableUpload(file, '' as UserDocDirectoryIdType, signal, onProgress, {
      root: ROOT,
      requestJson,
      networkError: uploadNetworkError,
      responseError: errorFrom,
    }),
    remove: async (docId, signal) => {
      try {
        await requestJson<undefined>(`${ROOT}?id=${encodeURIComponent(docId)}`, signal === undefined ? { method: 'DELETE' } : { method: 'DELETE', signal })
      } catch (error) {
        if (error instanceof UserDocServiceUnavailableError) return
        if (error instanceof UserDocHttpError && error.status === 404) return
        throw error
      }
    },
    transfer: (request, signal) => requestJson<UserDocTransferResponse>(TRANSFER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    }),
    contentUrl,
  }
}
