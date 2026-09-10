import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'scoped' | 'full'
  readonly changedSourceFiles: readonly string[]
  readonly changedPackageFiles: readonly string[]
  readonly changedDocsOnly: boolean
  readonly coverageMode: 'skip' | 'scoped' | 'full'
  readonly snapshotMode: 'skip' | 'scoped' | 'full'
}

const MAX_SCOPED_PACKAGES = 4

function scopedPackage(path: string): string | undefined {
  const match = /^packages\/([^/]+\/[^/]+)\/(?:src|tests)\//.exec(path)
  return match?.[1]
}

function isScopedPath(path: string): boolean {
  return /^packages\/[^/]+\/[^/]+\/(?:src|tests)\/[^/]+\.(?:ts|tsx)$/.test(path)
}

/**
 * Collect the `<group>/<name>` keys of every package whose source can change
 * browser-rendered output.
 *
 * Two markers are needed, because neither covers the whole surface on its own.
 * Everything under `packages/client/` is browser-rendered, including the shared
 * primitives that other client packages bundle without publishing a `./client`
 * entry of their own. Outside that directory the `./client` export is the
 * marker, and it is not optional: 16 browser-rendered packages live under other
 * groups, so the directory layout alone would miss them.
 *
 * @param root - Repository root holding the `packages/` workspace.
 * @returns The set of browser-rendered package keys.
 */
export function clientSurfacePackages(root: string): ReadonlySet<string> {
  const packages = new Set<string>()
  for (const group of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRoot = join(root, 'packages', group.name)
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let manifest: { exports?: Record<string, unknown> }
      try {
        manifest = JSON.parse(readFileSync(join(groupRoot, entry.name, 'package.json'), 'utf8')) as typeof manifest
      } catch {
        continue
      }
      if (group.name === 'client' || (manifest.exports !== undefined && Object.hasOwn(manifest.exports, './client'))) {
        packages.add(`${group.name}/${entry.name}`)
      }
    }
  }
  return packages
}

/**
 * Classify a pull-request diff for the CI lane selector.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param diff - Zero-context unified diff for identifying pin-only workflow edits.
 * @param clientPackages - Keys of browser-rendered packages, from {@link clientSurfacePackages}.
 * @returns Whether coverage, consumer, runtime, and Windows lanes should run.
 */
export function classifyCiPrScope(
  paths: readonly string[],
  diff: string,
  clientPackages: ReadonlySet<string> = new Set(),
): CiPrScope {
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

  const packages = [...new Set(paths.map(scopedPackage).filter((value): value is string => value !== undefined))]
  const scoped = paths.every(isScopedPath) && packages.length > 0 && packages.length <= MAX_SCOPED_PACKAGES
  if (scoped) return {
    ...common,
    runExpensive: true,
    reason: 'scoped',
    coverageMode: 'scoped',
    // The scoped consumer aggregate drops the Playwright browser snapshot, which
    // is only sound while the change cannot alter browser-rendered output. A
    // browser-rendered package breaks that assumption, so those pull requests
    // keep the full snapshot inventory while coverage stays scoped.
    snapshotMode: packages.some(pkg => clientPackages.has(pkg)) ? 'full' : 'scoped',
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
  const result = classifyCiPrScope(paths, diff, clientSurfacePackages(process.cwd()))
  if (result.reason === 'scoped' && result.snapshotMode === 'full') {
    console.error('ci-pr-scope: client-surface change, keeping the full snapshot inventory')
  }
  const scopedPackages = result.coverageMode === 'scoped'
    ? [...new Set(paths.map(scopedPackage).filter((value): value is string => value !== undefined))]
    : []
  process.stdout.write(`${[
    `run_expensive=${String(result.runExpensive)}`,
    `reason=${result.reason}`,
    `changed_source_files=${JSON.stringify(result.changedSourceFiles)}`,
    `changed_package_files=${JSON.stringify(result.changedPackageFiles)}`,
    `changed_docs_only=${String(result.changedDocsOnly)}`,
    `coverage_mode=${result.coverageMode}`,
    `snapshot_mode=${result.snapshotMode}`,
    `scoped_packages=${JSON.stringify(scopedPackages)}`,
  ].join('\n')}\n`)
}

if (import.meta.main) main()
