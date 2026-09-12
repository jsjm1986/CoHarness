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

interface StatementLocation {
  readonly start?: { readonly line?: unknown }
}

interface CoverageEntry {
  readonly statementMap?: Record<string, StatementLocation>
  readonly l?: Record<string, unknown>
  readonly s?: Record<string, unknown>
  readonly f?: Record<string, unknown>
  readonly b?: Record<string, unknown>
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
  map: Record<string, unknown>,
  paths: readonly string[],
): IncrementalCoverageFile[] {
  return changedMeasuredSources(paths).map((path) => {
    const entry = Object.entries(map).find(([key]) => normalizePath(root, key) === path)?.[1]
    if (entry === undefined) throw new Error(`changed source file is absent from coverage map: ${path}`)
    const coverage = asCoverageEntry(entry, path)
    return {
      path,
      lines: percentage(lineCounts(coverage), path, 'lines'),
      statements: percentage(coverage.s, path, 'statements'),
      functions: percentage(coverage.f, path, 'functions'),
      branches: percentageBranches(coverage.b, path),
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

function asCoverageEntry(value: unknown, path: string): Required<Pick<CoverageEntry, 'statementMap' | 's' | 'f' | 'b'>> & CoverageEntry {
  if (!isRecord(value)) throw new Error(`${path}: coverage entry is not an object`)
  const statementMap = value.statementMap
  const statements = value.s
  const functions = value.f
  const branches = value.b
  if (!isRecord(statementMap) || !isRecord(statements) || !isRecord(functions) || !isRecord(branches)) {
    throw new Error(`${path}: coverage entry is missing statementMap, s, f, or b`)
  }
  return { ...value, statementMap, s: statements, f: functions, b: branches } as Required<Pick<CoverageEntry, 'statementMap' | 's' | 'f' | 'b'>> & CoverageEntry
}

function lineCounts(entry: CoverageEntry & Required<Pick<CoverageEntry, 'statementMap' | 's'>>): Record<string, number> {
  if (entry.l !== undefined) return numericCounts(entry.l, 'lines')
  const lines: Record<string, number> = {}
  for (const [id, location] of Object.entries(entry.statementMap)) {
    const hit = entry.s[id]
    if (typeof hit !== 'number' || !Number.isFinite(hit) || hit < 0) throw new Error('invalid statement coverage count')
    const start = isRecord(location) && isRecord(location.start) ? location.start.line : undefined
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) throw new Error('coverage statement has no valid start line')
    const key = String(start)
    lines[key] = Math.max(lines[key] ?? 0, hit)
  }
  return lines
}

function numericCounts(values: unknown, metric: string): Record<string, number> {
  if (!isRecord(values)) throw new Error(`coverage entry has invalid ${metric} counts`)
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`coverage entry has invalid ${metric} count`)
    result[key] = value
  }
  return result
}

function percentage(values: unknown, path: string, metric: CoverageMetric): number {
  const counts = Object.values(numericCounts(values, metric))
  const total = counts.length
  if (total === 0) return 100
  const covered = counts.filter(value => value > 0).length
  if (covered === total) return 100
  throw new Error(`${path}: ${metric} coverage is below 100% (${covered}/${total})`)
}

function percentageBranches(values: unknown, path: string): number {
  if (!isRecord(values)) throw new Error(`${path}: coverage entry has invalid branches counts`)
  const counts = Object.values(values).flatMap((value) => {
    if (!Array.isArray(value)) {
      throw new Error(`${path}: coverage entry has invalid branches count`)
    }
    const branchCounts: number[] = []
    for (const item of value as unknown[]) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
        throw new Error(`${path}: coverage entry has invalid branches count`)
      }
      branchCounts.push(item)
    }
    return branchCounts
  })
  if (counts.length === 0) return 100
  const covered = counts.filter(value => value > 0).length
  if (covered === counts.length) return 100
  throw new Error(`${path}: branches coverage is below 100% (${covered}/${counts.length})`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function main(): void {
  const base = process.argv[2]
  const coveragePath = process.argv[3] ?? 'coverage/coverage-final.json'
  if (base === undefined || base === '') throw new Error('usage: tsx scripts/incremental-coverage.ts <base-ref> [coverage-map]')
  const root = resolve(import.meta.dirname, '..')
  // A deleted source has no coverage entry by definition; only added, copied,
  // modified, renamed, or type-changed sources need a per-file verdict.
  const paths = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRTXB', `${base}...HEAD`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .trim().split(/\r?\n/u).filter(Boolean)
  const map = JSON.parse(readFileSync(resolve(root, coveragePath), 'utf8')) as Record<string, unknown>
  const files = summarizeIncrementalCoverage(root, map, paths)
  assertIncrementalCoverage(files)
  process.stdout.write(`incremental coverage: ${files.length} changed measured source file(s) at 100%\n`)
}

if (import.meta.main) main()
