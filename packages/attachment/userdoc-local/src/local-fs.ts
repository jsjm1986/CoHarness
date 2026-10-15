/** Context-free local filesystem document engine shared by the runtime service and the Gateway broker. */

import { mkdir } from 'node:fs/promises'
import { UserDocDirectoryId } from '@deepseek-ai/dsh-userdoc'
import type {
  BeginUserDocUpload,
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadId,
  UserDocUploadSession,
  UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
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
import { LocalUploadManager } from './upload.ts'

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Document listing was aborted.', { cause: signal.reason })
}

/** Share one filesystem scan while keeping cancellation local to each waiter. */
export class SharedRead<T> {
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
      if (signal.aborted) onAbort()
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

/** Resolved filesystem layout and policy for {@link LocalUserDocFs}; every path is already absolute. */
export interface LocalUserDocFsOptions {
  /** Absolute document root. */
  readonly root: string
  /** Optional absolute legacy root migrated into `root` on first use. */
  readonly legacyRoot?: string
  /** Deployment-resolved document limits shared with client intake checks. */
  readonly limits: UserDocLimits
  /** Resumable-upload protocol and filesystem bounds. */
  readonly upload: {
    readonly chunkBytes: number
    readonly sessionTtlMs: number
    readonly minFreeBytes: number
    readonly maxConcurrent: number
    readonly cleanupIntervalMs: number
    readonly manifestMaxBytes: number
  }
  /** Interval of the trash-retention sweep started by {@link LocalUserDocFs.attach}. */
  readonly sweepIntervalMs: number
  /** Recoverable document trash retention in milliseconds. */
  readonly trashRetentionMs: number
}

/**
 * Real-file document filesystem engine without a service or plugin context.
 *
 * The Cordis `LocalUserDocStore` and the Gateway document broker share this
 * engine, so both hosts read and write one on-disk format through the same
 * code path. The owner decides lifecycle: `attach` starts maintenance sweeps
 * and `dispose` quiesces scans, upload sessions, and timers before resolve.
 */
export class LocalUserDocFs {
  /** Absolute document root. */
  readonly root: string
  readonly limits: UserDocLimits
  private readonly uploads: LocalUploadManager
  private readonly legacyRoot: string | undefined
  private readonly trashRetentionMs: number
  private readonly sweepIntervalMs: number
  private readonly directoryReads = new Map<string, SharedRead<UserDocDirectoryListing>>()
  private readonly trashReads = new Map<string, SharedRead<UserDocTrashRef[]>>()
  private readonly fullReads = new Map<string, SharedRead<UserDocRef[]>>()
  /** Includes scans removed from lookup maps by a mutation, so disposal can still join them. */
  private readonly activeReads = new Set<SharedRead<unknown>>()
  private ready: Promise<void> | undefined
  private disposed = false
  private trashSweepTask: Promise<void> | undefined
  private sweepTimer: NodeJS.Timeout | undefined

  constructor(options: LocalUserDocFsOptions) {
    this.root = options.root
    this.legacyRoot = options.legacyRoot
    this.limits = options.limits
    this.trashRetentionMs = options.trashRetentionMs
    this.sweepIntervalMs = options.sweepIntervalMs
    this.uploads = new LocalUploadManager({
      root: this.root,
      limits: this.limits,
      resolveTarget: input => this.resolveTarget(input),
      publish: (target, partial, bytes, expectedSha256) => publishDocPartial(this.root, target, partial, bytes, expectedSha256),
    }, {
      chunkBytes: options.upload.chunkBytes,
      sessionTtlMs: options.upload.sessionTtlMs,
      minFreeBytes: options.upload.minFreeBytes,
      maxConcurrent: options.upload.maxConcurrent,
      cleanupIntervalMs: options.upload.cleanupIntervalMs,
      manifestMaxBytes: options.upload.manifestMaxBytes,
    })
  }

  /** Start the periodic trash-retention sweep. Pairs with {@link dispose}. */
  attach(): void {
    this.sweepTimer = setInterval(() => {
      if (this.disposed || this.trashSweepTask !== undefined) return
      const task = Promise.resolve().then(() => purgeDueDocuments(this.root)).catch(() => {
        // A later sweep retries after a transient filesystem failure.
      }).then(() => undefined).finally(() => {
        if (this.trashSweepTask === task) this.trashSweepTask = undefined
      })
      this.trashSweepTask = task
    }, this.sweepIntervalMs)
  }

  /**
   * Stop maintenance, cancel in-flight scans, and join upload session state.
   * @returns after every owned operation settled; the engine must not be used afterwards.
   */
  dispose(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.disposed = true
    const reads = this.readOperations()
    const ready = this.ready
    for (const read of reads) read.cancel(new Error('document store disposed'))
    return Promise.allSettled([
      ...reads.map(read => read.promise),
      ...(ready === undefined ? [] : [ready]),
      ...(this.trashSweepTask === undefined ? [] : [this.trashSweepTask]),
    ]).then(() => this.uploads.stop()).then(() => undefined)
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

  async listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
    await this.ensureReady()
    return listDocDirectories(this.root, signal)
  }

  private invalidateReads(): void {
    // Existing callers keep their in-flight snapshot; only later requests must
    // miss the result after a mutation.
    this.directoryReads.clear()
    this.trashReads.clear()
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
    signal?.throwIfAborted()
    await this.ensureReady()
    await removeDocFile(this.root, docId, signal)
    this.invalidateReads()
  }
}
