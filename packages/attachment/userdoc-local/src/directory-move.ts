/** Directory moves retain their parent objects and atomically refuse occupied destinations, including on Linux musl. */
import { constants, fstat, fsync, close, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { getSystemErrorName } from 'node:util'
import type { KoffiFunc } from 'koffi'
import type { DocumentFileObjectId } from './file-object.ts'
import { withWindowsDirectoryMove } from './directory-move-win32.ts'

/** Borrowed move capability whose parent handles remain open until its callback settles. */
export interface DocumentDirectoryMove {
  /** Whether the native rename completed, including when a later sync or validation fails. */
  readonly renamed: boolean
  /** Recheck the lexical root and every opened parent against their original directory objects. */
  verify(): Promise<void>
  /** Move the source without replacing any existing destination. */
  rename(): Promise<void>
  /** Persist the opened parent directory entries before committing recovered metadata. */
  sync(): Promise<void>
}

interface PinnedDirectory {
  readonly path: string
  readonly fd: number
  readonly identity: DocumentFileObjectId
}

type RenameArguments = [sourceDirectory: number, source: string, targetDirectory: number, target: string, flags: number]

/** Linux exclusive-rename syscall numbers for the supported 64-bit application ABIs. */
const linuxRenameAt2: Readonly<Partial<Record<NodeJS.Architecture, number>>> = { arm64: 276, x64: 316 }

/** A directory root and, when managed, its retained kernel identity. */
export interface DocumentDirectoryMoveRoot {
  readonly path: string
  readonly identity?: DocumentFileObjectId
}

function identity(info: BigIntStats): DocumentFileObjectId {
  /* v8 ignore next -- the refusal triple is pinned by POSIX-gated move suites; win32 never hands this impl a stat. */
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) throw new Error('Document move requires a real directory.')
  return { device: String(info.dev), inode: String(info.ino) }
}

function same(left: DocumentFileObjectId, right: DocumentFileObjectId): boolean {
  return left.device === right.device && left.inode === right.inode
}

function statDescriptor(fd: number): Promise<BigIntStats> {
  return new Promise((accept, reject) => {
    fstat(fd, { bigint: true }, (error, info) => { if (error === null) accept(info); else reject(error) })
  })
}

function closeDescriptor(fd: number): Promise<void> {
  return new Promise((accept, reject) => {
    close(fd, (error) => { if (error === null) accept(); else reject(error) })
  })
}

function syncDescriptor(fd: number): Promise<void> {
  return new Promise((accept, reject) => {
    fsync(fd, (error) => { if (error === null) accept(); else reject(error) })
  })
}

/**
 * Retain parents while validating and performing a directory move.
 * @param root - canonical public document root.
 * @param source - existing non-root directory below the root.
 * @param target - non-root destination below the root.
 * @param operation - awaited work borrowing the move capability; must not retain it after returning.
 * @param expectedRoot - managed root identity; when absent, bind to the directory opened by this operation.
 * @returns the operation result after every acquired handle and native library closes.
 */
export async function withDocumentDirectoryMove<T>(
  root: string, source: string, target: string, operation: (move: DocumentDirectoryMove) => Promise<T>,
  expectedRoot?: DocumentFileObjectId,
): Promise<T> {
  const selectedRoot = { path: root, ...(expectedRoot === undefined ? {} : { identity: expectedRoot }) }
  return withDocumentDirectoryMoveRoots(selectedRoot, source, selectedRoot, target, operation)
}

/**
 * Retain both roots and parents for an exclusive move between public and private storage.
 * @param sourceRoot - source namespace and optional managed root identity.
 * @param source - non-root source below sourceRoot.
 * @param targetRoot - destination namespace and optional managed root identity.
 * @param target - non-root destination below targetRoot on the same filesystem.
 * @param operation - awaited borrower of the move; it must not retain the capability.
 * @returns the callback result after native handles and library close.
 */
export async function withDocumentDirectoryMoveRoots<T>(
  sourceRoot: DocumentDirectoryMoveRoot, source: string, targetRoot: DocumentDirectoryMoveRoot, target: string,
  operation: (move: DocumentDirectoryMove) => Promise<T>,
): Promise<T> {
  const selected = [
    { root: resolve(sourceRoot.path), path: resolve(source), identity: sourceRoot.identity },
    { root: resolve(targetRoot.path), path: resolve(target), identity: targetRoot.identity },
  ] as const
  for (const { root, path } of selected) {
    const entry = relative(root, path)
    if (entry === '' || entry === '..' || entry.startsWith(`..${sep}`) || isAbsolute(entry)) {
      throw new Error('Document directory move must remain below its root.')
    }
  }
  if (process.platform === 'win32') return withWindowsDirectoryMove(resolve(sourceRoot.path), source, target, operation,
    sourceRoot.identity, resolve(targetRoot.path), targetRoot.identity)
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Exclusive document directory moves are unavailable on this platform.')

  const koffi = (await import('koffi')).default
  const library = koffi.load(null)
  const directories: PinnedDirectory[] = []
  const cleanups: (() => Promise<void>)[] = []
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  try {
    const openAt = library.func('int openat(int directory, str path, int flags)') as KoffiFunc<(directory: number, path: string, flags: number) => number>
    const name = process.platform === 'darwin' ? 'renameatx_np' : 'renameat2'
    const native = <Args extends unknown[]>(
      call: KoffiFunc<(...args: Args) => number>, args: Args, syscall: string, path: string,
    ): Promise<number> => new Promise((accept, reject) => {
      call.async(...args, (error: unknown, result: number) => {
        const errno = koffi.errno()
        if (error !== null) reject(error instanceof Error ? error : new Error('Native directory operation failed.', { cause: error }))
        else if (result < 0) {
          /* v8 ignore next -- koffi reports a named errno only on POSIX; its refusal suites gate off win32. */
          const code = errno > 0 ? getSystemErrorName(-errno) : 'EIO'
          reject(Object.assign(new Error(`${syscall} ${code}: ${path}`), { code, errno: -errno, syscall, path }))
        } else accept(result)
      })
    })
    const syscallNumber = process.platform === 'linux' ? linuxRenameAt2[process.arch] : undefined
    let renameAt: (args: RenameArguments, path: string) => Promise<number>
    if (syscallNumber === undefined) {
      const call = library.func(`int ${name}(int sourceDirectory, str source, int targetDirectory, str target, uint flags)`) as KoffiFunc<(...args: RenameArguments) => number>
      renameAt = (args, path) => native(call, args, name, path)
    } else {
      const call = library.func('long syscall(long number, long sourceDirectory, str source, long targetDirectory, str target, long flags)') as KoffiFunc<
        (number: number, ...args: RenameArguments) => number
      >
      renameAt = (args, path) => native(call, [syscallNumber, ...args], name, path)
    }
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    const pinParent = async ({ root, path, identity: expectedRoot }: typeof selected[number]): Promise<PinnedDirectory> => {
      let parent = directories.find(directory => directory.path === root)
      if (parent === undefined) {
        const rootHandle = await open(root, flags)
        cleanups.push(() => rootHandle.close())
        parent = { path: root, fd: rootHandle.fd, identity: identity(await rootHandle.stat({ bigint: true })) }
        directories.push(parent)
      }
      /* v8 ignore next -- a changed root needs POSIX fd identity to observe; the refusal is gated to those suites. */
      if (expectedRoot !== undefined && !same(parent.identity, expectedRoot)) throw new Error('Document root changed before its directory move.')
      for (const segment of relative(root, dirname(path)).split(sep).filter(Boolean)) {
        const childPath = resolve(parent.path, segment)
        const existing = directories.find(directory => directory.path === childPath)
        if (existing !== undefined) { parent = existing; continue }
        const fd = await native(openAt, [parent.fd, segment, flags], 'openat', childPath)
        cleanups.push(() => closeDescriptor(fd))
        const pinned: PinnedDirectory = { path: childPath, fd, identity: identity(await statDescriptor(fd)) }
        directories.push(pinned)
        parent = pinned
      }
      return parent
    }
    const fromParent = await pinParent(selected[0]), toParent = await pinParent(selected[1])
    const verify = async (): Promise<void> => {
      for (const directory of directories) {
        if (!same(directory.identity, identity(await lstat(directory.path, { bigint: true })))) {
          throw new Error('Document parent changed during its directory move.')
        }
      }
    }
    let renamed = false
    const sync = async (): Promise<void> => {
      for (const parent of new Set([fromParent, toParent])) await syncDescriptor(parent.fd)
    }
    const move = async (): Promise<void> => {
      const fromPath = selected[0].path, toPath = selected[1].path
      await verify()
      await renameAt([fromParent.fd, basename(fromPath), toParent.fd, basename(toPath), process.platform === 'darwin' ? 4 : 1], fromPath)
      renamed = true
      await sync()
    }
    await verify()
    const value = await operation({ get renamed() { return renamed }, verify, rename: move, sync })
    outcome = { ok: true, value }
  } catch (error) { outcome = { ok: false, error } }
  const failures: unknown[] = []
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  try { library.unload() } catch (error) { failures.push(error) }
  if (failures.length > 0) {
    if (!outcome.ok) failures.unshift(outcome.error)
    throw new AggregateError(failures, 'Document directory move and handle cleanup failed.')
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
