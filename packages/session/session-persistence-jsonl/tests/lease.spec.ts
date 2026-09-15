/**
 * Cross-process write-lock behavior for the kernel lease: exclusion while a
 * holder is live, admission after release, the inode verification that defeats
 * an unlinked-and-recreated lock path, and takeover of the `{pid}` lock file
 * the create-and-probe mechanism this replaced left behind. Filesystem and
 * flock refusals are injected through the module mocks below — POSIX modes
 * cannot express them portably, and an injected error is the only deterministic
 * cross-platform refusal. Real two-process exclusion and crash release are
 * pinned by lease.two-process.e2e.ts.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionWriteLease } from '../src/lease.ts'
import { encodeSegment } from '../src/format.ts'

// The lock's directory name, duplicated for the hoisted mock factories: they run
// while `../src/lease.ts` is still evaluating.
const LOCKS = vi.hoisted(() => '.locks')

const refuse = vi.hoisted(() => ({
  /** Next open of a lock file fails EACCES (read-only directory). */
  lockOpen: false,
  /** Next flock call fails EACCES (a non-contention kernel refusal). */
  flock: false,
  /** Next flock call fails EWOULDBLOCK. */
  flockBusy: false,
  /** Next stat of a lock file fails EACCES (unreadable path). */
  lockStat: false,
  /** For N further lock-path stats: unlink and recreate the file first, so the locked inode is orphaned. */
  swapLockOnStat: 0,
  /** Next lock-path stat: unlink the file first, so the verify read finds nothing. */
  dropLockOnStat: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (syscall: string): never => {
    throw Object.assign(new Error(`EACCES: injected ${syscall} refusal`), { code: 'EACCES' })
  }
  const isLock = (path: unknown): boolean => String(path).startsWith(`${LOCKS}/`) || String(path).includes(`/${LOCKS}/`)
  return {
    ...actual,
    open: (async (path: unknown, ...rest: never[]) => {
      if (refuse.lockOpen && isLock(path)) {
        refuse.lockOpen = false
        denied('open')
      }
      return (actual.open as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.open,
    stat: (async (path: unknown, ...rest: never[]) => {
      const at = String(path)
      if (isLock(at)) {
        if (refuse.lockStat) {
          refuse.lockStat = false
          denied('stat')
        }
        if (refuse.dropLockOnStat) {
          refuse.dropLockOnStat = false
          await actual.unlink(at)
        } else if (refuse.swapLockOnStat > 0) {
          refuse.swapLockOnStat -= 1
          await actual.unlink(at)
          await actual.writeFile(at, '')
        }
      }
      return (actual.stat as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.stat,
  }
})

vi.mock('@deepseek-ai/node-addon-system/flock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return {
    tryLockExclusive: async (fd: number): Promise<void> => {
      if (refuse.flock) {
        refuse.flock = false
        throw Object.assign(new Error('EACCES: injected flock refusal'), { code: 'EACCES' })
      }
      if (refuse.flockBusy) {
        refuse.flockBusy = false
        throw Object.assign(new Error('EWOULDBLOCK: injected contention'), { code: 'EWOULDBLOCK' })
      }
      return actual.tryLockExclusive(fd)
    },
  }
})

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  refuse.lockOpen = false
  refuse.flock = false
  refuse.flockBusy = false
  refuse.lockStat = false
  refuse.swapLockOnStat = 0
  refuse.dropLockOnStat = false
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-lease-'))
  dirs.push(root)
  return root
}

function lockPath(root: string, id: string): string {
  return join(root, LOCKS, `${encodeSegment(SessionId(id))}.lock`)
}

/** The `.locks` directory a root mounts its kernel locks under. */
function locksDir(root: string): string {
  return join(root, LOCKS)
}

/** A pid that names no live process: probe upward until the kernel says so. */
function deadPid(): number {
  for (let pid = process.pid + 2; pid < process.pid + 4096; pid += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return pid
    }
  }
  throw new Error('no dead pid found in probe window')
}

describe('SessionWriteLease', () => {
  it('excludes a second acquire while the holder is live, and admits it after release', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-basic')

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await expect(SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    await held.release()
    const next = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await next.release()
  })

  it('publishes the holder pid record a legacy contender would probe', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-pid-record')

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    const record = JSON.parse(await readFile(lockPath(root, 'lease-pid-record'), 'utf8')) as { pid?: unknown }
    expect(record.pid).toBe(process.pid)
    await held.release()
  })

  it('retries when the locked inode is orphaned before verification', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-inode-swap')
    refuse.swapLockOnStat = 1

    // The first acquire locks an inode that is unlinked and recreated before
    // the verification stat: the retry re-opens the fresh file and holds it.
    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await held.release()
  })

  it('retries when the lock path vanishes before verification', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-inode-drop')
    refuse.dropLockOnStat = true

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await held.release()
  })

  it('reports ownership instead of spinning when every verify races a swap', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-swap-storm')
    refuse.swapLockOnStat = 3

    await expect(SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('takes over a legacy lock file whose recorded pid is dead', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-legacy-dead')
    const path = lockPath(root, 'lease-legacy-dead')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(locksDir(root), { recursive: true })
    await writeFile(path, JSON.stringify({ pid: deadPid(), createdAt: 1 }))

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    // Takeover rewrites the record so a legacy contender sees a live owner.
    const record = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    expect(record.pid).toBe(process.pid)
    await held.release()
  })

  it('refuses a legacy lock file while its recorded pid is alive', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-legacy-live')
    const path = lockPath(root, 'lease-legacy-live')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(locksDir(root), { recursive: true })
    // The test runner's own pid stands in for a live legacy holder.
    await writeFile(path, JSON.stringify({ pid: process.ppid > 1 ? process.ppid : 1, createdAt: 1 }))

    await expect(SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })

  it('locks a residue file that carries no readable record', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-empty-residue')
    const path = lockPath(root, 'lease-empty-residue')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(locksDir(root), { recursive: true })
    await writeFile(path, '')

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await held.release()
  })

  it('keeps the lock file after release and tolerates a second release', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-residue')
    const path = lockPath(root, 'lease-residue')

    const held = await SessionWriteLease.acquire(locksDir(root), id, `${encodeSegment(id)}.lock`)
    await held.release()
    await held.release()

    // The file survives: it pins the inode later lockers verify against, and
    // an unlocked file excludes nobody.
    expect((await import('node:fs')).existsSync(path)).toBe(true)
  })

  it('keeps distinct sessions independently lockable', async () => {
    const root = await freshRoot()
    const a = SessionId('lease-a')
    const b = SessionId('lease-b')

    const first = await SessionWriteLease.acquire(locksDir(root), a, `${encodeSegment(a)}.lock`)
    const second = await SessionWriteLease.acquire(locksDir(root), b, `${encodeSegment(b)}.lock`)
    await first.release()
    await second.release()
  })

  it('propagates a filesystem refusal instead of reporting contention', async () => {
    const root = await freshRoot()
    refuse.lockOpen = true

    await expect(SessionWriteLease.acquire(locksDir(root), SessionId('lease-open-eacces'), 'x.lock'))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('propagates a non-contention flock refusal instead of reporting ownership', async () => {
    const root = await freshRoot()
    refuse.flock = true

    await expect(SessionWriteLease.acquire(locksDir(root), SessionId('lease-flock-eacces'), 'x.lock'))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('maps flock contention to ownership refusal', async () => {
    const root = await freshRoot()
    refuse.flockBusy = true

    await expect(SessionWriteLease.acquire(locksDir(root), SessionId('lease-flock-busy'), 'x.lock'))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })
})

describe('write-handle locking through openHandleAsync', () => {
  it('excludes a second writer instance while the holder is live, and admits it after close', async () => {
    const root = await freshRoot()
    const id = SessionId('lease-handles')

    const firstCtx = new Context()
    contexts.push(firstCtx)
    await firstCtx.plugin(SessionStore)
    await firstCtx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const first = await firstCtx.sessionPersistence.openHandleAsync(id, 'write')

    const secondCtx = new Context()
    contexts.push(secondCtx)
    await secondCtx.plugin(SessionStore)
    await secondCtx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(secondCtx.sessionPersistence.openHandleAsync(id, 'write'))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)

    await first.close()
    const admitted = await secondCtx.sessionPersistence.openHandleAsync(id, 'write')
    await admitted.close()
  })
})
