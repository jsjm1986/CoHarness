/** Legacy upload-root migration for the local document store. */

import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { lstat, link, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import {
  DOCUMENT_MIGRATION_FAILED_CODE,
  UserDocError,
} from '@deepseek-ai/dsh-userdoc'
import { isInside, resolveTargetIn } from './name.ts'

const migrations = new Map<string, Promise<void>>()
const LOCK_POLL_MS = 50

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function processIsLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  while (true) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(String(process.pid))
      await handle.sync()
      return async () => {
        await handle.close()
        await unlink(path).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner = 0
      try {
        owner = Number(await readFile(path, 'utf8'))
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
          await unlink(path).catch(() => {})
        }
      }
      if (owner !== 0 && processIsLive(owner)) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, LOCK_POLL_MS))
        continue
      }
      await unlink(path).catch((errorToUnlink: unknown) => {
        if ((errorToUnlink as NodeJS.ErrnoException).code !== 'ENOENT') throw errorToUnlink
      })
    }
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
  const release = await acquireLock(join(dirname(root), `.${basename(root)}-migration.lock`))
  try {
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
  } finally {
    await release()
  }
}

/**
 * Move one legacy upload tree into the current document root.
 * Concurrent callers in one process share one migration, while an owner-only
 * lock file serializes replacement runtime processes and is reclaimed when its
 * recorded process is absent.
 * @param legacyRoot - previous upload directory.
 * @param documentRoot - current document directory.
 * @returns after the legacy tree is absent and the current root exists.
 * @throws UserDocError with `DOCUMENT_MIGRATION_FAILED` when migration cannot complete.
 */
export function migrateLegacyDocuments(legacyRoot: string, documentRoot: string): Promise<void> {
  const key = `${resolve(legacyRoot)}\u0000${resolve(documentRoot)}`
  const existing = migrations.get(key)
  if (existing !== undefined) return existing
  const pending = migrate(legacyRoot, documentRoot).catch((error: unknown) => {
    if (error instanceof UserDocError) throw error
    throw new UserDocError('Unable to migrate legacy document storage.', DOCUMENT_MIGRATION_FAILED_CODE, {
      cause: error,
    })
  }).finally(() => {
    if (migrations.get(key) === pending) migrations.delete(key)
  })
  migrations.set(key, pending)
  return pending
}
