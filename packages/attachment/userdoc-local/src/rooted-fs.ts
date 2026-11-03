/** Pin document parent directories while a filesystem operation uses their names. */

import { constants } from 'node:fs'
import { open, realpath, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const FD_PATH = process.platform === 'linux' ? '/proc/self/fd' : undefined

/** Paths held through opened parent descriptors for one operation. */
export interface RootedDocumentPaths {
  /** One path per input, in the same order, held through its opened parent descriptor. */
  readonly paths: readonly string[]
  /** Prove every lexical path still resolves below the same root and directory objects. */
  verify(): Promise<void>
  /** Remove a leaf relative to its pinned parent directory. */
  unlink(index: number): Promise<void>
  /** Remove an empty directory relative to its pinned parent directory. */
  rmdir(index: number): Promise<void>
}

/**
 * Keep document operations inside the directory objects opened below `root`.
 * Linux uses procfs descriptor paths because Node path operations do not expose
 * `*at` syscalls. Other platforms retain their existing same-account path behavior.
 * @param root - absolute document root.
 * @param paths - absolute paths whose parent directories must remain pinned.
 * @param operation - filesystem operation using the pinned paths.
 * @returns the callback result after descriptor cleanup.
 */
export async function withRootedDocumentPaths<T>(
  root: string,
  paths: readonly string[],
  operation: (rooted: RootedDocumentPaths) => Promise<T>,
): Promise<T> {
  if (FD_PATH === undefined) {
    return operation({
      paths,
      verify: async () => {},
      unlink: async (index) => {
        const path = paths[index]
        if (path === undefined) throw new RangeError('Document path index is outside the operation.')
        await unlink(path)
      },
      rmdir: async (index) => {
        const path = paths[index]
        if (path === undefined) throw new RangeError('Document path index is outside the operation.')
        await rmdir(path)
      },
    })
  }
  const resolvedRoot = resolve(root)
  const rootHandle = await open(resolvedRoot, DIRECTORY_FLAGS)
  const handles: FileHandle[] = [rootHandle]
  const pathParents: FileHandle[] = []
  let outcome: { readonly kind: 'success'; readonly value: T } | { readonly kind: 'failure'; readonly error: unknown } | undefined
  try {
    const rootedPaths: string[] = []
    for (const path of paths) {
      const resolvedPath = resolve(path)
      const relativePath = relative(resolvedRoot, resolvedPath)
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('Document operation path lies outside its pinned root.')
      }
      const segments = relativePath === '' ? [] : relativePath.split(sep)
      let parent = rootHandle
      for (const segment of segments.slice(0, -1)) {
        const child = await open(`${FD_PATH}/${String(parent.fd)}/${segment}`, DIRECTORY_FLAGS)
        handles.push(child)
        parent = child
      }
      pathParents.push(parent)
      rootedPaths.push(segments.length === 0
        ? `${FD_PATH}/${String(rootHandle.fd)}`
        : `${FD_PATH}/${String(parent.fd)}/${basename(resolvedPath)}`)
    }
    const verify = async (): Promise<void> => {
      const canonicalRoot = await realpath(resolvedRoot)
      const parentPaths = paths.map(path => resolve(path) === resolvedRoot ? resolvedRoot : dirname(resolve(path)))
      const canonicalParents = await Promise.all(parentPaths.map(path => realpath(path)))
      const rootInfo = await rootHandle.stat({ bigint: true })
      const currentRootInfo = await stat(resolvedRoot, { bigint: true })
      if (rootInfo.dev !== currentRootInfo.dev || rootInfo.ino !== currentRootInfo.ino) {
        throw new Error('Document root changed during a filesystem operation.')
      }
      for (let index = 0; index < paths.length; index += 1) {
        const canonicalParent = canonicalParents[index]
        if (canonicalParent === undefined) throw new Error('Document canonical parent path is missing.')
        const relativeParent = relative(canonicalRoot, canonicalParent)
        if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
          throw new Error('Document parent changed outside its pinned root.')
        }
        const handle = pathParents[index]
        if (handle === undefined) throw new Error('Document parent descriptor is missing.')
        const openedInfo = await handle.stat({ bigint: true })
        const parentPath = parentPaths[index]
        if (parentPath === undefined) throw new Error('Document parent path is missing.')
        const currentInfo = await stat(parentPath, { bigint: true })
        if (openedInfo.dev !== currentInfo.dev || openedInfo.ino !== currentInfo.ino) {
          throw new Error('Document parent changed during a filesystem operation.')
        }
      }
    }
    outcome = { kind: 'success', value: await operation({
      paths: rootedPaths,
      verify,
      unlink: async (index) => {
        const path = rootedPaths[index]
        if (path === undefined) throw new RangeError('Document path index is outside the operation.')
        await unlink(path)
      },
      rmdir: async (index) => {
        const path = rootedPaths[index]
        if (path === undefined) throw new RangeError('Document path index is outside the operation.')
        await rmdir(path)
      },
    }) }
  } catch (error) {
    outcome = { kind: 'failure', error }
  } finally {
    const closeFailures: unknown[] = []
    for (const handle of handles.reverse()) {
      try { await handle.close() } catch (error) { closeFailures.push(error) }
    }
    if (closeFailures.length > 0) {
      const error = outcome?.kind === 'failure' ? outcome.error : undefined
      outcome = {
        kind: 'failure',
        error: error === undefined
          ? new AggregateError(closeFailures, 'Document parent descriptor cleanup failed.')
          : new AggregateError([error, ...closeFailures], 'Document operation and descriptor cleanup failed.'),
      }
    }
  }
  if (outcome?.kind === 'failure') throw outcome.error
  if (outcome === undefined) throw new Error('Document filesystem operation did not complete.')
  return outcome.value
}
