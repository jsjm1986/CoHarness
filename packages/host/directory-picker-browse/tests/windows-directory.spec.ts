/** Windows ownership is exercised through deterministic native-call doubles on every CI host. */
import { lstat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openWindowsDirectory } from '../src/pinned-directory-win32.ts'
import { openPinnedDirectory } from '../src/pinned-directory.ts'
import type { DirectoryRoot, PinnedDirectory } from '../src/pinned-directory.ts'
import type { WindowsDirectoryCalls } from '../src/windows-directory-calls.ts'

const calls = vi.hoisted(() => ({
  openRoot: vi.fn<WindowsDirectoryCalls['openRoot']>(), child: vi.fn<WindowsDirectoryCalls['child']>(),
  identity: vi.fn<WindowsDirectoryCalls['identity']>(), read: vi.fn<WindowsDirectoryCalls['read']>(),
  reader: vi.fn<WindowsDirectoryCalls['reader']>(),
  close: vi.fn<WindowsDirectoryCalls['close']>(), unload: vi.fn<WindowsDirectoryCalls['unload']>(),
}))
vi.mock('../src/windows-directory-calls.ts', () => ({ loadWindowsDirectoryCalls: async () => calls }))
vi.mock('node:fs/promises', () => ({ lstat: vi.fn() }))

const paths = new Map<string, string>(), levels: PinnedDirectory[] = []
const grant: DirectoryRoot = { path: 'C:\\owned', identity: { device: '7', inode: '42' } }
let counter = 0
function inode(path: string): string { return path === grant.path ? '42' : String(path.length + 100) }
beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset()
  vi.mocked(lstat).mockReset()
  paths.clear(); counter = 0
  const keep = (path: string): number => { const handle = ++counter; paths.set(String(handle), path); return handle }
  calls.openRoot.mockImplementation(async path => keep(path.startsWith('\\\\?\\UNC\\') ? '\\\\' + path.slice(8) : path.slice(4)))
  calls.child.mockImplementation(async (parent, name) => keep(win32.join(paths.get(String(parent)) ?? '', name)))
  calls.reader.mockImplementation(async parent => keep(paths.get(String(parent)) ?? ''))
  calls.identity.mockImplementation(async handle => ({ device: '7', inode: inode(paths.get(String(handle)) ?? '') }))
  calls.read.mockResolvedValue(null)
  calls.close.mockResolvedValue()
  vi.mocked(lstat).mockImplementation(async path => ({ dev: 7n, ino: BigInt(inode(String(path))),
    isDirectory: () => true, isSymbolicLink: () => false }) as Awaited<ReturnType<typeof lstat>>)
})
afterEach(async () => {
  const closed = await Promise.allSettled(levels.splice(0).map(level => level.close()))
  const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'Windows directory fixture cleanup failed')
})
async function open(target = 'C:\\owned\\nested'): Promise<PinnedDirectory> {
  const level = await openWindowsDirectory(grant, target); levels.push(level); return level
}

it('walks one component at a time and uses the selected handle for reads and creation', async () => {
  const level = await open()
  expect(calls.openRoot).toHaveBeenCalledWith('\\\\?\\C:\\')
  expect(calls.child.mock.calls).toEqual([[1, 'owned', false], [2, 'nested', false]])
  calls.read.mockResolvedValueOnce([]).mockResolvedValueOnce([
    { name: 'child', isDirectory: true, isSymbolicLink: false },
    { name: 'link', isDirectory: false, isSymbolicLink: true },
  ])
  expect(await level.read()).toMatchObject({ name: 'child' })
  expect(await level.read()).toMatchObject({ name: 'link' })
  expect(await level.read()).toBeNull()
  expect(await level.read()).toBeNull()
  expect(calls.reader.mock.calls).toEqual([[3]])
  expect(calls.read.mock.calls).toEqual([[4], [4], [4]])
  await level.createDirectory('created')
  expect(calls.child).toHaveBeenLastCalledWith(3, 'created', true)
  await level.verify(); await level.close()
  expect(calls.close.mock.calls).toEqual([[5], [4], [3], [2], [1]])
  expect(calls.unload).toHaveBeenCalledOnce()
})

it('does not release handles or libraries while a departed reader is still pending', async () => {
  const began = Promise.withResolvers<undefined>(), release = Promise.withResolvers<null>()
  calls.read.mockImplementationOnce(() => { began.resolve(undefined); return release.promise })
  const level = await open(), reading = level.read()
  await began.promise
  try {
    const closing = level.close()
    expect(level.close()).toBe(closing)
    expect(calls.close).not.toHaveBeenCalled(); expect(calls.unload).not.toHaveBeenCalled()
    await expect(level.verify()).rejects.toThrow('closed')
    release.resolve(null)
    expect(await reading).toBeNull()
    await closing
    expect(calls.unload).toHaveBeenCalledOnce()
  } finally { release.resolve(null); await Promise.allSettled([reading, level.close()]) }
})

it('refuses a replaced grant object and releases every acquired parent', async () => {
  calls.identity.mockResolvedValue({ device: '7', inode: '999' })
  await expect(open()).rejects.toThrow('root was replaced')
  expect(calls.close.mock.calls).toEqual([[2], [1]])
  expect(calls.read).not.toHaveBeenCalled(); expect(calls.unload).toHaveBeenCalledOnce()
})

it('refuses a target that never opens the authorized root', async () => {
  await expect(open('C:\\foreign')).rejects.toThrow('root was not opened')
  expect(calls.close.mock.calls).toEqual([[2], [1]])
})

it('refuses reparse or unavailable parents without a path-based fallback', async () => {
  calls.child.mockRejectedValueOnce(new Error('reparse encountered'))
  await expect(open()).rejects.toThrow('reparse encountered')
  expect(calls.close.mock.calls).toEqual([[1]])
  expect(calls.read).not.toHaveBeenCalled()
})

it('keeps a read failure visible while still closing every parent', async () => {
  calls.read.mockRejectedValueOnce(new Error('native read unavailable'))
  const level = await open()
  await expect(level.read()).rejects.toThrow('native read unavailable')
  await level.close()
  expect(calls.close).toHaveBeenCalledTimes(4)
})

it.each(['directory', 'link', 'device', 'inode'] as const)('refuses a changed %s during logical-path verification', async (kind) => {
  const level = await open()
  vi.mocked(lstat).mockResolvedValueOnce({ dev: kind === 'device' ? 8n : 7n, ino: kind === 'inode' ? 999n : 103n,
    isDirectory: () => kind !== 'directory' && kind !== 'link', isSymbolicLink: () => kind === 'link' } as Awaited<ReturnType<typeof lstat>>)
  await expect(level.verify()).rejects.toThrow('parent was replaced')
})

it('aggregates open and cleanup failures while still unloading the native libraries', async () => {
  calls.child.mockRejectedValueOnce(new Error('child open failed'))
  calls.close.mockRejectedValueOnce(new Error('parent close failed'))
  calls.unload.mockImplementationOnce(() => { throw new Error('library unload failed') })
  const error = await open().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toHaveLength(2)
  expect(calls.unload).toHaveBeenCalledOnce()
})

it('accepts a share root grant without requiring a child below it', async () => {
  const path = '\\\\server\\share\\', nativeRoot = await openWindowsDirectory({ path, identity: { device: '7', inode: inode(path) } }, path)
  levels.push(nativeRoot)
  expect(calls.child).not.toHaveBeenCalled()
  await nativeRoot.verify()
})

it('selects the Windows implementation through the common granted-directory entry', async () => {
  vi.stubGlobal('process', new Proxy(process, { get: (target, key, receiver): unknown => key === 'platform' ? 'win32' : Reflect.get(target, key, receiver) }))
  try {
    const level = await openPinnedDirectory(grant, 'C:\\owned\\nested', 1)
    levels.push(level)
    expect(await level.read()).toBeNull()
    expect(calls.openRoot).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
