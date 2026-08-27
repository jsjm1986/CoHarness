/** User-uploaded document storage seam (`ctx.userDocs`). @module @deepseek-ai/dsh-userdoc */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ResolveUserDocTarget,
  BeginUserDocUpload,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocLimits,
  UserDocListQuery,
  UserDocListType,
  UserDocRef,
  UserDocTarget,
  UserDocUploadChunk,
  UserDocUploadSession,
  UserDocTrashRef,
  UserDocTrashPage,
} from './types.ts'
import type { UserDocDirectoryId, UserDocId, UserDocUploadId } from './brand.ts'
import { DOCUMENT_LIST_QUERY_CODE, UserDocError } from './error.ts'

function documentTypeForMediaType(mediaType: string): UserDocListType {
  return mediaType.startsWith('image/') ? 'image'
    : mediaType === 'application/pdf' ? 'pdf'
      : mediaType.startsWith('text/') || mediaType.endsWith('+json') || mediaType.endsWith('+xml')
        || mediaType === 'application/json' || mediaType === 'application/xml'
        || mediaType === 'application/x-yaml' || mediaType === 'application/javascript' ? 'text' : 'other'
}

/** Maximum offset accepted by the compatibility page implementation. */
const MAX_PAGE_OFFSET = 1_000_000

export { UserDocDirectoryId, UserDocId, UserDocUploadId } from './brand.ts'
export {
  DOCUMENT_DELETE_FAILED_CODE,
  DOCUMENT_DIRECTORY_CONFLICT_CODE,
  DOCUMENT_DIRECTORY_NOT_EMPTY_CODE,
  DOCUMENT_DIRECTORY_NOT_FOUND_CODE,
  DOCUMENT_DIRECTORY_WRITE_FAILED_CODE,
  DOCUMENT_MIGRATION_FAILED_CODE,
  DOCUMENT_MOVE_FAILED_CODE,
  DOCUMENT_NAME_EXHAUSTED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_STORE_UNAVAILABLE_CODE,
  DOCUMENT_UPLOAD_BUSY_CODE,
  DOCUMENT_LIST_QUERY_CODE,
  DOCUMENT_TRASHED_CODE,
  DOCUMENT_TRASH_NOT_FOUND_CODE,
  DOCUMENT_RESTORE_CONFLICT_CODE,
  DOCUMENT_UPLOAD_EXPIRED_CODE,
  DOCUMENT_UPLOAD_HASH_CODE,
  DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  DOCUMENT_UPLOAD_PROTOCOL_CODE,
  DOCUMENT_UPLOAD_RANGE_CODE,
  DOCUMENT_UPLOAD_SIZE_CODE,
  DOCUMENT_UPLOAD_STATE_CODE,
  DOCUMENT_UPLOAD_STORAGE_CODE,
  DOCUMENTS_TOO_LARGE_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_WRITE_FAILED_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_REF_CODE,
  TOO_MANY_DOCUMENTS_CODE,
  UserDocError,
} from './error.ts'
export type { UserDocErrorCode } from './error.ts'
export type {
  ResolveUserDocTarget,
  BeginUserDocUpload,
  StoredUserDoc,
  UserDocDirectoryId as UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocId as UserDocIdType,
  UserDocLimits,
  UserDocListQuery,
  UserDocListSort,
  UserDocListType,
  UserDocRef,
  UserDocPromptAttachment,
  UserDocPromptRepresentation,
  UserDocScope,
  UserDocTransferCapabilities,
  UserDocTransferCapability,
  UserDocTransferListResponse,
  UserDocTransferDirectoriesResponse,
  UserDocCatalogHistory,
  UserDocCatalogHistoryItem,
  UserDocCatalogMetrics,
  UserDocCatalogOverview,
  UserDocCatalogRow,
  UserDocTransferListedDocument,
  UserDocTarget,
  UserDocTransferItem,
  UserDocTransferRequest,
  UserDocTransferPlanResponse,
  UserDocTransferResponse,
  UserDocTransferScopeSummary,
  UserDocTransferSelection,
  UserDocTransferTargetRef,
  UserDocTrashRef,
  UserDocTrashPage,
  UserDocUploadCapabilities,
  UserDocUploadChunk,
  UserDocUploadId as UserDocUploadIdType,
  UserDocUploadSession,
  UserDocUploadState,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userDocs: UserDocStore
  }
}

/**
 * Storage for documents a user uploads into their own workspace.
 *
 * The stored form is an ordinary named file, not an opaque object: a document
 * lands at a real path the agent's filesystem and shell tools can read, which
 * is what lets one uploaded file serve every format without this seam knowing
 * any of them. Nothing here inspects, parses, or whitelists content —
 * `mediaType` is recorded and never acted upon, so an unrecognized format is
 * stored exactly like a recognized one and the agent decides how to read it.
 *
 * Writes are two explicit steps. `resolveTarget` sanitizes the untrusted
 * client name and computes the path; `save` streams bytes to that path. Naming
 * policy therefore has one auditable home, and `save` never defaults a target
 * of its own.
 */
export abstract class UserDocStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userDocs')
  }

  /** Deployment-resolved upload policy, shared with client-side intake pre-checks. */
  abstract readonly limits: UserDocLimits

  /**
   * Resolve one untrusted client file name to the absolute path a `save` will
   * create. Implementations sanitize the name, keep the result inside the
   * document root, and pick a leaf that no existing entry holds.
   * @param input - client-supplied name, treated as untrusted text.
   * @returns the resolved write target.
   * @throws UserDocError when no acceptable free name can be derived from the input.
   */
  abstract resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget>

  /**
   * Stream one document to a resolved target and publish its reference.
   *
   * Implementations enforce a finite `maxFileBytes` while streaming, so an
   * oversized upload is cut off rather than buffered; `null` accepts every
   * document size supported by the transport and filesystem. Failed or
   * cancelled writes leave no partial file behind. The recorded `mediaType` is
   * derived from the stored name, never taken from a client header: a declared
   * type is unverifiable here, and nothing in this seam acts on the value anyway.
   * @param target - a target from this store's own `resolveTarget`.
   * @param body - the upload byte stream.
   * @param signal - optional cancellation for the streaming write.
   * @returns the durable reference to the stored document.
   * @throws UserDocError when a finite `maxFileBytes` is exceeded or the write fails.
   */
  abstract save(
    target: UserDocTarget,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<UserDocRef>

  /**
   * Create or reuse a resumable upload session.
   * @param input - untrusted browser metadata validated by the provider.
   * @returns the public upload session state.
   */
  abstract beginUpload(input: BeginUserDocUpload): Promise<UserDocUploadSession>

  /**
   * Read one upload session's public state.
   * @param uploadId - opaque provider-produced identifier.
   * @param signal - optional cancellation.
   * @returns current upload state.
   */
  abstract inspectUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<UserDocUploadSession>

  /**
   * Append one sequential chunk to an upload session.
   * @param uploadId - opaque provider-produced identifier.
   * @param chunk - validated range, digest, and raw body.
   * @param signal - optional cancellation.
   * @returns updated public upload state.
   */
  abstract writeUploadChunk(
    uploadId: UserDocUploadId,
    chunk: UserDocUploadChunk,
    signal?: AbortSignal,
  ): Promise<UserDocUploadSession>

  /**
   * Start or repeat final verification and publication.
   * @param uploadId - opaque provider-produced identifier.
   * @param sha256 - final SHA-256 digest supplied by the browser.
   * @param signal - optional cancellation.
   * @returns verifying, complete, or failed public state.
   */
  abstract completeUpload(
    uploadId: UserDocUploadId,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<UserDocUploadSession>

  /**
   * Cancel and remove one incomplete upload session.
   * @param uploadId - opaque provider-produced identifier.
   * @param signal - optional cancellation.
   * @returns after temporary data is removed.
   */
  abstract cancelUpload(uploadId: UserDocUploadId, signal?: AbortSignal): Promise<void>

  /**
   * List every stored document, newest modification first.
   * @param signal - optional cancellation for the directory scan.
   * @returns references to all stored documents; empty before the first upload.
   */
  abstract list(signal?: AbortSignal): Promise<UserDocRef[]>

  /**
   * List one directory's immediate children.
   * @param directoryId - store-scoped directory identifier; the empty identifier selects the root.
   * @param signal - optional cancellation for the directory scan.
   * @returns immediate directories and documents.
   * @throws UserDocError when the identifier is invalid or the directory is absent.
   */
  abstract listDirectory(
    directoryId: UserDocDirectoryId,
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryListing>

  /**
   * Return one filtered page without requiring a consumer to materialize the
   * complete directory result. Providers may override this method with an
   * indexed implementation; the default keeps older providers functional.
   * @param directoryId - directory to inspect.
   * @param query - filtering, ordering and cursor options.
   * @param signal - optional cancellation.
   * @returns a page with an opaque offset cursor.
   */
  async listDirectoryPage(
    directoryId: UserDocDirectoryId,
    query: UserDocListQuery = {},
    signal?: AbortSignal,
  ): Promise<UserDocDirectoryPage> {
    signal?.throwIfAborted()
    if (query.state !== undefined && query.state !== 'active') {
      throw new UserDocError('Directory trash pages are not available from this provider.', DOCUMENT_LIST_QUERY_CODE)
    }
    if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 4096)
      || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
      || query.query !== undefined && (query.query.length > 255 || /[\u0000-\u001f\u007f]/u.test(query.query))
      || query.type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(query.type)
      || query.sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(query.sort)) {
      throw new UserDocError('Document list query is invalid.', DOCUMENT_LIST_QUERY_CODE)
    }
    const listing = await this.listDirectory(directoryId, signal)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
    const offset = query.cursor === undefined || query.cursor === '' ? 0 : Number(query.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
      throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
    }
    const safeOffset = offset
    const needle = query.query?.trim().toLowerCase() ?? ''
    const type = query.type ?? 'all'
    const filtered = listing.documents.filter(document =>
      (needle === '' || document.name.toLowerCase().includes(needle))
      && (type === 'all' || documentTypeForMediaType(document.mediaType) === type))
    const sort = query.sort ?? 'date-desc'
    const ordered = [...filtered].sort((left, right) => {
      const result = sort.startsWith('name') ? left.name.localeCompare(right.name)
        : sort.startsWith('size') ? left.bytes - right.bytes : left.modifiedAt - right.modifiedAt
      const direction = sort.endsWith('asc') ? 1 : -1
      if (result !== 0) return direction * result
      return left.docId.localeCompare(right.docId)
    })
    const documents = ordered.slice(safeOffset, safeOffset + limit)
    const nextOffset = safeOffset + documents.length
    return {
      ...listing,
      documents,
      totalDocuments: ordered.length,
      ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  /**
   * List recoverable documents retained in the provider trash.
   * @param signal - optional cancellation for the trash scan.
   * @returns recoverable document references.
   */
  abstract listTrash(signal?: AbortSignal): Promise<UserDocTrashRef[]>

  /**
   * Return one filtered page from recoverable trash.
   * @param query - filtering, ordering and cursor options.
   * @param signal - optional cancellation for the trash scan.
   * @returns a filtered trash page with an opaque offset cursor.
   */
  async listTrashPage(
    query: UserDocListQuery = {},
    signal?: AbortSignal,
  ): Promise<UserDocTrashPage> {
    signal?.throwIfAborted()
    if (query.state !== undefined && query.state !== 'trash') {
      throw new UserDocError('Trash list query is invalid.', DOCUMENT_LIST_QUERY_CODE)
    }
    if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 4096)
      || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
      || query.query !== undefined && (query.query.length > 255 || /[\u0000-\u001f\u007f]/u.test(query.query))
      || query.type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(query.type)
      || query.sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(query.sort)) {
      throw new UserDocError('Document list query is invalid.', DOCUMENT_LIST_QUERY_CODE)
    }
    const all = await this.listTrash(signal)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
    const offset = query.cursor === undefined || query.cursor === '' ? 0 : Number(query.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
      throw new UserDocError('Document cursor is invalid.', DOCUMENT_LIST_QUERY_CODE)
    }
    const needle = query.query?.trim().toLowerCase() ?? ''
    const filtered = all.filter(document => (needle === '' || document.name.toLowerCase().includes(needle))
      && (query.type === undefined || query.type === 'all' || documentTypeForMediaType(document.mediaType) === query.type))
    const sort = query.sort ?? 'date-desc'
    const ordered = [...filtered].sort((left, right) => {
      const result = sort.startsWith('name') ? left.name.localeCompare(right.name)
        : sort.startsWith('size') ? left.bytes - right.bytes : left.trashedAt - right.trashedAt
      const direction = sort.endsWith('asc') ? 1 : -1
      if (result !== 0) return direction * result
      return left.docId.localeCompare(right.docId)
    })
    const documents = ordered.slice(offset, offset + limit)
    const nextOffset = offset + documents.length
    return {
      documents,
      totalDocuments: ordered.length,
      ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  /**
   * Move one document into recoverable trash.
   * @param docId - store-scoped document identifier.
   * @param signal - optional cancellation for the move.
   * @returns the retained trash reference.
   */
  abstract trash(docId: UserDocId, signal?: AbortSignal): Promise<UserDocTrashRef>

  /**
   * Restore one trashed document, optionally choosing a destination directory.
   * A local provider recreates a missing original directory before publication;
   * an occupied or link-shaped destination is rejected.
   * @param docId - store-scoped document identifier.
   * @param directoryId - optional destination directory; omitted keeps the original directory.
   * @param name - optional replacement leaf name.
   * @param signal - optional cancellation for the restore.
   * @returns the restored durable document reference.
   */
  abstract restore(
    docId: UserDocId,
    directoryId?: UserDocDirectoryId,
    name?: string,
    signal?: AbortSignal,
  ): Promise<UserDocRef>

  /**
   * Permanently remove one trashed document.
   * @param docId - store-scoped document identifier.
   * @param signal - optional cancellation for the purge.
   */
  abstract purge(docId: UserDocId, signal?: AbortSignal): Promise<void>

  /**
   * List every directory below the document root.
   * @param signal - optional cancellation for the recursive scan.
   * @returns directory references ordered by identifier.
   */
  abstract listDirectories(signal?: AbortSignal): Promise<UserDocDirectoryRef[]>

  /**
   * Create one directory below an existing parent.
   * @param parentDirectoryId - parent directory; the empty identifier selects the root.
   * @param name - untrusted directory leaf name.
   * @returns the created directory reference.
   * @throws UserDocError when the name is invalid, the parent is absent, or the target exists.
   */
  abstract createDirectory(
    parentDirectoryId: UserDocDirectoryId,
    name: string,
  ): Promise<UserDocDirectoryRef>

  /**
   * Rename one directory within its current parent.
   * @param directoryId - non-root directory to rename.
   * @param name - untrusted replacement leaf name.
   * @returns the renamed directory reference.
   * @throws UserDocError when the directory is absent, the name is invalid, or the target exists.
   */
  abstract renameDirectory(directoryId: UserDocDirectoryId, name: string): Promise<UserDocDirectoryRef>

  /**
   * Delete one empty, non-root directory.
   * @param directoryId - directory to delete.
   * @returns after the directory is gone.
   * @throws UserDocError when the directory is absent, non-empty, or identifies the root.
   */
  abstract removeDirectory(directoryId: UserDocDirectoryId): Promise<void>

  /**
   * Move one document into an existing directory without replacing an entry.
   * @param docId - document to move.
   * @param directoryId - destination directory; the empty identifier selects the root.
   * @returns the moved document reference.
   * @throws UserDocError when either identifier is invalid or the destination is occupied.
   */
  abstract move(docId: UserDocId, directoryId: UserDocDirectoryId): Promise<UserDocRef>

  /**
   * Resolve one identifier to its current reference.
   *
   * Every read path takes this identifier rather than a `UserDocRef`, because a
   * reference carries an absolute path and a caller's copy of one is untrusted
   * input. Implementations re-derive the path from the identifier and re-prove
   * containment, so a tampered path cannot name a file outside the document root.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation for the filesystem probe.
   * @returns the current reference.
   * @throws UserDocError when the identifier is malformed, escapes the document root, or names no file.
   */
  abstract stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef>

  /**
   * Read one stored document in full.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation for the read.
   * @returns the bytes and the reference they were read through.
   * @throws the signal reason when aborted, or a UserDocError when the identifier does not resolve to a file.
   */
  abstract read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc>

  /**
   * Open one stored document as a byte stream, for a download response that must
   * not hold the whole file in memory.
   * @param docId - identifier from a previous `save` or `list`.
   * @returns the reference and its byte stream.
   * @throws UserDocError when the identifier does not resolve to a file.
   */
  abstract openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }>

  /**
   * Delete one stored document. Deleting an already-absent document succeeds, so
   * a client retrying a delete it already completed is not an error.
   * @param docId - identifier from a previous `save` or `list`.
   * @param signal - optional cancellation.
   * @returns after the entry is gone.
   * @throws UserDocError when the identifier is malformed or escapes the document
   * root, or the deletion fails for any reason other than absence.
   */
  abstract remove(docId: UserDocId, signal?: AbortSignal): Promise<void>
}

export default UserDocStore
