/** User-uploaded document storage seam (`ctx.userDocs`). @module @deepseek-ai/dsh-userdoc */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ResolveUserDocTarget,
  StoredUserDoc,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
} from './types.ts'
import type { UserDocDirectoryId, UserDocId } from './brand.ts'

export { UserDocDirectoryId, UserDocId } from './brand.ts'
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
  StoredUserDoc,
  UserDocDirectoryId as UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocId as UserDocIdType,
  UserDocLimits,
  UserDocRef,
  UserDocPromptAttachment,
  UserDocPromptRepresentation,
  UserDocScope,
  UserDocTransferCapabilities,
  UserDocTransferCapability,
  UserDocTransferListResponse,
  UserDocTransferListedDocument,
  UserDocTarget,
  UserDocTransferItem,
  UserDocTransferRequest,
  UserDocTransferResponse,
  UserDocTransferScopeSummary,
  UserDocTransferSelection,
  UserDocTransferTargetRef,
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
