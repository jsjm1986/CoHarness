/** Legacy upload-root migration for the local document store. */

import { basename, dirname, join, resolve } from 'node:path'
import { lstat, link, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_MIGRATION_FAILED_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import { isInside, resolveTargetIn } from './name.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function moveFile(source: string, targetDirectory: string, root: string): Promise<void> {
  const target = await resolveTargetIn(root, targetDirectory, basename(source), exists)
  let published = false
  try {
    await link(source, target.path)
    published = true
    await unlink(source)
  } catch (error) {
    if (published) await unlink(target.path).catch(() => {})
    throw error
  }
}

async function mergeDirectory(source: string, target: string, root: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isFile()) {
      await moveFile(sourcePath, target, root)
      continue
    }
    if (!entry.isDirectory()) {
      throw new UserDocError('Legacy document storage contains an unsupported entry.', DOCUMENT_MIGRATION_FAILED_CODE)
    }
    const targetEntry = await lstat(targetPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (targetEntry === undefined) {
      try {
        await rename(sourcePath, targetPath)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const current = await lstat(targetPath)
    if (current.isDirectory() && !current.isSymbolicLink()) {
      await mergeDirectory(sourcePath, targetPath, root)
      continue
    }
    const alternate = await resolveTargetIn(root, target, entry.name, exists)
    await rename(sourcePath, alternate.path)
  }
  await rmdir(source)
}

async function migrate(legacyRoot: string, documentRoot: string): Promise<void> {
  const legacy = resolve(legacyRoot)
  const root = resolve(documentRoot)
  if (legacy === root) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    return
  }
  if (isInside(legacy, root) || isInside(root, legacy)) {
    throw new UserDocError('Legacy and current document roots overlap.', DOCUMENT_MIGRATION_FAILED_CODE)
  }
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  await withFileLock(join(dirname(root), `.${basename(root)}-migration`), async () => {
    const source = await lstat(legacy).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (source === undefined) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      return
    }
    if (!source.isDirectory() || source.isSymbolicLink()) {
      throw new UserDocError('Legacy document storage is not a directory.', DOCUMENT_MIGRATION_FAILED_CODE)
    }
    if (!await exists(root)) {
      await rename(legacy, root)
      return
    }
    const target = await lstat(root)
    if (!target.isDirectory() || target.isSymbolicLink()) {
      throw new UserDocError('Document storage root is not a directory.', DOCUMENT_MIGRATION_FAILED_CODE)
    }
    await mergeDirectory(legacy, root, root)
  })
}

/**
 * Move one legacy upload tree into the current document root.
 * An owner-private writer lock serializes independent callers and runtime
 * processes. Only a complete record whose process is proven absent is
 * reclaimed; live or incomplete records are retained and acquisition is bounded.
 * LocalUserDocFs owns and coalesces each engine's first-use initialization.
 * @param legacyRoot - previous upload directory.
 * @param documentRoot - current document directory.
 * @returns after the legacy tree is absent and the current root exists.
 * @throws UserDocError with `DOCUMENT_MIGRATION_FAILED` when migration cannot complete.
 */
export function migrateLegacyDocuments(legacyRoot: string, documentRoot: string): Promise<void> {
  return migrate(legacyRoot, documentRoot).catch((error: unknown) => {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Unable to migrate legacy document storage.', DOCUMENT_MIGRATION_FAILED_CODE, {
      cause: error,
    })
  })
}
