/** Shared browser resumable uploader for the user-document HTTP protocol. */

import { sha256 } from '@noble/hashes/sha2.js'
import type {
  UserDocDirectoryIdType,
  UserDocRef,
  UserDocUploadIdType,
  UserDocUploadSession,
} from '@deepseek-ai/dsh-userdoc'

/** Phase reported by the resumable upload state machine. */
export type UserDocUploadPhase = 'uploading' | 'verifying'

/** Progress callback for one resumable browser upload. */
export type UserDocUploadProgress = (loaded: number, total: number, phase?: UserDocUploadPhase) => void

/** Host-specific HTTP primitives supplied by each client bundle. */
export interface ResumableUploadOptions {
  /** Root document route; defaults to the shared Host route. */
  readonly root?: string
  /** JSON request helper that maps the host's wire errors to its public error class. */
  readonly requestJson: <T>(input: RequestInfo | URL, init?: RequestInit) => Promise<T>
  /** Error used when an XHR disconnects before a response arrives. */
  readonly networkError: (status: number) => Error
  /** Error used when a chunk response carries a structured host failure. */
  readonly responseError: (status: number, body: unknown) => Error
}

interface ResumeRecord {
  readonly fingerprint: string
  readonly uploadId: UserDocUploadIdType
  readonly name: string
  readonly directoryId: UserDocDirectoryIdType
  readonly bytes: number
  readonly updatedAt: number
}

const RESUME_DB_NAME = 'dsh-userdoc-uploads'
const RESUME_STORE_NAME = 'sessions'
const RESUME_STORAGE_KEY = 'dsh-userdoc-upload-sessions-v1'
const FINGERPRINT_BYTES = 64 * 1024
const RETRY_LIMIT = 4

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function hash(data: Uint8Array): string {
  return hex(sha256(data))
}

function resumeKey(directoryId: UserDocDirectoryIdType, fingerprint: string): string {
  return `${String(directoryId)}\u0000${fingerprint}`
}

function localResumeRecords(): Record<string, ResumeRecord> {
  try {
    if (typeof globalThis.localStorage === 'undefined') return {}
    const raw = globalThis.localStorage.getItem(RESUME_STORAGE_KEY)
    if (raw === null) return {}
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as Record<string, ResumeRecord>
  } catch {
    return {}
  }
}

function saveLocalResumeRecords(records: Record<string, ResumeRecord>): void {
  try {
    if (typeof globalThis.localStorage !== 'undefined') globalThis.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(records))
  } catch { /* private storage may be disabled */ }
}

async function openResumeDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(RESUME_DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(RESUME_STORE_NAME) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed')) }
  })
}

async function resumeRecord(key: string): Promise<ResumeRecord | undefined> {
  if (typeof indexedDB === 'undefined') return localResumeRecords()[key]
  try {
    const database = await openResumeDb()
    return await new Promise<ResumeRecord | undefined>((resolve, reject) => {
      const request = database.transaction(RESUME_STORE_NAME, 'readonly').objectStore(RESUME_STORE_NAME).get(key)
      request.onsuccess = () => { resolve(request.result as ResumeRecord | undefined) }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB read failed')) }
    })
  } catch {
    return localResumeRecords()[key]
  }
}

async function putResumeRecord(key: string, record: ResumeRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    const records = localResumeRecords()
    records[key] = record
    saveLocalResumeRecords(records)
    return
  }
  try {
    const database = await openResumeDb()
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(RESUME_STORE_NAME, 'readwrite').objectStore(RESUME_STORE_NAME).put(record, key)
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB write failed')) }
    })
  } catch {
    const records = localResumeRecords()
    records[key] = record
    saveLocalResumeRecords(records)
  }
}

async function deleteResumeRecord(key: string): Promise<void> {
  const records = localResumeRecords()
  Reflect.deleteProperty(records, key)
  saveLocalResumeRecords(records)
  if (typeof indexedDB === 'undefined') return
  try {
    const database = await openResumeDb()
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(RESUME_STORE_NAME, 'readwrite').objectStore(RESUME_STORE_NAME).delete(key)
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB delete failed')) }
    })
  } catch { /* localStorage copy is already removed */ }
}

async function fileFingerprint(file: File, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const first = new Uint8Array(await file.slice(0, Math.min(file.size, FINGERPRINT_BYTES)).arrayBuffer())
  signal?.throwIfAborted()
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - FINGERPRINT_BYTES)).arrayBuffer())
  const descriptor = `${file.name}\u0000${String(file.size)}\u0000${String(file.lastModified)}\u0000${hash(first)}\u0000${hash(last)}`
  return hash(new TextEncoder().encode(descriptor))
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

function xhrChunk(
  url: string,
  body: Blob,
  start: number,
  end: number,
  total: number,
  digest: string,
  signal: AbortSignal | undefined,
  networkError: (status: number) => Error,
  responseError: (status: number, body: unknown) => Error,
  onProgress: (loaded: number) => void,
): Promise<void> {
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
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Range', `bytes ${String(start)}-${String(end)}/${String(total)}`)
    xhr.setRequestHeader('X-DSH-Chunk-SHA256', digest)
    xhr.upload.onprogress = (event) => { onProgress(event.lengthComputable ? event.loaded : 0) }
    xhr.onerror = () => { finish(() => { reject(networkError(xhr.status)) }) }
    xhr.onabort = () => { finish(() => { reject(abortError(signal)) }) }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let bodyValue: unknown
        try { bodyValue = xhr.responseText === '' ? undefined : JSON.parse(xhr.responseText) as unknown } catch { bodyValue = undefined }
        finish(() => { reject(responseError(xhr.status, bodyValue)) })
        return
      }
      finish(resolve)
    }
    try { xhr.send(body) } catch (error) {
      finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined
}

function checkedSession(
  value: unknown,
  file: File,
  responseError: (status: number, body: unknown) => Error,
): UserDocUploadSession {
  const invalid = (): never => {
    throw responseError(502, {
      error: { code: 'DOCUMENT_UPLOAD_RESPONSE_INVALID', message: 'The document upload service returned invalid session metadata.' },
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const candidate = value as Record<string, unknown>
  if (!/^[0-9a-f-]{36}$/u.test(String(candidate.uploadId))
    || typeof candidate.directoryId !== 'string' || typeof candidate.fingerprint !== 'string' || candidate.fingerprint === ''
    || candidate.bytes !== file.size || !Number.isSafeInteger(candidate.chunkBytes) || (candidate.chunkBytes as number) <= 0
    || !Number.isSafeInteger(candidate.receivedBytes) || (candidate.receivedBytes as number) < 0
    || (candidate.receivedBytes as number) > file.size
    || ((candidate.receivedBytes as number) !== file.size
      && (candidate.receivedBytes as number) % (candidate.chunkBytes as number) !== 0)
    || !Number.isSafeInteger(candidate.expiresAt) || (candidate.expiresAt as number) <= 0
    || (candidate.state !== 'uploading' && candidate.state !== 'verifying' && candidate.state !== 'complete' && candidate.state !== 'failed')
    || (candidate.state === 'complete' && candidate.ref === undefined)) invalid()
  return value as UserDocUploadSession
}

function retryable(error: unknown): boolean {
  const status = statusOf(error)
  return (status !== undefined && (status === 408 || status === 429 || status >= 500))
    || error instanceof Error && error.message.includes('connection was interrupted')
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError(signal)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function uploadChunkWithRetry(
  url: string,
  body: Blob,
  start: number,
  end: number,
  total: number,
  digest: string,
  signal: AbortSignal | undefined,
  networkError: (status: number) => Error,
  responseError: (status: number, body: unknown) => Error,
  onProgress: (loaded: number) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await xhrChunk(url, body, start, end, total, digest, signal, networkError, responseError, onProgress)
      return
    } catch (error) {
      if (!retryable(error) || attempt >= RETRY_LIMIT) throw error
      await delay(Math.min(4000, 250 * (2 ** attempt)), signal)
    }
  }
}

/**
 * Upload one browser file through the shared resumable protocol.
 * @param file - browser file to stream in bounded chunks.
 * @param directoryId - destination document directory.
 * @param signal - aborts the active request while retaining the session.
 * @param onProgress - receives bytes and the optional verification phase.
 * @param options - host-specific JSON and network error adapters.
 * @returns the published document reference.
 */
export async function resumableUpload(
  file: File,
  directoryId: UserDocDirectoryIdType,
  signal: AbortSignal | undefined,
  onProgress: UserDocUploadProgress | undefined,
  options: ResumableUploadOptions,
): Promise<UserDocRef> {
  const root = options.root ?? '/api/documents'
  const fingerprint = await fileFingerprint(file, signal)
  const key = resumeKey(directoryId, fingerprint)
  const existing = await resumeRecord(key)
  let session: UserDocUploadSession | undefined
  if (existing !== undefined && existing.bytes === file.size) {
    try {
      session = checkedSession(await options.requestJson<UserDocUploadSession>(
        `${root}/uploads/${encodeURIComponent(String(existing.uploadId))}`,
        signal === undefined ? {} : { signal },
      ), file, options.responseError)
    } catch (error) {
      if (statusOf(error) !== 404 && statusOf(error) !== 410) throw error
      await deleteResumeRecord(key)
    }
  }
  session ??= checkedSession(await options.requestJson<UserDocUploadSession>(`${root}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: file.name, directory: directoryId, bytes: file.size, fingerprint }),
    ...(signal === undefined ? {} : { signal }),
  }), file, options.responseError)
  if (session.state === 'failed') {
    await deleteResumeRecord(key)
    session = checkedSession(await options.requestJson<UserDocUploadSession>(`${root}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: file.name, directory: directoryId, bytes: file.size, fingerprint }),
      ...(signal === undefined ? {} : { signal }),
    }), file, options.responseError)
  }
  await putResumeRecord(key, {
    fingerprint, uploadId: session.uploadId, name: file.name, directoryId, bytes: file.size, updatedAt: Date.now(),
  })
  if (session.state === 'complete' && session.ref !== undefined) {
    await deleteResumeRecord(key)
    return session.ref
  }
  const finalHash = sha256.create()
  let uploaded = session.receivedBytes
  onProgress?.(uploaded, file.size)
  for (let start = 0, index = 0; start < file.size; index += 1) {
    signal?.throwIfAborted()
    const endExclusive = Math.min(file.size, start + session.chunkBytes)
    const data = new Uint8Array(await file.slice(start, endExclusive).arrayBuffer())
    const digest = hash(data)
    finalHash.update(data)
    if (start >= session.receivedBytes) {
      let sent = 0
      await uploadChunkWithRetry(
        `${root}/uploads/${encodeURIComponent(String(session.uploadId))}/chunks/${String(index)}`,
        new Blob([data]), start, endExclusive - 1, file.size, digest, signal, options.networkError, options.responseError,
        (loaded) => { sent = loaded; onProgress?.(uploaded + sent, file.size) },
      )
      uploaded = endExclusive
      onProgress?.(uploaded, file.size)
    }
    start = endExclusive
  }
  let current = checkedSession(await options.requestJson<UserDocUploadSession>(
    `${root}/uploads/${encodeURIComponent(String(session.uploadId))}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sha256: hex(finalHash.digest()) }),
      ...(signal === undefined ? {} : { signal }),
    },
  ), file, options.responseError)
  onProgress?.(file.size, file.size, 'verifying')
  while (current.state === 'verifying') {
    await delay(500, signal)
    current = checkedSession(await options.requestJson<UserDocUploadSession>(
      `${root}/uploads/${encodeURIComponent(String(session.uploadId))}`,
      signal === undefined ? {} : { signal },
    ), file, options.responseError)
  }
  if (current.state === 'complete' && current.ref !== undefined) {
    await deleteResumeRecord(key)
    onProgress?.(file.size, file.size)
    return current.ref
  }
  const code = current.error?.code
  const error = Object.assign(new Error(current.error?.message ?? 'Document upload verification failed.'), {
    status: 422,
    ...(code === undefined ? {} : { code }),
  })
  throw error
}
