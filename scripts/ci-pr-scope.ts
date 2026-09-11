import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expandPackageGroups, loadWebTestPolicy, scanGoldenOwners, WEB_TESTS_ROOT, type WebTestPolicy } from './web-test-policy.ts'

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'scoped' | 'python-only' | 'full'
  readonly changedSourceFiles: readonly string[]
  readonly changedPackageFiles: readonly string[]
  readonly changedDocsOnly: boolean
  readonly coverageMode: 'skip' | 'scoped' | 'full'
  /**
   * Snapshot lane selection. `skip` runs nothing; `scoped` keeps the keyless
   * ACP/CLI snapshots with no browser work; `focused` adds the web browser
   * verification of {@link webGroups}; `full` adds the complete browser
   * inventory. The keyless consumer aggregate is identical under `scoped`,
   * `focused`, and `full` — only the dedicated web verification lane differs.
   */
  readonly snapshotMode: 'skip' | 'scoped' | 'focused' | 'full'
  /** Business groups the focused web verification runs; empty unless snapshotMode is `focused`. */
  readonly webGroups: readonly string[]
  /** Node runtime-compatibility smokes across the supported Node majors. */
  readonly compatMode: 'skip' | 'full'
  /** The Python SDK suite and the release-shaped runtime wheel. */
  readonly pythonMode: 'skip' | 'full'
  /** The Wine blocking gate and the native Windows gate inventory. */
  readonly windowsMode: 'skip' | 'full'
}

/** The web browser verification tier for one changed path set. */
export interface WebVerificationPlan {
  readonly mode: 'skip' | 'focused' | 'full'
  /** Selected business groups; non-empty only under `focused`. */
  readonly groups: readonly string[]
}

const MAX_SCOPED_PACKAGES = 4

const FULL_WEB_VERIFICATION: WebVerificationPlan = { mode: 'full', groups: [] }
const SKIP_WEB_VERIFICATION: WebVerificationPlan = { mode: 'skip', groups: [] }

function scopedPackage(path: string): string | undefined {
  const match = /^packages\/([^/]+\/[^/]+)\/(?:src|tests)\//.exec(path)
  return match?.[1]
}

function isScopedPath(path: string): boolean {
  return /^packages\/[^/]+\/[^/]+\/(?:src|tests)\/[^/]+\.(?:ts|tsx)$/.test(path)
}

/** Lockfile and build configuration, which every lane's inputs depend on. */
const DEPENDENCY_PATH = /(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json)$/

/**
 * Documentation and agent notes, which no lane's inputs depend on. Golden
 * payloads under `apps/web/tests/snapshots/` are test data, not docs: their
 * `.md` extension must not read as documentation, or a golden-only diff would
 * skip every lane.
 */
function isInertPath(path: string): boolean {
  if (path.startsWith(`${WEB_TESTS_ROOT}snapshots/`)) return false
  return path.startsWith('docs/')
    || path.startsWith('website/')
    || path.startsWith('.agents/')
    || path.endsWith('.md')
    || path.endsWith('.mdx')
    || path.endsWith('.i18n.yaml')
}

/**
 * Paths that provably stay outside the browser lane's input domain: inert
 * documentation, the listed host-side trees, and root-level tooling
 * configuration. Anything else unrecognized falls through to the full
 * inventory.
 */
function isWebIrrelevantPath(path: string): boolean {
  if (isInertPath(path)
    || path.startsWith('python/')
    || path.startsWith('native/')
    || path.startsWith('examples/')
    || path.startsWith('apps/cli/')
    || path.startsWith('apps/android-shell/')
    || path.startsWith('.github/')
    || path.startsWith('scripts/')) {
    return true
  }
  if (!path.includes('/')) {
    // Root lane and tooling configs (vitest, knip, oxlint, jscpd) cannot alter
    // browser-rendered output; the web ones are matched by the policy's
    // webInfraPrefixes before this runs.
    if (/^[a-z0-9.-]+\.config\.ts$/.test(path)) return true
    if (/\.(?:json|yaml|yml|toml|mjs|cjs)$/.test(path) || path.startsWith('.')) return true
    return false
  }
  return false
}

/**
 * Route one path under {@link WEB_TESTS_ROOT}: a scenario key to its group, a
 * golden file to the groups of the scenarios that reference its directory,
 * inert documentation to nothing, and every other file to the full inventory.
 * @param path - Repository-relative path inside the web test tree.
 * @param policy - The checked-in web test policy.
 * @param goldenOwners - Golden directory to referencing scenario keys, from {@link scanGoldenOwners}.
 * @returns The owning business groups, or the `full`/`inert` disposition.
 */
function routeWebTestPath(
  path: string,
  policy: WebTestPolicy,
  goldenOwners: ReadonlyMap<string, readonly string[]>,
): readonly string[] | 'full' | 'inert' {
  const relative = path.slice(WEB_TESTS_ROOT.length)
  const scenarioGroup = policy.scenarios[relative]
  if (scenarioGroup !== undefined) return [scenarioGroup]
  const golden = /^snapshots\/([^/]+)\//.exec(relative)
  if (golden !== null) {
    const directory = golden[1]
    const owners = directory === undefined ? undefined : goldenOwners.get(directory)
    if (owners === undefined || owners.length === 0) return 'full'
    const groups = new Set<string>()
    for (const owner of owners) {
      const group = policy.scenarios[owner]
      if (group === undefined) return 'full'
      groups.add(group)
    }
    return [...groups].sort()
  }
  return isInertPath(path) ? 'inert' : 'full'
}

/**
 * Classify the changed paths for the dedicated web browser verification lane.
 *
 * Full triggers are proved reachability: a policy full prefix (the web app
 * source, public, and stress trees; client runtime, connection, Loader, api,
 * extensions, Typert, the apiproxy fetch carrier), a dependency or
 * build-config edit, a web-lane infrastructure file, a test file no scenario
 * table entry owns, or a golden directory no scenario references. A scenario
 * file routes to its group, and a committed golden routes to the groups of
 * every scenario that references its directory. Browser-rendered packages
 * resolve through the policy's package mapping; an unmapped browser-rendered
 * package falls back to the full inventory. Paths outside every known
 * category also fall back to full.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param clientPackages - Keys of browser-rendered packages, from {@link clientSurfacePackages}.
 * @param policy - The checked-in web test policy.
 * @param goldenOwners - Golden directory to referencing scenario keys, from {@link scanGoldenOwners}.
 * @returns The verification tier and, under `focused`, the selected business groups.
 */
export function classifyWebVerification(
  paths: readonly string[],
  clientPackages: ReadonlySet<string>,
  policy: WebTestPolicy,
  goldenOwners: ReadonlyMap<string, readonly string[]>,
): WebVerificationPlan {
  if (paths.length === 0) return FULL_WEB_VERIFICATION
  const groups = new Set<string>()
  for (const path of paths) {
    if (path.startsWith(WEB_TESTS_ROOT)) {
      const route = routeWebTestPath(path, policy, goldenOwners)
      if (route === 'inert') continue
      if (route === 'full') return FULL_WEB_VERIFICATION
      for (const group of route) groups.add(group)
      continue
    }
    if (policy.fullPrefixes.some(prefix => path.startsWith(prefix))) return FULL_WEB_VERIFICATION
    if (DEPENDENCY_PATH.test(path)) return FULL_WEB_VERIFICATION
    if (policy.webInfraPrefixes.some(prefix => path.startsWith(prefix))) return FULL_WEB_VERIFICATION
    const pkg = scopedPackage(path)
    if (pkg !== undefined) {
      if (!clientPackages.has(pkg)) continue
      const mapping = policy.packages[pkg]
      if (mapping === undefined) return FULL_WEB_VERIFICATION
      for (const group of expandPackageGroups(mapping, policy)) groups.add(group)
      continue
    }
    if (isWebIrrelevantPath(path)) continue
    return FULL_WEB_VERIFICATION
  }
  if (groups.size === 0) return SKIP_WEB_VERIFICATION
  return { mode: 'focused', groups: [...groups].sort() }
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
 * Lanes are selected by negative gating: a lane is skipped only when every
 * changed path is provably outside that lane's input domain, so an unrecognized
 * path falls through to the full inventory rather than silently skipping a lane.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param diff - Zero-context unified diff for identifying pin-only workflow edits.
 * @param clientPackages - Keys of browser-rendered packages, from {@link clientSurfacePackages}.
 * @param policy - The checked-in web test policy; defaults to loading it from the repository.
 * @param goldenOwners - Golden directory to referencing scenario keys; defaults to scanning the repository.
 * @returns Which coverage, snapshot, web, compatibility, Python, and Windows lanes should run.
 */
export function classifyCiPrScope(
  paths: readonly string[],
  diff: string,
  clientPackages: ReadonlySet<string> = new Set(),
  policy: WebTestPolicy = loadWebTestPolicy(resolve(import.meta.dirname, '..')),
  goldenOwners: ReadonlyMap<string, readonly string[]> = scanGoldenOwners(resolve(import.meta.dirname, '..')),
): CiPrScope {
  const changedSourceFiles = paths.filter(path => /^packages\/[^/]+\/[^/]+\/src\//.test(path))
  const changedPackageFiles = paths.filter(path => path.endsWith('/package.json') || path === 'package.json' || path === 'pnpm-lock.yaml')
  const inertOnly = paths.length > 0 && paths.every(isInertPath)
  const common = { changedSourceFiles, changedPackageFiles, changedDocsOnly: inertOnly }
  const webPlan = classifyWebVerification(paths, clientPackages, policy, goldenOwners)
  // The Node lanes run the whole runtime suite. Only documentation and the Python
  // SDK are provably outside their input domain; `scripts/**` is deliberately not
  // exempt, because it holds the gate runner every lane invokes and the fixture
  // generator the snapshot lane consumes.
  const nodeLanesUnreachable = paths.length > 0 && paths.every(path => isInertPath(path) || path.startsWith('python/'))
  // The Python lanes build and exercise `python/**` plus the packaged runtime, so
  // only a Python or dependency change can reach them.
  const pythonLanesReachable = paths.some(path => path.startsWith('python/') || DEPENDENCY_PATH.test(path))
  const snapshotModeFromWeb: Record<WebVerificationPlan['mode'], CiPrScope['snapshotMode']> = {
    skip: 'scoped',
    focused: 'focused',
    full: 'full',
  }

  if (paths.length === 0) return {
    runExpensive: true,
    reason: 'full',
    changedSourceFiles,
    changedPackageFiles,
    changedDocsOnly: false,
    coverageMode: 'full',
    snapshotMode: 'full',
    webGroups: [],
    compatMode: 'full',
    pythonMode: 'full',
    windowsMode: 'full',
  }

  const changedLines = diff
    .split('\n')
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
  const actionOnly = paths.every(path => path.startsWith('.github/workflows/'))
    && changedLines.length > 0
    && changedLines.every(line => /pnpm\/action-setup@v\d/.test(line))
  if (actionOnly) return {
    ...common,
    runExpensive: false,
    reason: 'action-only',
    coverageMode: 'skip',
    snapshotMode: 'skip',
    webGroups: [],
    compatMode: 'skip',
    pythonMode: 'skip',
    windowsMode: 'skip',
  }
  if (inertOnly) return {
    ...common,
    runExpensive: false,
    reason: 'docs-only',
    coverageMode: 'skip',
    snapshotMode: 'skip',
    webGroups: [],
    compatMode: 'skip',
    pythonMode: 'skip',
    windowsMode: 'skip',
  }

  const packages = [...new Set(paths.map(scopedPackage).filter((value): value is string => value !== undefined))]
  const scoped = paths.every(isScopedPath) && packages.length > 0 && packages.length <= MAX_SCOPED_PACKAGES
  if (scoped) return {
    ...common,
    runExpensive: true,
    reason: 'scoped',
    coverageMode: 'scoped',
    // The keyless consumer aggregate drops the browser snapshot in every
    // snapshot mode; focused and full tiers run it in the dedicated
    // web-verification lane instead.
    snapshotMode: snapshotModeFromWeb[webPlan.mode],
    webGroups: webPlan.groups,
    compatMode: 'full',
    pythonMode: pythonLanesReachable ? 'full' : 'skip',
    windowsMode: 'full',
  }

  return {
    ...common,
    runExpensive: !nodeLanesUnreachable,
    reason: nodeLanesUnreachable ? 'python-only' : 'full',
    coverageMode: nodeLanesUnreachable ? 'skip' : 'full',
    // A change with no browser-rendered input keeps the keyless ACP/CLI snapshots
    // but not the Playwright inventory, which would have nothing new to render.
    snapshotMode: nodeLanesUnreachable ? 'skip' : snapshotModeFromWeb[webPlan.mode],
    webGroups: nodeLanesUnreachable ? [] : webPlan.groups,
    compatMode: 'full',
    pythonMode: pythonLanesReachable ? 'full' : 'skip',
    windowsMode: nodeLanesUnreachable ? 'skip' : 'full',
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
  if (result.snapshotMode === 'focused') {
    console.error(`ci-pr-scope: focused web verification for groups ${JSON.stringify(result.webGroups)}`)
  } else if (result.snapshotMode === 'full') {
    console.error('ci-pr-scope: keeping the full web browser inventory')
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
    `web_groups=${result.webGroups.join(',')}`,
    `compat_mode=${result.compatMode}`,
    `python_mode=${result.pythonMode}`,
    `windows_mode=${result.windowsMode}`,
    `scoped_packages=${JSON.stringify(scopedPackages)}`,
  ].join('\n')}\n`)
}

if (import.meta.main) main()
