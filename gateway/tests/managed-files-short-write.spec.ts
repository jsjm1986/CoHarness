/** Backup byte copies retain partial progress without spinning or ignoring cancellation. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { copyVerifiedFile } from '../src/managed-files.ts'

const io = vi.hoisted(() => ({
  mode: 'short' as 'short' | 'zero' | 'abort' | 'flush', calls: 0,
  afterWrite: undefined as (() => void) | undefined,
  afterSync: undefined as (() => void) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, async open(...args: Parameters<typeof actual.open>) {
    const handle = await actual.open(...args)
    if (args[1] !== 'wx') return handle
    const write = handle.write.bind(handle)
    const sync = handle.sync.bind(handle)
    Object.defineProperty(handle, 'sync', { value: async () => { await sync(); io.afterSync?.() } })
    Object.defineProperty(handle, 'write', {
      value: async (data: Uint8Array) => {
        io.calls += 1
        if (io.mode === 'zero') {
          if (io.calls > 1) throw new Error('Fixture stopped a repeated zero-progress write')
          return { bytesWritten: 0, buffer: data }
        }
        const result = await write(data, 0, Math.min(data.byteLength, 2))
        io.afterWrite?.()
        return result
      },
    })
    return handle
  } }
})

const roots: string[] = []
afterEach(async () => {
  io.mode = 'short'; io.calls = 0; io.afterWrite = undefined; io.afterSync = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-copy-write-progress-'))
  roots.push(root)
  const source = join(root, 'source'), destination = join(root, 'copy')
  await writeFile(source, 'abcdefghijklm')
  return { source, destination }
}

it('keeps retrying positive partial copy progress until the captured bytes and digest agree', async () => {
  const { source, destination } = await fixture()
  const actual = await copyVerifiedFile(source, destination)
  expect(actual).toEqual({ sizeBytes: 13, sha256: createHash('sha256').update('abcdefghijklm').digest('hex') })
  expect(await readFile(destination, 'utf8')).toBe('abcdefghijklm')
  expect(io.calls).toBe(7)
})

it('refuses a zero-progress copy before attempting the same write again', async () => {
  const { source, destination } = await fixture()
  io.mode = 'zero'
  await expect(copyVerifiedFile(source, destination)).rejects.toThrow('Managed file write made no progress')
  expect(io.calls).toBe(1)
  expect(await readFile(source, 'utf8')).toBe('abcdefghijklm')
})

it('observes the original cancellation before writing another partial prefix', async () => {
  const { source, destination } = await fixture()
  const cancellation = new AbortController(), reason = new Error('Backup operation lease was lost')
  io.mode = 'abort'
  io.afterWrite = () => { cancellation.abort(reason) }
  await expect(copyVerifiedFile(source, destination, cancellation.signal)).rejects.toBe(reason)
  expect(io.calls).toBe(1)
  expect(await readFile(destination, 'utf8')).toBe('ab')
  expect(await readFile(source, 'utf8')).toBe('abcdefghijklm')
})

it('withholds a copied fingerprint when the operation expires during synchronization', async () => {
  const { source, destination } = await fixture()
  const cancellation = new AbortController(), reason = new Error('Backup lease expired during flush')
  io.mode = 'flush'
  io.afterSync = () => { cancellation.abort(reason) }
  await expect(copyVerifiedFile(source, destination, cancellation.signal)).rejects.toBe(reason)
  expect(await readFile(source, 'utf8')).toBe('abcdefghijklm')
})
