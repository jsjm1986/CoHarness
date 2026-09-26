/** Persisted events and comparison responses reject malformed file and hunk metadata. */
import { describe, expect, it } from 'vitest'
import { isChangedFile, isChangesDiff, isChangesEvent, isChangesSummary } from '../src/changes.ts'
import { isPresentedData, isPresentedFile } from '../src/presented.ts'

const file = { path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }
const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
const diff = { kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false, hunks: [hunk] }

describe('durable and wire delivery values', () => {
  it.each([null, [], 'text', 1])('rejects non-record values: %j', (value) => {
    expect(isChangedFile(value)).toBe(false)
    expect(isChangesSummary(value)).toBe(false)
    expect(isChangesDiff(value)).toBe(false)
    expect(isChangesEvent(value)).toBe(false)
    expect(isPresentedFile(value)).toBe(false)
    expect(isPresentedData(value)).toBe(false)
  })

  it('accepts explicit comparison states and refuses unsupported flags and malformed hunks', () => {
    expect(isChangedFile({ ...file, binary: true, oversized: true })).toBe(true)
    expect(isChangedFile({ ...file, binary: false })).toBe(false)
    expect(isChangedFile({ ...file, oversized: false })).toBe(false)
    expect(isChangesDiff(diff)).toBe(true)
    expect(isChangesDiff({ ...diff, kind: 'unknown' })).toBe(false)
    for (const invalid of [null, { ...hunk, lines: ['unprefixed'] }, { ...hunk, oldStart: -1 }, { ...hunk, lines: null }]) {
      expect(isChangesDiff({ ...diff, hunks: [invalid] })).toBe(false)
    }
    expect(isPresentedFile({ path: 'a.ts', description: 3 })).toBe(false)
    expect(isPresentedFile({ path: 'a.ts' })).toBe(true)
  })
})
