/** User-document identifier brand. @module @deepseek-ai/dsh-userdoc/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Durable identity of one document root's metadata domain. */
export type UserDocRootId = Branded<'UserDocRootId'>

/**
 * Brand a provider-allocated document root UUID.
 * @param value - UUID retained by the root metadata database.
 * @returns the same value branded as a document root id.
 */
export function UserDocRootId(value: string): UserDocRootId { return value as UserDocRootId }

/**
 * Opaque identifier for one document a user uploaded.
 *
 * Structurally the POSIX-style path of the document relative to the document
 * root (`reports/annual.pdf`). Publication identity and ownership are separate
 * from this mutable file address.
 * Consumers MUST treat it as opaque: it is not a usable filesystem path, and
 * every implementation re-derives and re-validates the absolute path from it,
 * so an id that escapes the document root is refused rather than resolved.
 */
export type UserDocId = Branded<'UserDocId'>

/** Durable identity of one document, independent of its current filesystem path. */
export type UserDocIncarnationId = Branded<'UserDocIncarnationId'>

/** Identity of one recoverable-trash action, independent of its original path. */
export type UserDocTrashId = Branded<'UserDocTrashId'>

/**
 * Opaque POSIX-style path of one directory relative to the document root.
 * The empty value identifies the root itself; every other value is validated
 * by the store before it reaches the filesystem.
 */
export type UserDocDirectoryId = Branded<'UserDocDirectoryId'>

/** Opaque identifier for one resumable document upload session. */
export type UserDocUploadId = Branded<'UserDocUploadId'>

/** Server-authenticated document actor key used by private uploads and retained as the original publication actor. */
export type UserDocUploadOwnerId = Branded<'UserDocUploadOwnerId'>

/**
 * Brand a backend-produced document identifier.
 * @param value - relative POSIX-style identifier produced by the store.
 * @returns the branded identifier.
 */
export function UserDocId(value: string): UserDocId {
  return value as UserDocId
}

/**
 * Brand a provider-produced document incarnation.
 * @param value - UUID persisted by the document provider.
 * @returns the document incarnation identity.
 */
export function UserDocIncarnationId(value: string): UserDocIncarnationId {
  return value as UserDocIncarnationId
}

/**
 * Brand a provider-produced trash action.
 * @param value - UUID persisted with the trash action.
 * @returns the trash identity.
 */
export function UserDocTrashId(value: string): UserDocTrashId {
  return value as UserDocTrashId
}

/**
 * Brand a backend-produced directory identifier.
 * @param value - relative POSIX-style directory identifier produced by the store.
 * @returns the branded identifier.
 */
export function UserDocDirectoryId(value: string): UserDocDirectoryId {
  return value as UserDocDirectoryId
}

/**
 * Brand a backend-produced resumable upload identifier.
 * @param value - identifier produced by the upload store.
 * @returns the branded identifier.
 */
export function UserDocUploadId(value: string): UserDocUploadId {
  return value as UserDocUploadId
}

/**
 * Brand an authenticated actor key; browser metadata cannot supply this value.
 * @param value - stable actor identity from the owning server context.
 * @returns the upload owner identity.
 */
export function UserDocUploadOwnerId(value: string): UserDocUploadOwnerId {
  return value as UserDocUploadOwnerId
}
