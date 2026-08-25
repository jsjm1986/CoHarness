/** User-document identifier brand. @module @deepseek-ai/dsh-userdoc/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identifier for one document a user uploaded.
 *
 * Structurally the POSIX-style path of the document relative to the document
 * root (`reports/annual.pdf`), which makes the filesystem itself the index
 * and keeps no sidecar database to fall out of step with the files on disk.
 * Consumers MUST treat it as opaque: it is not a usable filesystem path, and
 * every implementation re-derives and re-validates the absolute path from it,
 * so an id that escapes the document root is refused rather than resolved.
 */
export type UserDocId = Branded<'UserDocId'>

/**
 * Opaque POSIX-style path of one directory relative to the document root.
 * The empty value identifies the root itself; every other value is validated
 * by the store before it reaches the filesystem.
 */
export type UserDocDirectoryId = Branded<'UserDocDirectoryId'>

/** Opaque identifier for one resumable document upload session. */
export type UserDocUploadId = Branded<'UserDocUploadId'>

/**
 * Brand a backend-produced document identifier.
 * @param value - relative POSIX-style identifier produced by the store.
 * @returns the branded identifier.
 */
export function UserDocId(value: string): UserDocId {
  return value as UserDocId
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
