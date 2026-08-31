import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

/**
 * Create the owner-only file used to deliver a newly generated bootstrap
 * administrator password. Existing files are never overwritten: an operator
 * must inspect or remove a stale file explicitly before retrying bootstrap.
 *
 * @param path - absolute owner-private destination path.
 * @param password - freshly generated password to write once.
 * @returns after the file has been written with the requested mode.
 */
export async function writeBootstrapAdminPassword(path: string, password: string): Promise<void> {
  if (!isAbsolute(path) || path === '/' || password === '') {
    throw new Error('bootstrap administrator password path and value are invalid')
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(path))
  const uid = process.getuid?.()
  if (parent.isSymbolicLink() || !parent.isDirectory()
    || (uid !== undefined && (parent.uid !== uid || (parent.mode & 0o022) !== 0))) {
    throw new Error(`bootstrap administrator password directory is not owner-private: ${dirname(path)}`)
  }
  try {
    await writeFile(path, `${password}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code === 'EEXIST') {
      throw new Error(
        `bootstrap administrator password file already exists: ${path}; inspect and remove it before retrying`,
        { cause: error },
      )
    }
    throw new Error(`failed to write bootstrap administrator password file: ${path}`, { cause: error })
  }
}

/**
 * Remove the one-time bootstrap secret after an administrator changes it.
 * @param path - owner-only bootstrap password file.
 * @returns after removal, or when the file was already absent.
 */
export async function removeBootstrapAdminPassword(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code === 'ENOENT') return
    throw new Error(`failed to remove bootstrap administrator password file: ${path}`, { cause: error })
  }
}
