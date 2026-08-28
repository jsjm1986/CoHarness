/** Local real-file document backend rooted below the operating-system home. @module @deepseek-ai/dsh-userdoc-local */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { UserDocDirectoryId, UserDocStore } from '@deepseek-ai/dsh-userdoc'
import type {
  BeginUserDocUpload,
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocListQuery,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadId,
  UserDocUploadSession,
  UserDocTrashPage,
  UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  createDocDirectory,
  listDocDirectories,
  listDocDirectory,
  listDocFiles,
  moveDocFile,
  openDocFile,
  publishDocPartial,
  readDocFile,
  removeDocDirectory,
  removeDocFile,
  renameDocDirectory,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from './store.ts'
import {
  listTrash,
  purgeDocument,
  purgeDueDocuments,
  restoreDocument,
  trashDocument,
} from './trash.ts'
import { migrateLegacyDocuments } from './migration.ts'
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  MAX_UPLOAD_TIMER_DELAY_MS,
  LocalUploadManager,
} from './upload.ts'

export {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  MAX_UPLOAD_TIMER_DELAY_MS,
} from './upload.ts'

export { DEFAULT_MEDIA_TYPE, mediaTypeFor } from './media-type.ts'
export {
  directoryIdFor,
  docIdFor,
  isInside,
  parentDirectoryId,
  pathForDirectoryId,
  pathForDocId,
  sanitizeDirectoryName,
  sanitizeName,
  suffixName,
} from './name.ts'
export {
  dayDirectory,
  createDocDirectory,
  listDocDirectories,
  listDocDirectory,
  listDocFiles,
  moveDocFile,
  openDocFile,
  publishDocPartial,
  readDocFile,
  removeDocDirectory,
  removeDocFile,
  renameDocDirectory,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from './store.ts'
export { listTrash, purgeDocument, purgeDueDocuments, restoreDocument, trashDocument } from './trash.ts'

/** Default document directory name below the runtime operating-system home. */
export const DEFAULT_DOCUMENT_DIR_NAME = 'documents'
/** Previous document directory name used for one-time migration. */
export const LEGACY_UPLOAD_DIR_NAME = 'uploads'
/** Default per-document byte limit; `null` accepts every transport-supported size. */
export const DEFAULT_MAX_FILE_BYTES: number | null = null
/** Default maximum documents in one prompt. */
export const DEFAULT_MAX_FILES_PER_MESSAGE = 20
/** Default maximum aggregate document bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_BYTES = 200 * 1024 * 1024
/** Default maximum bytes of a document inlined into a prompt as text. */
export const DEFAULT_MAX_INLINE_TEXT_BYTES = 256 * 1024

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Document listing was aborted.', { cause: signal.reason })
}

/** Share one filesystem scan while keeping cancellation local to each waiter. */
class SharedRead<T> {
  private settled = false
  private waiters = 0
  readonly controller = new AbortController()
  readonly promise: Promise<T>

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      if (this.waiters === 0 && !this.settled) this.controller.abort()
      signal.throwIfAborted()
    }
    this.waiters += 1
    if (signal === undefined) return this.promise.finally(() => { this.release(false) })
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled)
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        release(true)
        reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.promise.then((value) => {
        signal.removeEventListener('abort', onAbort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        release(false)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      })
    })
  }

  /** Cancel the shared scan when its cached result is no longer useful. */
  cancel(reason = new Error('document scan invalidated')): void {
    if (!this.settled) this.controller.abort(reason)
  }

  private release(cancelled: boolean): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled) this.controller.abort()
  }
}

/** Local document backend configuration. */
export interface Config {
  /**
   * Absolute document root, `~`-expanded. Omitted uses `<home>/documents`.
   *
   * The deployment must keep this inside a directory the tool authorization
   * policy already grants the session, because every stored reference carries
   * a real path the model is invited to read.
   */
  uploadRoot?: string
  /** Optional legacy root to migrate into `uploadRoot`; omitted defaults to `<home>/uploads` only when `uploadRoot` is omitted. */
  legacyUploadRoot?: string
  /** Maximum bytes accepted for one document; omitted leaves the document size unlimited. */
  maxFileBytes?: number
  /** Maximum document count accepted in one submitted message. */
  maxFilesPerMessage?: number
  /** Maximum aggregate bytes accepted in one submitted message. */
  maxMessageBytes?: number
  /** Maximum bytes of a document inlined into a prompt as text. */
  maxInlineTextBytes?: number
  /** Maximum bytes accepted by one resumable upload request. */
  uploadChunkBytes?: number
  /** Retention period for incomplete resumable uploads. */
  uploadSessionTtlMs?: number
  /** Minimum free bytes retained on the document filesystem. */
  uploadMinFreeBytes?: number
  /** Maximum concurrent resumable upload sessions. */
  uploadMaxConcurrent?: number
  /** Interval between expired-session cleanup sweeps. */
  uploadCleanupIntervalMs?: number
  /** Maximum serialized upload manifest bytes read from disk. */
  uploadManifestMaxBytes?: number
  /** Recoverable document trash retention in days. */
  trashRetentionDays?: number
}

/** Real-file local document store. */
export class LocalUserDocStore extends UserDocStore {
  static Config: z<Config> = z.object({
    uploadRoot: z.string(),
    legacyUploadRoot: z.string(),
    maxFileBytes: z.number().step(1).min(1),
    maxFilesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_FILES_PER_MESSAGE),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxInlineTextBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_TEXT_BYTES),
    uploadChunkBytes: z.number().step(1).min(64 * 1024).default(DEFAULT_UPLOAD_CHUNK_BYTES),
    uploadSessionTtlMs: z.number().step(1).min(60 * 1000).default(DEFAULT_UPLOAD_SESSION_TTL_MS),
    uploadMinFreeBytes: z.number().step(1).min(0).default(DEFAULT_UPLOAD_MIN_FREE_BYTES),
    uploadMaxConcurrent: z.number().step(1).min(1).default(DEFAULT_UPLOAD_MAX_CONCURRENT),
    uploadCleanupIntervalMs: z.number().step(1).min(60 * 1000).max(MAX_UPLOAD_TIMER_DELAY_MS).default(DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS),
    uploadManifestMaxBytes: z.number().step(1).min(1024).default(DEFAULT_UPLOAD_MANIFEST_MAX_BYTES),
    trashRetentionDays: z.number().step(1).min(1).default(30),
  })

  /** Absolute document root. */
  readonly root: string
  readonly limits: UserDocLimits
  private readonly uploads: LocalUploadManager
  private readonly legacyRoot: string | undefined
  private readonly trashRetentionMs: number
  private readonly directoryReads = new Map<string, SharedRead<UserDocDirectoryListing>>()
  private readonly pageReads = new Map<string, SharedRead<UserDocDirectoryPage>>()
  private readonly trashReads = new Map<string, SharedRead<UserDocTrashRef[]>>()
  private readonly trashPageReads = new Map<string, SharedRead<UserDocTrashPage>>()
  private readonly fullReads = new Map<string, SharedRead<UserDocRef[]>>()
  /** Includes scans removed from lookup maps by a mutation, so disposal can still join them. */
  private readonly activeReads = new Set<SharedRead<unknown>>()
  private ready: Promise<void> | undefined
  private disposed = false
  private trashSweepTask: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.trashRetentionDays !== undefined
      && (!Number.isSafeInteger(config.trashRetentionDays) || config.trashRetentionDays < 1
        || config.trashRetentionDays > Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000))) {
      throw new Error('trashRetentionDays must be a positive safe integer')
    }
    const usesDefaultRoot = config.uploadRoot === undefined
    const configuredRoot = config.uploadRoot
    this.root = resolve(configuredRoot === undefined
      ? join(homedir(), DEFAULT_DOCUMENT_DIR_NAME)
      : expandHomePath(configuredRoot))
    this.legacyRoot = config.legacyUploadRoot === undefined
      ? usesDefaultRoot ? join(homedir(), LEGACY_UPLOAD_DIR_NAME) : undefined
      : resolve(expandHomePath(config.legacyUploadRoot))
    this.trashRetentionMs = (config.trashRetentionDays ?? 30) * 86_400_000
    this.limits = Object.freeze({
      maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxFilesPerMessage: config.maxFilesPerMessage ?? DEFAULT_MAX_FILES_PER_MESSAGE,
      maxMessageBytes: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      maxInlineTextBytes: config.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES,
      upload: Object.freeze({
        protocol: 'resumable-v1' as const,
        chunkBytes: config.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES,
        sessionTtlMs: config.uploadSessionTtlMs ?? DEFAULT_UPLOAD_SESSION_TTL_MS,
        resumable: true as const,
      }),
    })
    this.uploads = new LocalUploadManager({
      root: this.root,
      limits: this.limits,
      resolveTarget: input => this.resolveTarget(input),
      publish: (target, partial, bytes, expectedSha256) => publishDocPartial(this.root, target, partial, bytes, expectedSha256),
    }, {
      chunkBytes: config.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES,
      sessionTtlMs: config.uploadSessionTtlMs ?? DEFAULT_UPLOAD_SESSION_TTL_MS,
      minFreeBytes: config.uploadMinFreeBytes ?? DEFAULT_UPLOAD_MIN_FREE_BYTES,
      maxConcurrent: config.uploadMaxConcurrent ?? DEFAULT_UPLOAD_MAX_CONCURRENT,
      cleanupIntervalMs: config.uploadCleanupIntervalMs ?? DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
      manifestMaxBytes: config.uploadManifestMaxBytes ?? DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
    })
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (this.disposed || this.trashSweepTask !== undefined) return
        const task = Promise.resolve().then(() => purgeDueDocuments(this.root)).catch(() => {
          // A later sweep retries after a transient filesystem failure.
        }).then(() => undefined).finally(() => {
          if (this.trashSweepTask === task) this.trashSweepTask = undefined
        })
        this.trashSweepTask = task
      }, config.uploadCleanupIntervalMs ?? DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS)
      return () => {
        this.disposed = true
        clearInterval(timer)
        const reads = this.readOperations()
        const ready = this.ready
        for (const read of reads) read.cancel(new Error('document store disposed'))
        return Promise.allSettled([
          ...reads.map(read => read.promise),
          ...(ready === undefined ? [] : [ready]),
          ...(this.trashSweepTask === undefined ? [] : [this.trashSweepTask]),
        ]).then(() => this.uploads.stop()).then(() => undefined)
      }
    }, 'userdoc-local: upload cleanup')
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('document store is disposed'))
    if (this.ready !== undefined) return this.ready
    const operation = (async () => {
      if (this.legacyRoot === undefined) await mkdir(this.root, { recursive: true, mode: 0o700 })
      else await migrateLegacyDocuments(this.legacyRoot, this.root)
      await this.uploads.cleanupExpired()
      await this.uploads.resumePendingFinalizations()
      if (!this.disposed) this.uploads.startCleanup()
    })()
    const ready = operation.catch((error: unknown) => {
      // A prewarm can race a temporarily unavailable legacy root. Do not pin
      // the rejected promise forever; the next request must be able to retry
      // initialization after the filesystem recovers.
      if (this.ready === ready) this.ready = undefined
      throw error
    })
    this.ready = ready
    return ready
  }

  /** Pre-initialize storage and maintenance before the first browser request. */
  async warm(): Promise<void> {
    await this.ensureReady()
  }

  async resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    await this.ensureReady()
    return resolveDocTarget(this.root, input.directoryId ?? UserDocDirectoryId(''), input.name)
  }

  async save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef> {
    await this.ensureReady()
    const saved = await saveDocFile(this.root, target, body, this.limits, signal)
    this.invalidateReads()
    return saved
  }

  async beginUpload(input: BeginUserDocUpload): Promise<UserDocUploadSession> {
    await this.ensureReady()
    return this.uploads.begin(input)
  }

  async inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<UserDocUploadSession> {
    signal?.throwIfAborted()
    await this.ensureReady()
    return this.uploads.inspect(uploadId)
  }

  async writeUploadChunk(
    uploadId: UserDocUploadId,
    chunk: UserDocUploadChunk,
    signal?: AbortSignal,
  ): Promise<UserDocUploadSession> {
    await this.ensureReady()
    return this.uploads.write(uploadId, chunk, signal)
  }

  async completeUpload(uploadId: UserDocUploadId, sha256: string, signal?: AbortSignal): Promise<UserDocUploadSession> {
    signal?.throwIfAborted()
    await this.ensureReady()
    const completed = await this.uploads.complete(uploadId, sha256)
    if (completed.state === 'complete') this.invalidateReads()
    return completed
  }

  async cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.ensureReady()
    return this.uploads.cancel(uploadId)
  }

  async list(signal?: AbortSignal): Promise<UserDocRef[]> {
    await this.ensureReady()
    const existing = this.fullReads.get('root')
    if (existing !== undefined) return existing.wait(signal)
    const operation = new SharedRead<UserDocRef[]>(scanSignal => listDocFiles(this.root, scanSignal))
    this.activeReads.add(operation)
    this.fullReads.set('root', operation)
    void operation.promise.finally(() => {
      if (this.fullReads.get('root') === operation) this.fullReads.delete('root')
      this.activeReads.delete(operation)
    }).catch(() => {})
    return operation.wait(signal)
  }

  async listDirectory(
    directoryId: UserDocDirectoryId,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryListing> {
    await this.ensureReady()
    const key = String(directoryId)
    const existing = this.directoryReads.get(key)
    if (existing !== undefined) return existing.wait(signal)
    const operation = new SharedRead<UserDocDirectoryListing>(scanSignal => listDocDirectory(this.root, directoryId, scanSignal))
    this.activeReads.add(operation)
    this.directoryReads.set(key, operation)
    void operation.promise.finally(() => {
      if (this.directoryReads.get(key) === operation) this.directoryReads.delete(key)
      this.activeReads.delete(operation)
    }).catch(() => {})
    return operation.wait(signal)
  }

  override async listDirectoryPage(
    directoryId: UserDocDirectoryId,
    query: UserDocListQuery = {},
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryPage> {
    await this.ensureReady()
    const key = `${String(directoryId)}\u0000${JSON.stringify(query)}`
    const existing = this.pageReads.get(key)
    if (existing !== undefined) return existing.wait(signal)
    const operation = new SharedRead<UserDocDirectoryPage>(scanSignal => super.listDirectoryPage(directoryId, query, scanSignal))
    this.activeReads.add(operation)
    this.pageReads.set(key, operation)
    void operation.promise.finally(() => {
      if (this.pageReads.get(key) === operation) this.pageReads.delete(key)
      this.activeReads.delete(operation)
    }).catch(() => {})
    return operation.wait(signal)
  }

  async listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
    await this.ensureReady()
    return listDocDirectories(this.root, signal)
  }

  private invalidateReads(): void {
    // Existing callers keep their in-flight snapshot; only later requests must
    // miss the result after a mutation.
    this.directoryReads.clear()
    this.pageReads.clear()
    this.trashReads.clear()
    this.trashPageReads.clear()
    this.fullReads.clear()
  }

  /** Snapshot every cached scan so invalidation and disposal can cancel it once. */
  private readOperations(): SharedRead<unknown>[] {
    return [...this.activeReads]
  }

  async listTrash(signal?: AbortSignal): Promise<UserDocTrashRef[]> {
    signal?.throwIfAborted()
    await this.ensureReady()
    const existing = this.trashReads.get('root')
    if (existing !== undefined) return existing.wait(signal)
    const operation = new SharedRead<UserDocTrashRef[]>(scanSignal => listTrash(this.root, scanSignal))
    this.activeReads.add(operation)
    this.trashReads.set('root', operation)
    void operation.promise.finally(() => {
      if (this.trashReads.get('root') === operation) this.trashReads.delete('root')
      this.activeReads.delete(operation)
    }).catch(() => {})
    return operation.wait(signal)
  }

  override async listTrashPage(query: UserDocListQuery = {}, signal?: AbortSignal): Promise<UserDocTrashPage> {
    await this.ensureReady()
    const key = JSON.stringify(query)
    const existing = this.trashPageReads.get(key)
    if (existing !== undefined) return existing.wait(signal)
    const operation = new SharedRead<UserDocTrashPage>(scanSignal => super.listTrashPage(query, scanSignal))
    this.activeReads.add(operation)
    this.trashPageReads.set(key, operation)
    void operation.promise.finally(() => {
      if (this.trashPageReads.get(key) === operation) this.trashPageReads.delete(key)
      this.activeReads.delete(operation)
    }).catch(() => {})
    return operation.wait(signal)
  }

  async trash(docId: UserDocId, signal?: AbortSignal): Promise<UserDocTrashRef> {
    signal?.throwIfAborted()
    await this.ensureReady()
    const trashed = await trashDocument(this.root, docId, this.trashRetentionMs)
    this.invalidateReads()
    return trashed
  }

  async restore(docId: UserDocId, directoryId?: UserDocDirectoryId, name?: string, signal?: AbortSignal): Promise<UserDocRef> {
    signal?.throwIfAborted()
    await this.ensureReady()
    const restored = await restoreDocument(this.root, docId, directoryId, name)
    this.invalidateReads()
    return restored
  }

  async purge(docId: UserDocId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.ensureReady()
    await purgeDocument(this.root, docId)
    this.invalidateReads()
  }

  async createDirectory(parentDirectoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    await this.ensureReady()
    const created = await createDocDirectory(this.root, parentDirectoryId, name)
    this.invalidateReads()
    return created
  }

  async renameDirectory(directoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    await this.ensureReady()
    const renamed = await renameDocDirectory(this.root, directoryId, name)
    this.invalidateReads()
    return renamed
  }

  async removeDirectory(directoryId: UserDocDirectoryId): Promise<void> {
    await this.ensureReady()
    await removeDocDirectory(this.root, directoryId)
    this.invalidateReads()
  }

  async move(docId: UserDocId, directoryId: UserDocDirectoryId): Promise<UserDocRef> {
    await this.ensureReady()
    const moved = await moveDocFile(this.root, docId, directoryId)
    this.invalidateReads()
    return moved
  }

  async stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
    await this.ensureReady()
    return statDocFile(this.root, docId, signal)
  }

  async read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    await this.ensureReady()
    return readDocFile(this.root, docId, signal)
  }

  async openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    await this.ensureReady()
    return openDocFile(this.root, docId)
  }

  async remove(docId: UserDocId, signal?: AbortSignal): Promise<void> {
    await this.ensureReady()
    await removeDocFile(this.root, docId, signal)
    this.invalidateReads()
  }
}

export default LocalUserDocStore
