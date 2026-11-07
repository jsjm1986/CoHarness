/** Context-free local filesystem document engine shared by the runtime service and the Gateway broker. */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DOCUMENT_NOT_FOUND_CODE, DOCUMENT_PERMISSION_DENIED_CODE, DOCUMENT_STORE_UNAVAILABLE_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE, DOCUMENT_TRASH_NOT_FOUND_CODE,
  UserDocDirectoryId, UserDocError, UserDocIncarnationId,
} from '@deepseek-ai/dsh-userdoc'
import type {
  BeginUserDocUpload,
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocSelection,
  UserDocTarget,
  UserDocTrashSelection,
  UserDocUploadChunk,
  UserDocUploadId,
  UserDocUploadOwnerId,
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
import { LocalUploadManager, type UserDocBackgroundWrite } from './upload.ts'
import { assertPublicDirectory, isPrivateRootName, pathForDirectoryId, sanitizeDirectoryName } from './name.ts'
import { DocumentIdentityFs } from './identity-fs.ts'
import type { PreparePublishedDocument } from './identity-fs.ts'
import type { DocumentIdentityLocations } from './identity-storage.ts'

function documentSelection(ref: UserDocRef): UserDocSelection {
  const identity = ref.identity
  if (identity === undefined) throw new Error('Identity-aware document storage returned an unversioned reference.')
  return { docId: ref.docId, incarnationId: identity.incarnationId, revision: identity.revision }
}

function trashSelection(ref: UserDocTrashRef): UserDocTrashSelection {
  const identity = ref.identity
  if (identity === undefined || ref.trashId === undefined) throw new Error('Identity-aware trash returned an unversioned reference.')
  return { docId: ref.docId, incarnationId: identity.incarnationId, revision: identity.revision, trashId: ref.trashId }
}

function currentSelection(
  ref: UserDocRef, select: LocalUserDocFsOptions['identitySelection'], expected?: UserDocSelection,
): UserDocSelection {
  const selected = select?.(ref.docId, 'active')
  if (select !== undefined && selected === undefined) {
    throw new UserDocError('The authorized document identity is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
  }
  if (selected !== undefined && 'trashId' in selected) {
    throw new UserDocError('The authorized document state does not match the current action.', DOCUMENT_PERMISSION_DENIED_CODE)
  }
  const observed = documentSelection(ref), current = selected ?? expected ?? observed
  if (current.docId !== observed.docId || current.incarnationId !== observed.incarnationId || current.revision !== observed.revision
    || expected !== undefined && (current.incarnationId !== expected.incarnationId
    || current.revision !== expected.revision || expected.docId !== ref.docId)) {
    throw new UserDocError('The selected document version is no longer current.', DOCUMENT_TARGET_CONFLICT_CODE)
  }
  return current
}

function currentTrashSelection(
  docId: UserDocId, available: readonly UserDocTrashRef[], select: LocalUserDocFsOptions['identitySelection'], expected?: UserDocTrashSelection,
): UserDocTrashSelection {
  const selected = select === undefined ? expected : select(docId, 'trash')
  if (select !== undefined && selected === undefined) {
    throw new UserDocError('The authorized trash identity is unavailable.', DOCUMENT_PERMISSION_DENIED_CODE)
  }
  if (selected !== undefined) {
    if (!('trashId' in selected)) {
      throw new UserDocError('The authorized document state does not match the current action.', DOCUMENT_PERMISSION_DENIED_CODE)
    }
    if (selected.docId !== docId || expected !== undefined && (selected.incarnationId !== expected.incarnationId
      || selected.revision !== expected.revision || selected.trashId !== expected.trashId || expected.docId !== docId)) {
      throw new UserDocError('The selected trash action is no longer current.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    }
    const match = available.find(item => item.docId === docId
      && item.identity?.incarnationId === selected.incarnationId
      && item.identity.revision === selected.revision && item.trashId === selected.trashId)
    if (match === undefined) throw new UserDocError('The selected trash action is no longer current.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    return trashSelection(match)
  }
  const matches = available.filter(item => item.docId === docId)
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new UserDocError('The trash action is ambiguous or no longer recoverable.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
  return trashSelection(matches[0])
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Document listing was aborted.', { cause: signal.reason })
}

/** Share one filesystem scan while keeping cancellation local to each waiter. */
export class SharedRead<T> {
  private settled = false
  private waiters = 0
  /** Cancellation shared by the underlying scan; the last departing waiter or {@link cancel} trips it. */
  readonly controller = new AbortController()
  /** The scan's settle; every {@link wait} attaches to this one promise. */
  readonly promise: Promise<T>

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  /**
   * Join the shared scan. A waiter's own signal drops only that waiter; when
   * the last waiter leaves before settle, the scan is aborted.
   * @param signal - optional per-waiter cancellation.
   * @returns the shared scan result.
   */
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

  /**
   * Cancel the shared scan when its cached result is no longer useful.
   * @param reason - abort reason seen by the underlying scan.
   */
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
  /** Private upload and trash control root on the document filesystem; omitted keeps standalone layout. */
  readonly controlRoot?: string
  /** Optional durable identity domain used by Gateway-managed shared document roots. */
  readonly identityLocations?: DocumentIdentityLocations
  /** Current authenticated document actor; upload finalizers retain their actor in the upload manifest. */
  readonly identityActor?: () => UserDocUploadOwnerId | undefined
  /** Exact version captured by the Gateway catalog before a mutating request. */
  readonly identitySelection?: (docId: UserDocId, state: 'active' | 'trash') => UserDocSelection | UserDocTrashSelection | undefined
  /** Apply scope runtime access to the private source inode before its public hard link appears. */
  readonly preparePublished?: PreparePublishedDocument
  /** Apply scope runtime access to a Gateway-created public directory. */
  readonly prepareDirectory?: (path: string) => Promise<void>
  /** Optional absolute legacy root migrated into `root` on first use. */
  readonly legacyRoot?: string
  /** Deployment-resolved document limits shared with client intake checks. */
  readonly limits: UserDocLimits
  /** Host maintenance admission for initialization, detached finalization and periodic cleanup. */
  readonly backgroundWrite?: UserDocBackgroundWrite
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
  /** Deployment-resolved document limits enforced on writes. */
  readonly limits: UserDocLimits
  private readonly uploads: LocalUploadManager
  private readonly controlRoot: string
  private readonly backgroundWrite: UserDocBackgroundWrite
  private readonly legacyRoot: string | undefined
  private readonly trashRetentionMs: number
  private readonly sweepIntervalMs: number
  private readonly identityLocations: DocumentIdentityLocations | undefined
  private readonly identityActor: LocalUserDocFsOptions['identityActor']
  private readonly identitySelection: LocalUserDocFsOptions['identitySelection']
  private readonly preparePublished: PreparePublishedDocument | undefined
  private readonly prepareDirectory: LocalUserDocFsOptions['prepareDirectory']
  private identityStore: DocumentIdentityFs | undefined
  private readonly directoryReads = new Map<string, SharedRead<UserDocDirectoryListing>>()
  private readonly trashReads = new Map<string, SharedRead<UserDocTrashRef[]>>()
  private readonly fullReads = new Map<string, SharedRead<UserDocRef[]>>()
  /** Includes scans removed from lookup maps by a mutation, so disposal can still join them. */
  private readonly activeReads = new Set<SharedRead<unknown>>()
  private ready: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined
  private trashSweepTask: Promise<void> | undefined
  private sweepTimer: NodeJS.Timeout | undefined

  constructor(options: LocalUserDocFsOptions) {
    this.root = options.root
    this.controlRoot = options.controlRoot ?? options.root
    this.legacyRoot = options.legacyRoot
    this.limits = options.limits
    this.trashRetentionMs = options.trashRetentionMs
    this.sweepIntervalMs = options.sweepIntervalMs
    this.backgroundWrite = options.backgroundWrite ?? (operation => operation())
    this.identityLocations = options.identityLocations
    this.identityActor = options.identityActor
    this.identitySelection = options.identitySelection
    this.preparePublished = options.preparePublished
    this.prepareDirectory = options.prepareDirectory
    if (this.identityLocations !== undefined && (this.identityLocations.root !== this.root
      || this.identityLocations.filesRoot !== this.controlRoot)) {
      throw new Error('Identity document locations must match the public and private filesystem roots.')
    }
    this.uploads = new LocalUploadManager({
      root: this.root,
      controlRoot: this.controlRoot,
      limits: this.limits,
      backgroundWrite: this.backgroundWrite,
      resolveTarget: async (input, reserved) => {
        await this.ensureReady()
        return resolveDocTarget(this.root, input.directoryId, input.name, reserved)
      },
      publish: (target, partial, bytes, expectedSha256, uploadId, ownerId) => this.publishUpload(
        target, partial, bytes, expectedSha256, uploadId, ownerId,
      ),
    }, {
      chunkBytes: options.upload.chunkBytes,
      sessionTtlMs: options.upload.sessionTtlMs,
      minFreeBytes: options.upload.minFreeBytes,
      maxConcurrent: options.upload.maxConcurrent,
      cleanupIntervalMs: options.upload.cleanupIntervalMs,
      manifestMaxBytes: options.upload.manifestMaxBytes,
    })
  }

  /** The Gateway projection receiver reads changes from this same identity owner. */
  get identities(): DocumentIdentityFs | undefined { return this.identityStore }

  private async publishUpload(
    target: UserDocTarget, partial: string, bytes: number, expectedSha256: string,
    uploadId: UserDocUploadId, ownerId?: UserDocUploadOwnerId,
  ): Promise<UserDocRef> {
    const identity = this.identityStore
    if (identity === undefined) return publishDocPartial(this.root, target, partial, bytes, expectedSha256, this.controlRoot)
    return identity.publish(target, partial, {
      incarnationId: UserDocIncarnationId(String(uploadId)), bytes, origin: 'upload',
      ...(ownerId === undefined ? {} : { createdBy: ownerId }),
    }, this.preparePublished)
  }

  /** Start the periodic trash-retention sweep. Pairs with {@link dispose}. */
  attach(): void {
    if (this.closing !== undefined) return
    if (this.sweepTimer !== undefined) return
    this.sweepTimer = setInterval(() => {
      if (this.closing !== undefined || this.trashSweepTask !== undefined) return
      const task = Promise.resolve().then(() => this.backgroundWrite(async () => {
        if (this.closing === undefined) {
          if (this.identityStore === undefined) await purgeDueDocuments(this.root, Date.now(), this.controlRoot)
          else await this.identityStore.purgeDue(Date.now())
        }
      })).catch(() => {
        // Closed admission and filesystem failures leave retention work for the next interval.
      }).then(() => undefined).finally(() => {
        this.trashSweepTask = undefined
      })
      this.trashSweepTask = task
    }, this.sweepIntervalMs)
  }

  /**
   * Stop admission, cancel pending I/O, and join accepted operations, scans and upload finalizers.
   * @returns after every owned operation settled; the engine must not be used afterwards.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = Promise.resolve().then(async () => {
      if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
      this.lifetime.abort(new Error('document store disposed'))
      for (const read of this.readOperations()) read.cancel(new Error('document store disposed'))
      await Promise.allSettled([
        ...this.operations,
        ...(this.ready === undefined ? [] : [this.ready]),
        ...(this.trashSweepTask === undefined ? [] : [this.trashSweepTask]),
      ])
      const reads = this.readOperations()
      for (const read of reads) read.cancel(new Error('document store disposed'))
      await Promise.allSettled(reads.map(read => read.promise))
      const errors: unknown[] = []
      try { await this.uploads.stop() } catch (error) { errors.push(error) }
      try { await this.identityStore?.dispose() } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'Document store shutdown failed.')
    })
    return this.closing
  }

  private perform<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error('document store is disposed'))
    const task = Promise.resolve().then(operation)
    this.operations.add(task)
    const release = (): void => { this.operations.delete(task) }
    void task.then(release, release)
    return task
  }

  private ensureReady(): Promise<void> {
    if (this.closing !== undefined) return Promise.reject(new Error('document store is disposed'))
    if (this.ready !== undefined) return this.ready
    const operation = Promise.resolve().then(() => this.backgroundWrite(async () => {
      this.lifetime.signal.throwIfAborted()
      if (this.legacyRoot === undefined) await mkdir(this.root, { recursive: true, mode: 0o700 })
      else await migrateLegacyDocuments(this.legacyRoot, this.root)
      await assertPublicDirectory(this.root, this.root, DOCUMENT_STORE_UNAVAILABLE_CODE)
      await this.verifyControlRoot()
      await this.prepareDirectory?.(this.root)
      if (this.identityLocations !== undefined && this.identityStore === undefined) {
        this.identityStore = await DocumentIdentityFs.open(this.identityLocations, this.backgroundWrite)
      }
      await this.uploads.cleanupExpired()
      await this.uploads.resumePendingFinalizations()
      if (this.closing === undefined) this.uploads.startCleanup()
    }))
    const ready = operation.catch((error: unknown) => {
      // A prewarm can race a temporarily unavailable legacy root. Do not pin
      // the rejected promise forever; the next request must be able to retry
      // initialization after the filesystem recovers.
      this.ready = undefined
      throw error
    })
    this.ready = ready
    return ready
  }

  /** Refuse control data inside model-writable roots, on another filesystem or with replaceable owners. */
  private async verifyControlRoot(): Promise<void> {
    if (this.controlRoot === this.root) return
    if (!isAbsolute(this.controlRoot) || resolve(this.controlRoot) !== this.controlRoot) {
      throw new Error('Private document control root must be an absolute normalized path.')
    }
    const documentPath = resolve(this.root), controlPath = resolve(this.controlRoot)
    const contains = (parent: string, child: string): boolean => {
      const tail = relative(parent, child)
      return tail === '' || tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
    }
    if (contains(documentPath, controlPath) || contains(controlPath, documentPath)) {
      throw new Error('Private document control root must be disjoint from the public document root.')
    }
    const [documentInfo, controlInfo, parentInfo, canonicalDocument, canonicalControl] = await Promise.all([
      lstat(this.root), lstat(this.controlRoot), lstat(dirname(this.controlRoot)), realpath(this.root), realpath(this.controlRoot),
    ])
    if (!documentInfo.isDirectory() || documentInfo.isSymbolicLink()
      || !controlInfo.isDirectory() || controlInfo.isSymbolicLink()
      || contains(canonicalDocument, canonicalControl) || contains(canonicalControl, canonicalDocument)
      || documentInfo.dev !== controlInfo.dev) {
      throw new Error('Private document control storage must be a disjoint real directory on the document filesystem.')
    }
    if (process.getuid !== undefined) {
      const uid = process.getuid()
      if (controlInfo.uid !== uid || (controlInfo.mode & 0o077) !== 0
        || parentInfo.uid !== uid || (parentInfo.mode & 0o077) !== 0) {
        throw new Error('Private document control storage and its parent must be owner-only Gateway directories.')
      }
    }
  }

  /** Pre-initialize storage and maintenance before the first browser request. */
  async warm(): Promise<void> {
    await this.ensureReady()
  }

  /**
   * Resolve a document name inside a directory to canonical target ids.
   * @param input - target description; an absent `directoryId` names the root.
   * @returns the resolved directory/document identity for later operations.
   */
  resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    return this.perform(async () => {
      await this.ensureReady()
      return resolveDocTarget(this.root, input.directoryId ?? UserDocDirectoryId(''), input.name)
    })
  }

  /**
   * Stream a body into a new document at a resolved target.
   * @param target - destination from {@link resolveTarget}.
   * @param body - document content; enforcement of limits happens while streaming.
   * @param signal - aborts the write; the partial file is removed.
   * @returns the stored document ref.
   */
  save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      try {
        await this.ensureReady()
        const saved = this.identityStore === undefined
          ? await saveDocFile(this.root, target, body, this.limits, admittedSignal)
          : await this.identityStore.save(target, body, this.limits, this.identityActor?.(), admittedSignal, this.preparePublished)
        this.invalidateReads()
        return saved
      } catch (error) {
        if (!body.locked) {
          try { await body.cancel(error) } catch (cleanupError) {
            if (cleanupError !== error && !(error instanceof Error && error.cause === cleanupError)) {
              throw new AggregateError([error, cleanupError], 'Document save and body cleanup failed.')
            }
          }
        }
        throw error
      }
    })
  }

  /**
   * Open a resumable upload session under the per-scope concurrency cap.
   * @param input - directory, name, size, and fingerprint of the intended upload.
   * @param ownerId - authenticated actor; retained across upload requests and restart.
   * @returns the session; an identical in-flight fingerprint joins it instead.
   */
  beginUpload(input: BeginUserDocUpload, ownerId?: UserDocUploadOwnerId): Promise<UserDocUploadSession> {
    return this.perform(async () => {
      await this.ensureReady()
      return this.uploads.begin(input, ownerId)
    })
  }

  /**
   * Report a session's persisted chunk offsets and state.
   * @param uploadId - session id from {@link beginUpload}.
   * @param signal - aborts the read.
   * @param ownerId - authenticated actor; retained across upload requests and restart.
   * @returns the session snapshot a resuming client needs.
   */
  inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId): Promise<UserDocUploadSession> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      return this.uploads.inspect(uploadId, ownerId)
    })
  }

  /**
   * Append one chunk at its declared offset.
   * @param uploadId - session id from {@link beginUpload}.
   * @param chunk - offset plus bytes; out-of-order offsets are rejected.
   * @param signal - aborts the write.
   * @param ownerId - authenticated actor; retained across upload requests and restart.
   * @returns the session after the chunk landed.
   */
  writeUploadChunk(
    uploadId: UserDocUploadId,
    chunk: UserDocUploadChunk,
    signal?: AbortSignal,
    ownerId?: UserDocUploadOwnerId,
  ): Promise<UserDocUploadSession> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      return this.uploads.write(uploadId, chunk, admittedSignal, ownerId)
    })
  }

  /**
   * Verify the assembled payload against its fingerprint and publish it.
   * @param uploadId - session id from {@link beginUpload}.
   * @param sha256 - expected digest of the complete payload.
   * @param signal - aborts the publish.
   * @param ownerId - authenticated actor; retained across upload requests and restart.
   * @returns the session in `verifying` or `complete` state.
   */
  completeUpload(
    uploadId: UserDocUploadId, sha256: string, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId,
  ): Promise<UserDocUploadSession> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      const completed = await this.uploads.complete(uploadId, sha256, ownerId)
      if (completed.state === 'complete') this.invalidateReads()
      return completed
    })
  }

  /**
   * Drop an upload session and its buffered chunks.
   * @param uploadId - session id from {@link beginUpload}.
   * @param signal - aborts the cancellation read itself.
   * @param ownerId - authenticated actor owning the temporary upload.
   */
  cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal, ownerId?: UserDocUploadOwnerId): Promise<void> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      return this.uploads.cancel(uploadId, ownerId)
    })
  }

  /**
   * Scan the root listing; concurrent callers share one in-flight scan.
   * @param signal - aborts this caller's wait, not the shared scan.
   * @returns active document refs.
   */
  list(signal?: AbortSignal): Promise<UserDocRef[]> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      if (this.identityStore !== undefined) return this.identityStore.list(admittedSignal)
      const existing = this.fullReads.get('root')
      if (existing !== undefined) return existing.wait(admittedSignal)
      const operation = new SharedRead<UserDocRef[]>(scanSignal => listDocFiles(this.root, scanSignal))
      this.activeReads.add(operation)
      this.fullReads.set('root', operation)
      void operation.promise.finally(() => {
        if (this.fullReads.get('root') === operation) this.fullReads.delete('root')
        this.activeReads.delete(operation)
      }).catch(() => {})
      return operation.wait(admittedSignal)
    })
  }

  /**
   * Scan one directory's listing; concurrent callers share one scan.
   * @param directoryId - directory to list.
   * @param signal - aborts this caller's wait, not the shared scan.
   * @returns the directory's refs plus sub-directory refs.
   */
  listDirectory(
    directoryId: UserDocDirectoryId,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryListing> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      if (this.identityStore !== undefined) return this.identityStore.listDirectory(directoryId, admittedSignal)
      const key = String(directoryId)
      const existing = this.directoryReads.get(key)
      if (existing !== undefined) return existing.wait(admittedSignal)
      const operation = new SharedRead<UserDocDirectoryListing>(scanSignal => listDocDirectory(this.root, directoryId, scanSignal))
      this.activeReads.add(operation)
      this.directoryReads.set(key, operation)
      void operation.promise.finally(() => {
        if (this.directoryReads.get(key) === operation) this.directoryReads.delete(key)
        this.activeReads.delete(operation)
      }).catch(() => {})
      return operation.wait(admittedSignal)
    })
  }

  /**
   * List every directory in the scope.
   * @param signal - aborts the scan.
   * @returns directory refs in path order.
   */
  listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      return listDocDirectories(this.root, admittedSignal)
    })
  }

  private invalidateReads(): void {
    // Existing callers keep their in-flight snapshot; only later requests must
    // miss the result after a mutation.
    this.directoryReads.clear()
    this.trashReads.clear()
    this.fullReads.clear()
  }

  private assertSelectionSupported(expected: UserDocSelection | readonly UserDocSelection[] | undefined): void {
    if (expected !== undefined && this.identityStore === undefined) {
      throw new UserDocError('This document store cannot verify an exact document selection.', DOCUMENT_PERMISSION_DENIED_CODE)
    }
  }

  /** Snapshot every cached scan so invalidation and disposal can cancel it once. */
  private readOperations(): SharedRead<unknown>[] {
    return [...this.activeReads]
  }

  /**
   * Scan the recoverable-trash listing; concurrent callers share one scan.
   * @param signal - aborts this caller's wait, not the shared scan.
   * @returns trashed refs with their retention deadline.
   */
  listTrash(signal?: AbortSignal): Promise<UserDocTrashRef[]> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      if (this.identityStore !== undefined) return this.identityStore.listTrash(admittedSignal)
      const existing = this.trashReads.get('root')
      if (existing !== undefined) return existing.wait(admittedSignal)
      const operation = new SharedRead<UserDocTrashRef[]>(scanSignal => listTrash(this.root, scanSignal, this.controlRoot))
      this.activeReads.add(operation)
      this.trashReads.set('root', operation)
      void operation.promise.finally(() => {
        if (this.trashReads.get('root') === operation) this.trashReads.delete('root')
        this.activeReads.delete(operation)
      }).catch(() => {})
      return operation.wait(admittedSignal)
    })
  }

  /**
   * Move a document into recoverable trash.
   * @param docId - document to trash.
   * @param signal - aborts the move.
   * @param expected - optional exact active version selected by the caller's authorization owner.
   * @returns the trash ref carrying the retention deadline.
   */
  trash(docId: UserDocId, signal?: AbortSignal, expected?: UserDocSelection): Promise<UserDocTrashRef> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        const current = await this.identityStore.stat(docId)
        const selection = currentSelection(current, this.identitySelection, expected)
        const trashed = await this.identityStore.trash(selection, this.trashRetentionMs, this.identityActor?.())
        this.invalidateReads()
        return trashed
      }
      const trashed = await trashDocument(this.root, docId, this.trashRetentionMs, this.controlRoot)
      this.invalidateReads()
      return trashed
    })
  }

  /**
   * Return a trashed document to a directory, optionally renamed.
   * @param docId - trashed document.
   * @param directoryId - destination; absent restores the original directory.
   * @param name - replacement name; absent keeps the original.
   * @param signal - aborts the restore.
   * @param expected - optional exact recoverable trash action.
   * @returns the restored document ref.
   */
  restore(
    docId: UserDocId, directoryId?: UserDocDirectoryId, name?: string, signal?: AbortSignal, expected?: UserDocTrashSelection,
  ): Promise<UserDocRef> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        const available = await this.identityStore.listTrash(admittedSignal)
        const selection = currentTrashSelection(docId, available, this.identitySelection, expected)
        const restored = await this.identityStore.restore(selection, directoryId, name, this.identityActor?.(),
          this.prepareDirectory, this.preparePublished)
        this.invalidateReads()
        return restored
      }
      const restored = await restoreDocument(this.root, docId, directoryId, name, this.controlRoot)
      this.invalidateReads()
      return restored
    })
  }

  /**
   * Permanently delete a trashed document.
   * @param docId - trashed document.
   * @param signal - aborts the delete.
   * @param expected - optional exact recoverable trash action.
   */
  purge(docId: UserDocId, signal?: AbortSignal, expected?: UserDocTrashSelection): Promise<void> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        const available = await this.identityStore.listTrash(admittedSignal)
        const selection = currentTrashSelection(docId, available, this.identitySelection, expected)
        await this.identityStore.purge(selection, this.identityActor?.())
        this.invalidateReads()
        return
      }
      await purgeDocument(this.root, docId, this.controlRoot)
      this.invalidateReads()
    })
  }

  /**
   * Create a directory under a parent.
   * @param parentDirectoryId - parent; the root id nests at top level.
   * @param name - new directory name.
   * @returns the created directory ref.
   */
  createDirectory(parentDirectoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    return this.perform(async () => {
      await this.ensureReady()
      const created = await createDocDirectory(this.root, parentDirectoryId, name)
      await this.prepareDirectory?.(created.path)
      this.invalidateReads()
      return created
    })
  }

  /**
   * Rename a directory in place.
   * @param directoryId - directory to rename.
   * @param name - new name.
   * @param expected - optional complete authorized inventory checked before publication; omitted uses the current selection.
   * @returns the updated ref.
   */
  renameDirectory(directoryId: UserDocDirectoryId, name: string, expected?: readonly UserDocSelection[]): Promise<UserDocDirectoryRef> {
    return this.perform(async () => {
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        if (directoryId === '') throw new UserDocError('The document root cannot be renamed.', DOCUMENT_TARGET_CONFLICT_CODE)
        const from = directoryId
        const sourcePath = pathForDirectoryId(this.root, from)
        const leaf = sanitizeDirectoryName(name)
        const parentId = UserDocDirectoryId(relative(this.root, dirname(sourcePath)).split(sep).join('/'))
        if (parentId === '' && isPrivateRootName(leaf)) {
          throw new UserDocError('Document directory name is reserved.', DOCUMENT_TARGET_CONFLICT_CODE)
        }
        const targetPath = join(dirname(sourcePath), leaf)
        const to = UserDocDirectoryId(relative(this.root, targetPath).split(sep).join('/'))
        const refs = (await this.identityStore.list()).filter(item => String(item.docId).startsWith(`${String(from)}/`))
        const requested = expected === undefined ? undefined : new Map(expected.map(item => [item.docId, item]))
        if (expected !== undefined && (requested?.size !== expected.length || refs.length !== expected.length
          || refs.some(item => !requested.has(item.docId)))) {
          throw new UserDocError('The authorized folder contents changed.', DOCUMENT_TARGET_CONFLICT_CODE)
        }
        const selections = refs.map(item => currentSelection(item, this.identitySelection, requested?.get(item.docId)))
        if (from === to) return renameDocDirectory(this.root, from, leaf)
        await this.identityStore.renameDirectory(from, to, selections, this.identityActor?.())
        this.invalidateReads()
        const renamed = (await listDocDirectories(this.root)).find(item => item.directoryId === to)
        if (renamed === undefined) throw new Error('Renamed document directory disappeared before it was returned.')
        return renamed
      }
      const renamed = await renameDocDirectory(this.root, directoryId, name)
      this.invalidateReads()
      return renamed
    })
  }

  /**
   * Delete a directory.
   * @param directoryId - directory to remove.
   */
  removeDirectory(directoryId: UserDocDirectoryId): Promise<void> {
    return this.perform(async () => {
      await this.ensureReady()
      await removeDocDirectory(this.root, directoryId)
      this.invalidateReads()
    })
  }

  /**
   * Move a document into another directory.
   * @param docId - document to move.
   * @param directoryId - destination directory.
   * @param expected - optional exact active version.
   * @returns the updated ref.
   */
  move(docId: UserDocId, directoryId: UserDocDirectoryId, expected?: UserDocSelection): Promise<UserDocRef> {
    return this.perform(async () => {
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        const current = await this.identityStore.stat(docId)
        const selection = currentSelection(current, this.identitySelection, expected)
        const moved = await this.identityStore.move(selection, directoryId, this.identityActor?.())
        this.invalidateReads()
        return moved
      }
      const moved = await moveDocFile(this.root, docId, directoryId)
      this.invalidateReads()
      return moved
    })
  }

  /**
   * Read a document's metadata without its body.
   * @param docId - document to stat.
   * @param signal - aborts the read.
   * @returns the document ref.
   */
  stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      if (this.identityStore !== undefined) {
        admittedSignal.throwIfAborted()
        return this.identityStore.stat(docId)
      }
      return statDocFile(this.root, docId, admittedSignal)
    })
  }

  /**
   * Read a document's metadata and buffered body.
   * @param docId - document to read.
   * @param signal - aborts the read.
   * @returns ref plus body bytes.
   */
  read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      await this.ensureReady()
      if (this.identityStore !== undefined) return this.identityStore.read(docId, admittedSignal)
      return readDocFile(this.root, docId, admittedSignal)
    })
  }

  /**
   * Open a streaming read over a document's stored body.
   * @param docId - document to stream.
   * @returns the ref and a stream owned by the caller, who must consume or cancel it.
   */
  openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    return this.perform(async () => {
      await this.ensureReady()
      if (this.identityStore !== undefined) return this.identityStore.openRead(docId)
      return openDocFile(this.root, docId)
    })
  }

  /**
   * Delete a document outright, bypassing trash.
   * @param docId - document to remove.
   * @param signal - aborts the delete.
   * @param expected - optional exact active version.
   */
  remove(docId: UserDocId, signal?: AbortSignal, expected?: UserDocSelection): Promise<void> {
    return this.perform(async () => {
      const admittedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
      admittedSignal.throwIfAborted()
      await this.ensureReady()
      this.assertSelectionSupported(expected)
      if (this.identityStore !== undefined) {
        let current: UserDocRef
        try { current = await this.identityStore.stat(docId) } catch (error) {
          if (!(error instanceof UserDocError) || error.code !== DOCUMENT_NOT_FOUND_CODE
            || this.identitySelection !== undefined) throw error
          if (expected !== undefined) await this.identityStore.remove(expected, this.identityActor?.())
          return
        }
        const selection = currentSelection(current, this.identitySelection, expected)
        await this.identityStore.remove(selection, this.identityActor?.())
        this.invalidateReads()
        return
      }
      await removeDocFile(this.root, docId, admittedSignal)
      this.invalidateReads()
    })
  }
}
