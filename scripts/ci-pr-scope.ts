import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { consumerReasons, verifyConsumerReferences } from './ci-consumer-relations.ts'
import { classifyCiPrProofs } from './ci-pr-proofs.ts'
import scopePolicy from './ci-scope-policy.json' with { type: 'json' }
import {
  classifyFrozenCiPrScope, FROZEN_CI_SCOPE_COMMIT, FROZEN_CI_SCOPE_DATA_SHA256, type FrozenScopeInputs,
} from './fixtures/pr-scope-baseline/classifier.ts'
import {
  exactScenarioFiles, expandPackageGroups, focusedScenarioFiles, loadWebTestPolicy, scanGoldenOwners,
  verifiedWebScenarioFiles, WEB_TESTS_ROOT, type WebTestPolicy,
} from './web-test-policy.ts'

/** The expensive pull-request CI lanes that a scope decision controls. */
export interface CiPrScope {
  readonly runExpensive: boolean
  readonly reason: 'action-only' | 'docs-only' | 'scoped' | 'python-only' | 'consumer-only' | 'full'
  readonly changedSourceFiles: readonly string[]
  readonly changedPackageFiles: readonly string[]
  readonly changedDocsOnly: boolean
  readonly coverageMode: 'skip' | 'scoped' | 'full'
  /**
   * Snapshot lane selection. `skip` runs nothing; `scoped` keeps the keyless
   * ACP/CLI snapshots with no browser work; `focused` adds the web browser
   * verification of {@link webGroups} or {@link webScenarios}; `full` adds the complete browser
   * inventory. The keyless consumer aggregate is identical under `scoped`,
   * `focused`, and `full` — only the dedicated web verification lane differs.
   */
  readonly snapshotMode: 'skip' | 'scoped' | 'focused' | 'full'
  /** Business groups for a focused component change; empty for exact scenario selection. */
  readonly webGroups: readonly string[]
  /** Exact scenario keys including all smoke scenarios; mutually exclusive with `webGroups`. */
  readonly webScenarios: readonly string[]
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
  /** Android is optional and runs only through the manual android-audit suite. */
  readonly androidMode: 'skip'
  /** Explicit consumer rules used to explain added lanes. */
  readonly consumerReasons: ReturnType<typeof consumerReasons>
}

/** The web browser verification tier for one changed path set. */
export interface WebVerificationPlan {
  readonly mode: 'skip' | 'focused' | 'full'
  /** Selected business groups; empty when a focused run names exact scenarios. */
  readonly groups: readonly string[]
  /** Exact scenario keys plus smoke scenarios; empty for group selection, skip, and full. */
  readonly scenarios: readonly string[]
}

const MAX_SCOPED_PACKAGES = 4

const FULL_WEB_VERIFICATION: WebVerificationPlan = { mode: 'full', groups: [], scenarios: [] }
const SKIP_WEB_VERIFICATION: WebVerificationPlan = { mode: 'skip', groups: [], scenarios: [] }

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

/**
 * Documentation records and agent notes, which no lane's inputs depend on.
 * Golden payloads under any snapshot tree or named `*.expected.md` are test data:
 * their `.md` extension must not read as documentation, or a golden-only diff
 * would skip every lane.
 */
function isInertPath(path: string): boolean {
  if (/(?:^|\/)snapshots\//.test(path) || /\.expected\.(?:md|jsonl?|txt|html)$/.test(path)) return false
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

/** Ordinary explanatory documents do not widen a related runtime change. */
function isInertProsePath(path: string): boolean {
  return isInertPath(path) && !isModelInputPath(path) && /\.(?:md|mdx|i18n\.yaml)$/.test(path)
}

/** Keep configuration and generated inputs while removing accompanying inert prose. */
function runtimeInputPaths(paths: readonly string[]): readonly string[] {
  return paths.filter(path => !isInertProsePath(path))
}

function isGatewayPath(path: string): boolean {
  // The Admin app lives under gateway/ but is an independent npm project with
  // its own lane; a page-only edit there does not reach the Gateway runtime.
  return !path.startsWith(policy.adminUiPrefix)
    && policy.gatewayPrefixes.some(prefix => path.startsWith(prefix))
}

function isAdminUiPath(path: string): boolean {
  return path.startsWith(policy.adminUiPrefix)
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
 * Route one path under {@link WEB_TESTS_ROOT}: a scenario key to itself, a
 * golden file to every scenario that references its directory,
 * inert documentation to nothing, and every other file to the full inventory.
 * @param path - Repository-relative path inside the web test tree.
 * @param policy - The checked-in web test policy.
 * @param goldenOwners - Golden directory to referencing scenario keys, from {@link scanGoldenOwners}.
 * @returns The owning scenario keys, or the `full`/`inert` disposition.
 */
function routeWebTestPath(
  path: string,
  policy: WebTestPolicy,
  goldenOwners: ReadonlyMap<string, readonly string[]>,
): readonly string[] | 'full' | 'inert' {
  const relative = path.slice(WEB_TESTS_ROOT.length)
  const scenarioGroup = policy.scenarios[relative]
  if (scenarioGroup !== undefined) return [relative]
  const golden = /^snapshots\/([^/]+)\//.exec(relative)
  if (golden !== null) {
    const directory = golden[1]
    const owners = directory === undefined ? undefined : goldenOwners.get(directory)
    if (owners === undefined || owners.length === 0) return 'full'
    for (const owner of owners) {
      const group = policy.scenarios[owner]
      if (group === undefined) return 'full'
    }
    return owners
  }
  return isInertProsePath(path) ? 'inert' : 'full'
}

/**
 * Classify the changed paths for the dedicated web browser verification lane.
 *
 * Full triggers are proved reachability: a policy full prefix (the web app
 * source, public, and stress trees; client runtime, connection, Loader, api,
 * extensions, Typert, the apiproxy fetch carrier), a dependency or
 * build-config edit, a web-lane infrastructure file, a test file no scenario
 * table entry owns, or a golden directory no scenario references. A scenario
 * file and a committed golden select their exact owners plus smoke scenarios
 * when every non-documentation path is a scenario or golden. Browser-rendered packages
 * resolve through the policy's package mapping; an unmapped browser-rendered
 * package falls back to the full inventory. Paths outside every known
 * category also fall back to full.
 *
 * @param paths - Repository-relative paths changed by the pull request.
 * @param clientPackages - Keys of browser-rendered packages, from {@link clientSurfacePackages}.
 * @param policy - The checked-in web test policy.
 * @param goldenOwners - Golden directory to referencing scenario keys, from {@link scanGoldenOwners}.
 * @returns The verification tier and, under `focused`, either groups or exact scenario keys.
 */
export function classifyWebVerification(
  paths: readonly string[],
  clientPackages: ReadonlySet<string>,
  policy: WebTestPolicy,
  goldenOwners: ReadonlyMap<string, readonly string[]>,
): WebVerificationPlan {
  if (paths.length === 0) return FULL_WEB_VERIFICATION
  const groups = new Set<string>()
  const scenarios = new Set<string>()
  let exactOnly = true
  for (const path of paths) {
    const owners = Object.hasOwn(policy.sharedInputs, path) ? policy.sharedInputs[path] : undefined
    if (owners === undefined && isInertProsePath(path)) continue
    if (policy.fullPrefixes.some(prefix => path.startsWith(prefix))) return FULL_WEB_VERIFICATION
    if (DEPENDENCY_PATH.test(path)) return FULL_WEB_VERIFICATION
    if (policy.webInfraPrefixes.some(prefix => path.startsWith(prefix))
      && !(isAdminUiPath(path) && owners !== undefined)) return FULL_WEB_VERIFICATION
    if (owners !== undefined) {
      for (const owner of owners) {
        const group = policy.scenarios[owner]
        if (group === undefined) throw new Error(`web-test-policy: shared input ${JSON.stringify(path)} references unknown scenario ${JSON.stringify(owner)}.`)
        groups.add(group)
        scenarios.add(owner)
      }
      continue
    }
    if (path.startsWith(WEB_TESTS_ROOT)) {
      const route = routeWebTestPath(path, policy, goldenOwners)
      if (route === 'inert') continue
      if (route === 'full') return FULL_WEB_VERIFICATION
      for (const scenario of route) {
        const group = policy.scenarios[scenario]
        if (group === undefined) return FULL_WEB_VERIFICATION
        groups.add(group)
        scenarios.add(scenario)
      }
      continue
    }
    if (isInertProsePath(path)) continue
    exactOnly = false
    const pkg = scopedPackage(path)
    if (pkg !== undefined) {
      const mapping = policy.packages[pkg]
      if (!clientPackages.has(pkg) && mapping === undefined) continue
      if (mapping === undefined) return FULL_WEB_VERIFICATION
      for (const group of expandPackageGroups(mapping, policy)) groups.add(group)
      continue
    }
    if (isWebIrrelevantPath(path)) continue
    return FULL_WEB_VERIFICATION
  }
  if (groups.size === 0) return SKIP_WEB_VERIFICATION
  return exactOnly
    ? { mode: 'focused', groups: [], scenarios: exactScenarioFiles(policy, [...scenarios]) }
    : { mode: 'focused', groups: [...groups].sort(), scenarios: [] }
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
  const sharedWebInput = paths.some(path => Object.hasOwn(policy.sharedInputs, path))
  const inertOnly = !sharedWebInput && paths.length > 0 && paths.every(isInertPath)
  const runtimePaths = runtimeInputPaths(paths)
  const fullRuntime = runtimePaths.some(isFullRuntimePath)
  const modelInput = paths.some(isModelInputPath)
  const reasons = consumerReasons(paths.filter(path => !isInertPath(path) || isModelInputPath(path)))
  const gatewayReachable = reasons.gateway.length > 0 || paths.some(path => !isInertPath(path) && isGatewayPath(path))
  const adminUiReachable = reasons.adminUi.length > 0 || paths.some(path => !isInertPath(path) && isAdminUiPath(path))
  const common = {
    androidMode: 'skip' as const,
    consumerReasons: reasons,
    changedSourceFiles,
    changedPackageFiles,
    changedDocsOnly: inertOnly && !modelInput,
    gatewayMode: gatewayReachable ? 'full' as const : 'skip' as const,
    adminUiMode: adminUiReachable ? 'full' as const : 'skip' as const,
  }
  const webPlan = classifyWebVerification(paths, clientPackages, policy, goldenOwners)
  // The Node lanes run the whole runtime suite. Only documentation and the Python
  // SDK are provably outside their input domain; `scripts/**` is deliberately not
  // exempt, because it holds the gate runner every lane invokes and the fixture
  // generator the snapshot lane consumes.
  const adminBrowserInput = paths.some(path => isAdminUiPath(path) && Object.hasOwn(policy.sharedInputs, path))
  const onlyAdminSharedInputs = paths.every(path => !Object.hasOwn(policy.sharedInputs, path) || isAdminUiPath(path))
  const nodeLanesUnreachable = !modelInput && (!sharedWebInput || onlyAdminSharedInputs) && paths.length > 0
    && paths.every(path => isInertPath(path) || path.startsWith('python/') || path.startsWith(scopePolicy.adminUiPrefix))
  // The runtime wheel executes the TypeScript loop and Session protocol too.
  const pythonLanesReachable = reasons.python.length > 0 || paths.some(path => path.startsWith('python/') || DEPENDENCY_PATH.test(path))
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
    webScenarios: [],
    compatMode: 'full',
    pythonMode: 'full',
    windowsMode: 'full',
    gatewayMode: 'full',
    adminUiMode: 'full',
    androidMode: 'skip',
    consumerReasons: { python: ['unknown-or-empty-diff'], gateway: ['unknown-or-empty-diff'], adminUi: ['unknown-or-empty-diff'], android: ['unknown-or-empty-diff'] },
  }

  const changedLines = diff
    .split('\n')
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
  // A pin bump changes complete `uses:` lines and nothing else: a `run:` line
  // that merely contains the ref text is a real command edit, not a pin bump.
  const SETUP_USES = /^\s*-\s*uses:\s*pnpm\/action-setup@v[\d.]+\s*$/
  const normalizeRef = (line: string): string => line.replace(/pnpm\/action-setup@v[\d.]+/, 'pnpm/action-setup@')
  const added = changedLines.filter(line => line.startsWith('+')).map(line => line.slice(1))
  const removed = changedLines.filter(line => line.startsWith('-')).map(line => line.slice(1))
  const normalizedAdded = added.map(normalizeRef).sort()
  const normalizedRemoved = removed.map(normalizeRef).sort()
  const actionOnly = !sharedWebInput && paths.every(path => path.startsWith('.github/workflows/'))
    && added.length > 0
    && added.length === removed.length
    && [...added, ...removed].every(line => SETUP_USES.test(line))
    && normalizedAdded.every((line, index) => line === normalizedRemoved[index])
  if (actionOnly) return {
    ...common,
    runExpensive: false,
    reason: 'action-only',
    gatewayMode: 'skip',
    adminUiMode: 'skip',
    androidMode: 'skip',
    consumerReasons: { python: [], gateway: [], adminUi: [], android: [] },
    coverageMode: 'skip',
    snapshotMode: 'skip',
    webGroups: [],
    webScenarios: [],
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
    webGroups: [],
    webScenarios: [],
    compatMode: 'skip',
    pythonMode: 'skip',
    windowsMode: 'skip',
  }

  const packages = [...new Set(runtimePaths.map(scopedPackage).filter((value): value is string => value !== undefined))]
  const scoped = !fullRuntime
    && !modelInput
    && runtimePaths.every(path => isScopedPath(path) && isKnownScopedPackagePath(path))
    && packages.length > 0
    && packages.length <= MAX_SCOPED_PACKAGES
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
    webScenarios: webPlan.scenarios,
    compatMode: 'full',
    pythonMode: pythonLanesReachable ? 'full' : 'skip',
    windowsMode: 'full',
  }

  const unreachableReason = paths.every(path => isInertPath(path) || path.startsWith('python/')) ? 'python-only' : 'consumer-only'
  return {
    ...common,
    runExpensive: !nodeLanesUnreachable,
    reason: nodeLanesUnreachable ? unreachableReason : 'full',
    coverageMode: nodeLanesUnreachable ? 'skip' : 'full',
    // A change with no browser-rendered input keeps the keyless ACP/CLI snapshots
    // but not the Playwright inventory, which would have nothing new to render.
    snapshotMode: nodeLanesUnreachable && !adminBrowserInput ? 'skip' : snapshotModeFromWeb[webPlan.mode],
    webGroups: nodeLanesUnreachable && !adminBrowserInput ? [] : webPlan.groups,
    webScenarios: nodeLanesUnreachable && !adminBrowserInput ? [] : webPlan.scenarios,
    // The Node compatibility smokes exercise the Node runtime against the
    // TypeScript build; a Python-only change has no Node input to break them.
    compatMode: nodeLanesUnreachable ? 'skip' : 'full',
    pythonMode: pythonLanesReachable ? 'full' : 'skip',
    windowsMode: nodeLanesUnreachable ? 'skip' : 'full',
  }
}

/** One stable selection change, classified as added or removed validation. */
export interface CiScopeChange {
  readonly lane: string
  readonly from: string | readonly string[]
  readonly to: string | readonly string[]
  readonly reason: string
}

/** Candidate decisions beside the immutable migration baseline and the actual execution plan. */
export interface CiPrScopePlans {
  readonly baselineCommit: string
  readonly baselineStatus: 'available' | 'unavailable'
  readonly baselineError?: string
  readonly policy: 'shadow' | 'candidate'
  readonly executionSource: 'shadow-union' | 'candidate-experiment'
  readonly previous: CiPrScope
  readonly candidate: CiPrScope
  readonly execution: CiPrScope
  readonly changes: { readonly added: readonly CiScopeChange[]; readonly removed: readonly CiScopeChange[] }
}

function frozenScopeInputs(root: string): FrozenScopeInputs {
  execFileSync('git', ['cat-file', '-e', `${FROZEN_CI_SCOPE_COMMIT}^{commit}`], {
    cwd: root, stdio: 'pipe', timeout: 10_000,
  })
  const bytes = readFileSync(resolve(root, 'scripts/fixtures/pr-scope-baseline/inputs.json'))
  if (createHash('sha256').update(bytes).digest('hex') !== FROZEN_CI_SCOPE_DATA_SHA256) {
    throw new Error('ci-pr-scope: frozen baseline inputs do not match their committed digest')
  }
  // The digest pins the complete reviewed JSON, including its field types.
  return JSON.parse(bytes.toString('utf8')) as FrozenScopeInputs
}

function browserScenarios(scope: CiPrScope, policy: WebTestPolicy): readonly string[] {
  if (scope.snapshotMode === 'full') return Object.keys(policy.scenarios).sort()
  if (scope.snapshotMode !== 'focused') return []
  return scope.webScenarios.length > 0
    ? exactScenarioFiles(policy, scope.webScenarios)
    : focusedScenarioFiles(policy, scope.webGroups)
}

function scopeChanges(
  previous: CiPrScope, previousRuntime: CiPrScope, candidate: CiPrScope,
  policy: WebTestPolicy, previousPolicy: WebTestPolicy, paths: readonly string[],
): CiPrScopePlans['changes'] {
  const added: CiScopeChange[] = []
  const removed: CiScopeChange[] = []
  const coverageRank = { skip: 0, scoped: 1, full: 2 }
  if (previous.coverageMode !== candidate.coverageMode) {
    const changes = coverageRank[candidate.coverageMode] > coverageRank[previous.coverageMode] ? added : removed
    const accompanyingProse = previous.coverageMode === 'full' && candidate.coverageMode === 'scoped'
      && candidate.reason === 'scoped' && paths.some(isInertProsePath)
      && runtimeInputPaths(paths).every(path => isScopedPath(path) && isKnownScopedPackagePath(path))
    changes.push({ lane: 'coverage', from: previous.coverageMode, to: candidate.coverageMode,
      reason: changes === added ? 'runtime-input-policy' : accompanyingProse ? 'accompanying-inert-prose' : 'unexplained' })
  }
  const before = new Set(browserScenarios(previous, previousPolicy))
  const after = new Set(browserScenarios(candidate, policy))
  const addedScenarios = [...after].filter(file => !before.has(file)).sort()
  const removedScenarios = [...before].filter(file => !after.has(file)).sort()
  const proseOnlyBrowserExpansion = paths.some(isInertProsePath)
    && JSON.stringify(browserScenarios(previousRuntime, policy)) === JSON.stringify([...after].sort())
  if (addedScenarios.length > 0) added.push({ lane: 'web', from: [], to: addedScenarios, reason: 'browser-input-policy' })
  if (removedScenarios.length > 0) removed.push({ lane: 'web', from: removedScenarios, to: [],
    reason: candidate.webScenarios.length > 0 ? 'exact-scenario-owners-and-smokes'
      : proseOnlyBrowserExpansion ? 'accompanying-inert-prose' : 'unexplained' })
  for (const lane of ['compatMode', 'windowsMode', 'pythonMode', 'gatewayMode', 'adminUiMode'] as const) {
    if (previous[lane] === candidate[lane]) continue
    const changes = candidate[lane] === 'full' ? added : removed
    const claimed = paths.filter(path => lane === 'gatewayMode' ? isGatewayPath(path) : lane === 'adminUiMode' && isAdminUiPath(path))
    const inertConsumer = claimed.length > 0 && claimed.every(isInertProsePath)
    changes.push({ lane, from: previous[lane], to: candidate[lane],
      reason: changes === added ? 'consumer-input-policy' : inertConsumer ? 'inert-consumer-documentation' : 'unexplained' })
  }
  if (previous.runExpensive !== candidate.runExpensive) {
    const changes = candidate.runExpensive ? added : removed
    changes.push({ lane: 'runtime-consumers', from: String(previous.runExpensive), to: String(candidate.runExpensive),
      reason: changes === added ? 'runtime-input-policy' : 'unexplained' })
  }
  return { added, removed }
}

function executionUnion(previous: CiPrScope, candidate: CiPrScope, policy: WebTestPolicy, previousPolicy: WebTestPolicy): CiPrScope {
  const coverageMode = previous.coverageMode === 'full' || candidate.coverageMode === 'full' ? 'full'
    : previous.coverageMode === 'scoped' || candidate.coverageMode === 'scoped' ? 'scoped' : 'skip'
  const fullBrowser = previous.snapshotMode === 'full' || candidate.snapshotMode === 'full'
  const previousScenarios = browserScenarios(previous, previousPolicy)
  // A retained group also owns scenarios added since the frozen baseline.
  // Shadow execution keeps both inventories until the reviewed switch.
  const scenarios = [...new Set([
    ...previousScenarios, ...browserScenarios(previous, policy), ...browserScenarios(candidate, policy),
  ])].sort()
  const changedGroups = JSON.stringify(previousScenarios) !== JSON.stringify(browserScenarios(previous, policy))
  const exact = !fullBrowser && scenarios.length > 0
    && (changedGroups || previous.webScenarios.length > 0 || candidate.webScenarios.length > 0)
  const snapshotMode = fullBrowser ? 'full' : scenarios.length > 0 ? 'focused'
    : previous.snapshotMode === 'scoped' || candidate.snapshotMode === 'scoped' ? 'scoped' : 'skip'
  const unionMode = (before: 'skip' | 'full', after: 'skip' | 'full'): 'skip' | 'full' =>
    before === 'full' || after === 'full' ? 'full' : 'skip'
  return {
    ...candidate,
    reason: coverageMode === 'full' && candidate.coverageMode !== 'full' ? 'full' : candidate.reason,
    runExpensive: previous.runExpensive || candidate.runExpensive,
    coverageMode,
    snapshotMode,
    webScenarios: exact ? scenarios : [],
    webGroups: snapshotMode === 'focused' && !exact ? [...new Set([...previous.webGroups, ...candidate.webGroups])].sort() : [],
    compatMode: unionMode(previous.compatMode, candidate.compatMode),
    windowsMode: unionMode(previous.windowsMode, candidate.windowsMode),
    pythonMode: unionMode(previous.pythonMode, candidate.pythonMode),
    gatewayMode: unionMode(previous.gatewayMode, candidate.gatewayMode),
    adminUiMode: unionMode(previous.adminUiMode, candidate.adminUiMode),
  }
}

/**
 * Compare complete selections while keeping the frozen/current union authoritative by default.
 * @param paths - Complete changed paths, including both sides of renames.
 * @param diff - Zero-context patch used for the action-pin decision.
 * @param root - Candidate source checkout and Git history.
 * @param environment - `DSH_CI_SCOPE_POLICY` may be exactly `shadow` or `candidate`; omission keeps shadow mode.
 * @returns Stable baseline, candidate, execution, and explained additions/reductions; absent history retains full validation.
 * @throws If the current policy or a referenced current entry is invalid, or the execution policy is unknown.
 */
export function resolveCiPrScopePlans(
  paths: readonly string[],
  diff: string,
  root = resolve(import.meta.dirname, '..'),
  environment: NodeJS.ProcessEnv = process.env,
): CiPrScopePlans {
  const policy = environment.DSH_CI_SCOPE_POLICY ?? 'shadow'
  if (policy !== 'shadow' && policy !== 'candidate') {
    throw new Error('ci-pr-scope: DSH_CI_SCOPE_POLICY must be exactly shadow or candidate')
  }
  verifyConsumerReferences(root)
  const webPolicy = loadWebTestPolicy(root)
  verifiedWebScenarioFiles(root, webPolicy)
  const clients = clientSurfacePackages(root)
  const owners = scanGoldenOwners(root)
  const candidate = classifyCiPrScope(paths, diff, clients, webPolicy, owners)
  let previous: CiPrScope
  let previousRuntime: CiPrScope
  let previousPolicy = webPolicy
  let baselineError: string | undefined
  try {
    const inputs = frozenScopeInputs(root)
    previous = { ...classifyFrozenCiPrScope(paths, diff, inputs), webScenarios: [] }
    previousRuntime = { ...classifyFrozenCiPrScope(runtimeInputPaths(paths), diff, inputs), webScenarios: [] }
    previousPolicy = inputs.webPolicy
    if (previous.snapshotMode === 'focused') {
      // Removed historical entries cannot silently narrow the migration comparison.
      for (const scenario of browserScenarios(previous, previousPolicy)) {
        if (!Object.hasOwn(webPolicy.scenarios, scenario)) throw new Error(`ci-pr-scope: frozen scenario is absent: ${scenario}`)
      }
      browserScenarios(previous, webPolicy)
    }
  } catch (error) {
    baselineError = error instanceof Error ? error.message : String(error)
    previousPolicy = webPolicy
    previous = { ...classifyCiPrScope([], '', clients, webPolicy, owners),
      changedSourceFiles: candidate.changedSourceFiles, changedPackageFiles: candidate.changedPackageFiles }
    previousRuntime = previous
  }
  return {
    baselineCommit: FROZEN_CI_SCOPE_COMMIT,
    baselineStatus: baselineError === undefined ? 'available' : 'unavailable',
    ...baselineError === undefined ? {} : { baselineError },
    policy,
    executionSource: policy === 'shadow' ? 'shadow-union' : 'candidate-experiment',
    previous,
    candidate,
    execution: policy === 'shadow' ? executionUnion(previous, candidate, webPolicy, previousPolicy) : candidate,
    changes: scopeChanges(previous, previousRuntime, candidate, webPolicy, previousPolicy, paths),
  }
}

function main(): void {
  const base = process.argv[2]
  if (base === undefined || base === '') throw new Error('ci-pr-scope: expected a base commit')
  const range = `${base}...HEAD`
  const paths = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', range], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
  const diff = execFileSync('git', ['diff', '--unified=0', range], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
  const plans = resolveCiPrScopePlans(paths, diff, process.cwd())
  const result = plans.execution
  const proofs = classifyCiPrProofs(paths, plans.candidate, process.cwd(), {
    untrustedActor: process.env.DSH_CI_UNTRUSTED_ACTOR === 'true',
  })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const baseline = execFileSync('git', ['rev-parse', `${base}^{commit}`], { encoding: 'utf8' }).trim()
  mkdirSync('.artifacts/gates', { recursive: true })
  writeFileSync(`.artifacts/gates/selection-${commit}.json`, JSON.stringify({
    version: 1, kind: 'selection', phase: plans.policy, commit, baseline, paths, runtimePaths: runtimeInputPaths(paths),
    ...plans, executed: result, proofs,
    optionalConsumers: { android: { policy: 'manual-only', suite: 'android-audit', affectedRules: plans.candidate.consumerReasons.android } },
  }, null, 2) + '\n')
  console.error(`ci-pr-scope: decision=${plans.executionSource}, baseline=${plans.baselineStatus}`)
  if (result.snapshotMode === 'focused') {
    console.error(result.webScenarios.length > 0
      ? `ci-pr-scope: focused web verification for scenarios ${JSON.stringify(result.webScenarios)}`
      : `ci-pr-scope: focused web verification for groups ${JSON.stringify(result.webGroups)}`)
  } else if (result.snapshotMode === 'full') {
    console.error('ci-pr-scope: keeping the full web browser inventory')
  }
  const scopedPackages = result.coverageMode === 'scoped'
    ? [...new Set(runtimeInputPaths(paths).map(scopedPackage).filter((value): value is string => value !== undefined))]
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
    `web_scenarios=${JSON.stringify(result.webScenarios)}`,
    `compat_mode=${result.compatMode}`,
    `python_mode=${result.pythonMode}`,
    `windows_mode=${result.windowsMode}`,
    `gateway_mode=${result.gatewayMode}`,
    `admin_ui_mode=${result.adminUiMode}`,
    `android_mode=${result.androidMode}`,
    `scoped_packages=${JSON.stringify(scopedPackages)}`,
    `proof_release_pack=${String(proofs.releasePack)}`,
    `proof_vendor_pack=${String(proofs.vendorPack)}`,
    `proof_native_pack=${String(proofs.nativePack)}`,
    `proof_sandbox=${String(proofs.sandbox)}`,
    `proof_provider=${String(proofs.provider)}`,
    `proof_pi_ai=${String(proofs.piAi)}`,
    `proof_native_windows=${String(proofs.nativeWindows)}`,
    `proofs=${JSON.stringify(proofs)}`,
    `validation_plan=${JSON.stringify({ version: 1, commit, scope: result, proofs })}`,
  ].join('\n')}\n`)
}

/** Preserve the pre-migration consumer decisions for shadow comparison.
 * @param paths - changed paths used for both selectors.
 * @param candidate - new selection; all unchanged upstream lanes are shared.
 * @returns previous consumer decisions without duplicating the upstream classifier.
 */
export function previousConsumerSelection(paths: readonly string[], candidate: CiPrScope): CiPrScope {
  const inert = candidate.reason === 'docs-only' || candidate.reason === 'action-only'
  return {
    ...candidate,
    pythonMode: paths.length === 0 || (!inert && paths.some(path => path.startsWith('python/') || DEPENDENCY_PATH.test(path))) ? 'full' : 'skip',
    gatewayMode: paths.length === 0 || paths.some(isGatewayPath) ? 'full' : 'skip',
    adminUiMode: paths.length === 0 || paths.some(isAdminUiPath) ? 'full' : 'skip',
    androidMode: 'skip',
    consumerReasons: { python: [], gateway: [], adminUi: [], android: [] },
  }
}

/** Execute the union until a reviewed commit retires the previous consumer decisions.
 * @param previous - baseline selector result.
 * @param candidate - proposed selector result.
 * @returns one deduplicated decision per consumer lane.
 */
export function unionConsumerSelection(previous: CiPrScope, candidate: CiPrScope): CiPrScope {
  return {
    ...candidate,
    pythonMode: previous.pythonMode === 'full' ? 'full' : candidate.pythonMode,
    gatewayMode: previous.gatewayMode === 'full' ? 'full' : candidate.gatewayMode,
    adminUiMode: previous.adminUiMode === 'full' ? 'full' : candidate.adminUiMode,
  }
}

if (import.meta.main) main()
