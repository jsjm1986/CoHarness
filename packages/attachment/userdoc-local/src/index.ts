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
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadId,
  UserDocUploadSession,
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
import { migrateLegacyDocuments } from './migration.ts'
import {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
  LocalUploadManager,
} from './upload.ts'

export {
  DEFAULT_UPLOAD_CHUNK_BYTES,
  DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS,
  DEFAULT_UPLOAD_MAX_CONCURRENT,
  DEFAULT_UPLOAD_MIN_FREE_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_MS,
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
    uploadCleanupIntervalMs: z.number().step(1).min(60 * 1000).default(DEFAULT_UPLOAD_CLEANUP_INTERVAL_MS),
  })

  /** Absolute document root. */
  readonly root: string
  readonly limits: UserDocLimits
  private readonly uploads: LocalUploadManager
  private readonly legacyRoot: string | undefined
  private ready: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const usesDefaultRoot = config.uploadRoot === undefined
    const configuredRoot = config.uploadRoot
    this.root = resolve(configuredRoot === undefined
      ? join(homedir(), DEFAULT_DOCUMENT_DIR_NAME)
      : expandHomePath(configuredRoot))
    this.legacyRoot = config.legacyUploadRoot === undefined
      ? usesDefaultRoot ? join(homedir(), LEGACY_UPLOAD_DIR_NAME) : undefined
      : resolve(expandHomePath(config.legacyUploadRoot))
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
    })
    ctx.effect(() => {
      return () => { this.uploads.stopCleanup() }
    }, 'userdoc-local: upload cleanup')
  }

  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      if (this.legacyRoot === undefined) await mkdir(this.root, { recursive: true, mode: 0o700 })
      else await migrateLegacyDocuments(this.legacyRoot, this.root)
      await this.uploads.cleanupExpired()
      await this.uploads.resumePendingFinalizations()
      this.uploads.startCleanup()
    })()
    return this.ready
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
    return saveDocFile(this.root, target, body, this.limits, signal)
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
    return this.uploads.complete(uploadId, sha256)
  }

  async cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.ensureReady()
    return this.uploads.cancel(uploadId)
  }

  async list(signal?: AbortSignal): Promise<UserDocRef[]> {
    await this.ensureReady()
    return listDocFiles(this.root, signal)
  }

  async listDirectory(
    directoryId: UserDocDirectoryId,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryListing> {
    await this.ensureReady()
    return listDocDirectory(this.root, directoryId, signal)
  }

  async listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
    await this.ensureReady()
    return listDocDirectories(this.root, signal)
  }

  async createDirectory(parentDirectoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    await this.ensureReady()
    return createDocDirectory(this.root, parentDirectoryId, name)
  }

  async renameDirectory(directoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef> {
    await this.ensureReady()
    return renameDocDirectory(this.root, directoryId, name)
  }

  async removeDirectory(directoryId: UserDocDirectoryId): Promise<void> {
    await this.ensureReady()
    return removeDocDirectory(this.root, directoryId)
  }

  async move(docId: UserDocId, directoryId: UserDocDirectoryId): Promise<UserDocRef> {
    await this.ensureReady()
    return moveDocFile(this.root, docId, directoryId)
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
  }
}

export default LocalUserDocStore
