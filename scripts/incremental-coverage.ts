import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/** Four coverage dimensions enforced for every changed measured source file. */
export type CoverageMetric = 'lines' | 'statements' | 'functions' | 'branches'

/** A coverage summary for one source file. */
export interface IncrementalCoverageFile {
  readonly path: string
  readonly lines: number
  readonly statements: number
  readonly functions: number
  readonly branches: number
}

/** Return changed package source paths that are measured by the repository gate. */
export function changedMeasuredSources(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(path => /^packages\/[^/]+\/[^/]+\/src\/[^*?{}\[\]]+\.(?:ts|tsx)$/.test(path) && !path.endsWith('.d.ts')))].sort()
}

/**
 * Read an Istanbul/V8 coverage map and summarize the requested files.
 * @param root - repository root used to normalize coverage-map paths.
 * @param map - Istanbul coverage map keyed by absolute or repository-relative path.
 * @param paths - changed measured source paths.
 * @returns summaries in deterministic path order.
 */
export function summarizeIncrementalCoverage(
  root: string,
  map: Record<string, { l?: Record<string, number>; s?: Record<string, number>; f?: Record<string, number>; b?: Record<string, number[]> }>,
  paths: readonly string[],
): IncrementalCoverageFile[] {
  return changedMeasuredSources(paths).map((path) => {
    const entry = Object.entries(map).find(([key]) => normalizePath(root, key) === path)?.[1]
    if (entry === undefined) throw new Error(`changed source file is absent from coverage map: ${path}`)
    return {
      path,
      lines: percentage(entry.l ?? {}, path, 'lines'),
      statements: percentage(entry.s ?? {}, path, 'statements'),
      functions: percentage(entry.f ?? {}, path, 'functions'),
      branches: percentageBranches(entry.b ?? {}, path),
    }
  })
}

/** Assert that every changed measured source file meets all four coverage thresholds. */
export function assertIncrementalCoverage(files: readonly IncrementalCoverageFile[]): void {
  const failed = files.filter(file => Object.entries(file).some(([metric, value]) => metric !== 'path' && value < 100))
  if (failed.length > 0) {
    throw new Error(`incremental coverage below 100%:\n${failed.map(file => `${file.path}: lines=${file.lines}, statements=${file.statements}, functions=${file.functions}, branches=${file.branches}`).join('\n')}`)
  }
}

function normalizePath(root: string, value: string): string {
  return relative(root, resolve(root, value)).split(sep).join('/')
}

function percentage(values: Record<string, number>, path: string, metric: CoverageMetric): number {
  const counts = Object.values(values)
  const total = counts.length
  if (total === 0) return 100
  const covered = counts.filter(value => value > 0).length
  if (covered === total) return 100
  throw new Error(`${path}: ${metric} coverage is below 100% (${covered}/${total})`)
}

function percentageBranches(values: Record<string, number[]>, path: string): number {
  const counts = Object.values(values).flat()
  if (counts.length === 0) return 100
  const covered = counts.filter(value => value > 0).length
  if (covered === counts.length) return 100
  throw new Error(`${path}: branches coverage is below 100% (${covered}/${counts.length})`)
}

function main(): void {
  const base = process.argv[2]
  const coveragePath = process.argv[3] ?? 'coverage/coverage-final.json'
  if (base === undefined || base === '') throw new Error('usage: tsx scripts/incremental-coverage.ts <base-ref> [coverage-map]')
  const root = resolve(import.meta.dirname, '..')
  const paths = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .trim().split(/\r?\n/u).filter(Boolean)
  const map = JSON.parse(readFileSync(resolve(root, coveragePath), 'utf8')) as Record<string, { l?: Record<string, number>; s?: Record<string, number>; f?: Record<string, number>; b?: Record<string, number[]> }>
  const files = summarizeIncrementalCoverage(root, map, paths)
  assertIncrementalCoverage(files)
  process.stdout.write(`incremental coverage: ${files.length} changed measured source file(s) at 100%\n`)
}

if (import.meta.main) main()
