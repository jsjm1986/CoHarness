/** Local real-file document backend rooted below the operating-system home. @module @deepseek-ai/dsh-userdoc-local */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { UserDocDirectoryId, UserDocStore } from '@deepseek-ai/dsh-userdoc'
import type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
} from '@deepseek-ai/dsh-userdoc'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  createDocDirectory,
  listDocDirectories,
  listDocDirectory,
  listDocFiles,
  moveDocFile,
  openDocFile,
  readDocFile,
  removeDocDirectory,
  removeDocFile,
  renameDocDirectory,
  resolveDocTarget,
  saveDocFile,
  statDocFile,
} from './store.ts'
import { migrateLegacyDocuments } from './migration.ts'

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
/** Default maximum bytes for one document. */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
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
  /** Maximum bytes accepted for one document. */
  maxFileBytes?: number
  /** Maximum document count accepted in one submitted message. */
  maxFilesPerMessage?: number
  /** Maximum aggregate bytes accepted in one submitted message. */
  maxMessageBytes?: number
  /** Maximum bytes of a document inlined into a prompt as text. */
  maxInlineTextBytes?: number
}

/** Real-file local document store. */
export class LocalUserDocStore extends UserDocStore {
  static Config: z<Config> = z.object({
    uploadRoot: z.string(),
    legacyUploadRoot: z.string(),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
    maxFilesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_FILES_PER_MESSAGE),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxInlineTextBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_TEXT_BYTES),
  })

  /** Absolute document root. */
  readonly root: string
  readonly limits: UserDocLimits
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
    })
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.legacyRoot === undefined
      ? mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => undefined)
      : migrateLegacyDocuments(this.legacyRoot, this.root)
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
