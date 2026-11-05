/** One directory namespace or file flush per host platform. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'
import type { KoffiFunc } from 'koffi'
import { withDocumentHandle } from './handle.ts'

const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_READ_ATTRIBUTES = 0x80

function windowsDirectoryError(syscall: string, nativeCode: number, path: string): NodeJS.ErrnoException {
  const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES' } as Record<number, string>)[nativeCode] ?? 'EIO'
  return Object.assign(new Error(`${syscall} ${code} (Win32 ${String(nativeCode)}): ${path}`), { code, errno: nativeCode, syscall, path })
}

/**
 * Flush the directory on Windows: libuv opens directories without
 * FILE_FLAG_BACKUP_SEMANTICS and its fsync then fails EPERM, so the durable
 * namespace flush runs FlushFileBuffers on a backup-semantics handle instead.
 * @param path - directory whose namespace entries must persist.
 */
async function syncWindowsDirectory(path: string): Promise<void> {
  const koffi = (await import('koffi')).default, library = koffi.load('kernel32.dll')
  try {
    const lastError = library.func('__stdcall', 'GetLastError', 'uint', []) as () => number
    const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as (handle: number | bigint) => number
    const flush = library.func('__stdcall', 'FlushFileBuffers', 'int', ['intptr']) as KoffiFunc<(handle: number | bigint) => number>
    const create = library.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']) as KoffiFunc<
      (path: string, access: number, share: number, security: null, creation: number, flags: number, template: number) => number | bigint
    >
    const handle = await new Promise<number | bigint>((accept, reject) => {
      create.async(toNamespacedPath(path), FILE_READ_ATTRIBUTES, 7, null, 3, FILE_FLAG_BACKUP_SEMANTICS, 0,
        (error: unknown, result: number | bigint) => {
          if (error !== null) reject(error instanceof Error ? error : new Error('Windows directory open failed.', { cause: error }))
          else if (BigInt(result) === -1n) reject(windowsDirectoryError('CreateFileW', lastError(), path))
          else accept(result)
        })
    })
    const failures: unknown[] = []
    try {
      await new Promise<void>((accept, reject) => {
        flush.async(handle, (error: unknown, result: number) => {
          if (error !== null) reject(error instanceof Error ? error : new Error('Windows directory flush failed.', { cause: error }))
          else if (result === 0) reject(windowsDirectoryError('FlushFileBuffers', lastError(), path))
          else accept()
        })
      })
    } catch (error) { failures.push(error) }
    if (close(handle) === 0) failures.push(windowsDirectoryError('CloseHandle', lastError(), path))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 0) throw new AggregateError(failures, 'Windows directory flush and handle cleanup failed.')
  } finally {
    library.unload()
  }
}

/**
 * Durably persist one directory's committed namespace entries. POSIX fsyncs
 * the opened directory; Windows requires the backup-semantics flush.
 * @param path - directory whose renamed or created entries must persist.
 */
export async function syncDocumentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return syncWindowsDirectory(path)
  const handle = await open(path, 'r')
  await withDocumentHandle(handle, () => handle.sync())
}

/**
 * Durably persist one file's committed bytes and metadata. Read-only fsync is
 * a POSIX liberty: FlushFileBuffers needs a write-capable handle on Windows,
 * so the file opens read-write there without changing its content.
 * @param path - file whose content must persist.
 */
export async function syncDocumentFile(path: string): Promise<void> {
  const flags = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0))
  await withDocumentHandle(handle, () => handle.sync())
}
