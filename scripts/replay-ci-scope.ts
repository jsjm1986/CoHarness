/** Compare selections over immutable historical diffs without running historical builds. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveCiPrScopePlans, type CiPrScope, type CiPrScopePlans, type CiScopeChange } from './ci-pr-scope.ts'
import { FROZEN_CI_SCOPE_COMMIT } from './fixtures/pr-scope-baseline/classifier.ts'

/** One immutable parent/child comparison; archived selections retain their original source identity. */
export interface ScopeReplayRecord {
  readonly commit: string
  readonly base: string
  readonly paths: readonly string[]
  readonly selection?: Partial<CiPrScope>
}

/** A frozen pair of range endpoints and every commit selected by that range. */
export interface ScopeReplayRange {
  readonly base: string
  readonly head: string
  readonly records: readonly ScopeReplayRecord[]
}

/** A classified increase or reduction in executed validation. */
export interface ScopeReplayDifference extends CiScopeChange {
  readonly commit: string
  readonly direction: 'add' | 'reduce'
}

/** Stable results from comparing the frozen execution policy with the current candidate. */
export interface ScopeReplayResult {
  readonly comparisonBaseline: string
  readonly executionSource: 'shadow-union'
  readonly commits: number
  readonly groups: Readonly<Record<string, number>>
  readonly unexplained: readonly string[]
  readonly differences: readonly ScopeReplayDifference[]
  /** Differences from an older stored selector are context, not the current migration oracle. */
  readonly archivedDifferences: readonly {
    readonly commit: string
    readonly field: string
    readonly archived: unknown
    readonly frozen: unknown
  }[]
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 30_000 })
}

function frozenEndpoint(root: string, ref: string): string {
  if (!/^[\w][\w./~^@{}-]*$/.test(ref) || ref.includes('..')) throw new Error(`scope replay: invalid range endpoint ${JSON.stringify(ref)}`)
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim()
}

/**
 * Freeze a Git range and read each commit against its first parent, or the empty tree for a root.
 * @param root - Git checkout containing the requested commits.
 * @param range - An explicit A..B range; option-like and ambiguous endpoint syntax is rejected.
 * @returns Immutable endpoints, complete paths including both rename sides, and all selected commits.
 */
export function collectScopeReplayRange(root: string, range: string): ScopeReplayRange {
  const endpoints = range.split('..')
  if (range.includes('...') || endpoints.length !== 2 || !endpoints[0] || !endpoints[1]) {
    throw new Error('scope replay: --range requires explicit A..B endpoints')
  }
  const base = frozenEndpoint(root, endpoints[0])
  const head = frozenEndpoint(root, endpoints[1])
  const commits = git(root, ['rev-list', '--reverse', `${base}..${head}`]).trim().split('\n').filter(Boolean)
  if (commits.length === 0) throw new Error('scope replay: range contains no commits')
  const emptyTree = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '', encoding: 'utf8' }).trim()
  const records = commits.map((commit) => {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ')
    const parent = parents[1] ?? emptyTree
    const paths = git(root, ['diff', '--name-only', '-z', '--no-renames', parent, commit, '--']).split('\0').filter(Boolean)
    return { commit, base: parent, paths }
  })
  return { base, head, records }
}

function readBaseline(path: string): { head: string; digest: string; records: ScopeReplayRecord[] } {
  const bytes = readFileSync(path)
  const value = JSON.parse(bytes.toString('utf8')) as unknown
  if (value === null || typeof value !== 'object' || !('formatVersion' in value) || value.formatVersion !== 1
    || !('head' in value) || typeof value.head !== 'string' || !('records' in value) || !Array.isArray(value.records) || value.records.length === 0) {
    throw new Error('scope replay: empty or unsupported baseline')
  }
  const records = value.records as unknown[]
  for (const row of records) {
    if (row === null || typeof row !== 'object' || !('commit' in row) || typeof row.commit !== 'string'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.commit) || !('base' in row) || typeof row.base !== 'string'
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.base) || !('paths' in row) || !Array.isArray(row.paths)
      || !(row.paths as unknown[]).every(path => typeof path === 'string')
      || ('selection' in row && (row.selection === null || typeof row.selection !== 'object' || Array.isArray(row.selection)))) {
      throw new Error('scope replay: malformed baseline record')
    }
  }
  return { head: value.head, digest: createHash('sha256').update(bytes).digest('hex'), records: records as ScopeReplayRecord[] }
}

const REDUCTION_RULES: Readonly<Record<string, readonly string[]>> = {
  coverage: ['accompanying-inert-prose'],
  web: ['exact-scenario-owners-and-smokes', 'accompanying-inert-prose'],
  gatewayMode: ['inert-consumer-documentation'],
  adminUiMode: ['inert-consumer-documentation'],
}

/**
 * Record every changed lane and reject reductions without a reviewed path-class rule.
 * @param records - Frozen historical path sets, optionally carrying selections from an older audit.
 * @param select - Complete baseline/candidate comparison for one record, using shadow execution.
 * @returns Grouped differences, archived context, and failures; no tests or builds are run.
 */
export function compareScopeReplay(
  records: readonly ScopeReplayRecord[],
  select: (record: ScopeReplayRecord) => CiPrScopePlans,
): ScopeReplayResult {
  const groups: Record<string, number> = {}
  const unexplained: string[] = []
  const differences: ScopeReplayDifference[] = []
  const archivedDifferences: { commit: string; field: string; archived: unknown; frozen: unknown }[] = []
  for (const record of records) {
    const plan = select(record)
    if (plan.baselineStatus !== 'available') unexplained.push(`${record.commit}: frozen baseline unavailable: ${plan.baselineError ?? 'unknown cause'}`)
    if (plan.executionSource !== 'shadow-union' || plan.baselineCommit !== FROZEN_CI_SCOPE_COMMIT) {
      throw new Error('scope replay: comparison requires the pinned baseline and shadow execution')
    }
    if (record.selection !== undefined) {
      for (const field of Object.keys(record.selection) as (keyof CiPrScope)[]) {
        const archived = record.selection[field]
        const frozen = plan.previous[field]
        if (JSON.stringify(archived) !== JSON.stringify(frozen)) {
          archivedDifferences.push({ commit: record.commit, field, archived, frozen })
        }
      }
    }
    for (const direction of ['add', 'reduce'] as const) {
      for (const change of plan.changes[direction === 'add' ? 'added' : 'removed']) {
        if (direction === 'reduce' && !REDUCTION_RULES[change.lane]?.includes(change.reason)) {
          unexplained.push(`${record.commit}: unexplained reduction in ${change.lane}: ${change.reason}`)
        }
        const key = `${direction}:${change.lane}:${change.reason}`
        groups[key] = (groups[key] ?? 0) + 1
        differences.push({ commit: record.commit, direction, ...change })
      }
    }
  }
  return { comparisonBaseline: FROZEN_CI_SCOPE_COMMIT, executionSource: 'shadow-union', commits: records.length,
    groups, unexplained, differences, archivedDifferences }
}

function main(): void {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, range: { type: 'string' }, out: { type: 'string' } }, allowPositionals: false })
  if ((!values.baseline && !values.range) || (values.baseline && values.range) || !values.out) {
    throw new Error('scope replay: exactly one of --baseline or --range, and --out, are required')
  }
  const root = resolve(import.meta.dirname, '..')
  const corpus = values.baseline !== undefined ? readBaseline(values.baseline) : collectScopeReplayRange(root, values.range ?? '')
  const result = compareScopeReplay(corpus.records, (record) => {
    const diff = record.paths.length > 0 && record.paths.every(path => path.startsWith('.github/workflows/'))
      ? git(root, ['diff', '--unified=0', record.base, record.commit, '--']) : ''
    return resolveCiPrScopePlans(record.paths, diff, root, { DSH_CI_SCOPE_POLICY: 'shadow' })
  })
  const corpusBaseline = { kind: values.baseline !== undefined ? 'baseline-file' : 'git-range', head: corpus.head,
    ...'base' in corpus ? { base: corpus.base } : {}, ...'digest' in corpus ? { sha256: corpus.digest } : {} }
  writeFileSync(values.out, JSON.stringify({ version: 2, corpusBaseline, ...result }, null, 2) + '\n')
  console.log(JSON.stringify({ commits: result.commits, changedDecisions: result.differences.length,
    archivedDifferences: result.archivedDifferences.length, unexplained: result.unexplained.length, groups: result.groups }))
  if (result.unexplained.length > 0) process.exitCode = 1
}

if (import.meta.main) main()
