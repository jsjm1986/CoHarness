import { execFileSync } from 'node:child_process'

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'full'
}

/**
 * Classify a pull-request diff for the CI lane selector.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param diff - Zero-context unified diff for identifying pin-only workflow edits.
 * @returns Whether coverage, consumer, runtime, and Windows lanes should run.
 */
export function classifyCiPrScope(paths: readonly string[], diff: string): CiPrScope {
  if (paths.length === 0) return { runExpensive: true, reason: 'full' }

  const changedLines = diff
    .split('\n')
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
  const actionOnly = paths.every(path => path.startsWith('.github/workflows/'))
    && changedLines.length > 0
    && changedLines.every(line => /pnpm\/action-setup@v\d/.test(line))
  if (actionOnly) return { runExpensive: false, reason: 'action-only' }

  const docsOnly = paths.every(path => path.startsWith('docs/')
    || path.startsWith('website/')
    || path.startsWith('.agents/')
    || path.endsWith('.md')
    || path.endsWith('.mdx')
    || path.endsWith('.i18n.yaml'))
  if (docsOnly) return { runExpensive: false, reason: 'docs-only' }

  return { runExpensive: true, reason: 'full' }
}

function main(): void {
  const base = process.argv[2]
  if (base === undefined || base === '') throw new Error('ci-pr-scope: expected a base commit')
  const range = `${base}...HEAD`
  const paths = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
  const diff = execFileSync('git', ['diff', '--unified=0', range], { encoding: 'utf8' })
  const result = classifyCiPrScope(paths, diff)
  process.stdout.write(`run_expensive=${String(result.runExpensive)}\nreason=${result.reason}\n`)
}

if (import.meta.main) main()
