/** Local real-file document backend rooted below the operating-system home. @module @deepseek-ai/dsh-userdoc-local */

import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { UserDocStore } from '@deepseek-ai/dsh-userdoc'
import type {
  BeginUserDocUpload,
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryId,
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
import { LocalUserDocFs, SharedRead } from './local-fs.ts'
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  MAX_UPLOAD_TIMER_DELAY_MS,
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
export { LocalUserDocFs } from './local-fs.ts'
export type { LocalUserDocFsOptions } from './local-fs.ts'

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

  private readonly engine: LocalUserDocFs
  private readonly pageReads = new Map<string, SharedRead<UserDocDirectoryPage>>()
  private readonly trashPageReads = new Map<string, SharedRead<UserDocTrashPage>>()
  /** Includes scans removed from lookup maps by a mutation, so disposal can still join them. */
  private readonly activeReads = new Set<SharedRead<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.trashRetentionDays !== undefined
      && (!Number.isSafeInteger(config.trashRetentionDays) || config.trashRetentionDays < 1
        || config.trashRetentionDays > Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000))) {
      throw new Error('trashRetentionDays must be a positive safe integer')
    }
    const usesDefaultRoot = config.uploadRoot === undefined
    const configuredRoot = config.uploadRoot
    const root = resolve(configuredRoot === undefined
      ? join(homedir(), DEFAULT_DOCUMENT_DIR_NAME)
      : expandHomePath(configuredRoot))
    const legacyRoot = config.legacyUploadRoot === undefined
      ? usesDefaultRoot ? join(homedir(), LEGACY_UPLOAD_DIR_NAME) : undefined
      : resolve(expandHomePath(config.legacyUploadRoot))
    registerManagedDataPath({ owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: root }, process.env.DSH_MANAGED_DATA_MANIFEST)
    if (legacyRoot !== undefined) registerManagedDataPath({ owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: legacyRoot }, process.env.DSH_MANAGED_DATA_MANIFEST)
    const limits = Object.freeze({
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
    this.engine = new LocalUserDocFs({
      root,
      ...(legacyRoot === undefined ? {} : { legacyRoot }),
      limits,
      upload: {
        chunkBytes: config.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES,
        sessionTtlMs: config.uploadSessionTtlMs ?? DEFAULT_UPLOAD_SESSION_TTL_MS,
        minFreeBytes: config.uploadMinFreeBytes ?? DEFAULT_UPLOAD_MIN_FREE_BYTES,
        maxConcurrent: config.uploadMaxConcurrent ?? DEFAULT_UPLOAD_MAX_CONCURRENT,
        cleanupIntervalMs: config.uploadCleanupIntervalMs ?? DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
        manifestMaxBytes: config.uploadManifestMaxBytes ?? DEFAULT_UPLOAD_MANIFEST_MAX_BYTES,
      },
      sweepIntervalMs: config.uploadCleanupIntervalMs ?? DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
      trashRetentionMs: (config.trashRetentionDays ?? 30) * 86_400_000,
    })
    ctx.effect(() => {
      this.engine.attach()
      return () => {
        const reads = [...this.activeReads]
        for (const read of reads) read.cancel(new Error('document store disposed'))
        return Promise.allSettled([...reads.map(read => read.promise), this.engine.dispose()])
          .then(() => undefined)
      }
    }, 'userdoc-local: upload cleanup')
  }

  /** Absolute document root. */
  get root(): string {
    return this.engine.root
  }

  get limits(): UserDocLimits {
    return this.engine.limits
  }

  /** Pre-initialize storage and maintenance before the first browser request. */
  async warm(): Promise<void> {
    await this.engine.warm()
  }

  async resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget> {
    return this.engine.resolveTarget(input)
  }

  async save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef> {
    const saved = await this.engine.save(target, body, signal)
    this.invalidateReads()
    return saved
  }

  async beginUpload(input: BeginUserDocUpload): Promise<UserDocUploadSession> {
    return this.engine.beginUpload(input)
  }

  async inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<UserDocUploadSession> {
    return this.engine.inspectUpload(uploadId, signal)
  }

  async writeUploadChunk(
    uploadId: UserDocUploadId,
    chunk: UserDocUploadChunk,
    signal?: AbortSignal,
  ): Promise<UserDocUploadSession> {
    return this.engine.writeUploadChunk(uploadId, chunk, signal)
  }

  async completeUpload(uploadId: UserDocUploadId, sha256: string, signal?: AbortSignal): Promise<UserDocUploadSession> {
    const completed = await this.engine.completeUpload(uploadId, sha256, signal)
    if (completed.state === 'complete') this.invalidateReads()
    return completed
  }

  async cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<void> {
    return this.engine.cancelUpload(uploadId, signal)
  }

  async list(signal?: AbortSignal): Promise<UserDocRef[]> {
    return this.engine.list(signal)
  }

  async listDirectory(
    directoryId: UserDocDirectoryId,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryListing> {
    return this.engine.listDirectory(directoryId, signal)
  }

  override async listDirectoryPage(
    directoryId: UserDocDirectoryId,
    query: UserDocListQuery = {},
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryPage> {
    const key = `${String(directoryId)} ${JSON.stringify(query)}`
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

  private invalidateReads(): void {
    this.pageReads.clear()
    this.trashPageReads.clear()
  }

  async listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
    return this.engine.listDirectories(signal)
  }

  async listTrash(signal?: AbortSignal): Promise<UserDocTrashRef[]> {
    return this.engine.listTrash(signal)
  }

  override async listTrashPage(query: UserDocListQuery = {}, signal?: AbortSignal): Promise<UserDocTrashPage> {
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
    const trashed = await this.engine.trash(docId, signal)
    this.invalidateReads()
    return trashed
  }

  async restore(docId: UserDocId, directoryId?: UserDocDirectoryId, name?: string, signal?: AbortSignal): Promise<UserDocRef> {
    const restored = await this.engine.restore(docId, directoryId, name, signal)
    this.invalidateReads()
    return restored
  }

  async purge(docId: UserDocId, signal?: AbortSignal): Promise<void> {
    await this.engine.purge(docId, signal)
    this.invalidateReads()
  }

  async createDirectory(parentDirectoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    const created = await this.engine.createDirectory(parentDirectoryId, name)
    this.invalidateReads()
    return created
  }

  async renameDirectory(directoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    const renamed = await this.engine.renameDirectory(directoryId, name)
    this.invalidateReads()
    return renamed
  }

  async removeDirectory(directoryId: UserDocDirectoryId): Promise<void> {
    await this.engine.removeDirectory(directoryId)
    this.invalidateReads()
  }

  async move(docId: UserDocId, directoryId: UserDocDirectoryId): Promise<UserDocRef> {
    const moved = await this.engine.move(docId, directoryId)
    this.invalidateReads()
    return moved
  }

  async stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
    return this.engine.stat(docId, signal)
  }

  async read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    return this.engine.read(docId, signal)
  }

  async openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
    return this.engine.openRead(docId)
  }

  async remove(docId: UserDocId, signal?: AbortSignal): Promise<void> {
    await this.engine.remove(docId, signal)
    this.invalidateReads()
  }
}

export default LocalUserDocStore
