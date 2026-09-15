/**
 * Unit tests for the Windows durable namespace helper with a mocked kernel32
 * binding. The real JSONL suite exercises the helper on native Windows; these
 * tests keep the Win32 error mapping and race handling covered on every host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOVEFILE_WRITE_THROUGH = 0x00000008
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_SHARING_VIOLATION = 32
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x00000102
const WAIT_ABANDONED = 0x00000080

type MoveFileExW = (existing: string, replacement: string, flags: number, setLastError: (code: number) => void) => number

const roots: string[] = []

function stripNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-win32-'))
  roots.push(dir)
  return dir
}

async function importWithMove(moveFileExW: MoveFileExW): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => {
    let lastError = 0
    const setLastError = (code: number): void => { lastError = code }
    const move: MoveFileExW = (existing, replacement, flags, setError) => {
      const ok = moveFileExW(existing, replacement, flags, setError)
      lastError = ok === 0 ? lastError : 0
      return ok
    }
    return {
      default: {
        load: () => ({
          func: (_convention: string, name: string, result: string) => {
            if (name === 'MoveFileExW') return (existing: string, replacement: string, flags: number) => {
              expect(result).toBe('int')
              const ok = move(existing, replacement, flags, setLastError)
              return ok
            }
            return () => lastError
          },
        }),
      },
    }
  })
  return import('../src/win32.ts')
}

async function importWithError(code: number): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (_convention: string, name: string) => {
          if (name === 'MoveFileExW') return () => 0
          return () => code
        },
      }),
    },
  }))
  return import('../src/win32.ts')
}

/** Kernel32 semaphore answers; unspecified calls fail with `lastError`. */
interface SemaphoreStub {
  create?: () => number
  wait?: (handle: number, milliseconds: number) => number
  release?: (handle: number) => number
  close?: (handle: number) => number
  lastError?: number
}

async function importWithSemaphore(stub: SemaphoreStub): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (_convention: string, name: string) => {
          switch (name) {
            case 'CreateSemaphoreW': return () => stub.create?.() ?? 0
            case 'WaitForSingleObject': return (handle: number, ms: number) => stub.wait?.(handle, ms) ?? WAIT_ABANDONED
            case 'ReleaseSemaphore': return (handle: number) => stub.release?.(handle) ?? 0
            case 'CloseHandle': return (handle: number) => stub.close?.(handle) ?? 0
            default: return () => stub.lastError ?? 0
          }
        },
      }),
    },
  }))
  return import('../src/win32.ts')
}

async function importWithFilesystemMove(): Promise<typeof import('../src/win32.ts')> {
  return importWithMove((existing, replacement, flags, setLastError) => {
    expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
    const from = stripNamespace(existing)
    const to = stripNamespace(replacement)
    if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
    if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
    renameSync(from, to)
    return 1
  })
}

afterEach(async () => {
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('node:path')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Windows durable namespace helpers', () => {
  it('keeps drive-root probes native while namespacing descendants', async () => {
    const probes: string[] = []
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        stat: async (path: string) => {
          probes.push(path)
          return { isDirectory: () => true }
        },
      }
    })
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:path')>()
      return {
        ...actual,
        join: (...paths: string[]) => actual.win32.join(...paths),
        parse: (path: string) => actual.win32.parse(path),
        resolve: (...paths: string[]) => actual.win32.resolve(...paths),
        toNamespacedPath: (path: string) => actual.win32.toNamespacedPath(path),
      }
    })
    const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')

    await ensureDurableDirectoryWin32('C:\\existing')

    expect(probes).toEqual(['C:\\', '\\\\?\\C:\\existing'])
  })

  it('publishes a new file with write-through MoveFileExW semantics', async () => {
    const { publishNewFileWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const tmp = join(root, 'log.tmp')
    const final = join(root, 'log.jsonl')
    await writeFile(tmp, 'content')

    await publishNewFileWin32(tmp, final)
    expect(existsSync(tmp)).toBe(false)
    expect(readFileSync(final, 'utf8')).toBe('content')
  })

  it('maps Win32 publish failures to Node-style errno codes', async () => {
    const cases = [
      [ERROR_FILE_NOT_FOUND, 'ENOENT'],
      [ERROR_PATH_NOT_FOUND, 'ENOENT'],
      [ERROR_ACCESS_DENIED, 'EACCES'],
      [ERROR_NOT_SAME_DEVICE, 'EXDEV'],
      [ERROR_FILE_EXISTS, 'EEXIST'],
      [ERROR_ALREADY_EXISTS, 'EEXIST'],
      [ERROR_INVALID_NAME, 'EINVAL'],
      [9999, 'EIO'],
    ] as const
    for (const [win32Code, code] of cases) {
      const { publishNewFileWin32 } = await importWithError(win32Code)
      await expect(publishNewFileWin32('from', 'to')).rejects.toMatchObject({ code, win32Code, path: 'from', dest: 'to' })
    }
  })

  it('creates missing directories through staging siblings and tolerates an already-created race', async () => {
    const root = await tempRoot()
    const raced = join(root, 'raced')
    const { ensureDurableDirectoryWin32 } = await importWithMove((existing, replacement, flags, setLastError) => {
      expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (to === raced) {
        mkdirSync(to)
        setLastError(ERROR_ALREADY_EXISTS)
        return 0
      }
      if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
      if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
      renameSync(from, to)
      return 1
    })

    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    expect(existsSync(join(root, 'a', 'b'))).toBe(true)
    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    await ensureDurableDirectoryWin32(raced)
    expect(existsSync(raced)).toBe(true)
  })

  it('keeps staging names valid for a maximum-length target component', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const target = join(root, 'x'.repeat(255))

    await ensureDurableDirectoryWin32(target)
    expect(existsSync(target)).toBe(true)
  })

  it('surfaces directory publication failures other than an existing-target race', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithError(ERROR_ACCESS_DENIED)
    const root = await tempRoot()

    await expect(ensureDurableDirectoryWin32(join(root, 'denied'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects a non-directory component instead of treating it as missing', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'x')

    await expect(ensureDurableDirectoryWin32(join(blocked, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('Windows session lock semaphore', () => {
  it('acquires and releases a semaphore handle', async () => {
    const calls: string[] = []
    const { acquireLockHandleWin32, releaseLockHandleWin32 } = await importWithSemaphore({
      create: () => 7,
      wait: () => WAIT_OBJECT_0,
      release: () => { calls.push('release'); return 1 },
      close: () => { calls.push('close'); return 1 },
    })

    await expect(acquireLockHandleWin32('C:\\lock')).resolves.toBe(7)
    await expect(releaseLockHandleWin32(7)).resolves.toBeUndefined()
    expect(calls).toEqual(['release', 'close'])
  })

  it('surfaces a CreateSemaphoreW failure through GetLastError', async () => {
    const { acquireLockHandleWin32 } = await importWithSemaphore({ create: () => 0, lastError: ERROR_ACCESS_DENIED })
    await expect(acquireLockHandleWin32('C:\\lock')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('maps a contended zero-timeout wait to EBUSY', async () => {
    const closed: number[] = []
    const { acquireLockHandleWin32 } = await importWithSemaphore({
      create: () => 9,
      wait: () => WAIT_TIMEOUT,
      close: (handle) => { closed.push(handle); return 1 },
    })
    await expect(acquireLockHandleWin32('C:\\lock')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(closed).toEqual([9])
  })

  it('surfaces an unexpected wait result through GetLastError', async () => {
    const { acquireLockHandleWin32 } = await importWithSemaphore({
      create: () => 9,
      wait: () => WAIT_ABANDONED,
      close: () => 1,
      lastError: ERROR_SHARING_VIOLATION,
    })
    await expect(acquireLockHandleWin32('C:\\lock')).rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('rejects release when either kernel call fails', async () => {
    const { releaseLockHandleWin32 } = await importWithSemaphore({ release: () => 0, close: () => 1, lastError: ERROR_ACCESS_DENIED })
    await expect(releaseLockHandleWin32(7)).rejects.toMatchObject({ code: 'EACCES' })

    const { releaseLockHandleWin32: releaseClosed } = await importWithSemaphore({
      release: () => 1, close: () => 0, lastError: ERROR_ACCESS_DENIED,
    })
    await expect(releaseClosed(7)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
