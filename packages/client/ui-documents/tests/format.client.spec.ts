// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatBytes, getDateGroup } from '../src/client/format.ts'

describe('formatBytes', () => {
  it('formats bytes, kilobytes, megabytes and gigabytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('clamps negative counts to zero bytes', () => {
    expect(formatBytes(-1)).toBe('0 B')
  })
})

describe('getDateGroup', () => {
  it('formats a modification timestamp as a UTC date', () => {
    expect(getDateGroup(Date.UTC(2026, 7, 17, 23, 59))).toBe('2026-08-17')
  })

  it('returns Unknown for an invalid timestamp', () => {
    expect(getDateGroup(Number.NaN)).toBe('Unknown')
  })
})
