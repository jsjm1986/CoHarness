/** Explicit file owners must be assigned before an atomic replacement or lock becomes usable. */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({
  calls: [] as string[], failure: undefined as Error | undefined,
  collision: false, writeFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined, cleanupFailure: undefined as Error | undefined,
  renameFailure: undefined as Error | undefined, realOwner: false,
}))

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, randomBytes: (size: number) => state.collision ? Buffer.alloc(size) : actual.randomBytes(size) }
})

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (state.renameFailure !== undefined) throw state.renameFailure
      return actual.rename(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (state.cleanupFailure !== undefined && String(args[0]).endsWith('.tmp')) throw state.cleanupFailure
      return actual.rm(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const chown = handle.chown.bind(handle), close = handle.close.bind(handle)
      vi.spyOn(handle, 'chown').mockImplementation(async (uid, gid) => {
        state.calls.push(String(args[0]))
        if (state.failure !== undefined) throw state.failure
        if (state.realOwner) await chown(uid, gid)
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        if (state.closeFailure !== undefined) throw state.closeFailure
      })
      const write = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...input) => {
        if (state.writeFailure !== undefined) {
          await write('partial')
          throw state.writeFailure
        }
        await write(...input)
      })
      return handle
    },
  }
})

afterEach(() => {
  state.calls.length = 0; state.failure = undefined; state.collision = false; state.writeFailure = undefined
  state.closeFailure = undefined; state.cleanupFailure = undefined; state.renameFailure = undefined; state.realOwner = false
  vi.restoreAllMocks()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-owner-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, target: join(root, 'state.json'), owner: { uid: 12345, gid: 12345 } }
}

it('assigns the requested owner before replacing the old document', async () => {
  const f = await fixture()
  await writeFile(f.target, 'old')
  await writeFileAtomic(f.target, 'new', { mode: 0o600, owner: f.owner })
  expect(state.calls).toHaveLength(1)
  expect(await readFile(f.target, 'utf8')).toBe('new')
})

it('retains the old document and removes its temporary file when ownership fails', async () => {
  const f = await fixture()
  await writeFile(f.target, 'old')
  const failure = state.failure = new Error('ownership denied')
  await expect(writeFileAtomic(f.target, 'new', { mode: 0o600, owner: f.owner })).rejects.toBe(failure)
  expect(await readFile(f.target, 'utf8')).toBe('old')
  expect(await readdir(f.root)).toEqual(['state.json'])
})

it('assigns lock ownership before entering the operation', async () => {
  const f = await fixture()
  await withFileLock(f.target, async () => {
    expect(state.calls).toEqual([`${f.target}.lock`])
  }, { owner: f.owner })
  expect(await readdir(f.root)).toEqual([])
})

it('removes an unassigned lock and preserves the ownership failure', async () => {
  const f = await fixture(), operation = vi.fn(async () => undefined)
  const failure = state.failure = new Error('ownership denied')
  await expect(withFileLock(f.target, operation, { owner: f.owner })).rejects.toBe(failure)
  expect(operation).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
})

it('retains an occupied temporary file when its exclusive create fails', async () => {
  const f = await fixture(), occupied = `${f.target}.000000000000.tmp`
  await writeFile(f.target, 'old')
  await writeFile(occupied, 'another writer')
  state.collision = true
  await expect(writeFileAtomic(f.target, 'new', { mode: 0o600 })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(occupied, 'utf8')).toBe('another writer')
  expect(await readFile(f.target, 'utf8')).toBe('old')
})

it('removes an exclusively acquired temporary file after a partial write fails', async () => {
  const f = await fixture(), failure = state.writeFailure = new Error('partial write failed')
  await writeFile(f.target, 'old')
  await expect(writeFileAtomic(f.target, 'new', { mode: 0o600 })).rejects.toBe(failure)
  expect(await readFile(f.target, 'utf8')).toBe('old')
  expect(await readdir(f.root)).toEqual(['state.json'])
})

it('retains independent write, close and temporary-file cleanup failures', async () => {
  const f = await fixture(), write = state.writeFailure = new Error('write failed')
  const close = state.closeFailure = new Error('close failed'), cleanup = state.cleanupFailure = new Error('cleanup failed')
  await writeFile(f.target, 'old')
  await expect(writeFileAtomic(f.target, 'new', { mode: 0o600 })).rejects.toMatchObject({ errors: [write, close, cleanup] })
  expect(await readFile(f.target, 'utf8')).toBe('old')
  const [partial] = (await readdir(f.root)).filter(name => name.endsWith('.tmp'))
  expect(await readFile(join(f.root, partial!), 'utf8')).toBe('partial')
})

it('retains both replacement and cleanup failures with the complete temporary bytes', async () => {
  const f = await fixture(), rename = state.renameFailure = new Error('replace failed')
  const cleanup = state.cleanupFailure = new Error('cleanup failed')
  await writeFile(f.target, 'old')
  await expect(writeFileAtomic(f.target, 'new', { mode: 0o600 })).rejects.toMatchObject({ errors: [rename, cleanup] })
  expect(await readFile(f.target, 'utf8')).toBe('old')
  const [partial] = (await readdir(f.root)).filter(name => name.endsWith('.tmp'))
  expect(await readFile(join(f.root, partial!), 'utf8')).toBe('new')
})

it('cleans an incomplete lock record before another writer enters', async () => {
  const f = await fixture(), write = state.writeFailure = new Error('write failed')
  const operation = vi.fn(async () => 'committed')
  await expect(withFileLock(f.target, operation)).rejects.toBe(write)
  expect(operation).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
  state.writeFailure = undefined
  await expect(withFileLock(f.target, operation)).resolves.toBe('committed')
})

it('assigns the requested owner to both recovery claims and a successor lock', async () => {
  const f = await fixture(), absentPid = 2000000000
  const kill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === absentPid) throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    return kill(pid, signal)
  })
  await writeFile(`${f.target}.lock`, `${absentPid}\n`)
  await withFileLock(f.target, async () => {
    expect(state.calls[0]).toContain('.lock.takeover-')
    expect(state.calls[1]).toBe(`${f.target}.lock`)
  }, { owner: f.owner })
  expect(await readdir(f.root)).toEqual([])
})

it.skipIf(process.platform === 'win32')('applies the current POSIX account to a real replacement inode', async () => {
  const f = await fixture(), account = userInfo()
  state.realOwner = true
  await writeFileAtomic(f.target, 'new', { mode: 0o600, owner: { uid: account.uid, gid: account.gid } })
  const info = await stat(f.target)
  expect({ uid: info.uid, gid: info.gid, mode: info.mode & 0o777 }).toEqual({ uid: account.uid, gid: account.gid, mode: 0o600 })
})
