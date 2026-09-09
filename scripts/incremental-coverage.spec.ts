import { describe, expect, it } from 'vitest'
import {
  assertIncrementalCoverage,
  changedMeasuredSources,
  summarizeIncrementalCoverage,
} from './incremental-coverage.ts'

const root = '/repo'
const source = 'packages/client/foo/src/index.ts'
const component = 'packages/client/foo/src/view.tsx'

const covered = {
  [source]: { l: { '1': 1 }, s: { '1': 1 }, f: { '1': 1 }, b: { '1': [1, 1] } },
  [`${root}/${component}`]: { l: { '1': 1 }, s: { '1': 1 }, f: { '1': 1 }, b: { '1': [1] } },
}

describe('changedMeasuredSources', () => {
  it('keeps only package source files and sorts unique paths', () => {
    expect(changedMeasuredSources([
      'README.md', source, component, source, 'packages/foo/src/index.ts', 'packages/client/foo/src/data.js',
    ])).toEqual([source, component])
  })
})

describe('summarizeIncrementalCoverage', () => {
  it('normalizes absolute and relative map keys', () => {
    expect(summarizeIncrementalCoverage(root, covered, [component, source])).toEqual([
      { path: source, lines: 100, statements: 100, functions: 100, branches: 100 },
      { path: component, lines: 100, statements: 100, functions: 100, branches: 100 },
    ])
  })

  it('rejects a changed source absent from the coverage map', () => {
    expect(() => summarizeIncrementalCoverage(root, {}, [source])).toThrow(
      `changed source file is absent from coverage map: ${source}`,
    )
  })

  it('rejects an uncovered metric', () => {
    const map = { [source]: { l: { '1': 1, '2': 0 }, s: { '1': 1 }, f: { '1': 1 }, b: { '1': [1] } } }
    expect(() => summarizeIncrementalCoverage(root, map, [source])).toThrow(/lines coverage is below 100%/u)
  })
})

describe('assertIncrementalCoverage', () => {
  it('accepts an empty changed-source set', () => {
    expect(() => assertIncrementalCoverage([])).not.toThrow()
  })

  it('rejects any metric below 100%', () => {
    expect(() => assertIncrementalCoverage([{
      path: source, lines: 100, statements: 99, functions: 100, branches: 100,
    }])).toThrow(/incremental coverage below 100%/u)
  })
})
