/** Recoverable trash; every operation refuses an invalid or incomplete recovery manifest. */

import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_RESTORE_CONFLICT_CODE,
  DOCUMENT_TRASH_NOT_FOUND_CODE,
  DOCUMENT_TRASHED_CODE,
  DOCUMENT_TRASH_CONFLICT_CODE,
  UserDocError,
  type UserDocDirectoryId,
  type UserDocId,
  type UserDocRef,
  type UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
import { assertNestedDirectories, docIdFor, isInside, pathForDirectoryId, pathForDocId, resolveTargetIn } from './name.ts'
import { mediaTypeFor } from './media-type.ts'
import { withRootedDocumentPaths } from './rooted-fs.ts'

const TRASH_DIRECTORY = '.dsh-trash'
const MANIFEST_NAME = 'manifest.json'
const MANIFEST_VERSION = 1

interface TrashRecord extends UserDocTrashRef {
  readonly trashPath: string
}

/**
 * Read the complete version-one recovery data for identity migration without changing hidden bytes.
 * @param root - absolute document root.
 * @returns validated legacy records, including their provider-owned hidden paths.
 * @throws UserDocError on unknown versions, unsafe records or incomplete recovery data.
 */
export async function readLegacyTrashRecords(root: string): Promise<readonly TrashRecord[]> { return readManifest(root, root) }

function manifestPath(root: string): string {
  return join(root, TRASH_DIRECTORY, MANIFEST_NAME)
}

function trashPath(root: string, id: string): string {
  return join(root, TRASH_DIRECTORY, `${id}.bin`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(value: unknown): TrashRecord | undefined {
  if (!isRecord(value)
    || typeof value.docId !== 'string' || value.docId === ''
    || typeof value.directoryId !== 'string'
    || typeof value.name !== 'string' || value.name === '' || Buffer.byteLength(value.name, 'utf8') > 255
    || /[\\/\u0000-\u001f\u007f]/u.test(value.name)
    || !Number.isSafeInteger(value.trashedAt) || (value.trashedAt as number) < 0
    || !Number.isSafeInteger(value.purgeAfter) || (value.purgeAfter as number) < (value.trashedAt as number)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.mediaType !== 'string' || value.mediaType === '' || value.mediaType.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value.mediaType)
    || !Number.isFinite(value.modifiedAt) || (value.modifiedAt as number) < 0
    || typeof value.trashPath !== 'string' || value.trashPath === '') return undefined
  const docSegments = value.docId.split('/')
  if (docSegments.at(-1) !== value.name || docSegments.slice(0, -1).join('/') !== value.directoryId) return undefined
  return {
    docId: value.docId as UserDocId,
    directoryId: value.directoryId as UserDocDirectoryId,
    name: value.name,
    trashedAt: value.trashedAt as number,
    purgeAfter: value.purgeAfter as number,
    bytes: value.bytes as number,
    mediaType: value.mediaType,
    modifiedAt: value.modifiedAt as number,
    trashPath: value.trashPath,
  }
}

async function readManifest(
  root: string, controlRoot: string, signal?: AbortSignal, storagePath = manifestPath(controlRoot),
): Promise<TrashRecord[]> {
  try {
    signal?.throwIfAborted()
    if (!await validateTrashDirectory(controlRoot)) return []
    let serialized: string
    try {
      serialized = await readFile(storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const entries = await readdir(dirname(storagePath))
      if (entries.some(name => name.endsWith('.bin'))) {
        throw new Error('Document trash has hidden files without a manifest.')
      }
      return []
    }
    const raw: unknown = JSON.parse(serialized)
    signal?.throwIfAborted()
    if (!isRecord(raw) || raw.version !== MANIFEST_VERSION || !Array.isArray(raw.records)) {
      throw new Error('Document trash manifest version or records are invalid.')
    }
    const documentIds = new Set<UserDocId>()
    const hiddenPaths = new Set<string>()
    return raw.records.map((value) => {
      signal?.throwIfAborted()
      const record = parseRecord(value)
      if (record === undefined) throw new Error('Document trash record is invalid.')
      assertTrashPath(controlRoot, record.trashPath)
      pathForDocId(root, String(record.docId))
      pathForDirectoryId(root, String(record.directoryId))
      const hidden = resolve(record.trashPath)
      if (documentIds.has(record.docId) || hiddenPaths.has(hidden)) {
        throw new Error('Document trash manifest contains duplicate identifiers or hidden files.')
      }
      documentIds.add(record.docId)
      hiddenPaths.add(hidden)
      return record
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new UserDocError('Unable to read document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
}

async function writeManifest(controlRoot: string, records: readonly TrashRecord[]): Promise<void> {
  await mkdir(join(controlRoot, TRASH_DIRECTORY), { recursive: true, mode: 0o700 })
  await writeManifestAt(manifestPath(controlRoot), records)
}

async function writeManifestAt(path: string, records: readonly TrashRecord[]): Promise<void> {
  await writeFileAtomic(path, JSON.stringify({ version: MANIFEST_VERSION, records }), {
    mode: 0o600,
    dirMode: 0o700,
  })
}

interface TrashManifestAccess {
  readonly records: readonly TrashRecord[]
  readonly path: string
  readonly verify: () => Promise<void>
}

/** Keep manifest reads, replacement and lock release below the same retained directory on Linux. */
async function withPinnedTrashManifest<T>(
  root: string, controlRoot: string, operation: (access: TrashManifestAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withRootedDocumentPaths(controlRoot, [manifestPath(controlRoot)], async (rooted) => {
      const path = rooted.paths[0]
      if (path === undefined) throw new Error('Document trash manifest path is missing.')
      return withFileLock(path, async () => {
        await rooted.verify()
        const records = await readManifest(root, controlRoot, undefined, path)
        await rooted.verify()
        const result = await operation({ records, path, verify: () => rooted.verify() })
        await rooted.verify()
        return result
      })
    })
  } catch (cause) {
    if (cause instanceof UserDocError) throw cause
    throw new UserDocError('Unable to update document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause })
  }
}

async function ensureTrashDirectory(controlRoot: string): Promise<void> {
  const trash = join(controlRoot, TRASH_DIRECTORY)
  try {
    const rootEntry = await lstat(controlRoot)
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new UserDocError('Document trash root is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    }
  } catch (error) {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Document trash root is unavailable.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
  const existing = await lstat(trash).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isDirectory())) {
    throw new UserDocError('Document trash directory is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
  if (existing === undefined) await mkdir(trash, { mode: 0o700 })
}

/** Validate the optional trash directory without creating it during a read. */
async function validateTrashDirectory(controlRoot: string): Promise<boolean> {
  let rootEntry
  try {
    rootEntry = await lstat(controlRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new UserDocError('Document trash root is unavailable.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new UserDocError('Document trash root is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
  let trashEntry
  try {
    trashEntry = await lstat(join(controlRoot, TRASH_DIRECTORY))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new UserDocError('Document trash directory is unavailable.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
  if (trashEntry.isSymbolicLink() || !trashEntry.isDirectory()) {
    throw new UserDocError('Document trash directory is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
  return true
}

function publicRecord(record: TrashRecord): UserDocTrashRef {
  const { trashPath: _trashPath, ...publicValue } = record
  return publicValue
}

function assertTrashPath(root: string, path: string): void {
  const trashRoot = resolve(root, TRASH_DIRECTORY)
  const candidate = resolve(path)
  const nested = relative(trashRoot, candidate)
  // Trash records are flat `<uuid>.bin` files. Reject prefix collisions,
  // traversal, and nested paths before any unlink/rename operation.
  if (nested === '' || nested.startsWith(`..${sep}`) || nested === '..' || isAbsolute(nested) || nested.includes(sep)
    || !/^[0-9a-f-]{36}\.bin$/u.test(basename(candidate))) {
    throw new UserDocError('Document trash metadata is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
}

async function assertRealParent(root: string, path: string): Promise<void> {
  try {
    const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(join(path, '..'))])
    if (!isInside(canonicalRoot, canonicalParent)) {
      throw new UserDocError('Document path lies outside the document root.', DOCUMENT_NOT_FOUND_CODE)
    }
    await assertNestedDirectories(root, join(path, '..'), DOCUMENT_NOT_FOUND_CODE)
  } catch (error) {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE, { cause: error })
  }
}

/** Require a trash inode to be a regular non-symlink file before publishing it. */
async function assertRegularTrashFile(path: string): Promise<void> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new UserDocError('Document trash entry is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    }
  } catch (error) {
    if (error instanceof UserDocError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UserDocError('Document is no longer in trash.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    }
    throw new UserDocError('Unable to inspect document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
}

/** Recreate a deleted original directory; Linux pins each parent through creation and rollback. */
async function ensureRestoreDirectory(root: string, directory: string): Promise<void> {
  const nested = relative(resolve(root), resolve(directory))
  let current = resolve(root)
  for (const part of nested.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      await withRootedDocumentPaths(root, [current], async (rooted) => {
        const path = rooted.paths[0]
        if (path === undefined) throw new Error('Document restore directory path is missing.')
        let entry, created = false
        try { entry = await lstat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await mkdir(path, { mode: 0o700 })
          created = true
          entry = await lstat(path)
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new UserDocError('Document restore directory is unavailable.', DOCUMENT_RESTORE_CONFLICT_CODE)
        }
        try { await rooted.verify() } catch (error) {
          if (created) {
            try { await rooted.rmdir(0) } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Document restore directory creation and rollback failed.')
            }
          }
          throw error
        }
      })
    } catch (cause) {
      if (cause instanceof UserDocError) throw cause
      throw new UserDocError('Document restore directory is unavailable.', DOCUMENT_RESTORE_CONFLICT_CODE, { cause })
    }
  }
  await assertRealParent(root, join(directory, '.placeholder'))
}

/**
 * List recoverable documents in newest-trash-first order.
 * @param root - absolute document root.
 * @param signal - optional cancellation for manifest reads.
 * @param controlRoot - private trash storage root; omitted uses `root`.
 * @returns public trash metadata without hidden storage paths.
 * @throws UserDocError when recovery metadata is invalid or unavailable.
 */
export async function listTrash(root: string, signal?: AbortSignal, controlRoot = root): Promise<UserDocTrashRef[]> {
  signal?.throwIfAborted()
  const records = await readManifest(root, controlRoot, signal)
  signal?.throwIfAborted()
  return records.sort((left, right) => right.trashedAt - left.trashedAt).map(publicRecord)
}

/**
 * Move one active document into recoverable trash.
 * Linux pins both parents through the move and rollback. Failed rollback retains the hidden copy.
 * @param root - absolute document root.
 * @param docId - store-scoped document identifier.
 * @param retentionMs - duration for which the hidden bytes remain recoverable.
 * @param controlRoot - private trash storage root; omitted uses `root`.
 * @returns the public trash record.
 * @throws UserDocError before moving bytes when recovery metadata is invalid or unavailable.
 */
export async function trashDocument(root: string, docId: UserDocId, retentionMs: number, controlRoot = root): Promise<UserDocTrashRef> {
  const source = pathForDocId(root, docId)
  const at = Date.now()
  await ensureTrashDirectory(controlRoot)
  return withFileLock(manifestPath(controlRoot), async () => {
    const records = await readManifest(root, controlRoot)
    const existing = records.find(record => record.docId === docId)
    if (existing !== undefined) {
      const current = await lstat(source).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (current !== undefined) {
        throw new UserDocError('An older item remains in trash at this path. The active item was not deleted.', DOCUMENT_TRASH_CONFLICT_CODE)
      }
      throw new UserDocError('Document is already in trash.', DOCUMENT_TRASHED_CODE)
    }
    let info
    try { info = await lstat(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    await assertRealParent(root, source)
    const id = randomUUID()
    const target = trashPath(controlRoot, id)
    await assertRealParent(controlRoot, target)
    const directoryId = String(docId).split('/').slice(0, -1).join('/') as UserDocDirectoryId
    const record: TrashRecord = {
      docId,
      directoryId,
      name: String(docId).split('/').at(-1) ?? 'document',
      trashedAt: at,
      purgeAfter: at + Math.max(0, retentionMs),
      bytes: info.size,
      mediaType: mediaTypeFor(String(docId)),
      modifiedAt: info.mtimeMs,
      trashPath: target,
    }
    return withRootedDocumentPaths(root, [source], async (sourcePaths) => {
      return withRootedDocumentPaths(controlRoot, [target], async (targetPaths) => {
        const selectedSource = sourcePaths.paths[0], selectedTarget = targetPaths.paths[0]
        if (selectedSource === undefined || selectedTarget === undefined) throw new Error('Document trash path is missing.')
        const selected = await lstat(selectedSource)
        if (!selected.isFile() || selected.isSymbolicLink() || selected.dev !== info.dev || selected.ino !== info.ino) {
          throw new UserDocError('The selected document changed before it was trashed.', DOCUMENT_NOT_FOUND_CODE)
        }
        await rename(selectedSource, selectedTarget)
        try {
          await sourcePaths.verify()
          await targetPaths.verify()
          await assertRegularTrashFile(selectedTarget)
          const moved = await lstat(selectedTarget)
          if (moved.dev !== info.dev || moved.ino !== info.ino) throw new Error('The trashed document file object changed.')
          await writeManifest(controlRoot, [...records, record])
        } catch (error) {
          let failure = error
          try {
            await link(selectedTarget, selectedSource)
            await targetPaths.unlink(0)
          } catch (cleanupError) {
            failure = new AggregateError([error, cleanupError], 'Document trash and source restoration failed.')
          }
          throw new UserDocError('Unable to update document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: failure })
        }
        return publicRecord(record)
      })
    })
  })
}

/** Restore the hidden link before removing a failed publication; occupied recovery paths are never replaced. */
async function rollbackRestore(hidden: string, published: string): Promise<void> {
  try {
    await link(published, hidden)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const [source, target] = await Promise.all([lstat(hidden), lstat(published)])
    if (source.dev !== target.dev || source.ino !== target.ino) {
      throw new Error('Document recovery path is occupied by another file.', { cause: error })
    }
  }
  await unlink(published)
}

/**
 * Restore one trash record through exclusive publication, refusing a concurrently occupied target.
 * Linux retains source and destination parents through publication and rollback.
 * @param root - absolute document root.
 * @param docId - original store-scoped document identifier.
 * @param directoryId - optional destination directory; defaults to the original directory.
 * @param name - optional replacement name; defaults to the original leaf.
 * @param controlRoot - private trash storage root; omitted uses `root`.
 * @returns the restored document reference.
 * @throws UserDocError on invalid metadata or publication failure; failed rollback preserves its cause and remaining file copies.
 */
export async function restoreDocument(
  root: string,
  docId: UserDocId,
  directoryId?: UserDocDirectoryId,
  name?: string,
  controlRoot = root,
): Promise<UserDocRef> {
  await ensureTrashDirectory(controlRoot)
  return withFileLock(manifestPath(controlRoot), async () => {
    const records = await readManifest(root, controlRoot)
    const record = records.find(item => item.docId === docId)
    if (record === undefined) throw new UserDocError('Document is not in trash.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    assertTrashPath(controlRoot, record.trashPath)
    await assertRealParent(controlRoot, record.trashPath)
    await assertRegularTrashFile(record.trashPath)
    const parentId = directoryId ?? record.directoryId
    const directory = pathForDirectoryId(root, parentId)
    await ensureRestoreDirectory(root, directory)
    const target = await resolveTargetIn(root, directory, name ?? record.name, async (path) => {
      try { await lstat(path); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
    if (target.path === record.trashPath) {
      throw new UserDocError('The restore target is invalid.', DOCUMENT_RESTORE_CONFLICT_CODE)
    }
    try {
      await assertRealParent(root, target.path)
      await withRootedDocumentPaths(controlRoot, [record.trashPath], async (sourcePaths) => {
        await withRootedDocumentPaths(root, [target.path], async (targetPaths) => {
          const hidden = sourcePaths.paths[0], selectedTarget = targetPaths.paths[0]
          if (hidden === undefined || selectedTarget === undefined) throw new Error('Document restore path is missing.')
          const selected = await lstat(hidden)
          if (!selected.isFile() || selected.isSymbolicLink()) {
            throw new UserDocError('Document trash entry is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
          }
          let published = false
          try {
            await link(hidden, selectedTarget)
            published = true
            await sourcePaths.verify()
            await targetPaths.verify()
            const entry = await lstat(selectedTarget)
            if (!entry.isFile() || entry.isSymbolicLink() || entry.dev !== selected.dev || entry.ino !== selected.ino) {
              throw new UserDocError('Document trash entry is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
            }
            await sourcePaths.unlink(0)
            await sourcePaths.verify()
            await targetPaths.verify()
            await writeManifest(controlRoot, records.filter(item => item !== record))
          } catch (error) {
            let cause = error
            if (published) {
              try { await rollbackRestore(hidden, selectedTarget) } catch (rollbackError) {
                cause = new AggregateError([error, rollbackError], 'Document restore and recovery rollback failed.')
              }
            }
            throw cause
          }
        })
      })
    } catch (cause) {
      throw new UserDocError('Unable to restore the document.', DOCUMENT_RESTORE_CONFLICT_CODE, { cause })
    }
    return {
      docId: docIdFor(root, target.path),
      path: resolve(target.path),
      name: target.name,
      bytes: record.bytes,
      mediaType: mediaTypeFor(target.name),
      modifiedAt: record.modifiedAt,
    }
  })
}

/**
 * Permanently remove one trash record and its hidden file.
 * @param root - absolute document root.
 * @param docId - original store-scoped document identifier.
 * @param controlRoot - private trash storage root; omitted uses `root`.
 * @throws UserDocError before deleting bytes when recovery metadata is invalid or unavailable.
 */
export async function purgeDocument(root: string, docId: UserDocId, controlRoot = root): Promise<void> {
  await ensureTrashDirectory(controlRoot)
  await withPinnedTrashManifest(root, controlRoot, async ({ records, path, verify }) => {
    const record = records.find(item => item.docId === docId)
    if (record === undefined) return
    await removeTrashFile(controlRoot, record)
    await verify()
    await writeManifestAt(path, records.filter(item => item !== record))
  })
}

/** Remove a manifest-owned file; an already-absent payload still permits metadata cleanup. */
async function removeTrashFile(controlRoot: string, record: TrashRecord): Promise<void> {
  assertTrashPath(controlRoot, record.trashPath)
  await assertRealParent(controlRoot, record.trashPath)
  await withRootedDocumentPaths(controlRoot, [record.trashPath], async (rooted) => {
    await rooted.verify()
    await rooted.unlink(0).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await rooted.verify()
  })
}

/**
 * Purge current records whose retention deadline has elapsed under the manifest writer lock.
 * @param root - absolute document root.
 * @param now - epoch milliseconds used for the retention comparison.
 * @param controlRoot - private trash storage root; omitted uses `root`.
 * @returns the number of records permanently removed.
 * @throws UserDocError when recovery metadata is invalid or unavailable.
 */
export async function purgeDueDocuments(root: string, now = Date.now(), controlRoot = root): Promise<number> {
  const candidates = await readManifest(root, controlRoot)
  let purged = 0
  for (const candidate of candidates) {
    if (candidate.purgeAfter > now) continue
    const removed = await withPinnedTrashManifest(root, controlRoot, async ({ records, path, verify }) => {
      const current = records.find(record => record.docId === candidate.docId
        && record.trashPath === candidate.trashPath && record.purgeAfter <= now)
      if (current === undefined) return false
      await removeTrashFile(controlRoot, current)
      await verify()
      await writeManifestAt(path, records.filter(record => record !== current))
      return true
    })
    if (removed) purged += 1
  }
  return purged
}
