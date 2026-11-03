/** Complete recovery spills under partial or stalled filesystem syscalls. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputCollector } from '../src/output.ts'

const io = vi.hoisted(() => ({ mode: 'short' as 'short' | 'zero', calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual,
    writeSync(fd: number, data: Uint8Array, offset = 0, length = data.byteLength - offset, position: number | null = null): number {
      io.calls += 1
      if (io.mode === 'zero') return 0
      return actual.writeSync(fd, data, offset, Math.min(length, 2), position)
    },
  }
})

const roots: string[] = []
afterEach(() => {
  io.mode = 'short'; io.calls = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-spill-partial-write-'))
  roots.push(root)
  const failures: unknown[] = []
  const collector = new OutputCollector(4, 'stdout', { dir: root, maxBytes: 100,
    onFailure: (error) => { failures.push(error) } })
  return { root, failures, collector }
}

describe('subprocess spill write progress', () => {
  it('preserves the retained prefix, overflow and later chunks in the complete spill', () => {
    const { collector, failures } = fixture()
    let result: ReturnType<OutputCollector['finalize']>
    try {
      for (const text of ['abc', 'defghij', 'klm']) collector.push(Buffer.from(text))
      result = collector.finalize()
    } finally { collector.seal() }
    expect(result.text).toBe('jklm')
    expect(result.truncated).toBe(true)
    expect(result.spillPath).toBeDefined()
    expect(readFileSync(result.spillPath!, 'utf8')).toBe('abcdefghijklm')
    expect(failures).toEqual([])
    expect(io.calls).toBeGreaterThan(3)
  })

  it('discards a zero-progress spill once and keeps collecting the in-memory tail', () => {
    const { root, collector, failures } = fixture()
    io.mode = 'zero'
    let result: ReturnType<OutputCollector['finalize']>
    try {
      for (const text of ['abc', 'defghij', 'klm']) collector.push(Buffer.from(text))
      result = collector.finalize()
    } finally { collector.seal() }
    expect(result.text).toBe('jklm')
    expect(result.truncated).toBe(true)
    expect(result.spillPath).toBeUndefined()
    expect(failures).toHaveLength(1)
    expect(io.calls).toBe(1)
    expect(readdirSync(root)).toEqual([])
  })
})
