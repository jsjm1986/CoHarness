/** Durable namespace and file flushes: POSIX descriptor sync and the Windows backup-semantics path. */
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syncDocumentDirectory, syncDocumentFile } from '../src/directory-sync.ts'

const state = vi.hoisted(() => ({
  opened: [] as { path: string; flags: unknown }[], calls: [] as { name: string; args: unknown[] }[],
  unloads: 0, lastError: 0, createResult: 11 as number | bigint, createError: undefined as Error | string | undefined,
  flushResult: 1, flushError: undefined as Error | string | undefined, closeResult: 1, syncError: undefined as Error | undefined,
}))

vi.mock('node:fs/promises', () => ({
  open: async (path: string, flags?: unknown) => {
    state.opened.push({ path, flags })
    return { sync: async () => { if (state.syncError !== undefined) throw state.syncError }, close: async () => {} }
  },
}))

vi.mock('koffi', () => ({ default: {
  load: () => ({
    func: (_convention: string, name: string) => {
      if (name === 'GetLastError') return () => state.lastError
      if (name === 'CloseHandle') return () => state.closeResult
      return { async: (...args: unknown[]) => {
        const complete = args.pop() as (error: unknown, result: unknown) => void
        state.calls.push({ name, args })
        if (name === 'CreateFileW') complete(state.createError ?? null, state.createResult)
        else complete(state.flushError ?? null, state.flushResult)
      } }
    },
    unload: () => { state.unloads++ },
  }),
} }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const directory = join(tmpdir(), 'document-namespace')
const file = join(directory, 'document.md')

beforeEach(() => {
  state.opened.length = 0; state.calls.length = 0; state.unloads = 0; state.lastError = 0
  state.createResult = 11; state.createError = undefined; state.flushResult = 1; state.flushError = undefined
  state.closeResult = 1; state.syncError = undefined
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
})

afterEach(() => { Object.defineProperty(process, 'platform', platform) })

it('flushes a committed directory through its POSIX descriptor', async () => {
  await syncDocumentDirectory(directory)
  expect(state.opened).toEqual([{ path: directory, flags: 'r' }])
})

it('flushes a committed file read-only on POSIX and read-write on Windows', async () => {
  await syncDocumentFile(file)
  expect(state.opened).toEqual([{ path: file, flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }])
  state.opened.length = 0
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  await syncDocumentFile(file)
  expect(state.opened).toEqual([{ path: file, flags: constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) }])
})

it('flushes a Windows directory through a backup-semantics handle', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  await syncDocumentDirectory(directory)
  const create = state.calls.find(call => call.name === 'CreateFileW')
  expect(create?.args).toEqual([directory, 0x40000000, 7, null, 3, 0x02000000, 0])
  expect(state.calls.map(call => call.name)).toEqual(['CreateFileW', 'FlushFileBuffers'])
  expect(state.unloads).toBe(1)
})

it.each([new Error('koffi queue failed'), 'koffi queue failed'])('retains a CreateFileW callback failure: %s', async (error) => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.createError = error
  await expect(syncDocumentDirectory(directory)).rejects.toSatisfy((failure: unknown) =>
    error instanceof Error ? failure === error : (failure as Error).cause === error)
  expect(state.unloads).toBe(1)
})

it.each([[2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [87, 'EIO']])('maps a directory open refusal %i to %s', async (lastError, code) => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.createResult = -1n; state.lastError = lastError
  await expect(syncDocumentDirectory(directory)).rejects.toMatchObject({ code, errno: lastError, syscall: 'CreateFileW', path: directory })
  expect(state.unloads).toBe(1)
})

it.each([new Error('koffi queue failed'), 'koffi queue failed'])('retains a FlushFileBuffers callback failure: %s', async (error) => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.flushError = error
  await expect(syncDocumentDirectory(directory)).rejects.toSatisfy((failure: unknown) =>
    error instanceof Error ? failure === error : (failure as Error).cause === error)
  expect(state.unloads).toBe(1)
})

it('maps a flush refusal through the surviving handle cleanup', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.flushResult = 0; state.lastError = 5
  await expect(syncDocumentDirectory(directory)).rejects.toMatchObject({ code: 'EACCES', syscall: 'FlushFileBuffers' })
  expect(state.unloads).toBe(1)
})

it('reports a failed handle release after a successful flush', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.closeResult = 0; state.lastError = 5
  await expect(syncDocumentDirectory(directory)).rejects.toMatchObject({ code: 'EACCES', syscall: 'CloseHandle' })
})

it('aggregates a flush refusal with a failed handle release', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  state.flushResult = 0; state.closeResult = 0; state.lastError = 5
  await expect(syncDocumentDirectory(directory)).rejects.toMatchObject({ errors: [
    { code: 'EACCES', syscall: 'FlushFileBuffers' }, { code: 'EACCES', syscall: 'CloseHandle' },
  ] })
  expect(state.unloads).toBe(1)
})
