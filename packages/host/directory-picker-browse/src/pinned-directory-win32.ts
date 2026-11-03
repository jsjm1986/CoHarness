/** Windows directory operations use retained handles and refuse reparse traversal. */
import { win32 } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { DirectoryRoot, PinnedDirectory, PinnedDirectoryEntry } from './pinned-directory.ts'
import { loadWindowsDirectoryCalls } from './windows-directory-calls.ts'
import { retainDirectory } from './directory-lifetime.ts'

/**
 * Walk real Windows directories through handle-relative opens, then retain the selected level.
 * @param root - Grant root and its recorded volume/file identity.
 * @param target - Canonical path at or below root.
 * @param signal - Caller lifetime; no new operation starts after an observed abort.
 * @returns An owned level; close waits for pending operations before releasing its parents.
 */
export async function openWindowsDirectory(root: DirectoryRoot, target: string, signal?: AbortSignal): Promise<PinnedDirectory> {
  const native = await loadWindowsDirectoryCalls()
  const handles: (number | bigint)[] = []
  const paths: { path: string; device: string; inode: string }[] = []
  const close = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const handle of handles.toReversed()) {
      try { await native.close(handle) } catch (error) { failures.push(error) }
    }
    try { native.unload() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Windows directory cleanup failed')
  }
  try {
    signal?.throwIfAborted()
    let current = win32.parse(target).root
    let handle = await native.openRoot(win32.toNamespacedPath(current)); handles.push(handle)
    const inspect = async (path: string, selectedHandle: number | bigint): Promise<boolean> => {
      const identity = await native.identity(selectedHandle)
      paths.push({ path, ...identity })
      const selected = path === win32.resolve(root.path)
      if (selected) {
        if (identity.device !== root.identity.device || identity.inode !== root.identity.inode) {
          throw new Error('Authorized directory root was replaced')
        }
      }
      return selected
    }
    let verified = await inspect(current, handle)
    for (const part of win32.relative(current, target).split(win32.sep).filter(Boolean)) {
      signal?.throwIfAborted()
      handle = await native.child(handle, part, false); handles.push(handle)
      current = win32.join(current, part)
      verified = await inspect(current, handle) || verified
    }
    if (!verified) throw new Error('Authorized directory root was not opened')
    signal?.throwIfAborted()
    const selected = handle
    let batch = Array<PinnedDirectoryEntry>()[Symbol.iterator](), ended = false
    let reader: number | bigint | undefined
    return retainDirectory({
      read: async () => {
        while (!ended) {
          signal?.throwIfAborted()
          const entry = batch.next()
          if (!entry.done) return entry.value
          if (reader === undefined) { reader = await native.reader(selected); handles.push(reader) }
          signal?.throwIfAborted()
          const next = await native.read(reader)
          if (next === null) ended = true
          else batch = next[Symbol.iterator]()
        }
        return null
      },
      createDirectory: async (name) => {
        const created = await native.child(selected, name, true)
        handles.push(created)
      },
      verify: async () => {
        for (const entry of paths) {
          signal?.throwIfAborted()
          const info = await lstat(entry.path, { bigint: true })
          if (!info.isDirectory() || String(info.dev) !== entry.device || String(info.ino) !== entry.inode) {
            throw new Error('Authorized directory parent was replaced')
          }
        }
      },
    }, close)
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows directory open and cleanup failed') }
    throw error
  }
}
