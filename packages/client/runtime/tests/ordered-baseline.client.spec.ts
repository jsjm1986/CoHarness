import { describe, expect, it } from 'vitest'
import { mergeOrderedBaseline } from '../src/client/ordered-baseline.ts'

interface Row { readonly id: unknown; readonly revision: number }

function reference(current: readonly Row[], baseline: readonly Row[]): Row[] {
  const byKey = new Map(baseline.map(row => [row.id, row]))
  const merged = current.map(row => byKey.get(row.id)).filter((row): row is Row => row !== undefined)
  const keys = new Set(merged.map(row => row.id))
  for (let index = 0; index < baseline.length; index++) {
    const row = baseline[index]!
    if (keys.has(row.id)) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const known = merged.findIndex(candidate => candidate.id === baseline[following]!.id)
      if (known >= 0) { insertion = known; break }
    }
    merged.splice(insertion, 0, row)
    keys.add(row.id)
  }
  return merged
}

function arrangements(): string[][] {
  const all: string[][] = [[]]
  let level: string[][] = [[]]
  for (let length = 1; length <= 4; length++) {
    level = level.flatMap(prefix => ['a', 'b', 'c'].map(id => [...prefix, id]))
    all.push(...level)
  }
  return all
}

describe('ordered Session baselines', () => {
  it('matches established order and nearest following anchor placement across reordered and repeated keys', () => {
    const sequences = arrangements()
    for (const previous of sequences) {
      const current = previous.map(id => ({ id, revision: 0 }))
      for (const incoming of sequences) {
        const baseline = incoming.map((id, revision) => ({ id, revision: revision + 1 }))
        const actual = mergeOrderedBaseline(current, baseline, row => row.id)
        const expected = reference(current, baseline)
        expect(actual).toEqual(expected)
        for (let index = 0; index < actual.length; index++) expect(actual[index]).toBe(expected[index])
      }
    }
  })

  it('bounds key reads when a reconnect baseline replaces the established catalog', () => {
    const baseline = Array.from({ length: 250 }, (_, index) => ({ id: `new-${String(index)}`, revision: 1 }))
    let reads = 0
    expect(mergeOrderedBaseline([{ id: 'removed', revision: 0 }], baseline, (row) => {
      reads++
      return row.id
    })).toEqual(baseline)
    expect(reads).toBeLessThanOrEqual(2 * (baseline.length + 1))
  })

  it('preserves primitive key equality and skips undefined rows', () => {
    for (const previous of [[], [Number.NaN], [2, Number.NaN], [1, 1]]) {
      const current = previous.map(id => ({ id, revision: 0 }))
      for (const incoming of [[Number.NaN, 1, 2, 1, Number.NaN], [1, Number.NaN, 2], [Number.NaN]]) {
        const baseline = incoming.map((id, revision) => ({ id, revision: revision + 1 }))
        expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual(reference(current, baseline))
      }
    }
    expect(mergeOrderedBaseline<number | undefined>([undefined, 1], [undefined, 2, 1], value => value)).toEqual([2, 1])
  })
})
