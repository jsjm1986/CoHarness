/** User-document failure class. @module @deepseek-ai/dsh-userdoc/error */

/**
 * Stable failures suitable for host RPC error mapping.
 *
 * Re-implements the `HarnessError` shape rather than extending it, for the
 * same reason `AttachmentError` does: the base lives in `@deepseek-ai/dsh-llm`,
 * which depends on the attachment vocabulary this package sits beside, so
 * sharing the base would risk a dependency cycle as soon as a content block
 * references a document. Consumers route on `code`, never on the prototype
 * chain, so the shapes stay interchangeable at the wire boundary.
 */
export class UserDocError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: UserDocErrorCode

  /**
   * @param message - human-readable description carrying neither document bytes nor absolute host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: UserDocErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserDocError'
    this.code = code
  }
}

/** One uploaded name could not be reduced to a safe leaf below the document root. */
export const INVALID_DOCUMENT_NAME_CODE = 'INVALID_DOCUMENT_NAME'

/** An identifier did not resolve to a path inside the document root. */
export const INVALID_DOCUMENT_REF_CODE = 'INVALID_DOCUMENT_REF'

/** A directory identifier or name is invalid or escapes the document root. */
export const INVALID_DOCUMENT_DIRECTORY_CODE = 'INVALID_DOCUMENT_DIRECTORY'

/** A resolved target changed or became occupied before it could be published. */
export const DOCUMENT_TARGET_CONFLICT_CODE = 'DOCUMENT_TARGET_CONFLICT'

/** Every bounded collision suffix for one upload name is already occupied. */
export const DOCUMENT_NAME_EXHAUSTED_CODE = 'DOCUMENT_NAME_EXHAUSTED'

/** One document exceeded the configured per-file byte limit. */
export const DOCUMENT_TOO_LARGE_CODE = 'DOCUMENT_TOO_LARGE'

/** One prompt referenced more documents than the deployment permits. */
export const TOO_MANY_DOCUMENTS_CODE = 'TOO_MANY_DOCUMENTS'

/** One prompt's referenced documents exceed the aggregate byte limit. */
export const DOCUMENTS_TOO_LARGE_CODE = 'DOCUMENTS_TOO_LARGE'

/** Prompt admission cannot resolve documents because no store is composed. */
export const DOCUMENT_STORE_UNAVAILABLE_CODE = 'DOCUMENT_STORE_UNAVAILABLE'

/** The referenced document is absent from storage. */
export const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND'

/** Storage refused a write, or a partial write could not be completed. */
export const DOCUMENT_WRITE_FAILED_CODE = 'DOCUMENT_WRITE_FAILED'

/** Storage refused a read. */
export const DOCUMENT_READ_FAILED_CODE = 'DOCUMENT_READ_FAILED'

/** Storage refused a deletion. */
export const DOCUMENT_DELETE_FAILED_CODE = 'DOCUMENT_DELETE_FAILED'

/** The referenced document directory is absent. */
export const DOCUMENT_DIRECTORY_NOT_FOUND_CODE = 'DOCUMENT_DIRECTORY_NOT_FOUND'

/** A document-directory create, rename, or move target is occupied. */
export const DOCUMENT_DIRECTORY_CONFLICT_CODE = 'DOCUMENT_DIRECTORY_CONFLICT'

/** A requested directory deletion targeted a directory that still has children. */
export const DOCUMENT_DIRECTORY_NOT_EMPTY_CODE = 'DOCUMENT_DIRECTORY_NOT_EMPTY'

/** Storage refused a directory create, rename, or deletion. */
export const DOCUMENT_DIRECTORY_WRITE_FAILED_CODE = 'DOCUMENT_DIRECTORY_WRITE_FAILED'

/** Storage could not move a document without replacing an existing entry. */
export const DOCUMENT_MOVE_FAILED_CODE = 'DOCUMENT_MOVE_FAILED'

/** The legacy upload directory could not be migrated into the document root. */
export const DOCUMENT_MIGRATION_FAILED_CODE = 'DOCUMENT_MIGRATION_FAILED'

/** Closed set of stable user-document failure codes. */
export type UserDocErrorCode =
  | typeof INVALID_DOCUMENT_NAME_CODE
  | typeof INVALID_DOCUMENT_REF_CODE
  | typeof INVALID_DOCUMENT_DIRECTORY_CODE
  | typeof DOCUMENT_TARGET_CONFLICT_CODE
  | typeof DOCUMENT_NAME_EXHAUSTED_CODE
  | typeof DOCUMENT_TOO_LARGE_CODE
  | typeof TOO_MANY_DOCUMENTS_CODE
  | typeof DOCUMENTS_TOO_LARGE_CODE
  | typeof DOCUMENT_STORE_UNAVAILABLE_CODE
  | typeof DOCUMENT_NOT_FOUND_CODE
  | typeof DOCUMENT_WRITE_FAILED_CODE
  | typeof DOCUMENT_READ_FAILED_CODE
  | typeof DOCUMENT_DELETE_FAILED_CODE
  | typeof DOCUMENT_DIRECTORY_NOT_FOUND_CODE
  | typeof DOCUMENT_DIRECTORY_CONFLICT_CODE
  | typeof DOCUMENT_DIRECTORY_NOT_EMPTY_CODE
  | typeof DOCUMENT_DIRECTORY_WRITE_FAILED_CODE
  | typeof DOCUMENT_MOVE_FAILED_CODE
  | typeof DOCUMENT_MIGRATION_FAILED_CODE
