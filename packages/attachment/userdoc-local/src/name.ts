/** Upload-name sanitization and target resolution. */

import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DOCUMENT_NAME_EXHAUSTED_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_NAME_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
  UserDocDirectoryId,
  UserDocId,
} from '@deepseek-ai/dsh-userdoc'
import type { UserDocDirectoryId as UserDocDirectoryIdType, UserDocTarget } from '@deepseek-ai/dsh-userdoc'

/** Maximum bytes of a sanitized leaf name, the common filesystem limit. */
const MAX_NAME_BYTES = 255
const INTERNAL_UPLOAD_DIRECTORY = '.upload-sessions'
const INTERNAL_TRASH_DIRECTORY = '.dsh-trash'

/** Names a POSIX filesystem accepts as entries but which never denote a file. */
const RESERVED_NAMES = new Set(['', '.', '..'])

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return new TextDecoder().decode(encoded.subarray(0, maxBytes)).replace(/\uFFFD$/, '')
}

/**
 * Reduce untrusted client text to a leaf file name that cannot escape a
 * directory or carry control characters into a shell-visible path.
 *
 * Both separator styles are stripped by hand rather than through
 * `path.basename`: a POSIX host treats `\` as an ordinary filename character,
 * so `basename` alone would keep a Windows client's full local path and write
 * a file literally named `C:\Users\...`.
 * @param value - client-supplied name, treated as untrusted text.
 * @returns the sanitized leaf name.
 * @throws UserDocError with `INVALID_DOCUMENT_NAME` when nothing usable remains.
 */
export function sanitizeName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  // NUL would truncate the path at the syscall boundary; the other control
  // characters are legal POSIX filename bytes but make a path unquotable in
  // any terminal or log the operator later reads.
  const stripped = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  let clean = stripped
  // Truncate by bytes, not code units: the limit filesystems enforce is bytes,
  // and a multi-byte name (a Chinese document title) hits it at a quarter the
  // character count. Trailing partial sequences are dropped by the decoder.
  clean = truncateUtf8(clean, MAX_NAME_BYTES)
  // A name of only dots would resolve to this directory or its parent.
  if (RESERVED_NAMES.has(clean) || /^\.+$/.test(clean)) {
    throw new UserDocError('Upload name is not a usable file name.', INVALID_DOCUMENT_NAME_CODE)
  }
  return clean
}

/**
 * Reduce untrusted client text to one directory leaf.
 * @param value - client-supplied directory name.
 * @returns the sanitized leaf name.
 * @throws UserDocError with `INVALID_DOCUMENT_DIRECTORY` when nothing usable remains.
 */
export function sanitizeDirectoryName(value: string): string {
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = truncateUtf8(leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim(), MAX_NAME_BYTES)
  if (RESERVED_NAMES.has(clean) || /^\.+$/.test(clean)) {
    throw new UserDocError('Document directory name is invalid.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  return clean
}

/**
 * Split a leaf name into its stem and extension for collision suffixing, so a
 * second `report.pdf` becomes `report (2).pdf` rather than `report.pdf (2)`.
 * A leading dot is part of the stem, so `.env` keeps its whole name.
 */
function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension: name.slice(dot) }
}

/**
 * Add an occurrence suffix to a leaf name.
 * @param name - sanitized leaf name.
 * @param occurrence - one-based occurrence; 1 returns the name unchanged.
 * @returns the suffixed leaf name.
 */
export function suffixName(name: string, occurrence: number): string {
  if (occurrence === 1) return name
  const { stem, extension } = splitName(name)
  const suffix = ` (${String(occurrence)})`
  const reserved = new TextEncoder().encode(suffix + extension).byteLength
  return `${truncateUtf8(stem, Math.max(0, MAX_NAME_BYTES - reserved))}${suffix}${extension}`
}

/**
 * Prove a candidate path lies inside a root directory.
 *
 * Both sides are resolved first, and the comparison is on path segments (via a
 * relative walk) rather than string prefixes, so a sibling directory whose name
 * merely starts with the root's name is not mistaken for a child.
 * @param root - absolute containing directory.
 * @param candidate - absolute path to test.
 * @returns true when candidate is root itself or below it.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '') return true
  // An absolute result means the two paths share no root at all (separate
  // Windows drives), which is outside by definition.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Assert a path lies inside the document root.
 * @param root - absolute document root.
 * @param candidate - absolute path to test.
 * @throws UserDocError with `INVALID_DOCUMENT_REF` when the path escapes.
 */
export function assertInside(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new UserDocError('Document path lies outside the document root.', INVALID_DOCUMENT_REF_CODE)
  }
}

/**
 * Compose the store-scoped identifier for one stored path. The identifier is
 * the path relative to the document root with forward slashes, which keeps it
 * stable across platforms and readable in a session log, while carrying no
 * information about where the root itself lives.
 * @param root - absolute document root.
 * @param path - absolute path inside the root.
 * @returns the branded identifier.
 */
export function docIdFor(root: string, path: string): UserDocId {
  return UserDocId(relative(resolve(root), resolve(path)).split(sep).join('/'))
}

/**
 * Compose the store-scoped identifier for one directory.
 * @param root - absolute document root.
 * @param path - absolute directory at or below the root.
 * @returns the branded relative identifier; the root becomes an empty string.
 */
export function directoryIdFor(root: string, path: string): UserDocDirectoryIdType {
  assertInside(root, path)
  return UserDocDirectoryId(relative(resolve(root), resolve(path)).split(sep).join('/'))
}

function validRelativeSegments(value: string, allowRoot: boolean): string[] | undefined {
  if (value === '') return allowRoot ? [] : undefined
  const segments = value.split('/')
  // The provider's root-level maintenance directories are not user
  // documents. Keep them unreachable through an opaque id even when a caller
  // guesses the hidden name; nested user directories with the same leaf remain
  // ordinary entries.
  if (segments[0] === INTERNAL_UPLOAD_DIRECTORY || segments[0] === INTERNAL_TRASH_DIRECTORY) return undefined
  if (segments.every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && !segment.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(segment) && basename(segment) === segment)) return segments
  return undefined
}

/**
 * Resolve a store-scoped identifier back to an absolute path.
 *
 * The identifier is untrusted whenever it arrives from a client, so it is
 * rejected unless every segment is an ordinary name: a `..` segment, an
 * absolute spelling, or a Windows separator would otherwise let a caller name
 * a file outside the document root. Containment is re-proved after joining.
 * @param root - absolute document root.
 * @param docId - identifier as carried on the wire or in a session log.
 * @returns the absolute path inside the root.
 * @throws UserDocError with `INVALID_DOCUMENT_REF` when the identifier is malformed or escapes.
 */
export function pathForDocId(root: string, docId: string): string {
  const segments = validRelativeSegments(docId, false)
  if (segments === undefined) throw new UserDocError('Document identifier is invalid.', INVALID_DOCUMENT_REF_CODE)
  const path = resolve(join(resolve(root), ...segments))
  assertInside(root, path)
  return path
}

/**
 * Resolve a directory identifier to an absolute path below the document root.
 * @param root - absolute document root.
 * @param directoryId - store-scoped directory identifier; the empty value names the root.
 * @returns the absolute directory path.
 * @throws UserDocError with `INVALID_DOCUMENT_DIRECTORY` when the identifier is malformed.
 */
export function pathForDirectoryId(root: string, directoryId: string): string {
  const segments = validRelativeSegments(directoryId, true)
  if (segments === undefined) {
    throw new UserDocError('Document directory identifier is invalid.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  const path = resolve(join(resolve(root), ...segments))
  if (!isInside(root, path)) {
    throw new UserDocError('Document directory lies outside the document root.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  return path
}

/**
 * Resolve the parent identifier of one directory.
 * @param directoryId - validated store-scoped directory identifier.
 * @returns the parent identifier, or undefined for the root.
 */
export function parentDirectoryId(directoryId: UserDocDirectoryIdType): UserDocDirectoryIdType | undefined {
  if (directoryId === '') return undefined
  const segments = String(directoryId).split('/')
  segments.pop()
  return UserDocDirectoryId(segments.join('/'))
}

/**
 * Resolve one upload request to the exact path a save will create.
 * @param root - absolute document root.
 * @param directory - absolute directory inside the root that will hold the file.
 * @param name - client-supplied file name.
 * @param taken - whether a candidate leaf name already exists.
 * @returns the resolved target.
 * @throws UserDocError when the name is unusable or no free name is available.
 */
export async function resolveTargetIn(
  root: string,
  directory: string,
  name: string,
  taken: (path: string) => Promise<boolean>,
): Promise<UserDocTarget> {
  assertInside(root, directory)
  const clean = sanitizeName(name)
  if (resolve(directory) === resolve(root)
    && (clean === INTERNAL_UPLOAD_DIRECTORY || clean === INTERNAL_TRASH_DIRECTORY)) {
    throw new UserDocError('Document name is reserved by the document store.', INVALID_DOCUMENT_NAME_CODE)
  }
  // Bounded rather than unbounded: a caller repeatedly uploading one name is
  // either a client retry loop or an attempt to make this walk the expensive
  // part of a request, and both are better answered with a failure.
  for (let occurrence = 1; occurrence <= 1000; occurrence += 1) {
    const leaf = suffixName(clean, occurrence)
    const path = resolve(join(directory, leaf))
    // The sanitized leaf cannot contain a separator, so this re-proof is a
    // second fence rather than the only one.
    assertInside(root, path)
    if (!await taken(path)) return { path, name: leaf, docId: docIdFor(root, path) }
  }
  throw new UserDocError('Too many documents share this name.', DOCUMENT_NAME_EXHAUSTED_CODE)
}
