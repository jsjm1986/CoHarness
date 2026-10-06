/** Runtime diagnostics respect byte limits and propagate backpressure to subprocess pipes. */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeLog } from '../src/runtime-log.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function file(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-log-'))
  roots.push(root)
  return join(root, 'runtime.log')
}

it('bounds every generation during a burst and preserves the newest admitted bytes', async () => {
  const path = await file(), log = new RuntimeLog(path, 64)
  const chunks = Array.from({ length: 101 }, (_, index) => Buffer.alloc(64, index))
  let pending = 0
  const source = Readable.from(chunks, { objectMode: false, highWaterMark: 64 })
  source.on('data', () => { pending = Math.max(pending, log.writableLength) })
  await pipeline(source, log)
  await log.close()
  expect(pending).toBeLessThanOrEqual(64)
  expect(await readFile(path)).toEqual(chunks[100])
  expect(await readFile(`${path}.1`)).toEqual(chunks[99])
  expect(await readdir(roots.at(-1)!)).toEqual(['runtime.log', 'runtime.log.1'])
})

it('splits oversized UTF-8 output by bytes and waits for admitted output on close', async () => {
  const path = await file(), log = new RuntimeLog(path, 8)
  const text = '你好🙂abc'
  expect(log.write(text)).toBe(false)
  const first = log.close(), second = log.close()
  expect(second).toBe(first)
  await first
  expect(await readFile(`${path}.1`)).toEqual(Buffer.from(text).subarray(0, 8))
  expect(await readFile(path)).toEqual(Buffer.from(text).subarray(8))
})

it('opens lazily and includes existing file bytes in the cap', async () => {
  const path = await file(), silent = new RuntimeLog(path, 8)
  await silent.close()
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(path, '123456')
  const log = new RuntimeLog(path, 8)
  log.write('789')
  await log.close()
  expect(await readFile(`${path}.1`, 'utf8')).toBe('12345678')
  expect(await readFile(path, 'utf8')).toBe('9')
})

it('caps a legacy oversized generation and fails closed when rotation cannot rename', async () => {
  const path = await file()
  await writeFile(path, '12345678901234567890')
  const first = new RuntimeLog(path, 8)
  first.write('new')
  await first.close()
  expect((await stat(`${path}.1`)).size).toBe(8)
  expect(await readFile(path, 'utf8')).toBe('new')
  await rm(`${path}.1`)
  await mkdir(`${path}.1`)
  await writeFile(path, '12345678')
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const broken = new RuntimeLog(path, 8)
  await pipeline(Readable.from(['must not append', 'nor this']), broken)
  await broken.close()
  expect(await readFile(path, 'utf8')).toBe('12345678')
  expect(diagnostic).toHaveBeenCalledTimes(1)
})

it('bounds a retained generation when a smaller cap is configured before the next rotation', async () => {
  const path = await file()
  await writeFile(path, 'a')
  await writeFile(`${path}.1`, Buffer.alloc(64, 98))
  const log = new RuntimeLog(path, 8)
  log.write('c')
  await log.close()
  expect(await readFile(path, 'utf8')).toBe('ac')
  expect((await stat(`${path}.1`)).size).toBe(8)
})
