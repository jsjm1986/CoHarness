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
  /** Query string appended to every session, chunk, status, and completion request. */
  readonly query?: string
  /** Namespace used to isolate resumable sessions for distinct document targets. */
  readonly resumeNamespace?: string
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
  /** Server expiry copied at admission; old records fall back to the local TTL. */
  readonly expiresAt?: number
}

const RESUME_DB_NAME = 'dsh-userdoc-uploads'
const RESUME_STORE_NAME = 'sessions'
const RESUME_STORAGE_KEY = 'dsh-userdoc-upload-sessions-v1'
const FINGERPRINT_BYTES = 64 * 1024
const RETRY_LIMIT = 4
/** Do not wait forever for a provider that keeps returning `verifying`. */
const MAX_VERIFY_WAIT_MS = 5 * 60 * 1000
/** Bound browser-side retained resume metadata when storage is persistent. */
const MAX_LOCAL_RESUME_RECORDS = 256
/** Bound total serialized resume metadata in either browser storage backend. */
const MAX_LOCAL_RESUME_BYTES = 1024 * 1024
/** Fallback lifetime for records written before server expiry was persisted. */
const RESUME_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Prevent a malformed runtime response from forcing an unbounded browser allocation. */
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function hash(data: Uint8Array): string {
  return hex(sha256(data))
}

function resumeKey(directoryId: UserDocDirectoryIdType, fingerprint: string, namespace: string): string {
  return namespace === ''
    ? `${String(directoryId)}\u0000${fingerprint}`
    : `${namespace}\u0000${String(directoryId)}\u0000${fingerprint}`
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function recordBytes(key: string, record: ResumeRecord): number {
  return utf8Bytes(JSON.stringify([key, record]))
}

function isResumeRecord(value: unknown): value is ResumeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.fingerprint === 'string'
    && /^[0-9a-f]{64}$/u.test(record.fingerprint)
    && typeof record.uploadId === 'string'
    && /^[0-9a-f-]{36}$/u.test(record.uploadId)
    && typeof record.name === 'string'
    && typeof record.directoryId === 'string'
    && Number.isSafeInteger(record.bytes) && (record.bytes as number) >= 0
    && Number.isSafeInteger(record.updatedAt) && (record.updatedAt as number) > 0
    && (record.expiresAt === undefined
      || Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > 0)
}

function isFreshResumeRecord(record: unknown, now: number): record is ResumeRecord {
  if (!isResumeRecord(record)) return false
  const expiresAt = record.expiresAt ?? record.updatedAt + RESUME_RECORD_TTL_MS
  return expiresAt > now && now - record.updatedAt <= RESUME_RECORD_TTL_MS
}

function boundedLocalRecords(records: Record<string, ResumeRecord>): Record<string, ResumeRecord> {
  const entries = Object.entries(records).sort((left, right) => left[1].updatedAt - right[1].updatedAt)
  const minimumStart = Math.max(0, entries.length - MAX_LOCAL_RESUME_RECORDS)
  const make = (start: number): Record<string, ResumeRecord> => {
    const bounded: Record<string, ResumeRecord> = Object.create(null) as Record<string, ResumeRecord>
    for (const [key, value] of entries.slice(start)) {
      Object.defineProperty(bounded, key, { configurable: true, enumerable: true, value, writable: true })
    }
    return bounded
  }
  let low = minimumStart
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (utf8Bytes(JSON.stringify(make(middle))) <= MAX_LOCAL_RESUME_BYTES) high = middle
    else low = middle + 1
  }
  return make(low)
}

function endpoint(root: string, suffix: string, query: string): string {
  return `${root}${suffix}${query}`
}

function localResumeRecords(now = Date.now()): Record<string, ResumeRecord> {
  try {
    if (typeof globalThis.localStorage === 'undefined') return {}
    const raw = globalThis.localStorage.getItem(RESUME_STORAGE_KEY)
    if (raw === null) return {}
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const records: Record<string, ResumeRecord> = Object.create(null) as Record<string, ResumeRecord>
    let changed = false
    for (const [key, entry] of Object.entries(value)) {
      if (isFreshResumeRecord(entry, now)) {
        Object.defineProperty(records, key, { configurable: true, enumerable: true, value: entry, writable: true })
      } else {
        changed = true
      }
    }
    const bounded = boundedLocalRecords(records)
    if (changed || Object.keys(bounded).length !== Object.keys(records).length) saveLocalResumeRecords(bounded)
    return bounded
  } catch {
    return {}
  }
}

function saveLocalResumeRecords(records: Record<string, ResumeRecord>): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return
    const bounded = boundedLocalRecords(records)
    globalThis.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(bounded))
  } catch { /* private storage may be disabled */ }
}

async function openResumeDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(RESUME_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RESUME_STORE_NAME)) request.result.createObjectStore(RESUME_STORE_NAME)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB open failed')) }
  })
}

async function resumeRecord(key: string): Promise<ResumeRecord | undefined> {
  if (typeof indexedDB === 'undefined') return localResumeRecords()[key]
  let database: IDBDatabase | undefined
  try {
    const opened = await openResumeDb()
    database = opened
    await pruneIndexedDbRecords(opened)
    return await new Promise<ResumeRecord | undefined>((resolve, reject) => {
      const request = opened.transaction(RESUME_STORE_NAME, 'readonly').objectStore(RESUME_STORE_NAME).get(key)
      request.onsuccess = () => {
        const value: unknown = request.result
        resolve(isFreshResumeRecord(value, Date.now()) ? value : undefined)
      }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB read failed')) }
    })
  } catch {
    return localResumeRecords()[key]
  } finally {
    database?.close()
  }
}

async function putResumeRecord(key: string, record: ResumeRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    const records = localResumeRecords()
    records[key] = record
    saveLocalResumeRecords(records)
    return
  }
  let database: IDBDatabase | undefined
  try {
    const opened = await openResumeDb()
    database = opened
    await new Promise<void>((resolve, reject) => {
      const request = opened.transaction(RESUME_STORE_NAME, 'readwrite').objectStore(RESUME_STORE_NAME).put(record, key)
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB write failed')) }
    })
    await pruneIndexedDbRecords(opened)
  } catch {
    const records = localResumeRecords()
    records[key] = record
    saveLocalResumeRecords(records)
  } finally {
    database?.close()
  }
}

async function deleteResumeRecord(key: string): Promise<void> {
  const records = localResumeRecords()
  Reflect.deleteProperty(records, key)
  saveLocalResumeRecords(records)
  if (typeof indexedDB === 'undefined') return
  let database: IDBDatabase | undefined
  try {
    const opened = await openResumeDb()
    database = opened
    await new Promise<void>((resolve, reject) => {
      const request = opened.transaction(RESUME_STORE_NAME, 'readwrite').objectStore(RESUME_STORE_NAME).delete(key)
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB delete failed')) }
    })
  } catch { /* localStorage copy is already removed */
  } finally {
    database?.close()
  }
}

/** Remove expired, malformed, and oldest oversized IndexedDB resume records. */
async function pruneIndexedDbRecords(database: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RESUME_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(RESUME_STORE_NAME)
    const entries: Array<{ readonly key: string; readonly record: ResumeRecord }> = []
    const now = Date.now()
    transaction.onerror = () => { reject(transaction.error ?? new Error('IndexedDB cleanup failed')) }
    transaction.onabort = () => { reject(transaction.error ?? new Error('IndexedDB cleanup aborted')) }
    transaction.oncomplete = () => { resolve() }
    const request = store.openCursor()
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB cleanup read failed')) }
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor === null) {
        entries.sort((left, right) => left.record.updatedAt - right.record.updatedAt)
        const keep = new Set<string>()
        let bytes = 0
        for (let index = entries.length - 1; index >= 0 && keep.size < MAX_LOCAL_RESUME_RECORDS; index -= 1) {
          const entry = entries[index] as { readonly key: string; readonly record: ResumeRecord }
          const size = recordBytes(entry.key, entry.record)
          if (bytes + size > MAX_LOCAL_RESUME_BYTES) continue
          keep.add(entry.key)
          bytes += size
        }
        for (const entry of entries) {
          if (!keep.has(entry.key)) store.delete(entry.key)
        }
        return
      }
      if (isFreshResumeRecord(cursor.value, now)) {
        if (typeof cursor.key === 'string') entries.push({ key: cursor.key, record: cursor.value })
      } else {
        cursor.delete()
      }
      cursor.continue()
    }
  })
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
    if (signal?.aborted) {
      abort()
      return
    }
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
  expectedDirectoryId?: UserDocDirectoryIdType,
): UserDocUploadSession {
  const invalid = (): never => {
    throw responseError(502, {
      error: { code: 'DOCUMENT_UPLOAD_RESPONSE_INVALID', message: 'The document upload service returned invalid session metadata.' },
    })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const candidate = value as Record<string, unknown>
  if (!/^[0-9a-f-]{36}$/u.test(String(candidate.uploadId))
    || typeof candidate.directoryId !== 'string'
    || (expectedDirectoryId !== undefined && candidate.directoryId !== String(expectedDirectoryId))
    || typeof candidate.fingerprint !== 'string' || candidate.fingerprint === ''
    || candidate.bytes !== file.size || !Number.isSafeInteger(candidate.chunkBytes) || (candidate.chunkBytes as number) <= 0
    || (candidate.chunkBytes as number) > MAX_UPLOAD_CHUNK_BYTES
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
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
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
  const query = options.query ?? ''
  const namespace = options.resumeNamespace ?? ''
  const fingerprint = await fileFingerprint(file, signal)
  const key = resumeKey(directoryId, fingerprint, namespace)
  const existing = await resumeRecord(key)
  let session: UserDocUploadSession | undefined
  if (existing !== undefined && existing.bytes === file.size) {
    try {
      session = checkedSession(await options.requestJson<UserDocUploadSession>(
        endpoint(root, `/uploads/${encodeURIComponent(String(existing.uploadId))}`, query),
        signal === undefined ? {} : { signal },
      ), file, options.responseError, directoryId)
    } catch (error) {
      if (statusOf(error) !== 404 && statusOf(error) !== 410) throw error
      await deleteResumeRecord(key)
    }
  }
  session ??= checkedSession(await options.requestJson<UserDocUploadSession>(endpoint(root, '/uploads', query), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, name: file.name, directory: directoryId, bytes: file.size, fingerprint }),
    ...(signal === undefined ? {} : { signal }),
  }), file, options.responseError, directoryId)
  if (session.state === 'failed') {
    await deleteResumeRecord(key)
    session = checkedSession(await options.requestJson<UserDocUploadSession>(endpoint(root, '/uploads', query), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: file.name, directory: directoryId, bytes: file.size, fingerprint }),
      ...(signal === undefined ? {} : { signal }),
    }), file, options.responseError, directoryId)
    if (session.state === 'failed') {
      await deleteResumeRecord(key)
      throw options.responseError(422, session)
    }
  }
  await putResumeRecord(key, {
    fingerprint,
    uploadId: session.uploadId,
    name: file.name,
    directoryId,
    bytes: file.size,
    updatedAt: Date.now(),
    expiresAt: session.expiresAt,
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
        endpoint(root, `/uploads/${encodeURIComponent(String(session.uploadId))}/chunks/${String(index)}`, query),
        new Blob([data]), start, endExclusive - 1, file.size, digest, signal, options.networkError, options.responseError,
        (loaded) => { sent = loaded; onProgress?.(uploaded + sent, file.size) },
      )
      uploaded = endExclusive
      onProgress?.(uploaded, file.size)
    }
    start = endExclusive
  }
  let current = checkedSession(await options.requestJson<UserDocUploadSession>(
    endpoint(root, `/uploads/${encodeURIComponent(String(session.uploadId))}/complete`, query),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sha256: hex(finalHash.digest()) }),
      ...(signal === undefined ? {} : { signal }),
    },
  ), file, options.responseError, directoryId)
  onProgress?.(file.size, file.size, 'verifying')
  const verifyDeadline = Math.min(current.expiresAt, Date.now() + MAX_VERIFY_WAIT_MS)
  while (current.state === 'verifying') {
    const remaining = verifyDeadline - Date.now()
    if (remaining <= 0) {
      await deleteResumeRecord(key)
      throw Object.assign(new Error('Document upload verification timed out.'), {
        status: 504,
        code: 'DOCUMENT_UPLOAD_VERIFY_TIMEOUT',
      })
    }
    await delay(Math.min(500, remaining), signal)
    current = checkedSession(await options.requestJson<UserDocUploadSession>(
      endpoint(root, `/uploads/${encodeURIComponent(String(session.uploadId))}`, query),
      signal === undefined ? {} : { signal },
    ), file, options.responseError, directoryId)
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
