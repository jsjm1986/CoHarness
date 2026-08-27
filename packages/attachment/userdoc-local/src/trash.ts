/** Recoverable trash for the local user-document provider. */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_NOT_FOUND_CODE,
  DOCUMENT_RESTORE_CONFLICT_CODE,
  DOCUMENT_TRASH_NOT_FOUND_CODE,
  DOCUMENT_TRASHED_CODE,
  UserDocError,
  type UserDocDirectoryId,
  type UserDocId,
  type UserDocRef,
  type UserDocTrashRef,
} from '@deepseek-ai/dsh-userdoc'
import { docIdFor, isInside, pathForDirectoryId, pathForDocId, resolveTargetIn } from './name.ts'
import { mediaTypeFor } from './media-type.ts'

const TRASH_DIRECTORY = '.dsh-trash'
const MANIFEST_NAME = 'manifest.json'
const MANIFEST_VERSION = 1

interface TrashRecord extends UserDocTrashRef {
  readonly trashPath: string
}

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

async function readManifest(root: string, signal?: AbortSignal): Promise<TrashRecord[]> {
  try {
    signal?.throwIfAborted()
    if (!await validateTrashDirectory(root)) return []
    const raw = JSON.parse(await readFile(manifestPath(root), 'utf8')) as unknown
    signal?.throwIfAborted()
    if (!isRecord(raw) || raw.version !== MANIFEST_VERSION || !Array.isArray(raw.records)) return []
    return raw.records.flatMap((value) => {
      signal?.throwIfAborted()
      const record = parseRecord(value)
      if (record === undefined) return []
      try {
        assertTrashPath(root, record.trashPath)
        pathForDocId(root, String(record.docId))
        pathForDirectoryId(root, String(record.directoryId))
      } catch {
        // A damaged record must never become an arbitrary filesystem target.
        // Its hidden bytes are left for an operator/maintenance sweep rather
        // than returned as a usable document reference.
        return []
      }
      return [record]
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new UserDocError('Unable to read document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
}

async function writeManifest(root: string, records: readonly TrashRecord[]): Promise<void> {
  await mkdir(join(root, TRASH_DIRECTORY), { recursive: true, mode: 0o700 })
  await writeFileAtomic(manifestPath(root), JSON.stringify({ version: MANIFEST_VERSION, records }), {
    mode: 0o600,
    dirMode: 0o700,
  })
}

async function ensureTrashDirectory(root: string): Promise<void> {
  const trash = join(root, TRASH_DIRECTORY)
  try {
    const rootEntry = await lstat(root)
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
async function validateTrashDirectory(root: string): Promise<boolean> {
  let rootEntry
  try {
    rootEntry = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new UserDocError('Document trash root is unavailable.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new UserDocError('Document trash root is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
  }
  let trashEntry
  try {
    trashEntry = await lstat(join(root, TRASH_DIRECTORY))
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
    const nested = relative(resolve(root), resolve(join(path, '..')))
    if (nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`)) {
      let current = resolve(root)
      for (const part of nested.split(sep).filter(Boolean)) {
        current = join(current, part)
        const entry = await lstat(current)
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new UserDocError('Document directory not found.', DOCUMENT_NOT_FOUND_CODE)
        }
      }
    }
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

/** Recreate a deleted original directory while refusing symlink components. */
async function ensureRestoreDirectory(root: string, directory: string): Promise<void> {
  const nested = relative(resolve(root), resolve(directory))
  let current = resolve(root)
  for (const part of nested.split(sep).filter(Boolean)) {
    current = join(current, part)
    let entry
    try {
      entry = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new UserDocError('Document restore directory is unavailable.', DOCUMENT_RESTORE_CONFLICT_CODE, { cause: error })
      }
      try {
        await mkdir(current, { mode: 0o700 })
        entry = await lstat(current)
      } catch (mkdirError) {
        throw new UserDocError('Document restore directory is unavailable.', DOCUMENT_RESTORE_CONFLICT_CODE, { cause: mkdirError })
      }
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new UserDocError('Document restore directory is unavailable.', DOCUMENT_RESTORE_CONFLICT_CODE)
    }
  }
  await assertRealParent(root, join(directory, '.placeholder'))
}

/**
 * List recoverable documents in newest-trash-first order.
 * @param root - absolute document root.
 * @param signal - optional cancellation for manifest reads.
 * @returns public trash metadata without hidden storage paths.
 */
export async function listTrash(root: string, signal?: AbortSignal): Promise<UserDocTrashRef[]> {
  signal?.throwIfAborted()
  const records = await readManifest(root, signal)
  signal?.throwIfAborted()
  return records.sort((left, right) => right.trashedAt - left.trashedAt).map(publicRecord)
}

/**
 * Move one active document into recoverable trash.
 * @param root - absolute document root.
 * @param docId - store-scoped document identifier.
 * @param retentionMs - duration for which the hidden bytes remain recoverable.
 * @returns the public trash record.
 */
export async function trashDocument(root: string, docId: UserDocId, retentionMs: number): Promise<UserDocTrashRef> {
  const source = pathForDocId(root, docId)
  const at = Date.now()
  await ensureTrashDirectory(root)
  return withFileLock(manifestPath(root), async () => {
    const records = await readManifest(root)
    const existing = records.find(record => record.docId === docId)
    if (existing !== undefined) throw new UserDocError('Document is already in trash.', DOCUMENT_TRASHED_CODE)
    let info
    try { info = await lstat(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    await assertRealParent(root, source)
    const id = randomUUID()
    const target = trashPath(root, id)
    await assertRealParent(root, target)
    await rename(source, target)
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
    try {
      await assertRegularTrashFile(target)
      await writeManifest(root, [...records, record])
    } catch (error) {
      await rename(target, source).catch(() => {})
      throw new UserDocError('Unable to update document trash.', DOCUMENT_TRASH_NOT_FOUND_CODE, { cause: error })
    }
    return publicRecord(record)
  })
}

/**
 * Restore one trash record, resolving a safe non-overwriting target name.
 * @param root - absolute document root.
 * @param docId - original store-scoped document identifier.
 * @param directoryId - optional destination directory; defaults to the original directory.
 * @param name - optional replacement name; defaults to the original leaf.
 * @returns the restored document reference.
 */
export async function restoreDocument(
  root: string,
  docId: UserDocId,
  directoryId?: UserDocDirectoryId,
  name?: string,
): Promise<UserDocRef> {
  await ensureTrashDirectory(root)
  return withFileLock(manifestPath(root), async () => {
    const records = await readManifest(root)
    const record = records.find(item => item.docId === docId)
    if (record === undefined) throw new UserDocError('Document is not in trash.', DOCUMENT_TRASH_NOT_FOUND_CODE)
    assertTrashPath(root, record.trashPath)
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
    let moved = false
    try {
      await assertRealParent(root, target.path)
      await rename(record.trashPath, target.path)
      moved = true
      // Re-check the published inode after the rename. A local attacker can
      // race the preflight lstat by replacing the hidden path; never leave a
      // symlink in the user-visible document tree.
      const published = await lstat(target.path)
      if (!published.isFile() || published.isSymbolicLink()) {
        await rename(target.path, record.trashPath).catch(() => {})
        moved = false
        throw new UserDocError('Document trash entry is invalid.', DOCUMENT_TRASH_NOT_FOUND_CODE)
      }
      await writeManifest(root, records.filter(item => item !== record))
    } catch (error) {
      if (moved) await rename(target.path, record.trashPath).catch(() => {})
      throw new UserDocError('Unable to restore the document.', DOCUMENT_RESTORE_CONFLICT_CODE, { cause: error })
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
 */
export async function purgeDocument(root: string, docId: UserDocId): Promise<void> {
  await ensureTrashDirectory(root)
  await withFileLock(manifestPath(root), async () => {
    const records = await readManifest(root)
    const record = records.find(item => item.docId === docId)
    if (record === undefined) return
    assertTrashPath(root, record.trashPath)
    await assertRealParent(root, record.trashPath)
    await unlink(record.trashPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await writeManifest(root, records.filter(item => item !== record))
  })
}

/**
 * Purge records whose retention deadline has elapsed.
 * @param root - absolute document root.
 * @param now - epoch milliseconds used for the retention comparison.
 * @returns the number of records permanently removed.
 */
export async function purgeDueDocuments(root: string, now = Date.now()): Promise<number> {
  const records = await readManifest(root)
  let purged = 0
  for (const record of records) {
    if (record.purgeAfter <= now) {
      await purgeDocument(root, record.docId)
      purged += 1
    }
  }
  return purged
}
