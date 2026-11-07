/** Windows directory moves exclude parent replacement through handles without delete sharing. */
import { lstat } from 'node:fs/promises'
import { dirname, relative, resolve, sep, toNamespacedPath } from 'node:path'
import type { KoffiFunc } from 'koffi'
import type { DocumentFileObjectId } from './file-object.ts'
import type { DocumentDirectoryMove } from './directory-move.ts'

const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const MOVEFILE_WRITE_THROUGH = 8

function windowsError(syscall: string, nativeCode: number, path: string): NodeJS.ErrnoException {
  const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 32: 'EBUSY', 80: 'EEXIST', 183: 'EEXIST' } as Record<number, string>)[nativeCode] ?? 'EIO'
  return Object.assign(new Error(`${syscall} ${code} (Win32 ${String(nativeCode)}): ${path}`), { code, errno: nativeCode, syscall, path })
}

/**
 * Retain each Windows parent with reparse traversal and delete sharing disabled.
 * @param root - validated absolute document root.
 * @param source - source below the root.
 * @param target - target below the root.
 * @param operation - awaited work using the native move capability.
 * @param expectedRoot - managed root identity, or the root opened by this operation when absent.
 * @param targetRoot - destination root; absence uses the source root.
 * @param expectedTargetRoot - optional managed destination-root identity.
 * @returns the callback result after native handles and library close; independent failures are aggregated.
 */
export async function withWindowsDirectoryMove<T>(
  root: string, source: string, target: string, operation: (move: DocumentDirectoryMove) => Promise<T>,
  expectedRoot?: DocumentFileObjectId, targetRoot: string = root, expectedTargetRoot?: DocumentFileObjectId,
): Promise<T> {
  const koffi = (await import('koffi')).default, library = koffi.load('kernel32.dll')
  const handles: { readonly path: string; readonly identity: DocumentFileObjectId }[] = []
  const cleanups: (() => void)[] = []
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  try {
    const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as (handle: number | bigint) => number
    const lastError = library.func('__stdcall', 'GetLastError', 'uint', []) as () => number
    const create = library.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']) as KoffiFunc<
      (path: string, access: number, share: number, security: null, creation: number, flags: number, template: number) => number | bigint
    >
    const inspect = library.func('__stdcall', 'GetFileInformationByHandle', 'int', ['intptr', 'void*']) as KoffiFunc<
      (handle: number | bigint, buffer: Buffer) => number
    >
    const rename = library.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as KoffiFunc<(source: string, target: string, flags: number) => number>
    // Synchronous calls keep GetLastError honest: koffi's async path runs on a
    // worker thread but delivers the callback on the JS thread, where the
    // thread-local error code no longer belongs to the failed call.
    const native = <Args extends unknown[], R extends number | bigint>(
      call: KoffiFunc<(...args: Args) => R>, args: Args, syscall: string, path: string, failed: (result: R) => boolean,
    ): R => {
      const result = call(...args)
      if (failed(result)) throw windowsError(syscall, lastError(), path)
      return result
    }
    const roots = [{ root, expected: expectedRoot }, { root: targetRoot, expected: expectedTargetRoot }]
    const parents = new Set([root, targetRoot])
    for (const [selectedRoot, path] of [[root, source], [targetRoot, target]] as const) {
      let current = selectedRoot
      for (const segment of relative(selectedRoot, dirname(path)).split(sep).filter(Boolean)) {
        current = resolve(current, segment)
        parents.add(current)
      }
    }
    for (const path of parents) {
      const handle = native(create,
        [toNamespacedPath(path), 0, 3, null, 3, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, 0],
        'CreateFileW', path, result => BigInt(result) === -1n)
      cleanups.push(() => {
        if (close(handle) === 0) throw windowsError('CloseHandle', lastError(), path)
      })
      const info = Buffer.alloc(52)
      native(inspect, [handle, info], 'GetFileInformationByHandle', path, result => result === 0)
      const attributes = info.readUInt32LE(0)
      if ((attributes & FILE_ATTRIBUTE_DIRECTORY) === 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        throw new Error('Document move requires real Windows parent directories.')
      }
      const entry = { path, identity: { device: String(info.readUInt32LE(28)),
        inode: String(BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48))) } }
      handles.push(entry)
      for (const selected of roots) {
        if (path === selected.root && selected.expected !== undefined
          && (entry.identity.device !== selected.expected.device || entry.identity.inode !== selected.expected.inode)) {
          throw new Error('Document root changed before its directory move.')
        }
      }
    }
    const verify = async (): Promise<void> => {
      for (const entry of handles) {
        const info = await lstat(entry.path, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink()
          || String(info.dev) !== entry.identity.device || String(info.ino) !== entry.identity.inode) {
          throw new Error('Document parent changed during its directory move.')
        }
      }
    }
    let renamed = false
    await verify()
    const value = await operation({
      get renamed() { return renamed }, verify,
      // MoveFileExW's write-through completion owns namespace durability on Windows.
      sync: () => verify(),
      rename: async () => {
        await verify()
        native(rename, [toNamespacedPath(source), toNamespacedPath(target), MOVEFILE_WRITE_THROUGH],
          'MoveFileExW', source, result => result === 0)
        renamed = true
      },
    })
    outcome = { ok: true, value }
  } catch (error) { outcome = { ok: false, error } }
  const failures: unknown[] = []
  for (const cleanup of cleanups.reverse()) {
    try { cleanup() } catch (error) { failures.push(error) }
  }
  try { library.unload() } catch (error) { failures.push(error) }
  if (failures.length > 0) {
    if (!outcome.ok) failures.unshift(outcome.error)
    throw new AggregateError(failures, 'Document directory move and Windows handle cleanup failed.')
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

/**
 * Replace one verified, private recovery file by a same-volume write-through move.
 * @param source - newly created and flushed sibling or verified replacement hard link.
 * @param destination - existing file within the exclusively owned restore directory.
 * @returns after Windows completes the namespace change.
 */
export async function replaceRecoveredFileWindows(source: string, destination: string): Promise<void> {
  const koffi = (await import('koffi')).default
  const library = koffi.load('kernel32.dll')
  try {
    const move = library.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as (from: string, to: string, flags: number) => number
    const lastError = library.func('__stdcall', 'GetLastError', 'uint', []) as () => number
    const MOVEFILE_REPLACE_EXISTING = 1
    if (!move(toNamespacedPath(source), toNamespacedPath(destination), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      throw windowsError('MoveFileExW', lastError(), destination)
    }
  } finally { library.unload() }
}
