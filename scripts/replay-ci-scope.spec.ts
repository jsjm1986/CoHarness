import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { resolveCiPrScopePlans } from './ci-pr-scope.ts'
import { FROZEN_CI_SCOPE_COMMIT } from './fixtures/pr-scope-baseline/classifier.ts'
import { collectScopeReplayRange, compareScopeReplay } from './replay-ci-scope.ts'

const root = resolve(import.meta.dirname, '..')
const paths = ['packages/util/timeout/src/index.ts', 'docs/testing.md']
const record = { commit: FROZEN_CI_SCOPE_COMMIT, base: FROZEN_CI_SCOPE_COMMIT, paths }

it('compares full-to-scoped coverage and exact Web reductions against the pinned complete plan', () => {
  const records = [record, { ...record, paths: ['apps/web/tests/goal-bar.e2e.ts'] }]
  const result = compareScopeReplay(records, entry => resolveCiPrScopePlans(entry.paths, '', root, {}))
  expect(result.unexplained).toEqual([])
  expect(result.groups).toEqual({
    'reduce:coverage:accompanying-inert-prose': 1,
    'reduce:web:exact-scenario-owners-and-smokes': 1,
  })
  expect(result.differences.find(change => change.lane === 'web')?.from).toContain('queue-actions.e2e.ts')
})

it('keeps an older archived selector distinct from the migration baseline', () => {
  const result = compareScopeReplay([{ ...record, selection: { coverageMode: 'skip' as const } }],
    entry => resolveCiPrScopePlans(entry.paths, '', root, {}))
  expect(result.unexplained).toEqual([])
  expect(result.archivedDifferences).toEqual([{ commit: record.commit, field: 'coverageMode', archived: 'skip', frozen: 'full' }])
})

it('rejects unsupported reductions and unavailable historical evidence without hiding the candidate', () => {
  const plan = resolveCiPrScopePlans(paths, '', root, {})
  const result = compareScopeReplay([record], () => ({ ...plan, baselineStatus: 'unavailable', baselineError: 'missing history',
    changes: { added: [], removed: [{ lane: 'pythonMode', from: 'full', to: 'skip', reason: 'consumer-input-policy' }] } }))
  expect(result.unexplained).toHaveLength(2)
  expect(result.unexplained.join('\n')).toContain('unexplained reduction in pythonMode')
  expect(result.differences).toHaveLength(1)
  expect(() => compareScopeReplay([record], () => ({ ...plan, executionSource: 'candidate-experiment' }))).toThrow(/shadow execution/)
})

it('freezes every range commit and uses first-parent, empty-tree, and both rename paths', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'scope-replay-git-'))
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Scope fixture', GIT_AUTHOR_EMAIL: 'scope@example.invalid',
      GIT_COMMITTER_NAME: 'Scope fixture', GIT_COMMITTER_EMAIL: 'scope@example.invalid' }
    const git = (args: readonly string[], input = ''): string => execFileSync('git', args, {
      cwd: directory, input, encoding: 'utf8', env,
    }).trim()
    git(['init', '--quiet'])
    const tree = (files: readonly string[]): string => {
      const blob = git(['hash-object', '-w', '--stdin'], 'fixture\n')
      return git(['mktree'], files.map(file => `100644 blob ${blob}\t${file}\n`).join(''))
    }
    const commit = (files: readonly string[], parents: readonly string[] = []): string =>
      git(['commit-tree', tree(files), ...parents.flatMap(parent => ['-p', parent]), '-m', 'scope replay fixture'])
    const first = commit(['old.ts'])
    const left = commit(['main.ts', 'old.ts'], [first])
    const right = commit(['feature.ts', 'old.ts'], [first])
    const merge = commit(['feature.ts', 'main.ts', 'old.ts'], [left, right])
    const unrelated = commit([])
    const range = collectScopeReplayRange(directory, `${unrelated}..${merge}`)
    expect(range).toMatchObject({ base: unrelated, head: merge })
    expect(range.records).toHaveLength(4)
    expect(range.records.find(entry => entry.commit === merge)).toEqual({ commit: merge, base: left, paths: ['feature.ts'] })
    expect(range.records.find(entry => entry.commit === first)).toEqual({ commit: first, base: tree([]), paths: ['old.ts'] })
    const renamed = commit(['feature.ts', 'main.ts', 'new.ts'], [merge])
    expect(collectScopeReplayRange(directory, `${merge}..${renamed}`).records[0]?.paths).toEqual(['new.ts', 'old.ts'])
    for (const bad of ['--all..HEAD', 'HEAD...HEAD', '..HEAD', 'HEAD', 'HEAD ..HEAD']) {
      expect(() => collectScopeReplayRange(directory, bad), bad).toThrow(/scope replay:/)
    }
    expect(() => collectScopeReplayRange(directory, `${merge}..${merge}`)).toThrow(/no commits/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('the real CLI preserves archived input compatibility and refuses malformed or ambiguous input', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'scope-replay-cli-'))
  try {
    const baseline = resolve(directory, 'baseline.json')
    const out = resolve(directory, 'report.json')
    const run = (args: readonly string[]): ReturnType<typeof spawnSync> => {
      const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/replay-ci-scope.ts', ...args], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      return result
    }
    writeFileSync(baseline, JSON.stringify({ formatVersion: 1, head: record.commit, records: [record] }))
    const accepted = run(['--baseline', baseline, '--out', out])
    expect(accepted.status, String(accepted.stderr)).toBe(0)
    const report = JSON.parse(readFileSync(out, 'utf8')) as {
      version: number
      corpusBaseline: { head: string }
      comparisonBaseline: string
      unexplained: string[]
    }
    expect(report).toMatchObject({ version: 2, corpusBaseline: { head: record.commit },
      comparisonBaseline: FROZEN_CI_SCOPE_COMMIT, unexplained: [] })
    expect(run(['--baseline', baseline, '--range', 'HEAD~1..HEAD', '--out', out]).status).not.toBe(0)
    writeFileSync(baseline, JSON.stringify({ formatVersion: 1, head: record.commit, records: [{ ...record, paths: [null] }] }))
    expect(run(['--baseline', baseline, '--out', out]).status).not.toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 45_000)
