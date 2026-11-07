/** Serialize consumers before releasing the directory objects they borrow. */
import type { PinnedDirectory } from './pinned-directory.ts'

/**
 * Retain a directory's resources through every previously admitted operation.
 * @param operations - Filesystem operations on the retained directory objects.
 * @param release - Release all owned handles after consumers settle.
 * @returns A capability with idempotent close and refusal of work after close begins.
 */
export function retainDirectory(operations: Omit<PinnedDirectory, 'close'>, release: () => Promise<void>): PinnedDirectory {
  let pending: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) return Promise.reject(new Error('Directory is closed'))
    const result = pending.then(operation)
    // Keep completion only; results and failures remain owned by their callers.
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    read: () => run(() => operations.read()),
    createDirectory: name => run(() => operations.createDirectory(name)),
    verify: () => run(() => operations.verify()),
    close: () => closing ??= pending.then(release),
  }
}
