/** Real-file document storage below one runtime-owned document root. */

import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, link, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  DOCUMENT_DELETE_FAILED_CODE,
  DOCUMENT_DIRECTORY_CONFLICT_CODE,
  DOCUMENT_DIRECTORY_NOT_EMPTY_CODE,
  DOCUMENT_DIRECTORY_NOT_FOUND_CODE,
  DOCUMENT_DIRECTORY_WRITE_FAILED_CODE,
  DOCUMENT_MOVE_FAILED_CODE,
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_READ_FAILED_CODE,
  DOCUMENT_TARGET_CONFLICT_CODE,
  DOCUMENT_TOO_LARGE_CODE,
  DOCUMENT_WRITE_FAILED_CODE,
  INVALID_DOCUMENT_DIRECTORY_CODE,
  INVALID_DOCUMENT_REF_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import type {
  StoredUserDoc,
  UserDocDirectoryId,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocId,
  UserDocLimits,
  UserDocRef,
  UserDocTarget,
} from '@deepseek-ai/dsh-userdoc'
import { mediaTypeFor } from './media-type.ts'
import {
  assertInside,
  directoryIdFor,
  docIdFor,
  parentDirectoryId,
  pathForDirectoryId,
  pathForDocId,
  resolveTargetIn,
  sanitizeDirectoryName,
} from './name.ts'

const PARTIAL_SUFFIX = '.part'
/* v8 ignore next -- the fallback runs only on platforms whose fs constants omit O_NOFOLLOW. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- O_NOFOLLOW is absent on platforms that do not expose the flag.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function assertRealParent(root: string, path: string): Promise<void> {
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(root),
    realpath(dirname(path)),
  ])
  assertInside(canonicalRoot, canonicalParent)
}

async function openDocument(root: string, path: string) {
  try {
    await assertRealParent(root, path)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close()
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    return { handle, info }
  } catch (error) {
    if (error instanceof UserDocError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') {
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  }
}

async function directoryInfo(root: string, path: string): Promise<Stats> {
  try {
    const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(path)])
    assertInside(canonicalRoot, canonicalDirectory)
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new UserDocError('Document directory not found.', DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
    }
    return entry
  } catch (error) {
    if (error instanceof UserDocError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') {
      throw new UserDocError('Document directory not found.', DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to read the document directory.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  }
}

function documentRef(root: string, path: string, info: Pick<Stats, 'size' | 'mtimeMs'>): UserDocRef {
  const name = basename(path)
  return {
    docId: docIdFor(root, path),
    path,
    name,
    bytes: info.size,
    mediaType: mediaTypeFor(name),
    modifiedAt: info.mtimeMs,
  }
}

function directoryRef(root: string, path: string, info: Pick<Stats, 'mtimeMs'>): UserDocDirectoryRef {
  return {
    directoryId: directoryIdFor(root, path),
    path,
    name: basename(path),
    modifiedAt: info.mtimeMs,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Resolve where one upload will land inside an existing directory. The legacy
 * `(root, name, date)` call form still creates a UTC date directory; the current
 * `(root, directoryId, name)` form writes to an existing user directory.
 * @param root - absolute document root.
 * @param directoryId - destination directory identifier, or the legacy file name.
 * @param nameOrDate - client-supplied file name, or the legacy date value.
 * @returns the resolved target.
 */
export async function resolveDocTarget(
  root: string,
  directoryId: UserDocDirectoryId | string,
  nameOrDate: string | Date,
): Promise<UserDocTarget> {
  if (nameOrDate instanceof Date) {
    const directory = resolve(join(root, dayDirectory(nameOrDate)))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return resolveTargetIn(root, directory, directoryId, exists)
  }
  const directory = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, directory)
  return resolveTargetIn(root, directory, nameOrDate, exists)
}

/**
 * Format a UTC date as the legacy upload directory name.
 * @param now - date to format.
 * @returns a `YYYY-MM-DD` directory name.
 */
export function dayDirectory(now: Date): string {
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
}

/**
 * Stream one document to its resolved target and publish it atomically.
 * @param root - absolute document root, re-proved before the write.
 * @param target - resolved write target.
 * @param body - upload byte stream.
 * @param limits - resolved storage policy.
 * @param signal - optional cancellation.
 * @returns the durable reference.
 */
export async function saveDocFile(
  root: string,
  target: UserDocTarget,
  body: ReadableStream<Uint8Array>,
  limits: UserDocLimits,
  signal?: AbortSignal,
): Promise<UserDocRef> {
  signal?.throwIfAborted()
  assertInside(root, target.path)
  if (pathForDocId(root, String(target.docId)) !== resolve(target.path)
    || basename(target.path) !== target.name) {
    throw new UserDocError('Resolved document target is inconsistent.', INVALID_DOCUMENT_REF_CODE)
  }
  await mkdir(dirname(target.path), { recursive: true, mode: 0o700 })
  await directoryInfo(root, dirname(target.path))
  await assertRealParent(root, target.path)
  const partial = join(dirname(target.path), `.userdoc-${randomBytes(12).toString('hex')}${PARTIAL_SUFFIX}`)
  let handle
  let bytes = 0
  try {
    handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
    const reader = body.getReader()
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > limits.maxFileBytes) {
          throw new UserDocError('Document exceeds the configured byte limit.', DOCUMENT_TOO_LARGE_CODE)
        }
        await handle.write(value)
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await assertRealParent(root, target.path)
    try {
      await link(partial, target.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UserDocError('Document target became occupied before publication.', DOCUMENT_TARGET_CONFLICT_CODE)
      }
      throw error
    }
    await unlink(partial)
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(
        /* v8 ignore next -- a close failure is superseded by the write failure that entered cleanup. */
        () => {},
      )
    }
    await unlink(partial).catch(
      /* v8 ignore next -- best-effort cleanup of a partial file a failed open never created. */
      () => {},
    )
    if (error instanceof UserDocError) throw error
    signal?.throwIfAborted()
    throw new UserDocError('Unable to store the uploaded document.', DOCUMENT_WRITE_FAILED_CODE, { cause: error })
  }
  const { handle: published, info } = await openDocument(root, target.path)
  await published.close()
  return {
    docId: target.docId,
    path: target.path,
    name: target.name,
    bytes,
    mediaType: mediaTypeFor(target.name),
    modifiedAt: info.mtimeMs,
  }
}

/**
 * List every stored document below the document root, newest first.
 * @param root - absolute document root.
 * @param signal - optional cancellation.
 * @returns every regular document reference.
 */
export async function listDocFiles(root: string, signal?: AbortSignal): Promise<UserDocRef[]> {
  signal?.throwIfAborted()
  const refs: UserDocRef[] = []
  const pending = [resolve(root)]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const directory = pending.pop() as string
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new UserDocError('Unable to list stored documents.', DOCUMENT_READ_FAILED_CODE, { cause: error })
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile() || entry.name.endsWith(PARTIAL_SUFFIX)) continue
      const { handle, info } = await openDocument(root, path)
      await handle.close()
      refs.push(documentRef(root, path, info))
    }
  }
  return refs.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/**
 * List one directory's immediate children.
 * @param root - absolute document root.
 * @param directoryId - directory to inspect.
 * @param signal - optional cancellation.
 * @returns the immediate directory listing.
 */
export async function listDocDirectory(
  root: string,
  directoryId: UserDocDirectoryId,
  signal?: AbortSignal,
): Promise<UserDocDirectoryListing> {
  signal?.throwIfAborted()
  const directory = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, directory)
  const directories: UserDocDirectoryRef[] = []
  const documents: UserDocRef[] = []
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        directories.push(directoryRef(root, path, await directoryInfo(root, path)))
        continue
      }
      if (!entry.isFile() || entry.name.endsWith(PARTIAL_SUFFIX)) continue
      const { handle, info } = await openDocument(root, path)
      await handle.close()
      documents.push(documentRef(root, path, info))
    }
  } catch (error) {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Unable to list the document directory.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  }
  directories.sort((left, right) => left.name.localeCompare(right.name))
  documents.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const parent = parentDirectoryId(directoryId)
  return {
    directoryId,
    ...(parent === undefined ? {} : { parentDirectoryId: parent }),
    directories,
    documents,
  }
}

/**
 * List every directory below the document root.
 * @param root - absolute document root.
 * @param signal - optional cancellation.
 * @returns all non-root directory references.
 */
export async function listDocDirectories(root: string, signal?: AbortSignal): Promise<UserDocDirectoryRef[]> {
  signal?.throwIfAborted()
  await directoryInfo(root, root)
  const directories: UserDocDirectoryRef[] = []
  const pending = [root]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const directory = pending.pop() as string
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      const ref = directoryRef(root, path, await directoryInfo(root, path))
      directories.push(ref)
      pending.push(path)
    }
  }
  return directories.sort((left, right) => String(left.directoryId).localeCompare(String(right.directoryId)))
}

/**
 * Create one directory below an existing parent.
 * @param root - absolute document root.
 * @param parentId - parent directory identifier.
 * @param name - untrusted directory leaf name.
 * @returns the created directory reference.
 */
export async function createDocDirectory(
  root: string,
  parentId: UserDocDirectoryId,
  name: string,
): Promise<UserDocDirectoryRef> {
  const parent = pathForDirectoryId(root, parentId)
  await directoryInfo(root, parent)
  const path = resolve(join(parent, sanitizeDirectoryName(name)))
  assertInside(root, path)
  try {
    await mkdir(path, { mode: 0o700 })
    return directoryRef(root, path, await directoryInfo(root, path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new UserDocError('Document directory already exists.', DOCUMENT_DIRECTORY_CONFLICT_CODE)
    }
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Unable to create the document directory.', DOCUMENT_DIRECTORY_WRITE_FAILED_CODE, {
      cause: error,
    })
  }
}

/**
 * Rename one non-root directory within its current parent.
 * @param root - absolute document root.
 * @param directoryId - directory identifier to rename.
 * @param name - untrusted replacement directory leaf name.
 * @returns the renamed directory reference.
 */
export async function renameDocDirectory(
  root: string,
  directoryId: UserDocDirectoryId,
  name: string,
): Promise<UserDocDirectoryRef> {
  if (directoryId === '') {
    throw new UserDocError('The document root cannot be renamed.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  const source = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, source)
  const target = resolve(join(dirname(source), sanitizeDirectoryName(name)))
  assertInside(root, target)
  if (source === target) return directoryRef(root, source, await directoryInfo(root, source))
  if (await exists(target)) {
    throw new UserDocError('Document directory already exists.', DOCUMENT_DIRECTORY_CONFLICT_CODE)
  }
  try {
    await rename(source, target)
    return directoryRef(root, target, await directoryInfo(root, target))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new UserDocError('Document directory already exists.', DOCUMENT_DIRECTORY_CONFLICT_CODE)
    }
    if (code === 'ENOENT') {
      throw new UserDocError('Document directory not found.', DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to rename the document directory.', DOCUMENT_DIRECTORY_WRITE_FAILED_CODE, {
      cause: error,
    })
  }
}

/**
 * Delete one empty, non-root directory.
 * @param root - absolute document root.
 * @param directoryId - directory identifier to delete.
 * @returns completion after the directory is removed.
 */
export async function removeDocDirectory(root: string, directoryId: UserDocDirectoryId): Promise<void> {
  if (directoryId === '') {
    throw new UserDocError('The document root cannot be deleted.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  const path = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, path)
  try {
    await rmdir(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new UserDocError('Document directory is not empty.', DOCUMENT_DIRECTORY_NOT_EMPTY_CODE)
    }
    if (code === 'ENOENT') {
      throw new UserDocError('Document directory not found.', DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to delete the document directory.', DOCUMENT_DIRECTORY_WRITE_FAILED_CODE, {
      cause: error,
    })
  }
}

/**
 * Move one document into an existing directory without replacing a target.
 * @param root - absolute document root.
 * @param docId - document identifier to move.
 * @param directoryId - destination directory identifier.
 * @returns the moved document reference.
 */
export async function moveDocFile(
  root: string,
  docId: UserDocId,
  directoryId: UserDocDirectoryId,
): Promise<UserDocRef> {
  const source = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, source)
  await handle.close()
  const directory = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, directory)
  const target = resolve(join(directory, basename(source)))
  assertInside(root, target)
  if (source === target) return documentRef(root, source, info)
  let published = false
  try {
    await assertRealParent(root, target)
    await link(source, target)
    published = true
    await unlink(source)
    const { handle: moved, info: movedInfo } = await openDocument(root, target)
    await moved.close()
    return documentRef(root, target, movedInfo)
  } catch (error) {
    if (published) await unlink(target).catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new UserDocError('A document with this name already exists in the destination.', DOCUMENT_DIRECTORY_CONFLICT_CODE)
    }
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Unable to move the document.', DOCUMENT_MOVE_FAILED_CODE, { cause: error })
  }
}

/**
 * Resolve one identifier to its current stored reference.
 * @param root - absolute document root.
 * @param docId - document identifier to inspect.
 * @param signal - optional cancellation for the filesystem probe.
 * @returns the current document reference.
 */
export async function statDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  await handle.close()
  return documentRef(root, path, info)
}

/**
 * Read one stored document in full.
 * @param root - absolute document root.
 * @param docId - document identifier to read.
 * @param signal - optional cancellation for the read.
 * @returns the stored bytes and reference.
 */
export async function readDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  const ref = documentRef(root, path, info)
  try {
    return { ref, data: new Uint8Array(await handle.readFile(signal === undefined ? undefined : { signal })) }
  } catch (error) {
    signal?.throwIfAborted()
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: error })
  } finally {
    await handle.close()
  }
}

/**
 * Open one stored document as a byte stream.
 * @param root - absolute document root.
 * @param docId - document identifier to open.
 * @returns the reference and its byte stream.
 */
export async function openDocFile(
  root: string,
  docId: UserDocId,
): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }> {
  const path = pathForDocId(root, docId)
  const { handle, info } = await openDocument(root, path)
  const ref = documentRef(root, path, info)
  return { ref, body: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array> }
}

/**
 * Delete one stored document idempotently.
 * @param root - absolute document root.
 * @param docId - document identifier to remove.
 * @param signal - optional cancellation for the deletion.
 * @returns completion after the entry is absent.
 */
export async function removeDocFile(root: string, docId: UserDocId, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const path = pathForDocId(root, docId)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UserDocError('Unable to delete the stored document.', DOCUMENT_DELETE_FAILED_CODE, { cause: error })
  }
}
