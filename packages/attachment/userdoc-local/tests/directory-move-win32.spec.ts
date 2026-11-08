/** Windows adapter ownership and native-error transfer; real platform rename semantics remain a platform test. */
import { join, toNamespacedPath } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'
import { replaceRecoveredFileWindows, withWindowsDirectoryMove } from '../src/directory-move-win32.ts'

const native = vi.hoisted(() => ({
  opened: new Map<number, string>(), closed: [] as number[], shares: [] as number[], moveFlags: [] as number[],
  calls: [] as string[], unloads: 0, next: 100, code: 0,
  fail: '' as string, nativeCode: 183, failOpen: 2, badAttributes: false, badIdentity: false,
  closeFailure: false, unloadFailure: false, bindingFailure: false, callbackFailure: undefined as Error | string | undefined,
  asyncError: undefined as unknown, asyncMoveResult: undefined as number | undefined,
}))

vi.mock('node:fs/promises', () => ({ lstat: async (path: string) => {
  const selected = [...native.opened].find(([, opened]) => opened === toNamespacedPath(path))
  if (selected === undefined) throw new Error('The adapter inspected a directory without owning its handle.')
  return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: BigInt(selected[0] + (native.badIdentity ? 1 : 0)) }
} }))

vi.mock('koffi', () => ({ default: { load: () => ({
  func: (_convention: string, name: string) => {
    if (native.bindingFailure) throw new Error('Owned native symbol failure')
    if (name === 'CloseHandle') return (handle: number) => {
      native.closed.push(handle)
      if (native.closeFailure) { native.closeFailure = false; native.code = 5; return 0 }
      return 1
    }
    if (name === 'GetLastError') return () => native.code
    const invoke = (args: unknown[]): number => {
      native.calls.push(name)
      if (native.callbackFailure !== undefined) throw native.callbackFailure
      if (name === 'CreateFileW') {
        if (native.fail === name && native.opened.size + 1 === native.failOpen) { native.code = native.nativeCode; return -1 }
        const handle = native.next++
        native.opened.set(handle, String(args[0]))
        native.shares.push(Number(args[2]))
        return handle
      }
      if (native.fail === name) { native.code = native.nativeCode; return 0 }
      if (name === 'GetFileInformationByHandle') {
        const info = args[1]
        if (!Buffer.isBuffer(info)) throw new Error('The adapter must retain a native file-information buffer.')
        info.writeUInt32LE(native.badAttributes ? 0x410 : 0x10, 0)
        info.writeUInt32LE(1, 28); info.writeUInt32LE(0, 44); info.writeUInt32LE(Number(args[0]), 48)
        return 1
      }
      if (name === 'MoveFileExW') { native.moveFlags.push(Number(args[2])); return 1 }
      throw new Error(`Unexpected native function ${name}`)
    }
    return Object.assign((...args: unknown[]): number => invoke(args), {
      async: (...args: unknown[]) => {
        const callback = args.pop()
        if (typeof callback !== 'function') throw new Error('The native operation must have an awaited callback.')
        const complete = callback as (error: unknown, result: number) => void
        if (name === 'MoveFileExW' && native.asyncError !== undefined) { complete(native.asyncError, -1); return }
        void Promise.resolve().then(() => invoke(args)).then(
          (result) => {
            if (name === 'MoveFileExW' && native.asyncMoveResult !== undefined) result = native.asyncMoveResult
            complete(null, result)
          },
          (error: unknown) => { complete(error, -1) },
        )
      },
    })
  },
  unload: () => { native.unloads += 1; if (native.unloadFailure) throw new Error('Owned native unload failure') },
}) } }))

beforeEach(() => {
  native.opened.clear(); native.closed.length = 0; native.shares.length = 0; native.calls.length = 0; native.moveFlags.length = 0
  native.unloads = 0; native.next = 100; native.code = 0; native.fail = ''; native.nativeCode = 183; native.failOpen = 2
  native.badAttributes = false; native.badIdentity = false; native.closeFailure = false; native.unloadFailure = false
  native.bindingFailure = false; native.callbackFailure = undefined
  native.asyncError = undefined; native.asyncMoveResult = undefined
})

function move<T>(operation: Parameters<typeof withWindowsDirectoryMove<T>>[3], expectedRoot?: { device: string; inode: string }) {
  const root = join(tmpdir(), 'virtual-windows-document-root')
  return withWindowsDirectoryMove(root, join(root, 'a', 'source'), join(root, 'b', 'target'), operation, expectedRoot)
}

function expectClosed() {
  expect(native.closed).toEqual([...native.opened.keys()].reverse())
  expect(native.unloads).toBe(1)
}

it('owns every non-reparse parent without delete sharing through write-through rename', async () => {
  await expect(move(async (scope) => {
    expect(scope.renamed).toBe(false)
    await scope.rename(); await scope.sync(); await scope.verify()
    expect(scope.renamed).toBe(true)
    expect(native.closed).toEqual([])
    return 'moved'
  }, { device: '1', inode: '100' })).resolves.toBe('moved')
  expect(native.shares).toEqual([3, 3, 3])
  expect(native.moveFlags).toEqual([8])
  expectClosed()
})

it.each([false, true])('pins an independent private root and validates its identity: stale=%s', async (stale) => {
  const root = join(tmpdir(), 'virtual-windows-public'), privateRoot = join(tmpdir(), 'virtual-windows-private')
  const work = withWindowsDirectoryMove(root, join(root, 'source'), join(privateRoot, 'captures', 'stage'),
    async (scope) => { await scope.rename(); await scope.sync() }, { device: '1', inode: '100' }, privateRoot,
    { device: '1', inode: stale ? '999' : '101' })
  if (stale) await expect(work).rejects.toThrow('root changed')
  else await expect(work).resolves.toBeUndefined()
  expect(native.shares.every(share => share === 3)).toBe(true)
  expect(native.moveFlags).toEqual(stale ? [] : [8])
  expectClosed()
})

it.each([[183, 'EEXIST'], [32, 'EBUSY'], [17, 'EXDEV'], [999, 'EIO']] as const)(
  'transfers native error %s from a failed asynchronous rename as %s', async (code, expected) => {
    native.fail = 'MoveFileExW'; native.nativeCode = code
    await move(async (scope) => {
      await expect(scope.rename()).rejects.toHaveProperty('code', expected)
      expect(scope.renamed).toBe(false)
    })
    expectClosed()
  },
)

it.each(['CreateFileW', 'GetFileInformationByHandle'])('releases all acquired handles after %s fails', async (name) => {
  native.fail = name; native.nativeCode = 5
  await expect(move(scope => scope.rename())).rejects.toHaveProperty('code', 'EACCES')
  expectClosed()
})

it('closes a rejected reparse directory before unloading its library', async () => {
  native.badAttributes = true
  await expect(move(scope => scope.rename())).rejects.toThrow('real Windows parent')
  expectClosed()
})

it('refuses a replaced managed root or a changed lexical directory before rename', async () => {
  await expect(move(scope => scope.rename(), { device: '1', inode: '999' })).rejects.toThrow('root changed')
  expectClosed()
  native.unloads = 0; native.closed.length = 0; native.opened.clear(); native.next = 100
  native.badIdentity = true
  await expect(move(scope => scope.rename())).rejects.toThrow('parent changed')
  expect(native.moveFlags).toEqual([])
  expectClosed()
})

it('retains independent operation, handle-close and library-unload failures while completing cleanup', async () => {
  const operation = new Error('Owned callback failure')
  native.closeFailure = true; native.unloadFailure = true
  await expect(move(async () => { throw operation })).rejects.toMatchObject({ errors: [operation,
    expect.objectContaining({ code: 'EACCES' }), expect.objectContaining({ message: 'Owned native unload failure' })] })
  expectClosed()
})

it('unloads a library when symbol binding fails before handles open', async () => {
  native.bindingFailure = true
  await expect(move(scope => scope.rename())).rejects.toThrow('native symbol failure')
  expectClosed()
})

it('propagates an FFI call failure without leaving a native owner behind', async () => {
  native.callbackFailure = 'owned invalid native callback'
  await expect(move(scope => scope.rename())).rejects.toBe(native.callbackFailure)
  expectClosed()
})

it('retains a native call Error and reports cleanup failure after a successful rename', async () => {
  const failure = new Error('Owned native callback Error')
  native.callbackFailure = failure
  await expect(move(scope => scope.rename())).rejects.toBe(failure)
  expectClosed()
  native.callbackFailure = undefined; native.unloads = 0; native.closed.length = 0; native.opened.clear(); native.next = 100
  native.closeFailure = true
  await expect(move(scope => scope.rename())).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'EACCES' })] })
  expect(native.moveFlags).toEqual([8])
  expectClosed()
})

it('completes the rename when the synchronous retry finds the destination free', async () => {
  native.asyncMoveResult = 0
  await expect(move(async (scope) => {
    await scope.rename()
    expect(scope.renamed).toBe(true)
    return 'moved'
  })).resolves.toBe('moved')
  expect(native.moveFlags).toEqual([8, 8])
  expectClosed()
})

it.each([new Error('owned transport failure'), 'opaque ffi failure'])(
  'rejects a failed asynchronous rename with its delivered error: %p', async (asyncError) => {
    native.asyncError = asyncError
    await move(async (scope) => {
      if (asyncError instanceof Error) await expect(scope.rename()).rejects.toBe(asyncError)
      else await expect(scope.rename()).rejects.toMatchObject({ cause: asyncError })
      expect(scope.renamed).toBe(false)
    })
    expectClosed()
  },
)

it('transfers the native error from a refused recovered-file replacement', async () => {
  const root = join(tmpdir(), 'virtual-windows-document-root')
  await expect(replaceRecoveredFileWindows(join(root, 'stage'), join(root, 'body'))).resolves.toBeUndefined()
  native.fail = 'MoveFileExW'; native.nativeCode = 80
  await expect(replaceRecoveredFileWindows(join(root, 'stage'), join(root, 'body'))).rejects.toMatchObject({ code: 'EEXIST' })
  expect(native.unloads).toBe(2)
})

it('keeps handles and the library open for the operation duration', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const operation = move(async () => {
    entered.resolve(undefined)
    await release.promise
  })
  try {
    await entered.promise
    expect(native.unloads).toBe(0)
    expect(native.closed).toEqual([])
    expect(native.opened.size).toBeGreaterThan(0)
  } finally { release.resolve(undefined); await operation }
  expectClosed()
})
