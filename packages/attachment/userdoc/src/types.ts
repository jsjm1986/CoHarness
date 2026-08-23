/** User-document vocabulary. @module @deepseek-ai/dsh-userdoc/types */

import type { UserDocDirectoryId, UserDocId } from './brand.ts'

export type { UserDocDirectoryId, UserDocId } from './brand.ts'

/**
 * Durable, serializable metadata for one uploaded document.
 *
 * Deliberately unlike `ImageAttachmentRef`: `path` is a real absolute host
 * path, because the point of this seam is that an uploaded document is an
 * ordinary file the agent's own filesystem and shell tools can reach. The
 * deployment is responsible for rooting the document workspace somewhere the tool
 * authorization policy already grants (the user's home directory under the
 * multi-user gateway), so publishing the path grants no access the session did
 * not already have.
 */
export interface UserDocRef {
  /** Store-scoped identifier; resolves to a path inside the document root and nowhere else. */
  docId: UserDocId
  /** Absolute host path of the stored document. */
  path: string
  /** Display name: the sanitized leaf actually written, which may differ from what was uploaded. */
  name: string
  /** Byte length observed when this reference was created. */
  bytes: number
  /**
   * Extension-derived media type. It is presentation metadata only; no
   * admission decision, parse, or dispatch reads it.
   */
  mediaType: string
  /** Storage modification time in epoch milliseconds. */
  modifiedAt: number
}

/** Metadata for one ordinary directory below the document root. */
export interface UserDocDirectoryRef {
  /** Store-scoped directory identifier; the empty identifier names the root. */
  directoryId: UserDocDirectoryId
  /** Absolute host path of the directory. */
  path: string
  /** Directory leaf displayed to the user. */
  name: string
  /** Directory modification time in epoch milliseconds. */
  modifiedAt: number
}

/** Immediate children of one directory in the document store. */
export interface UserDocDirectoryListing {
  /** Directory whose immediate children were listed. */
  directoryId: UserDocDirectoryId
  /** Parent directory, absent at the document root. */
  parentDirectoryId?: UserDocDirectoryId
  /** Immediate subdirectories, ordered by name. */
  directories: UserDocDirectoryRef[]
  /** Immediate documents, newest modification first. */
  documents: UserDocRef[]
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface UserDocLimits {
  /** Maximum bytes accepted for one document; `null` means no per-document limit. */
  maxFileBytes: number | null
  /** Maximum documents accepted in one submitted message. */
  maxFilesPerMessage: number
  /** Maximum aggregate bytes accepted in one submitted message. */
  maxMessageBytes: number
  /**
   * Maximum bytes of a document inlined into a prompt as text. A document at
   * or below this size that decodes as UTF-8 text is inlined; everything else
   * reaches the model as its path only.
   */
  maxInlineTextBytes: number
}

/**
 * A resolved write target: the exact absolute path a `save` will create, plus
 * the sanitized leaf it will carry. Produced by an explicit `resolveTarget`
 * step so that name sanitization and root containment are decided in one
 * auditable place rather than defaulted inside `save`.
 */
export interface UserDocTarget {
  /** Absolute path to create; guaranteed to lie inside the store's document root. */
  path: string
  /** Sanitized leaf name of `path`. */
  name: string
  /** Identifier that will resolve back to this path. */
  docId: UserDocId
}

/** Request to resolve one upload target. */
export interface ResolveUserDocTarget {
  /** Client-supplied file name, treated as untrusted text and never as a path. */
  name: string
  /** Destination directory; omitted selects the document root. */
  directoryId?: UserDocDirectoryId
}

/** Stored document bytes returned with the reference they were read through. */
export interface StoredUserDoc {
  ref: UserDocRef
  data: Uint8Array
}

/** Scope selector used by the Gateway's versioned snapshot-copy operation. */
export type UserDocScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'project'; readonly projectId: number }

/** One source document selected for a cross-scope copy. */
export interface UserDocTransferSelection {
  readonly docId: UserDocId
}

/** Browser/runtime request for a one-way document snapshot copy. */
export interface UserDocTransferRequest {
  readonly version: 1
  readonly source: UserDocScope
  readonly target: UserDocScope
  readonly directory?: UserDocDirectoryId
  readonly documents: readonly UserDocTransferSelection[]
}

/** Safe target metadata returned after a document snapshot is copied. */
export interface UserDocTransferTargetRef {
  readonly docId: UserDocId
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
}

/** One per-file result; a failed item does not roll back successful items. */
export type UserDocTransferItem =
  | {
    readonly status: 'copied'
    readonly source: { readonly name: string; readonly bytes: number; readonly mediaType: string }
    readonly target: UserDocTransferTargetRef
  }
  | {
    readonly status: 'failed'
    readonly source: { readonly name: string }
    readonly error: { readonly code: string; readonly message: string }
  }

/** Safe scope label returned to a browser after a transfer. */
export interface UserDocTransferScopeSummary {
  readonly kind: 'personal' | 'project'
  readonly label: string
}

/** Versioned cross-scope transfer response. */
export interface UserDocTransferResponse {
  readonly version: 1
  readonly transferId: string
  readonly source: UserDocTransferScopeSummary
  readonly target: UserDocTransferScopeSummary
  readonly items: readonly UserDocTransferItem[]
}

/** Safe scope capability advertised by a Gateway-backed document runtime. */
export interface UserDocTransferCapability {
  readonly scope: UserDocScope
  readonly label: string
  readonly canRead: boolean
  readonly canWrite: boolean
}

/** Versioned cross-scope capability response. */
export interface UserDocTransferCapabilities {
  readonly version: 1
  readonly current: UserDocTransferScopeSummary
  readonly targets: readonly UserDocTransferCapability[]
}

/** Safe document row returned when browsing an authorized alternate scope. */
export type UserDocTransferListedDocument = UserDocTransferTargetRef

/** Versioned alternate-scope document listing. */
export interface UserDocTransferListResponse {
  readonly version: 1
  readonly scope: UserDocTransferScopeSummary
  readonly documents: readonly UserDocTransferListedDocument[]
}

/** Exact model-facing representation frozen when a document prompt is admitted. */
export type UserDocPromptRepresentation =
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'path' }

/** One document snapshot carried with a queued prompt until it enters the Session log. */
export interface UserDocPromptAttachment {
  /** Metadata observed while the Host admitted the prompt. */
  readonly ref: UserDocRef
  /** Inline text when the byte and UTF-8 policy admitted it; otherwise path-only. */
  readonly representation: UserDocPromptRepresentation
}
