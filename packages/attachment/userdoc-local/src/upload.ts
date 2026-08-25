/** Filesystem-backed resumable upload sessions for user documents. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  statfs,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_UPLOAD_BUSY_CODE,
  DOCUMENT_UPLOAD_EXPIRED_CODE,
  DOCUMENT_UPLOAD_HASH_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  DOCUMENT_UPLOAD_SIZE_CODE,
  DOCUMENT_UPLOAD_STATE_CODE,
  DOCUMENT_UPLOAD_STORAGE_CODE,
  UserDocError,
  UserDocUploadId,
} from '@deepseek-ai/dsh-userdoc'
import type {
  BeginUserDocUpload,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadSession,
} from '@deepseek-ai/dsh-userdoc'
import { pathForDirectoryId, pathForDocId } from './name.ts'

/** Default request body size, safely below the public Cloudflare limit. */
export const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
/** Default retention for an incomplete upload session. */
export const DEFAULT_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000
/** Default disk space kept free for the rest of the runtime. */
export const DEFAULT_UPLOAD_MIN_FREE_BYTES = 512 * 1024 * 1024
/** Default number of simultaneous upload sessions. */
export const DEFAULT_UPLOAD_MAX_CONCURRENT = 2
/** Default interval between expired-session sweeps. */
export const DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000

/** Configurable safety policy for local resumable uploads. */
export interface LocalUploadConfig {
  /** Maximum bytes in one HTTP request. */
  readonly chunkBytes?: number
  /** Retention period for an incomplete session. */
  readonly sessionTtlMs?: number
  /** Minimum free bytes retained after an upload reservation. */
  readonly minFreeBytes?: number
  /** Maximum active sessions in one runtime. */
  readonly maxConcurrent?: number
  /** Expired-session sweep interval. */
  readonly cleanupIntervalMs?: number
}

/** Callbacks that connect the session manager to the ordinary document store. */
export interface LocalUploadDependencies {
  /** Runtime document root. */
  readonly root: string
  /** Resolved document limits. */
  readonly limits: UserDocLimits
  /** Resolve and reserve a sanitized target. */
  readonly resolveTarget: (input: { name: string; directoryId: BeginUserDocUpload['directoryId'] }) => Promise<UserDocTarget>
  /** Publish a complete private partial file atomically, recovering a prior commit by digest. */
  readonly publish: (
    target: UserDocTarget,
    partialPath: string,
    bytes: number,
    expectedSha256: string,
  ) => Promise<import('@deepseek-ai/dsh-userdoc').UserDocRef>
}

interface StoredChunk {
  index: number
  start: number
  end: number
  sha256: string
}

interface Manifest {
  formatVersion: 1
  uploadId: string
  name: string
  directoryId: string
  docId: string
  targetPath: string
  bytes: number
  fingerprint: string
  chunkBytes: number
  receivedBytes: number
  lastChunk?: StoredChunk
  expiresAt: number
  state: UserDocUploadSession['state']
  finalSha256?: string
  ref?: import('@deepseek-ai/dsh-userdoc').UserDocRef
  error?: ManifestError
}

interface ManifestError {
  code: string
  message: string
}

interface ActiveJob {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

const ID_PATTERN = /^[0-9a-f-]{36}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_FINGERPRINT_LENGTH = 512
const ADMISSION_LOCK_NAME = '.admission'
const LOCK_WAIT_MS = 30_000

function manifestPath(root: string, uploadId: string): string {
  if (!ID_PATTERN.test(uploadId)) {
    throw new UserDocError('The upload identifier is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
  }
  return join(root, '.upload-sessions', 'v1', uploadId, 'manifest.json')
}

function partialPath(root: string, uploadId: string): string {
  if (!ID_PATTERN.test(uploadId)) {
    throw new UserDocError('The upload identifier is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
  }
  return join(root, '.upload-sessions', 'v1', uploadId, 'data.part')
}

function sessionRoot(root: string): string {
  return join(root, '.upload-sessions', 'v1')
}

function asPublic(manifest: Manifest): UserDocUploadSession {
  return {
    uploadId: UserDocUploadId(manifest.uploadId),
    name: manifest.name,
    directoryId: manifest.directoryId as UserDocUploadSession['directoryId'],
    bytes: manifest.bytes,
    fingerprint: manifest.fingerprint,
    chunkBytes: manifest.chunkBytes,
    receivedBytes: manifest.receivedBytes,
    expiresAt: manifest.expiresAt,
    state: manifest.state,
    ...(manifest.ref === undefined ? {} : { ref: manifest.ref }),
    ...(manifest.error === undefined ? {} : { error: manifest.error }),
  }
}

function invalidManifest(): never {
  throw new UserDocError('The resumable upload manifest is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
}

function parseManifestRef(value: unknown): UserDocRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidManifest()
  const ref = value as Record<string, unknown>
  if (typeof ref.docId !== 'string' || ref.docId === '' || typeof ref.path !== 'string' || ref.path === ''
    || typeof ref.name !== 'string' || ref.name === '' || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0
    || typeof ref.mediaType !== 'string' || ref.mediaType === '' || ref.mediaType.length > 255
    || typeof ref.modifiedAt !== 'number' || !Number.isFinite(ref.modifiedAt)) return invalidManifest()
  return {
    docId: ref.docId as UserDocRef['docId'],
    path: ref.path,
    name: ref.name,
    bytes: ref.bytes as number,
    mediaType: ref.mediaType,
    modifiedAt: ref.modifiedAt,
  }
}

function parseManifest(value: unknown): Manifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidManifest()
  const item = value as Record<string, unknown>
  if (item.formatVersion !== 1 || typeof item.uploadId !== 'string' || !ID_PATTERN.test(item.uploadId)
    || typeof item.name !== 'string' || item.name === '' || typeof item.directoryId !== 'string'
    || typeof item.docId !== 'string' || item.docId === '' || typeof item.targetPath !== 'string'
    || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0
    || typeof item.fingerprint !== 'string' || item.fingerprint === '' || item.fingerprint.length > MAX_FINGERPRINT_LENGTH
    || !Number.isSafeInteger(item.chunkBytes) || (item.chunkBytes as number) <= 0
    || !Number.isSafeInteger(item.receivedBytes) || (item.receivedBytes as number) < 0
    || (item.receivedBytes as number) > (item.bytes as number)
    || !Number.isSafeInteger(item.expiresAt) || (item.expiresAt as number) <= 0
    || !['uploading', 'verifying', 'complete', 'failed'].includes(String(item.state))) {
    return invalidManifest()
  }
  const last = item.lastChunk
  if (last !== undefined) {
    if (last === null || typeof last !== 'object' || Array.isArray(last)) return invalidManifest()
    const chunk = last as Record<string, unknown>
    if (!Number.isSafeInteger(chunk.index) || (chunk.index as number) < 0
      || !Number.isSafeInteger(chunk.start) || (chunk.start as number) < 0
      || !Number.isSafeInteger(chunk.end) || (chunk.end as number) < (chunk.start as number)
      || typeof chunk.sha256 !== 'string' || !SHA256_PATTERN.test(chunk.sha256)
      || (chunk.end as number) - (chunk.start as number) + 1 > (item.chunkBytes as number)
      || (chunk.start as number) !== (item.receivedBytes as number) - ((chunk.end as number) - (chunk.start as number) + 1)
      || (chunk.end as number) >= (item.bytes as number)
      || (chunk.end as number) + 1 !== (item.receivedBytes as number)
      || (chunk.index as number) !== Math.floor((chunk.start as number) / (item.chunkBytes as number))) return invalidManifest()
  }
  if (item.finalSha256 !== undefined && (typeof item.finalSha256 !== 'string' || !SHA256_PATTERN.test(item.finalSha256))) {
    return invalidManifest()
  }
  if ((item.state === 'verifying' || item.state === 'complete') && item.finalSha256 === undefined) return invalidManifest()
  if (item.error !== undefined) {
    if (item.error === null || typeof item.error !== 'object' || Array.isArray(item.error)) return invalidManifest()
    const error = item.error as Record<string, unknown>
    if (typeof error.code !== 'string' || error.code === '' || error.code.length > 128
      || typeof error.message !== 'string' || error.message.length > 1000) return invalidManifest()
  }
  const ref = item.ref === undefined ? undefined : parseManifestRef(item.ref)
  if (item.state === 'complete' && ref === undefined) return invalidManifest()
  return {
    formatVersion: 1,
    uploadId: item.uploadId,
    name: item.name,
    directoryId: item.directoryId,
    docId: item.docId,
    targetPath: item.targetPath,
    bytes: item.bytes as number,
    fingerprint: item.fingerprint,
    chunkBytes: item.chunkBytes as number,
    receivedBytes: item.receivedBytes as number,
    ...(last === undefined ? {} : { lastChunk: last as StoredChunk }),
    expiresAt: item.expiresAt as number,
    state: item.state as Manifest['state'],
    ...(item.finalSha256 === undefined ? {} : { finalSha256: item.finalSha256 }),
    ...(ref === undefined ? {} : { ref }),
    ...(item.error === undefined ? {} : { error: item.error as ManifestError }),
  }
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof UserDocError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UserDocError('Resumable upload session was not found.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to read the resumable upload session.', DOCUMENT_UPLOAD_STORAGE_CODE, { cause: error })
  }
}

async function readBody(body: ReadableStream<Uint8Array>, expected: number, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > expected) throw new UserDocError('Upload chunk is larger than its declared range.', DOCUMENT_UPLOAD_RANGE_CODE)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  if (bytes !== expected) throw new UserDocError('Upload chunk is shorter than its declared range.', DOCUMENT_UPLOAD_RANGE_CODE)
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function admissionLockPath(root: string): string {
  return join(sessionRoot(root), ADMISSION_LOCK_NAME)
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function availableBytes(root: string): Promise<number> {
  try {
    const info = await statfs(root)
    const bytes = info.bavail * info.bsize
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('filesystem free-byte count is invalid')
    return bytes
  } catch (error) {
    throw new UserDocError('Unable to inspect available document storage.', DOCUMENT_UPLOAD_STORAGE_CODE, { cause: error })
  }
}

/** Filesystem implementation of the resumable upload lifecycle. */
export class LocalUploadManager {
  private readonly root: string
  private readonly limits: UserDocLimits
  private readonly resolveTarget: LocalUploadDependencies['resolveTarget']
  private readonly publish: LocalUploadDependencies['publish']
  private readonly chunkBytes: number
  private readonly sessionTtlMs: number
  private readonly minFreeBytes: number
  private readonly maxConcurrent: number
  private readonly cleanupIntervalMs: number
  private readonly jobs = new Map<string, ActiveJob>()
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param dependencies - document-root callbacks and resolved policy.
   * @param config - validated local upload safety settings.
   */
  constructor(dependencies: LocalUploadDependencies, config: Required<LocalUploadConfig>) {
    this.root = dependencies.root
    this.limits = dependencies.limits
    this.resolveTarget = dependencies.resolveTarget
    this.publish = dependencies.publish
    this.chunkBytes = config.chunkBytes
    this.sessionTtlMs = config.sessionTtlMs
    this.minFreeBytes = config.minFreeBytes
    this.maxConcurrent = config.maxConcurrent
    this.cleanupIntervalMs = config.cleanupIntervalMs
  }

  /** Start periodic expired-session cleanup after the document root is ready. */
  startCleanup(): void {
    if (this.cleanupTimer !== undefined) return
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(() => {})
    }, this.cleanupIntervalMs)
    this.cleanupTimer.unref()
  }

  /** Stop periodic cleanup when the owning runtime is disposed. */
  stopCleanup(): void {
    if (this.cleanupTimer === undefined) return
    clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
  }

  /**
   * Remove expired or malformed temporary sessions.
   * @param now - current epoch time used for the expiration comparison.
   */
  async cleanupExpired(now = Date.now()): Promise<void> {
    await mkdir(sessionRoot(this.root), { recursive: true, mode: 0o700 })
    await withFileLock(admissionLockPath(this.root), () => this.sweepExpired(now), { waitMs: LOCK_WAIT_MS })
  }

  private async sweepExpired(now: number): Promise<void> {
    const directory = sessionRoot(this.root)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
      // A live finalizer owns the session even if its original retention
      // deadline passes while it is hashing or publishing. It refreshes the
      // manifest when the commit completes; removing it here would lose a
      // document that is already in the publication path.
      if (this.jobs.has(entry.name)) return
      const path = join(directory, entry.name, 'manifest.json')
      try {
        await withFileLock(path, async () => {
          if (this.jobs.has(entry.name)) return
          const manifest = await readManifest(path)
          if (manifest.expiresAt <= now) await rm(join(directory, entry.name), { recursive: true, force: true })
        }, { waitMs: LOCK_WAIT_MS })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        if (error instanceof UserDocError && error.code === DOCUMENT_UPLOAD_NOT_FOUND_CODE) {
          await rm(join(directory, entry.name), { recursive: true, force: true })
          return
        }
        throw error
      }
    }))
  }

  /**
   * Create or reuse a session for one browser file.
   * @param input - validated browser file metadata.
   * @returns the public upload session state.
   */
  async begin(input: BeginUserDocUpload): Promise<UserDocUploadSession> {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
      throw new UserDocError('The upload byte count is invalid.', DOCUMENT_UPLOAD_SIZE_CODE)
    }
    if (this.limits.maxFileBytes !== null && input.bytes > this.limits.maxFileBytes) {
      throw new UserDocError('Document exceeds the configured byte limit.', DOCUMENT_TOO_LARGE_CODE)
    }
    if (input.fingerprint === '' || input.fingerprint.length > MAX_FINGERPRINT_LENGTH) {
      throw new UserDocError('The upload fingerprint is invalid.', DOCUMENT_UPLOAD_SIZE_CODE)
    }
    await mkdir(sessionRoot(this.root), { recursive: true, mode: 0o700 })
    return withFileLock(admissionLockPath(this.root), async () => {
      await this.sweepExpired(Date.now())
      const existing = await this.findByFingerprint(input)
      if (existing !== undefined) {
        if (existing.state === 'verifying') this.startFinalization(existing)
        return asPublic(existing)
      }
      const active = await this.activeCount()
      if (active >= this.maxConcurrent) {
        throw new UserDocError('Too many document uploads are active.', DOCUMENT_UPLOAD_BUSY_CODE)
      }
      const free = await availableBytes(this.root)
      const reserved = await this.reservedRemainingBytes()
      if (free - this.minFreeBytes - reserved < input.bytes) {
        throw new UserDocError('There is not enough free document storage.', DOCUMENT_UPLOAD_STORAGE_CODE)
      }
      const target = await this.resolveTarget({ name: input.name, directoryId: input.directoryId })
      const uploadId = randomUUID()
      const directory = join(sessionRoot(this.root), uploadId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const manifest: Manifest = {
        formatVersion: 1,
        uploadId,
        name: target.name,
        directoryId: String(input.directoryId),
        docId: String(target.docId),
        targetPath: target.path,
        bytes: input.bytes,
        fingerprint: input.fingerprint,
        chunkBytes: this.chunkBytes,
        receivedBytes: 0,
        expiresAt: Date.now() + this.sessionTtlMs,
        state: 'uploading',
      }
      const handle = await open(join(directory, 'data.part'), 'wx', 0o600)
      await handle.close()
      await writeFileAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600, dirMode: 0o700 })
      return asPublic(manifest)
    }, { waitMs: LOCK_WAIT_MS })
  }

  /**
   * Read one session, rejecting expired or malformed state.
   * @param uploadId - opaque upload identifier.
   * @returns the public upload session state.
   */
  async inspect(uploadId: UserDocUploadId): Promise<UserDocUploadSession> {
    const manifest = await this.load(uploadId)
    if (manifest.state === 'verifying') this.startFinalization(manifest)
    return asPublic(manifest)
  }

  /** Resume finalization jobs that were marked verifying before a process stop. */
  async resumePendingFinalizations(): Promise<void> {
    let entries
    try {
      entries = await readdir(sessionRoot(this.root), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      try {
        const manifest = await this.load(UserDocUploadId(entry.name))
        if (manifest.state === 'verifying') this.startFinalization(manifest)
      } catch {
        // Cleanup has already removed expired or malformed sessions. A single
        // unreadable sibling must not prevent healthy sessions from resuming.
      }
    }
  }

  /**
   * Write one sequential, hash-verified chunk.
   * @param uploadId - opaque upload identifier.
   * @param chunk - validated range and body digest.
   * @param signal - optional cancellation signal.
   * @returns the updated public upload session state.
   */
  async write(uploadId: UserDocUploadId, chunk: UserDocUploadChunk, signal?: AbortSignal): Promise<UserDocUploadSession> {
    signal?.throwIfAborted()
    const path = manifestPath(this.root, String(uploadId))
    return withFileLock(path, async () => {
      signal?.throwIfAborted()
      const manifest = await this.load(uploadId)
      if (manifest.state !== 'uploading') {
        if (manifest.state === 'complete' || manifest.state === 'verifying') return asPublic(manifest)
        throw new UserDocError('The upload session cannot accept more chunks.', DOCUMENT_UPLOAD_STATE_CODE)
      }
      if (![chunk.index, chunk.start, chunk.end, chunk.total].every(Number.isSafeInteger)
        || chunk.index < 0 || chunk.start < 0 || chunk.end < chunk.start || chunk.total < 0
        || chunk.total !== manifest.bytes || chunk.end >= manifest.bytes) {
        throw new UserDocError('The upload chunk range is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
      }
      const expectedLength = chunk.end - chunk.start + 1
      if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > manifest.chunkBytes) {
        throw new UserDocError('The upload chunk range is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
      }
      if (chunk.start < manifest.receivedBytes && manifest.lastChunk !== undefined
        && chunk.index === manifest.lastChunk.index && chunk.start === manifest.lastChunk.start
        && chunk.end === manifest.lastChunk.end && chunk.sha256 === manifest.lastChunk.sha256) {
        const data = await readBody(chunk.body, expectedLength, signal)
        if (hashBytes(data) !== chunk.sha256) {
          throw new UserDocError('The upload chunk hash does not match its bytes.', DOCUMENT_UPLOAD_HASH_CODE)
        }
        return asPublic(manifest)
      }
      if (expectedLength > manifest.chunkBytes || chunk.start !== manifest.receivedBytes
        || chunk.index !== Math.floor(chunk.start / manifest.chunkBytes)) {
        throw new UserDocError('The upload chunk range is invalid.', DOCUMENT_UPLOAD_RANGE_CODE)
      }
      if (!SHA256_PATTERN.test(chunk.sha256)) {
        throw new UserDocError('The upload chunk hash is invalid.', DOCUMENT_UPLOAD_HASH_CODE)
      }
      const data = await readBody(chunk.body, expectedLength, signal)
      if (hashBytes(data) !== chunk.sha256) {
        throw new UserDocError('The upload chunk hash does not match its bytes.', DOCUMENT_UPLOAD_HASH_CODE)
      }
      signal?.throwIfAborted()
      const free = await availableBytes(this.root)
      if (free < this.minFreeBytes + data.byteLength) {
        throw new UserDocError('There is not enough free document storage.', DOCUMENT_UPLOAD_STORAGE_CODE)
      }
      let handle
      try {
        handle = await open(partialPath(this.root, manifest.uploadId), 'r+')
        await handle.write(data, 0, data.byteLength, chunk.start)
        await handle.sync()
      } catch (error) {
        throw new UserDocError('Unable to store the upload chunk.', DOCUMENT_UPLOAD_STORAGE_CODE, { cause: error })
      } finally {
        await handle?.close()
      }
      const next: Manifest = {
        ...manifest,
        receivedBytes: manifest.receivedBytes + data.byteLength,
        lastChunk: { index: chunk.index, start: chunk.start, end: chunk.end, sha256: chunk.sha256 },
        expiresAt: Date.now() + this.sessionTtlMs,
      }
      await writeFileAtomic(path, `${JSON.stringify(next)}\n`, { mode: 0o600, dirMode: 0o700 })
      return asPublic(next)
    }, { waitMs: 30_000 })
  }

  /**
   * Start asynchronous final verification and return its current state.
   * @param uploadId - opaque upload identifier.
   * @param sha256 - final SHA-256 digest.
   * @returns the public upload session state.
   */
  async complete(uploadId: UserDocUploadId, sha256: string): Promise<UserDocUploadSession> {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new UserDocError('The final upload hash is invalid.', DOCUMENT_UPLOAD_HASH_CODE)
    }
    const path = manifestPath(this.root, String(uploadId))
    return withFileLock(path, async () => {
      const manifest = await this.load(uploadId)
      if ((manifest.state === 'complete' || manifest.state === 'verifying')
        && manifest.finalSha256 !== undefined && manifest.finalSha256 !== sha256) {
        throw new UserDocError('The final upload hash does not match the active session.', DOCUMENT_UPLOAD_HASH_CODE)
      }
      if (manifest.state === 'complete' || manifest.state === 'verifying') {
        if (manifest.state === 'verifying') this.startFinalization(manifest)
        return asPublic(manifest)
      }
      if (manifest.state === 'failed') throw new UserDocError(manifest.error?.message ?? 'The upload failed.', DOCUMENT_UPLOAD_STATE_CODE)
      if (manifest.receivedBytes !== manifest.bytes) {
        throw new UserDocError('The upload is missing bytes.', DOCUMENT_UPLOAD_RANGE_CODE)
      }
      const next: Manifest = { ...manifest, state: 'verifying', finalSha256: sha256, expiresAt: Date.now() + this.sessionTtlMs }
      await writeFileAtomic(path, `${JSON.stringify(next)}\n`, { mode: 0o600, dirMode: 0o700 })
      this.startFinalization(next)
      return asPublic(next)
    }, { waitMs: 30_000 })
  }

  /**
   * Cancel an incomplete session and remove all temporary bytes.
   * @param uploadId - opaque upload identifier.
   */
  async cancel(uploadId: UserDocUploadId): Promise<void> {
    const id = String(uploadId)
    const job = this.jobs.get(id)
    if (job !== undefined) {
      job.controller.abort()
      await job.promise.catch(() => {})
    }
    const path = manifestPath(this.root, id)
    await withFileLock(path, async () => {
      const manifest = await this.load(uploadId)
      if (manifest.state === 'complete') throw new UserDocError('Completed documents cannot be cancelled.', DOCUMENT_UPLOAD_STATE_CODE)
      await rm(join(sessionRoot(this.root), id), { recursive: true, force: true })
    }, { waitMs: LOCK_WAIT_MS })
  }

  private async load(uploadId: UserDocUploadId, options: { readonly allowExpired?: boolean } = {}): Promise<Manifest> {
    const id = String(uploadId)
    if (!ID_PATTERN.test(id)) throw new UserDocError('The upload identifier is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE)
    const manifest = await readManifest(manifestPath(this.root, id))
    try {
      const target = pathForDocId(this.root, manifest.docId)
      if (manifest.uploadId !== id || target !== manifest.targetPath || basename(target) !== manifest.name
        || pathForDirectoryId(this.root, manifest.directoryId) !== dirname(target)) throw new Error('upload target metadata is inconsistent')
      if (manifest.ref !== undefined) {
        const refPath = pathForDocId(this.root, String(manifest.ref.docId))
        if (refPath !== manifest.ref.path || refPath !== target || manifest.ref.name !== basename(refPath)
          || manifest.ref.bytes !== manifest.bytes) throw new Error('upload publication metadata is inconsistent')
      }
    } catch (error) {
      throw new UserDocError('The resumable upload target is invalid.', DOCUMENT_UPLOAD_NOT_FOUND_CODE, { cause: error })
    }
    if (!options.allowExpired && manifest.expiresAt <= Date.now()) {
      await rm(join(sessionRoot(this.root), id), { recursive: true, force: true })
      throw new UserDocError('The upload session has expired.', DOCUMENT_UPLOAD_EXPIRED_CODE)
    }
    return manifest
  }

  private async findByFingerprint(input: BeginUserDocUpload): Promise<Manifest | undefined> {
    let entries
    try {
      entries = await readdir(sessionRoot(this.root), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      try {
        const manifest = await this.load(UserDocUploadId(entry.name))
        if (manifest.fingerprint === input.fingerprint && manifest.bytes === input.bytes
          && manifest.directoryId === String(input.directoryId)
          && (manifest.state === 'uploading' || manifest.state === 'verifying')) return manifest
      } catch {
        // Cleanup owns malformed sessions; one broken sibling must not block a new upload.
      }
    }
    return undefined
  }

  private async activeCount(): Promise<number> {
    let entries
    try {
      entries = await readdir(sessionRoot(this.root), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let count = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      try {
        const manifest = await readManifest(manifestPath(this.root, entry.name))
        if (manifest.expiresAt > Date.now() && (manifest.state === 'uploading' || manifest.state === 'verifying')) count += 1
      } catch {
        // Malformed sessions are removed by the next cleanup pass.
      }
    }
    return count
  }

  private async reservedRemainingBytes(): Promise<number> {
    let entries
    try {
      entries = await readdir(sessionRoot(this.root), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let reserved = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      try {
        const manifest = await this.load(UserDocUploadId(entry.name))
        if (manifest.state !== 'uploading' && manifest.state !== 'verifying') continue
        const remaining = manifest.bytes - manifest.receivedBytes
        if (remaining > 0) {
          reserved += remaining
          if (!Number.isSafeInteger(reserved)) throw new UserDocError('Reserved upload storage is invalid.', DOCUMENT_UPLOAD_STORAGE_CODE)
        }
      } catch (error) {
        if (error instanceof UserDocError
          && (error.code === DOCUMENT_UPLOAD_EXPIRED_CODE || error.code === DOCUMENT_UPLOAD_NOT_FOUND_CODE)) continue
        throw error
      }
    }
    return reserved
  }

  private startFinalization(manifest: Manifest): void {
    if (this.jobs.has(manifest.uploadId)) return
    const controller = new AbortController()
    const promise = this.finalize(manifest, controller.signal).finally(() => {
      this.jobs.delete(manifest.uploadId)
    })
    this.jobs.set(manifest.uploadId, { controller, promise })
    void promise.catch(() => {})
  }

  private async finalize(manifest: Manifest, signal: AbortSignal): Promise<void> {
    try {
      await this.refreshFinalizationLease(manifest)
      const digest = createHash('sha256')
      let partialPresent = true
      try {
        for await (const chunk of createReadStream(partialPath(this.root, manifest.uploadId))) {
          signal.throwIfAborted()
          digest.update(Buffer.from(chunk as Uint8Array))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // The hard-link publication may have committed before a process
        // stopped. `publishDocPartial` verifies the target and recovers that
        // commit below, so a missing private inode is not itself a failure.
        partialPresent = false
      }
      signal.throwIfAborted()
      await this.refreshFinalizationLease(manifest)
      if (partialPresent && digest.digest('hex') !== manifest.finalSha256) {
        await this.markFailed(manifest, DOCUMENT_UPLOAD_HASH_CODE, 'The final upload hash does not match its bytes.')
        return
      }
      const target: UserDocTarget = {
        path: manifest.targetPath,
        name: manifest.name,
        docId: manifest.docId as UserDocTarget['docId'],
      }
      await withFileLock(manifestPath(this.root, manifest.uploadId), async () => {
        const current = await this.load(UserDocUploadId(manifest.uploadId), { allowExpired: true })
        if (current.state === 'complete') return
        if (current.state !== 'verifying' || current.finalSha256 === undefined || current.finalSha256 !== manifest.finalSha256) return
        const ref = await this.publish(
          target,
          partialPath(this.root, manifest.uploadId),
          current.bytes,
          current.finalSha256,
        )
        const complete: Manifest = { ...current, state: 'complete', ref, expiresAt: Date.now() + this.sessionTtlMs }
        await writeFileAtomic(manifestPath(this.root, manifest.uploadId), `${JSON.stringify(complete)}\n`, { mode: 0o600, dirMode: 0o700 })
      }, { waitMs: LOCK_WAIT_MS })
    } catch (error) {
      if (signal.aborted) return
      const code = error instanceof UserDocError ? error.code : DOCUMENT_UPLOAD_STORAGE_CODE
      await this.markFailed(manifest, code, error instanceof Error ? error.message : 'The upload could not be finalized.')
    }
  }

  private async refreshFinalizationLease(manifest: Manifest): Promise<void> {
    const path = manifestPath(this.root, manifest.uploadId)
    await withFileLock(path, async () => {
      const current = await this.load(UserDocUploadId(manifest.uploadId), { allowExpired: true })
      if (current.state !== 'verifying') return
      const refreshed: Manifest = { ...current, expiresAt: Date.now() + this.sessionTtlMs }
      await writeFileAtomic(path, `${JSON.stringify(refreshed)}\n`, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: LOCK_WAIT_MS })
  }

  private async markFailed(manifest: Manifest, code: string, message: string): Promise<void> {
    const path = manifestPath(this.root, manifest.uploadId)
    await withFileLock(path, async () => {
      let current: Manifest
      try {
        current = await this.load(UserDocUploadId(manifest.uploadId), { allowExpired: true })
      } catch (error) {
        if (error instanceof UserDocError && error.code === DOCUMENT_UPLOAD_NOT_FOUND_CODE) return
        throw error
      }
      if (current.state === 'complete') return
      const failed: Manifest = {
        ...current,
        state: 'failed',
        error: { code, message },
        expiresAt: Date.now() + this.sessionTtlMs,
      }
      await writeFileAtomic(path, `${JSON.stringify(failed)}\n`, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: LOCK_WAIT_MS })
  }
}
