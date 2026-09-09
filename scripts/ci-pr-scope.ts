import { execFileSync } from 'node:child_process'

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'full'
  readonly changedSourceFiles: readonly string[]
  readonly changedPackageFiles: readonly string[]
  readonly changedDocsOnly: boolean
  readonly coverageMode: 'skip' | 'full'
  readonly snapshotMode: 'skip' | 'full'
}

/**
 * Classify a pull-request diff for the CI lane selector.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param diff - Zero-context unified diff for identifying pin-only workflow edits.
 * @returns Whether coverage, consumer, runtime, and Windows lanes should run.
 */
export function classifyCiPrScope(paths: readonly string[], diff: string): CiPrScope {
  const changedSourceFiles = paths.filter(path => /^packages\/[^/]+\/[^/]+\/src\//.test(path))
  const changedPackageFiles = paths.filter(path => path.endsWith('/package.json') || path === 'package.json' || path === 'pnpm-lock.yaml')
  const docsOnlyPaths = paths.every(path => path.startsWith('docs/')
    || path.startsWith('website/')
    || path.startsWith('.agents/')
    || path.endsWith('.md')
    || path.endsWith('.mdx')
    || path.endsWith('.i18n.yaml'))

  if (paths.length === 0) return {
    runExpensive: true,
    reason: 'full',
    changedSourceFiles,
    changedPackageFiles,
    changedDocsOnly: false,
    coverageMode: 'full',
    snapshotMode: 'full',
  }

  const changedLines = diff
    .split('\n')
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
  const actionOnly = paths.every(path => path.startsWith('.github/workflows/'))
    && changedLines.length > 0
    && changedLines.every(line => /pnpm\/action-setup@v\d/.test(line))
  const common = { changedSourceFiles, changedPackageFiles, changedDocsOnly: docsOnlyPaths }
  if (actionOnly) return {
    ...common,
    runExpensive: false,
    reason: 'action-only',
    coverageMode: 'skip',
    snapshotMode: 'skip',
  }
  if (docsOnlyPaths) return {
    ...common,
    runExpensive: false,
    reason: 'docs-only',
    coverageMode: 'skip',
    snapshotMode: 'skip',
  }

  return {
    ...common,
    runExpensive: true,
    reason: 'full',
    coverageMode: 'full',
    snapshotMode: 'full',
  }
}

function main(): void {
  const base = process.argv[2]
  if (base === undefined || base === '') throw new Error('ci-pr-scope: expected a base commit')
  const range = `${base}...HEAD`
  const paths = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
    .trim()
    .split('\n')
    .filter(Boolean)
  const diff = execFileSync('git', ['diff', '--unified=0', range], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
  const result = classifyCiPrScope(paths, diff)
  process.stdout.write(`${[
    `run_expensive=${String(result.runExpensive)}`,
    `reason=${result.reason}`,
    `changed_source_files=${JSON.stringify(result.changedSourceFiles)}`,
    `changed_package_files=${JSON.stringify(result.changedPackageFiles)}`,
    `changed_docs_only=${String(result.changedDocsOnly)}`,
    `coverage_mode=${result.coverageMode}`,
    `snapshot_mode=${result.snapshotMode}`,
  ].join('\n')}\n`)
}

if (import.meta.main) main()
