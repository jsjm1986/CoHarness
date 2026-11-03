/** Real-file document storage below one runtime-owned document root. */

import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, link, mkdir, open, readdir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises'
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
  DOCUMENT_UPLOAD_SIZE_CODE,
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
import { writeAll } from './write.ts'
import { withDocumentHandle } from './handle.ts'
import { consumeDocumentBody } from './body.ts'
import { withRootedDocumentPaths } from './rooted-fs.ts'
import { withDocumentDirectoryMove } from './directory-move.ts'
import {
  assertInside,
  assertNestedDirectories,
  assertPublicDirectory,
  directoryIdFor,
  docIdFor,
  parentDirectoryId,
  pathForDirectoryId,
  pathForDocId,
  resolveTargetIn,
  sanitizeDirectoryName,
  isDocumentPartial,
  isPrivateRootName,
} from './name.ts'

const PARTIAL_SUFFIX = '.part'
const LIST_METADATA_CONCURRENCY = 8
/* v8 ignore next -- the fallback runs only on platforms whose fs constants omit O_NOFOLLOW. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- O_NOFOLLOW is absent on platforms that do not expose the flag.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
/* v8 ignore next -- platforms without POSIX nonblocking opens do not expose named pipes through this flag. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- some supported platforms omit O_NONBLOCK.
const NONBLOCK = constants.O_NONBLOCK ?? 0

async function assertRealParent(root: string, path: string, privateSource = false): Promise<void> {
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(root),
    realpath(dirname(path)),
  ])
  assertInside(canonicalRoot, canonicalParent)
  await assertNestedDirectories(root, dirname(path), DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
  if (!privateSource) await assertPublicDirectory(root, dirname(path), INVALID_DOCUMENT_REF_CODE)
}

async function openDocument(root: string, path: string, privateSource = false) {
  let handle: FileHandle | undefined
  try {
    if (resolve(path) !== resolve(root)) await assertRealParent(root, path, privateSource)
    const info = await withRootedDocumentPaths(root, [path], async (rooted) => {
      const filePath = rooted.paths[0]
      if (filePath === undefined) throw new Error('Document path is missing.')
      const entry = await lstat(filePath)
      if (entry.isSymbolicLink() || !entry.isFile()) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
      handle = await open(filePath, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
      const opened = await handle.stat()
      if (!opened.isFile()) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
      await rooted.verify()
      return opened
    })
    if (handle === undefined) throw new Error('Document file handle was not opened.')
    return { handle, info }
  } catch (error) {
    let failure = error
    if (handle !== undefined) {
      try { await handle.close() } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], 'Document open and handle cleanup failed.')
      }
    }
    if (failure === error && error instanceof UserDocError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (failure === error && (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR')) {
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: failure })
  }
}

async function directoryInfo(root: string, path: string): Promise<Stats> {
  try {
    if (resolve(path) !== resolve(root)) await assertRealParent(root, path)
    return await withRootedDocumentPaths(root, [path], async (rooted) => {
      const directoryPath = rooted.paths[0]
      if (directoryPath === undefined) throw new Error('Document directory path is missing.')
      const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(path)])
      assertInside(canonicalRoot, canonicalDirectory)
      const entry = resolve(path) === resolve(root)
        ? await stat(directoryPath)
        : await lstat(directoryPath)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new UserDocError('Document directory not found.', DOCUMENT_DIRECTORY_NOT_FOUND_CODE)
      }
      await assertPublicDirectory(root, path, INVALID_DOCUMENT_DIRECTORY_CODE)
      await rooted.verify()
      return entry
    })
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

async function exists(root: string, path: string): Promise<boolean> {
  try {
    return await withRootedDocumentPaths(root, [path], async (rooted) => {
      const filePath = rooted.paths[0]
      if (filePath === undefined) throw new Error('Document path is missing.')
      await lstat(filePath)
      await rooted.verify()
      return true
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const value = values[index]
      if (value === undefined) return
      results[index] = await operation(value)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

/**
 * Resolve where one upload will land inside an existing directory. The legacy
 * `(root, name, date)` call form still creates a UTC date directory; the current
 * `(root, directoryId, name)` form writes to an existing user directory.
 * @param root - absolute document root.
 * @param directoryId - destination directory identifier, or the legacy file name.
 * @param nameOrDate - client-supplied file name, or the legacy date value.
 * @param reserved - document names held by active uploads under the admission lock.
 * @returns the resolved target.
 */
export async function resolveDocTarget(
  root: string,
  directoryId: UserDocDirectoryId | string,
  nameOrDate: string | Date,
  reserved?: ReadonlySet<UserDocId>,
): Promise<UserDocTarget> {
  const taken = async (path: string): Promise<boolean> => reserved?.has(docIdFor(root, path)) === true || await exists(root, path)
  if (nameOrDate instanceof Date) {
    const directory = resolve(join(root, dayDirectory(nameOrDate)))
    await mkdir(root, { recursive: true, mode: 0o700 })
    await assertPublicDirectory(root, root, INVALID_DOCUMENT_REF_CODE)
    await withRootedDocumentPaths(root, [directory], async (rooted) => {
      const path = rooted.paths[0]
      if (path === undefined) throw new Error('Document directory path is missing.')
      await mkdir(path, { recursive: true, mode: 0o700 })
      await rooted.verify()
    })
    return resolveTargetIn(root, directory, directoryId, taken)
  }
  const directory = pathForDirectoryId(root, directoryId)
  await directoryInfo(root, directory)
  return resolveTargetIn(root, directory, nameOrDate, taken)
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
 * Linux retains parent descriptors from staging creation through owned cleanup.
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
  await directoryInfo(root, dirname(target.path))
  await assertRealParent(root, target.path)
  const partial = join(dirname(target.path), `.userdoc-${randomBytes(12).toString('hex')}${PARTIAL_SUFFIX}`)
  let bytes = 0
  try {
    await withRootedDocumentPaths(root, [partial, target.path], async (rooted) => {
      const source = rooted.paths[0], destination = rooted.paths[1]
      if (source === undefined || destination === undefined) throw new Error('Document publication path is missing.')
      let ownsPartial = false, partialInfo: Stats | undefined
      try {
        await rooted.verify()
        const handle = await open(source, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600)
        ownsPartial = true
        await withDocumentHandle(handle, async () => {
          await consumeDocumentBody(body, async (value) => {
            bytes += value.byteLength
            if (limits.maxFileBytes !== null && bytes > limits.maxFileBytes) {
              throw new UserDocError('Document exceeds the configured byte limit.', DOCUMENT_TOO_LARGE_CODE)
            }
            await writeAll(handle, value, null, signal)
          }, signal)
          signal?.throwIfAborted()
          await handle.sync()
          partialInfo = await handle.stat()
        })
        await assertRealParent(root, target.path)
        signal?.throwIfAborted()
        const sourceInfo = await lstat(source)
        if (partialInfo === undefined || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()
          || sourceInfo.dev !== partialInfo.dev || sourceInfo.ino !== partialInfo.ino) {
          throw new UserDocError('The uploaded document changed before publication.', DOCUMENT_NOT_FOUND_CODE)
        }
        try { await link(source, destination) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new UserDocError('Document target became occupied before publication.', DOCUMENT_TARGET_CONFLICT_CODE)
          }
          throw error
        }
        try { await rooted.verify() } catch (error) {
          try { await rooted.unlink(1) } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Document publication and rollback failed.')
          }
          throw error
        }
        await rooted.unlink(0)
        ownsPartial = false
      } catch (error) {
        let failure = error
        if (ownsPartial) {
          try { await rooted.unlink(0) } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
              failure = new AggregateError([error, cleanupError], 'Document save and partial cleanup failed.')
            }
          }
        }
        throw failure
      }
    })
  } catch (error) {
    if (error instanceof UserDocError) throw error
    if (signal?.aborted === true && error === signal.reason) throw error
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
 * Publish a fully verified resumable-upload partial file without copying its
 * bytes or replacing an existing document.
 * @param root - absolute document root.
 * @param target - sanitized target resolved by this store.
 * @param partialPath - private partial file below `partialRoot` on the document filesystem.
 * @param bytes - expected byte count.
 * @param expectedSha256 - final digest used to recover a publication committed before a crash.
 * @param partialRoot - authorized private source root; omitted uses the document root.
 * @returns the durable public document reference.
 */
export async function publishDocPartial(
  root: string,
  target: UserDocTarget,
  partialPath: string,
  bytes: number,
  expectedSha256?: string,
  partialRoot = root,
): Promise<UserDocRef> {
  assertInside(root, target.path)
  assertInside(partialRoot, partialPath)
  await assertRealParent(root, target.path)

  // A process can stop after the hard link is committed but before the
  // session manifest is replaced. On restart the private partial may already
  // be gone; recover the published target only when its complete bytes match
  // the final digest recorded by the session.
  const existing = async (): Promise<UserDocRef | undefined> => {
    let published
    try {
      published = await openDocument(root, target.path)
    } catch (error) {
      if (error instanceof UserDocError && error.code === DOCUMENT_NOT_FOUND_CODE) return undefined
      throw error
    }
    try {
      if (published.info.size !== bytes) return undefined
      if (expectedSha256 !== undefined && await digestHandle(published.handle) !== expectedSha256) return undefined
      return documentRef(root, target.path, published.info)
    } finally {
      await published.handle.close()
    }
  }

  let partial
  try {
    partial = await openDocument(partialRoot, partialPath, true)
  } catch (error) {
    if (error instanceof UserDocError && error.code === DOCUMENT_NOT_FOUND_CODE) {
      const recovered = await existing()
      if (recovered !== undefined) return recovered
    }
    throw error
  }
  const partialInfo = partial.info
  try {
    if (partial.info.size !== bytes) {
      throw new UserDocError('The resumable upload size does not match its manifest.', DOCUMENT_UPLOAD_SIZE_CODE)
    }
  } finally {
    await partial.handle.close()
  }
  try {
    await withRootedDocumentPaths(partialRoot, [partialPath], async (sourcePaths) => {
      await withRootedDocumentPaths(root, [target.path], async (targetPaths) => {
        const source = sourcePaths.paths[0], destination = targetPaths.paths[0]
        if (source === undefined || destination === undefined) throw new Error('Document publication path is missing.')
        const sourceInfo = await lstat(source)
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()
          || sourceInfo.dev !== partialInfo.dev || sourceInfo.ino !== partialInfo.ino) {
          throw new UserDocError('The resumable upload changed before publication.', DOCUMENT_NOT_FOUND_CODE)
        }
        await link(source, destination)
        try {
          await sourcePaths.verify()
          await targetPaths.verify()
        } catch (error) {
          try { await targetPaths.unlink(0) } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Document publication and rollback failed.')
          }
          throw error
        }
        await sourcePaths.unlink(0)
      })
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const recovered = await existing()
      if (recovered !== undefined) {
        await unlink(partialPath).catch(() => {})
        return recovered
      }
      throw new UserDocError('Document target became occupied before publication.', DOCUMENT_TARGET_CONFLICT_CODE)
    }
    throw new UserDocError('Unable to publish the uploaded document.', DOCUMENT_WRITE_FAILED_CODE, { cause: error })
  }
  // The hard link is the publication commit. A best-effort cleanup keeps a
  // transient unlink failure from turning a successfully published document
  // into a failed session; the session cleanup sweep removes the private
  // directory later.
  const published = await openDocument(root, target.path)
  await published.handle.close()
  return documentRef(root, target.path, published.info)
}

/** Hash an already-open regular file without buffering the document. */
async function digestHandle(handle: import('node:fs/promises').FileHandle): Promise<string> {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  for (;;) {
    const result = await handle.read(buffer, 0, buffer.byteLength, position)
    if (result.bytesRead === 0) break
    digest.update(buffer.subarray(0, result.bytesRead))
    position += result.bytesRead
  }
  return digest.digest('hex')
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
      await assertPublicDirectory(root, directory, INVALID_DOCUMENT_DIRECTORY_CODE)
      entries = await withRootedDocumentPaths(root, [directory], async (rooted) => {
        const path = rooted.paths[0]
        if (path === undefined) throw new Error('Document directory path is missing.')
        const listed = await readdir(path, { withFileTypes: true })
        await rooted.verify()
        return listed
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof UserDocError) throw error
      throw new UserDocError('Unable to list stored documents.', DOCUMENT_READ_FAILED_CODE, { cause: error })
    }
    const files = entries.filter(entry => entry.isFile() && !isDocumentPartial(entry.name)
      && (directory !== resolve(root) || !isPrivateRootName(entry.name)))
    const listed = await mapConcurrent(files, LIST_METADATA_CONCURRENCY, async (entry) => {
      const path = join(directory, entry.name)
      const { handle, info } = await openDocument(root, path)
      await handle.close()
      return documentRef(root, path, info)
    })
    refs.push(...listed)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (directory === resolve(root) && isPrivateRootName(entry.name)) continue
      pending.push(join(directory, entry.name))
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
    const entries = (await withRootedDocumentPaths(root, [directory], async (rooted) => {
      const path = rooted.paths[0]
      if (path === undefined) throw new Error('Document directory path is missing.')
      const listed = await readdir(path, { withFileTypes: true })
      await rooted.verify()
      return listed
    })).filter((entry) => {
      signal?.throwIfAborted()
      return !(directoryId === '' && isPrivateRootName(entry.name))
    })
    const directoryEntries = entries.filter(entry => entry.isDirectory())
    const fileEntries = entries.filter(entry => entry.isFile() && !isDocumentPartial(entry.name))
    const listedDirectories = await mapConcurrent(directoryEntries, LIST_METADATA_CONCURRENCY, async (entry) => {
      const path = join(directory, entry.name)
      return directoryRef(root, path, await directoryInfo(root, path))
    })
    const listedDocuments = await mapConcurrent(fileEntries, LIST_METADATA_CONCURRENCY, async (entry) => {
      const path = join(directory, entry.name)
      const { handle, info } = await openDocument(root, path)
      await handle.close()
      return documentRef(root, path, info)
    })
    directories.push(...listedDirectories)
    documents.push(...listedDocuments)
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
    await assertPublicDirectory(root, directory, INVALID_DOCUMENT_DIRECTORY_CODE)
    const entries = await withRootedDocumentPaths(root, [directory], async (rooted) => {
      const path = rooted.paths[0]
      if (path === undefined) throw new Error('Document directory path is missing.')
      const listed = await readdir(path, { withFileTypes: true })
      await rooted.verify()
      return listed
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (directory === resolve(root) && isPrivateRootName(entry.name)) continue
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
  const leaf = sanitizeDirectoryName(name)
  if (parentId === '' && isPrivateRootName(leaf)) {
    throw new UserDocError('Document directory name is reserved.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  const path = resolve(join(parent, leaf))
  assertInside(root, path)
  try {
    await withRootedDocumentPaths(root, [path], async (rooted) => {
      const directoryPath = rooted.paths[0]
      if (directoryPath === undefined) throw new Error('Document directory path is missing.')
      await mkdir(directoryPath, { mode: 0o700 })
      try { await rooted.verify() } catch (error) {
        try { await rooted.rmdir(0) } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Document directory creation and rollback failed.')
        }
        throw error
      }
    })
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
  const leaf = sanitizeDirectoryName(name)
  if (dirname(source) === resolve(root) && isPrivateRootName(leaf)) {
    throw new UserDocError('Document directory name is reserved.', INVALID_DOCUMENT_DIRECTORY_CODE)
  }
  const target = resolve(join(dirname(source), leaf))
  assertInside(root, target)
  if (source === target) return directoryRef(root, source, await directoryInfo(root, source))
  if (await exists(root, target)) {
    throw new UserDocError('Document directory already exists.', DOCUMENT_DIRECTORY_CONFLICT_CODE)
  }
  try {
    await withDocumentDirectoryMove(root, source, target, async (move) => {
      await move.rename()
      await move.verify()
    })
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
    await withRootedDocumentPaths(root, [path], async (rooted) => {
      await rooted.rmdir(0)
      await rooted.verify()
    })
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
 * A failed source restoration retains the destination for recovery.
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
  try {
    await assertRealParent(root, target)
    await withRootedDocumentPaths(root, [source, target], async (rooted) => {
      const sourcePath = rooted.paths[0], targetPath = rooted.paths[1]
      if (sourcePath === undefined || targetPath === undefined) throw new Error('Document move path is missing.')
      const currentSource = await lstat(sourcePath)
      if (!currentSource.isFile() || currentSource.isSymbolicLink()
        || currentSource.dev !== info.dev || currentSource.ino !== info.ino) {
        throw new UserDocError('The source document changed before it was moved.', DOCUMENT_NOT_FOUND_CODE)
      }
      await link(sourcePath, targetPath)
      let sourceRemoved = false
      try {
        await rooted.verify()
        await rooted.unlink(0)
        sourceRemoved = true
        await rooted.verify()
      } catch (error) {
        let failure = error
        if (sourceRemoved) {
          try { await link(targetPath, sourcePath) } catch (restoreError) {
            // The target is the remaining copy when restoring the source fails.
            throw new AggregateError([failure, restoreError], 'Document move and source restoration failed.')
          }
        }
        try { await rooted.unlink(1) } catch (cleanupError) {
          failure = new AggregateError([failure, cleanupError], 'Document move and destination rollback failed.')
        }
        throw failure
      }
    })
    const { handle: moved, info: movedInfo } = await openDocument(root, target)
    await moved.close()
    return documentRef(root, target, movedInfo)
  } catch (error) {
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
    return await withDocumentHandle(handle, async () => {
      let data: Buffer
      try { data = await handle.readFile(signal === undefined ? undefined : { signal }) } catch (error) {
        signal?.throwIfAborted()
        throw error
      }
      return { ref, data: new Uint8Array(data) }
    })
  } catch (error) {
    if (signal?.aborted === true && error === signal.reason) throw error
    throw new UserDocError('Unable to read the stored document.', DOCUMENT_READ_FAILED_CODE, { cause: error })
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
  let entry
  try {
    entry = await withRootedDocumentPaths(root, [path], async (rooted) => {
      const filePath = rooted.paths[0]
      if (filePath === undefined) throw new Error('Document path is missing.')
      const found = await lstat(filePath)
      await rooted.verify()
      return found
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UserDocError('Unable to delete the stored document.', DOCUMENT_DELETE_FAILED_CODE, { cause: error })
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
  }
  signal?.throwIfAborted()
  await assertRealParent(root, path)
  try {
    await withRootedDocumentPaths(root, [path], async (rooted) => {
      await rooted.unlink(0)
      await rooted.verify()
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UserDocError('Unable to delete the stored document.', DOCUMENT_DELETE_FAILED_CODE, { cause: error })
  }
}
