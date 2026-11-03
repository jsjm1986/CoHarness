/** Native directory-move ABI selection, error transfer and descriptor ownership. */
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { withDocumentDirectoryMove } from '../src/directory-move.ts'
import { withWindowsDirectoryMove } from '../src/directory-move-win32.ts'

const state = vi.hoisted(() => ({
  opened: new Map<number, string>(), closed: [] as number[], calls: [] as { declaration: string; args: unknown[] }[],
  next: 10, unloads: 0, errno: 0, failedCall: '', callbackError: undefined as Error | string | undefined,
  statError: undefined as Error | undefined, closeError: undefined as Error | undefined,
  rootCloseError: undefined as Error | undefined, syncError: undefined as Error | undefined,
  unloadError: undefined as Error | undefined, replaced: false,
}))

function information(fd: number, replacement = false) {
  return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: BigInt(fd + (replacement ? 100 : 0)) }
}

vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
  fstat: (fd: number, _options: unknown, callback: (error: Error | null, info?: unknown) => void) => {
    callback(state.statError ?? null, information(fd))
  },
  fsync: (_fd: number, callback: (error: Error | null) => void) => { callback(state.syncError ?? null) },
  close: (fd: number, callback: (error: Error | null) => void) => {
    state.closed.push(fd); callback(state.closeError ?? null)
  },
}))

vi.mock('node:fs/promises', () => ({
  open: async (path: string) => {
    const fd = state.next++
    state.opened.set(fd, path)
    return { fd, stat: async () => information(fd), close: async () => {
      state.closed.push(fd)
      if (state.rootCloseError !== undefined) throw state.rootCloseError
    } }
  },
  lstat: async (path: string) => {
    const found = [...state.opened].find(([, name]) => name === path)
    if (found === undefined) throw new Error('The directory must be opened before lexical verification.')
    return information(found[0], state.replaced)
  },
}))

vi.mock('koffi', () => ({ default: {
  errno: () => state.errno,
  load: () => ({
    func: (declaration: string) => ({ async: (...args: unknown[]) => {
      const complete = args.pop() as (error: unknown, result: number) => void
      state.calls.push({ declaration, args })
      if (state.callbackError !== undefined) { complete(state.callbackError, -1); return }
      if (declaration.includes(state.failedCall) && state.failedCall !== '') { complete(null, -1); return }
      if (declaration.includes('openat(')) {
        const parent = state.opened.get(Number(args[0]))
        if (parent === undefined) throw new Error('A child must retain its opened parent.')
        const fd = state.next++
        state.opened.set(fd, resolve(parent, String(args[1])))
        complete(null, fd)
      } else complete(null, 0)
    } }),
    unload: () => { state.unloads++; if (state.unloadError !== undefined) throw state.unloadError },
  }),
} }))

vi.mock('../src/directory-move-win32.ts', () => ({ withWindowsDirectoryMove: vi.fn(async () => 'windows-result') }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!
const root = join(tmpdir(), 'virtual-document-native-root')

beforeEach(() => {
  state.opened.clear(); state.closed.length = 0; state.calls.length = 0
  state.next = 10; state.unloads = 0; state.errno = 0; state.failedCall = ''; state.replaced = false
  state.callbackError = undefined; state.statError = undefined; state.closeError = undefined
  state.rootCloseError = undefined; state.syncError = undefined; state.unloadError = undefined
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' })
  vi.mocked(withWindowsDirectoryMove).mockClear()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', architecture)
})

function move<T>(operation: Parameters<typeof withDocumentDirectoryMove<T>>[3]) {
  return withDocumentDirectoryMove(root, join(root, 'parent', 'source'), join(root, 'parent', 'target'), operation)
}

function expectClosed() {
  expect(state.closed).toEqual([...state.opened.keys()].reverse())
  expect(state.unloads).toBe(1)
}

it.each(['arm64', 'x64'] as const)('uses the Linux %s exclusive kernel ABI with retained parents', async (arch) => {
  Object.defineProperty(process, 'arch', { ...architecture, value: arch })
  await expect(move(async (scope) => { await scope.rename(); return scope.renamed })).resolves.toBe(true)
  const call = state.calls.find(entry => entry.declaration.includes('syscall('))
  expect(call?.args).toEqual([arch === 'arm64' ? 276 : 316, 11, 'source', 11, 'target', 1])
  expect(state.calls.filter(entry => entry.declaration.includes('openat('))).toHaveLength(1)
  expectClosed()
})

it('retains the libc binding for Linux architectures without a selected syscall number', async () => {
  Object.defineProperty(process, 'arch', { ...architecture, value: 's390x' })
  await move(scope => scope.rename())
  expect(state.calls.at(-1)?.declaration).toContain('renameat2(')
  expect(state.calls.at(-1)?.args).toEqual([11, 'source', 11, 'target', 1])
  expectClosed()
})

it('retains the macOS exclusive flag and parent descriptors', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  await move(scope => scope.rename())
  expect(state.calls.at(-1)?.declaration).toContain('renameatx_np(')
  expect(state.calls.at(-1)?.args).toEqual([11, 'source', 11, 'target', 4])
  expectClosed()
})

it('delegates Windows roots and the borrowed operation to its handle adapter', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const operation = async () => true
  await expect(move(operation)).resolves.toBe('windows-result')
  expect(withWindowsDirectoryMove).toHaveBeenCalledWith(root, join(root, 'parent', 'source'), join(root, 'parent', 'target'),
    operation, undefined, root, undefined)
  expect(state.unloads).toBe(0)
})

it('refuses a platform without exclusive native moves before acquiring handles', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'freebsd' })
  await expect(move(scope => scope.rename())).rejects.toThrow('unavailable on this platform')
  expect(state.opened.size).toBe(0)
})

it.each([new Error('Native queue failed'), 'Native queue failed'])('retains a native callback failure: %s', async (error) => {
  state.callbackError = error
  await expect(move(scope => scope.rename())).rejects.toSatisfy((failure: Error) => error instanceof Error
    ? failure === error : failure.cause === error)
  expectClosed()
})

it.each([0, 13])('transfers native errno without a replacement fallback: %s', async (errno) => {
  state.failedCall = 'syscall('; state.errno = errno
  await expect(move(scope => scope.rename())).rejects.toMatchObject({ code: errno === 0 ? 'EIO' : 'EACCES', syscall: 'renameat2' })
  expect(state.calls.filter(entry => entry.declaration.includes('syscall('))).toHaveLength(1)
  expectClosed()
})

it('closes an acquired child when descriptor identity reading fails', async () => {
  state.statError = new Error('Descriptor identity unavailable')
  await expect(move(scope => scope.rename())).rejects.toBe(state.statError)
  expectClosed()
})

it('reports an object replacement while retaining both parent handles until refusal', async () => {
  await expect(move(async (scope) => { state.replaced = true; await scope.rename() })).rejects.toThrow('parent changed')
  expect(state.calls.some(entry => entry.declaration.includes('syscall('))).toBe(false)
  expectClosed()
})

it('reports synchronization failure after retaining the completed rename state', async () => {
  state.syncError = new Error('Directory synchronization failed')
  await move(async (scope) => {
    await expect(scope.rename()).rejects.toBe(state.syncError)
    expect(scope.renamed).toBe(true)
  })
  expectClosed()
})

it.each(['closeError', 'rootCloseError', 'unloadError'] as const)('reports cleanup failure after successful work: %s', async (key) => {
  const error = new Error('Native cleanup failed')
  state[key] = error
  await expect(move(scope => scope.rename())).rejects.toMatchObject({ errors: [error] })
  expectClosed()
})

it('retains the primary operation failure before every independent cleanup failure', async () => {
  const primary = new Error('Directory move refused')
  state.closeError = new Error('Child close failed')
  state.rootCloseError = new Error('Root close failed')
  state.unloadError = new Error('Library unload failed')
  await expect(move(async () => { throw primary })).rejects.toMatchObject({
    errors: [primary, state.closeError, state.rootCloseError, state.unloadError],
  })
  expectClosed()
})
