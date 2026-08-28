/** OpenAI-compatible DeepSeek Files API transport. @module dsh-llm-deepseek/files-api */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'

/** Minimum provider-supported file lifetime. */
export const MIN_FILE_EXPIRY_SECONDS = 3_600
/** Maximum provider-supported file lifetime. */
export const MAX_FILE_EXPIRY_SECONDS = 2_592_000
/** Maximum Files API upload size. */
export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024
/** Default maximum UTF-8 bytes retained from one Files API response. */
export const DEFAULT_MAX_FILE_RESPONSE_BYTES = 16 * 1024 * 1024
/** Hard upper bound for a configured Files API response budget. */
export const MAX_FILE_RESPONSE_BYTES = 256 * 1024 * 1024
/** Current per-key file-count quota. */
export const MAX_STORED_FILE_COUNT = 10_000
/** Current per-key storage quota. */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024

/** Validated file object returned by the OpenAI-compatible endpoint. */
export interface DeepSeekFileObject {
  id: DeepSeekFileIdType
  bytes: number
  createdAt: number
  filename: string
  purpose: 'user_data'
  expiresAt?: number
}

/** One page returned by `GET /files`. */
export interface DeepSeekFilePage {
  data: DeepSeekFileObject[]
  firstId?: DeepSeekFileIdType
  lastId?: DeepSeekFileIdType
  hasMore: boolean
}

/** Files API operation failure with its HTTP status retained for recovery policy. */
export class DeepSeekFilesError extends LlmError {
  /** Parsed provider detail used only for error classification. */
  readonly detail: string

  /**
   * @param message - user-readable provider failure.
   * @param status - HTTP status returned by the Files API.
   * @param detail - provider error fields joined for classification.
   */
  constructor(message: string, status: number, detail: string) {
    super(message, status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'FILES_API', { status })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

/**
 * Whether an upload failure reports a provider storage or file-count quota.
 * @param error - Files API operation failure.
 * @returns whether one bounded remote cleanup and upload retry may recover.
 */
export function isFilesQuotaError(error: unknown): error is DeepSeekFilesError {
  return error instanceof DeepSeekFilesError
    && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail)
}

interface FilesApiOptions {
  baseURL: string
  apiKey: string
  fetch?: typeof fetch
  /** Maximum UTF-8 bytes retained from one success or error response. */
  maxResponseBytes?: number
}

/** Internal marker used to distinguish a bounded-body refusal from bad JSON. */
class FilesResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`DeepSeek Files API response exceeds the ${String(limit)}-byte limit`)
    this.name = 'FilesResponseTooLargeError'
  }
}

interface WireFileObject {
  id?: unknown
  object?: unknown
  bytes?: unknown
  created_at?: unknown
  filename?: unknown
  purpose?: unknown
  expires_at?: unknown
}

function invalidResponse(operation: string, cause?: unknown): LlmError {
  return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, 'INVALID_RESPONSE', {
    ...cause === undefined ? {} : { cause },
  })
}

/** Read a standard or test-double Fetch response with a strict byte budget. */
/* jscpd:ignore-start -- Files API cannot depend on gateway-runtime; this local reader protects the provider's independent transport. */
async function readResponseJson(response: Response, limit: number): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('DeepSeek Files API response byte limit must be a positive safe integer')
  }
  const body = response.body
  const headers = (response as unknown as { headers?: Headers }).headers
  // Fetch's ordinary Response has a body stream. This fallback keeps
  // Response-shaped test carriers observable without affecting network paths.
  if (body == null && headers === undefined) {
    const candidate = response as unknown as { json?: unknown }
    if (typeof candidate.json === 'function') return await (candidate.json as () => Promise<unknown>)()
    return undefined
  }
  const declared = headers?.get('content-length') ?? null
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await Promise.resolve(response.body?.cancel()).catch(() => {})
      throw new FilesResponseTooLargeError(limit)
    }
  }
  if (body === null) return undefined
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (!Number.isSafeInteger(total) || total > limit) {
        await reader.cancel().catch(() => {})
        throw new FilesResponseTooLargeError(limit)
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
/* jscpd:ignore-end */

function parseFileObject(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as WireFileObject
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.object !== 'file'
    || !Number.isSafeInteger(wire.bytes) || (wire.bytes as number) < 0
    || !Number.isSafeInteger(wire.created_at) || (wire.created_at as number) < 0
    || typeof wire.filename !== 'string' || wire.filename.length === 0
    || wire.purpose !== 'user_data'
    || (wire.expires_at !== undefined
      && (!Number.isSafeInteger(wire.expires_at) || (wire.expires_at as number) < 0))) {
    throw invalidResponse(operation)
  }
  return {
    id: DeepSeekFileId(wire.id),
    bytes: wire.bytes as number,
    createdAt: wire.created_at as number,
    filename: wire.filename,
    purpose: 'user_data',
    ...wire.expires_at === undefined ? {} : { expiresAt: wire.expires_at as number },
  }
}

function providerErrorDetail(value: unknown): { message?: string; detail: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { detail: '' }
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { detail: '' }
  const fields = error as { message?: unknown; type?: unknown; code?: unknown }
  const message = typeof fields.message === 'string' ? fields.message : undefined
  return {
    ...message === undefined ? {} : { message },
    detail: [fields.code, fields.type, fields.message]
      .filter((field): field is string => typeof field === 'string')
      .join(' '),
  }
}

/** Direct client for the OpenAI-compatible `/files` endpoints. */
export class DeepSeekFilesClient {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly maxResponseBytes: number

  /**
   * @param options - endpoint, API-key snapshot, and optional test transport.
   */
  constructor(options: FilesApiOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_FILE_RESPONSE_BYTES
    if (!Number.isSafeInteger(this.maxResponseBytes)
      || this.maxResponseBytes < 1
      || this.maxResponseBytes > MAX_FILE_RESPONSE_BYTES) {
      throw new RangeError(`DeepSeek Files API response byte limit must be within 1..${String(MAX_FILE_RESPONSE_BYTES)}`)
    }
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(attributionHeaders())
      headers.set('authorization', `Bearer ${this.apiKey}`)
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        headers,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (response.ok) return response
    let parsed: unknown
    try {
      parsed = await readResponseJson(response, this.maxResponseBytes)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      // A status remains sufficient to report the provider failure.
    }
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${response.status})`,
      response.status,
      detail,
    )
  }

  /**
   * Upload one image with an explicit expiry.
   * @param input - deterministic request-version bytes, media type, filename, lifetime, and cancellation.
   * @returns the validated provider file object, including `expires_at`.
   */
  async upload(input: {
    data: Uint8Array
    mediaType: ImageMediaType
    filename: string
    expiresAfterSeconds: number
    signal?: AbortSignal
  }): Promise<DeepSeekFileObject & { expiresAt: number }> {
    if (input.data.byteLength > MAX_FILE_UPLOAD_BYTES) {
      throw new LlmError('DeepSeek Files API upload exceeds 128 MiB.', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(input.expiresAfterSeconds)
      || input.expiresAfterSeconds < MIN_FILE_EXPIRY_SECONDS
      || input.expiresAfterSeconds > MAX_FILE_EXPIRY_SECONDS) {
      throw new LlmError('DeepSeek file expiry must be between 3600 and 2592000 seconds.', 'INVALID_REQUEST')
    }
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
    form.set('file', new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename)
    const response = await this.request('/files', { method: 'POST', body: form }, input.signal)
    let value: unknown
    try {
      value = await readResponseJson(response, this.maxResponseBytes)
    } catch (error: unknown) {
      if (error instanceof FilesResponseTooLargeError) throw invalidResponse('upload', error)
      throw error
    }
    const file = parseFileObject(value, 'upload')
    if (file.expiresAt === undefined) throw invalidResponse('upload')
    return { ...file, expiresAt: file.expiresAt }
  }

  /**
   * List one ascending or descending page of user-data files.
   * @param options - pagination, ordering, and cancellation.
   * @returns the validated page.
   */
  async list(options: {
    after?: DeepSeekFileIdType
    limit?: number
    order?: 'asc' | 'desc'
    signal?: AbortSignal
  } = {}): Promise<DeepSeekFilePage> {
    const query = new URLSearchParams({ purpose: 'user_data' })
    if (options.after !== undefined) query.set('after', options.after)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.order !== undefined) query.set('order', options.order)
    const response = await this.request(`/files?${query.toString()}`, { method: 'GET' }, options.signal)
    let value: unknown
    try {
      value = await readResponseJson(response, this.maxResponseBytes)
    } catch (error: unknown) {
      if (error instanceof FilesResponseTooLargeError) throw invalidResponse('list', error)
      throw error
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('list')
    const wire = value as { object?: unknown; data?: unknown; first_id?: unknown; last_id?: unknown; has_more?: unknown }
    if (wire.object !== 'list' || !Array.isArray(wire.data) || typeof wire.has_more !== 'boolean'
      || (wire.first_id !== undefined && typeof wire.first_id !== 'string')
      || (wire.last_id !== undefined && typeof wire.last_id !== 'string')) {
      throw invalidResponse('list')
    }
    return {
      data: wire.data.map(item => parseFileObject(item, 'list')),
      ...typeof wire.first_id === 'string' ? { firstId: DeepSeekFileId(wire.first_id) } : {},
      ...typeof wire.last_id === 'string' ? { lastId: DeepSeekFileId(wire.last_id) } : {},
      hasMore: wire.has_more,
    }
  }

  /**
   * Retrieve one file object.
   * @param fileId - provider file identifier.
   * @param signal - request cancellation.
   * @returns the validated file object.
   */
  async retrieve(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<DeepSeekFileObject> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' }, signal)
    let value: unknown
    try {
      value = await readResponseJson(response, this.maxResponseBytes)
    } catch (error: unknown) {
      if (error instanceof FilesResponseTooLargeError) throw invalidResponse('retrieve', error)
      throw error
    }
    return parseFileObject(value, 'retrieve')
  }

  /**
   * Delete one provider file.
   * @param fileId - provider file identifier.
   * @param signal - request cancellation.
   */
  async delete(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, signal)
    let value: unknown
    try {
      value = await readResponseJson(response, this.maxResponseBytes)
    } catch (error: unknown) {
      if (error instanceof FilesResponseTooLargeError) throw invalidResponse('delete', error)
      throw error
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('delete')
    const wire = value as { id?: unknown; object?: unknown; deleted?: unknown }
    if (wire.id !== fileId || wire.object !== 'file' || wire.deleted !== true) throw invalidResponse('delete')
  }
}

/** True for a Fetch abort raised while reading a provider response body. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
