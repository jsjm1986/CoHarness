/**
 * Cross-process write-ownership lock for one session, held for the whole life
 * of a write handle. The arbiter is the kernel: POSIX takes a non-blocking
 * `flock(2)` via native system support on a lock file under the root's
 * `.locks/` directory, and Windows holds a named kernel semaphore derived
 * from that path — never a file lock or handle, so readers, searches, and
 * directory removal proceed freely while the lock is held. Contention maps
 * to `SessionAlreadyOwnedError`; the kernel releases the lock when the
 * holder's descriptor or last object handle closes, including on any process
 * death, so a crashed holder never blocks a successor. A live but wedged
 * holder keeps the lock until its process exits: there is deliberately no
 * expiry that could expropriate a stalled writer whose resumed appends would
 * tear the log.
 * A POSIX lock names an inode, not a path, so after locking the holder
 * verifies the locked inode is still the file at the lock path and retries
 * otherwise: an unlinked-and-recreated lock file carries a fresh inode, and
 * a lock on the orphaned one proves nothing. Removing a live session's lock
 * file therefore forfeits exclusion on POSIX (nothing in the harness does
 * so); Windows has no lock file at all. Readers never touch the lock.
 * The lock file also carries a `{pid}` record for one reason: the mechanism
 * this replaced locked by creating that file and probing the recorded pid.
 * A file left by such a legacy holder is refused while its pid is alive and
 * taken over once it is dead — and a held lock rewrites the record so a
 * legacy contender still sees a live owner instead of a missing file. A
 * legacy file with a dead or unreadable record is safe to lock in place: a
 * kernel-lock holder always has a live pid, so a dead record can only be
 * legacy residue. New acquisitions write the record before publishing.
 * Release never removes the POSIX lock file: keeping it preserves the stable
 * inode later lockers verify against, and an unlocked file excludes nobody.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { mkdir, open, readFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** Base name of the kernel lock file inside a session's directory. */
export const LEASE_FILENAME = 'session.lock'

/** The held kernel lock: a POSIX descriptor or a Win32 semaphore handle. */
type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) reports EAGAIN; some libcs spell it EWOULDBLOCK.
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/** The pid record a legacy create-and-probe lock file carries. */
function legacyPidRecord(content: string): number | undefined {
  try {
    const pid = (JSON.parse(content) as { pid?: unknown }).pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a recorded legacy pid still names a live process on this machine. */
function legacyPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means the process exists but is owned by another user: still live.
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

/**
 * One held write lock. Constructed only by {@link SessionWriteLease.acquire};
 * `release` closes the descriptor or handle, which is what releases the lock.
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /**
   * Acquire the kernel write lock on `join(dir, filename)`, creating `dir` and
   * the lock file as needed.
   * @param dir - the directory holding the lock file (created if absent).
   * @param id - the session the lock guards, for error identities.
   * @param filename - the lock file's base name inside `dir`.
   * @returns the held lock.
   * @throws {SessionAlreadyOwnedError} while another holder — kernel-lock or
   *   live legacy pid record — keeps the lock.
   */
  static async acquire(dir: string, id: SessionId, filename = LEASE_FILENAME): Promise<SessionWriteLease> {
    const path = join(dir, filename)
    // Owner-only like materializePosix's directories: the lock may create the
    // directory first, and both creators must agree on the mode.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      let handle: number
      try {
        handle = await acquireLockHandleWin32(path)
      } catch (error: unknown) {
        // Sharing violation: another handle already holds the write exclusion.
        if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new SessionAlreadyOwnedError(id)
        throw error
      }
      return new SessionWriteLease({ kind: 'win32', handle })
    }
    /* v8 ignore stop */
    // Bounded retry: locking an inode a releasing creator just unlinked (or a
    // recreated path) re-opens the fresh file; steady state needs one pass.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Create-exclusively so an existing file is classified, not truncated:
      // it may be a legacy pid lock whose live owner must be refused, or a
      // kernel-lock file whose holder the flock below arbitrates.
      let handle = await open(path, 'wx').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return undefined
        throw error
      })
      if (handle === undefined) {
        // A live pid record names a holder that never flocks — a legacy
        // create-and-probe writer — or a kernel-lock holder; either refuses
        // this acquire. The record may also be residue this same process left
        // on release, in which case only the flock below arbitrates.
        const legacyPid = legacyPidRecord(await readFile(path, 'utf8').catch(() => ''))
        if (legacyPid !== undefined && legacyPid !== process.pid && legacyPidAlive(legacyPid)) {
          throw new SessionAlreadyOwnedError(id)
        }
        handle = await open(path, 'w')
      }
      try {
        try {
          await tryLockExclusive(handle.fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        // Publish the holder pid so a legacy create-and-probe contender sees a
        // live owner instead of residue it might unlink under the flock.
        await handle.writeFile(JSON.stringify({ pid: process.pid }))
        const held = await handle.stat({ bigint: true })
        const current = await stat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new SessionWriteLease({ kind: 'posix', handle })
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      // The locked inode is no longer the file at the lock path: start over
      // against whatever now stands there.
      await handle.close()
    }
    throw new SessionAlreadyOwnedError(id)
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. The POSIX
   * lock file is never removed: every acquired lock belongs to a
   * materialized or materializing session, and keeping the file preserves
   * the stable inode later lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}
