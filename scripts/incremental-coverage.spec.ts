import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  assertIncrementalCoverage,
  changedMeasuredSources,
  summarizeIncrementalCoverage,
} from './incremental-coverage.ts'

const root = '/repo'
const source = 'packages/client/foo/src/index.ts'
const component = 'packages/client/foo/src/view.tsx'

const covered = {
  [source]: { statementMap: { '1': { start: { line: 1 } } }, s: { '1': 1 }, f: { '1': 1 }, b: { '1': [1, 1] } },
  [`${root}/${component}`]: { statementMap: { '1': { start: { line: 1 } } }, s: { '1': 1 }, f: { '1': 1 }, b: { '1': [1] } },
}

it('runs the real incremental entry with erased types and refuses missing runtime data', () => {
  const repository = resolve(import.meta.dirname, '..')
  const fixture = mkdtempSync(join(tmpdir(), 'incremental-entry-'))
  const write = (path: string, data: string): void => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(join(fixture, path), data)
  }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim()
  const commit = (): string => {
    git('add', '.')
    git('-c', 'user.name=Coverage fixture', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  try {
    for (const path of ['scripts/incremental-coverage.ts', 'scripts/coverage-policy.ts', 'scripts/coverage-selection.ts',
      'scripts/coverage-baseline.ts', 'packages/shell/pwsh-local/src/resolve.ts']) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      cpSync(join(repository, path), join(fixture, path))
    }
    symlinkSync(join(repository, 'node_modules'), join(fixture, 'node_modules'), 'junction')
    write('package.json', '{"type":"module"}\n')
    write('.gitignore', 'node_modules/\ncoverage.json\n')
    write('packages/probe/runtime/src/value.ts', 'export const value = 1\n')
    write('packages/probe/runtime/src/contract.ts', 'export interface Value {}\n')
    git('init', '-q')
    const base = commit()
    write('packages/probe/runtime/src/contract.ts', 'export interface Value { id: string }\n')
    commit()
    write('coverage.json', '{}')
    const run = () => spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/incremental-coverage.ts', base, 'coverage.json'],
      { cwd: fixture, encoding: 'utf8', timeout: 25_000 })
    const types = run()
    expect(types.error).toBeUndefined()
    expect(types.status, types.stderr).toBe(0)
    expect(types.stdout).toContain('0 changed measured')
    write('packages/probe/runtime/src/value.ts', 'export const value = 2\n')
    commit()
    const missing = run()
    expect(missing.status, missing.stderr).toBe(1)
    expect(missing.stderr).toContain('changed source file is absent')
    write('coverage.json', JSON.stringify({ 'packages/probe/runtime/src/value.ts': {
      statementMap: { 1: { start: { line: 1 } } }, s: { 1: 1 }, f: {}, b: {},
    } }))
    const measured = run()
    expect(measured.status, measured.stderr).toBe(0)
    expect(measured.stdout).toContain('1 changed measured')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
}, 90_000)

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
    const map = { [source]: {
      statementMap: { '1': { start: { line: 1 } }, '2': { start: { line: 2 } } },
      s: { '1': 1, '2': 0 }, f: { '1': 1 }, b: { '1': [1] },
    } }
    expect(() => summarizeIncrementalCoverage(root, map, [source])).toThrow(/lines coverage is below 100%/u)
  })

  it('derives line coverage from the standard Istanbul statement map', () => {
    const map = { [source]: {
      statementMap: { '1': { start: { line: 4 } }, '2': { start: { line: 4 } } },
      s: { '1': 1, '2': 1 }, f: { '1': 1 }, b: { '1': [1] },
    } }
    expect(summarizeIncrementalCoverage(root, map, [source])[0]?.lines).toBe(100)
  })

  it('rejects malformed generated coverage instead of treating missing fields as covered', () => {
    expect(() => summarizeIncrementalCoverage(root, { [source]: {} }, [source]))
      .toThrow(/missing statementMap, s, f, or b/u)
  })
})

describe('assertIncrementalCoverage', () => {
  it('accepts an empty changed-source set', () => {
    expect(() => { assertIncrementalCoverage([]) }).not.toThrow()
  })

  it('rejects any metric below 100%', () => {
    expect(() => { assertIncrementalCoverage([{
      path: source, lines: 100, statements: 99, functions: 100, branches: 100,
    }]) }).toThrow(/incremental coverage below 100%/u)
  })
})
