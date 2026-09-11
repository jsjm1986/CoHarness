import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'scoped' | 'python-only' | 'full'
  readonly changedSourceFiles: readonly string[]
  readonly changedPackageFiles: readonly string[]
  readonly changedDocsOnly: boolean
  readonly coverageMode: 'skip' | 'scoped' | 'full'
  readonly snapshotMode: 'skip' | 'scoped' | 'full'
  /** Node runtime-compatibility smokes across the supported Node majors. */
  readonly compatMode: 'skip' | 'full'
  /** The Python SDK suite and the release-shaped runtime wheel. */
  readonly pythonMode: 'skip' | 'full'
  /** The Wine blocking gate and the native Windows gate inventory. */
  readonly windowsMode: 'skip' | 'full'
  /** The independent cloud Gateway project and its ACL/runtime API tests. */
  readonly gatewayMode: 'skip' | 'full'
  /** The independent Gateway administration UI project. */
  readonly adminUiMode: 'skip' | 'full'
}

const MAX_SCOPED_PACKAGES = 4

interface CiScopePolicy {
  readonly version: number
  readonly inertPrefixes: readonly string[]
  readonly fullRuntimePrefixes: readonly string[]
  readonly fullRuntimePackagePrefixes: readonly string[]
  readonly scopedPackageGroups: readonly string[]
  readonly modelInputPrefixes: readonly string[]
  readonly modelInputSuffixes: readonly string[]
  readonly gatewayPrefixes: readonly string[]
  readonly adminUiPrefix: string
}

const policy = scopePolicy as CiScopePolicy
if (policy.version !== 1) throw new Error(`ci-pr-scope: unsupported policy version ${String(policy.version)}`)

function scopedPackage(path: string): string | undefined {
  const match = /^packages\/([^/]+\/[^/]+)\/(?:src|tests)\//.exec(path)
  return match?.[1]
}

function isScopedPath(path: string): boolean {
  return /^packages\/[^/]+\/[^/]+\/(?:src|tests)\/[^*?{}\[\]]+\.(?:ts|tsx)$/.test(path)
}

/** Lockfile and build configuration, which every lane's inputs depend on. */
const DEPENDENCY_PATH = /(^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig[^/]*\.json)$/

/** Documentation records and agent notes, which no lane's inputs depend on. */
function isInertPath(path: string): boolean {
  return policy.inertPrefixes.some(prefix => path.startsWith(prefix))
    || path.endsWith('.md')
    || path.endsWith('.mdx')
    || path.endsWith('.i18n.yaml')
}

/** Runtime seams whose changes can alter generated contracts, durable history, model requests, authorization, or process confinement. */
function isFullRuntimePath(path: string): boolean {
  return policy.fullRuntimePrefixes.some(prefix => path.startsWith(prefix))
    || policy.fullRuntimePackagePrefixes.some(prefix => path.startsWith(prefix))
}

function isKnownScopedPackagePath(path: string): boolean {
  const match = /^packages\/([^/]+)\//.exec(path)
  const group = match?.[1]
  return group !== undefined && policy.scopedPackageGroups.includes(group)
}

/** Model-visible files are inputs even when they are stored as Markdown. */
function isModelInputPath(path: string): boolean {
  return policy.modelInputPrefixes.some(prefix => path.startsWith(prefix))
    || policy.modelInputSuffixes.some(suffix => path.endsWith(suffix))
}

function isGatewayPath(path: string): boolean {
  return policy.gatewayPrefixes.some(prefix => path.startsWith(prefix))
}

function isAdminUiPath(path: string): boolean {
  return path.startsWith(policy.adminUiPrefix)
}

/** Paths that reach browser-rendered output: the web app and client-surface packages. */
function isBrowserPath(path: string, clientPackages: ReadonlySet<string>): boolean {
  if (path.startsWith('apps/web/')) return true
  const pkg = scopedPackage(path)
  return pkg !== undefined && clientPackages.has(pkg)
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
 * @returns Which coverage, snapshot, compatibility, Python, and Windows lanes should run.
 */
export function classifyCiPrScope(
  paths: readonly string[],
  diff: string,
  clientPackages: ReadonlySet<string> = new Set(),
): CiPrScope {
  const changedSourceFiles = paths.filter(path => /^packages\/[^/]+\/[^/]+\/src\//.test(path))
  const changedPackageFiles = paths.filter(path => path.endsWith('/package.json') || path === 'package.json' || path === 'pnpm-lock.yaml')
  const inertOnly = paths.length > 0 && paths.every(isInertPath)
  const fullRuntime = paths.some(isFullRuntimePath)
  const modelInput = paths.some(isModelInputPath)
  const gatewayReachable = paths.some(isGatewayPath)
  const adminUiReachable = paths.some(isAdminUiPath)
  const common = {
    changedSourceFiles,
    changedPackageFiles,
    changedDocsOnly: inertOnly && !modelInput,
    gatewayMode: gatewayReachable ? 'full' as const : 'skip' as const,
    adminUiMode: adminUiReachable ? 'full' as const : 'skip' as const,
  }
  // The Node lanes run the whole runtime suite. Only documentation and the Python
  // SDK are provably outside their input domain; `scripts/**` is deliberately not
  // exempt, because it holds the gate runner every lane invokes and the fixture
  // generator the snapshot lane consumes.
  const nodeLanesUnreachable = !modelInput && paths.length > 0 && paths.every(path => isInertPath(path) || path.startsWith('python/'))
  // The Python lanes build and exercise `python/**` plus the packaged runtime, so
  // only a Python or dependency change can reach them.
  const pythonLanesReachable = paths.some(path => path.startsWith('python/') || DEPENDENCY_PATH.test(path))
  const browserReachable = paths.some(path => isBrowserPath(path, clientPackages))
  // A lockfile or manifest edit can move any dependency, including the ones the
  // browser bundle resolves, so it keeps the browser inventory too.
  const browserSnapshotNeeded = browserReachable || paths.some(path => DEPENDENCY_PATH.test(path))

  if (paths.length === 0) return {
    runExpensive: true,
    reason: 'full',
    changedSourceFiles,
    changedPackageFiles,
    changedDocsOnly: false,
    coverageMode: 'full',
    snapshotMode: 'full',
    compatMode: 'full',
    pythonMode: 'full',
    windowsMode: 'full',
    gatewayMode: 'full',
    adminUiMode: 'full',
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
    compatMode: 'skip',
    pythonMode: 'skip',
    windowsMode: 'skip',
  }
  if (inertOnly && !modelInput) return {
    ...common,
    runExpensive: false,
    reason: 'docs-only',
    coverageMode: 'skip',
    snapshotMode: 'skip',
    compatMode: 'skip',
    pythonMode: 'skip',
    windowsMode: 'skip',
  }

  const packages = [...new Set(paths.map(scopedPackage).filter((value): value is string => value !== undefined))]
  const scoped = !fullRuntime
    && !modelInput
    && paths.every(path => isScopedPath(path) && isKnownScopedPackagePath(path))
    && packages.length > 0
    && packages.length <= MAX_SCOPED_PACKAGES
  if (scoped) return {
    ...common,
    runExpensive: true,
    reason: 'scoped',
    coverageMode: 'scoped',
    // The scoped consumer aggregate drops the Playwright browser snapshot, which
    // is only sound while the change cannot alter browser-rendered output.
    snapshotMode: browserSnapshotNeeded ? 'full' : 'scoped',
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
    snapshotMode: nodeLanesUnreachable ? 'skip' : browserSnapshotNeeded ? 'full' : 'scoped',
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
    `compat_mode=${result.compatMode}`,
    `python_mode=${result.pythonMode}`,
    `windows_mode=${result.windowsMode}`,
    `gateway_mode=${result.gatewayMode}`,
    `admin_ui_mode=${result.adminUiMode}`,
    `scoped_packages=${JSON.stringify(scopedPackages)}`,
  ].join('\n')}\n`)
}

if (import.meta.main) main()
