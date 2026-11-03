/** Granted directory operations retain filesystem objects until their asynchronous work settles. */
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import { lstat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { openWindowsDirectory } from './pinned-directory-win32.ts'
import { retainDirectory } from './directory-lifetime.ts'

/** Filesystem identity captured when a grant is loaded. */
export interface DirectoryObjectIdentity {
  /** Filesystem device identifier. */
  readonly device: string
  /** Directory inode or Windows file identifier. */
  readonly inode: string
}

/** Canonical directory root and the object authorized by that grant. */
export interface DirectoryRoot {
  /** Canonical absolute directory path. */
  readonly path: string
  /** Filesystem object authorized when the grant was loaded. */
  readonly identity: DirectoryObjectIdentity
}

/** One entry from an opened directory; link targets have not been accessed. */
export interface PinnedDirectoryEntry {
  /** One name within the opened level. */
  readonly name: string
  /** The entry itself is a real directory. */
  readonly isDirectory: boolean
  /** The entry is a link or reparse point whose target needs separate authorization. */
  readonly isSymbolicLink: boolean
}

/** Opened directory whose operations cannot follow replacement parents. */
export interface PinnedDirectory {
  /** Read the next entry; null marks the end of the level. */
  read(): Promise<PinnedDirectoryEntry | null>
  /** Create one child relative to the retained parent. */
  createDirectory(name: string): Promise<void>
  /** Refuse a result whose logical parent chain no longer names the retained objects. */
  verify(): Promise<void>
  /** Close after outstanding consumers finish, including an abandoned read. */
  close(): Promise<void>
}

/**
 * Open an authorized canonical directory without following replacement links.
 * @param root - Canonical grant root with its retained filesystem identity.
 * @param target - Canonical path at or below that root, selected by the caller's grant check.
 * @param batchEntries - Entries per asynchronous POSIX read, validated by the plugin configuration.
 * @param signal - Caller lifetime; pending syscalls retain their handles, and subsequent work stops after abort.
 * @returns An owned directory; close queues behind every operation using its handles.
 */
export async function openPinnedDirectory(
  root: DirectoryRoot, target: string, batchEntries: number, signal?: AbortSignal,
): Promise<PinnedDirectory> {
  if (process.platform === 'win32') return openWindowsDirectory(root, target, signal)
  const handles: { path: string; handle: DirectoryHandle }[] = []
  const close = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const { handle } of handles.toReversed()) {
      try { await handle.close() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Directory handle cleanup failed')
  }
  try {
    signal?.throwIfAborted()
    let handle = await DirectoryHandle.open(sep)
    let path: string = sep
    handles.push({ path, handle })
    const verifyRoot = (): void => {
      if (String(handle.identity.device) !== root.identity.device || String(handle.identity.inode) !== root.identity.inode) {
        throw new Error('Authorized directory root was replaced')
      }
    }
    for (const part of root.path.split(sep).filter(Boolean)) {
      signal?.throwIfAborted()
      handle = await handle.openChild(part)
      path = join(path, part)
      handles.push({ path, handle })
    }
    verifyRoot()
    for (const part of relative(root.path, target).split(sep).filter(Boolean)) {
      signal?.throwIfAborted()
      handle = await handle.openChild(part)
      path = join(path, part)
      handles.push({ path, handle })
    }
    const directory = handle
    signal?.throwIfAborted()
    let batch: PinnedDirectoryEntry[] = [], offset = 0
    return retainDirectory({
      read: async () => {
        signal?.throwIfAborted()
        if (offset === batch.length) { batch = await directory.read(batchEntries); offset = 0 }
        return batch[offset++] ?? null
      },
      createDirectory: name => directory.createDirectory(name),
      verify: async () => {
        for (const { path, handle } of handles) {
          signal?.throwIfAborted()
          const info = await lstat(path, { bigint: true })
          if (!info.isDirectory() || info.dev !== handle.identity.device || info.ino !== handle.identity.inode) {
            throw new Error('Authorized directory parent was replaced')
          }
        }
      },
    }, close)
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Directory open and cleanup failed') }
    throw error
  }
}
