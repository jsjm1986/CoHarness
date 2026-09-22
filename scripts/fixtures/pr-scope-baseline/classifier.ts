/**
 * Frozen migration oracle from the Git identity in inputs.json.
 * Source: https://github.com/jsjm1986/CoHarness/blob/master/scripts/ci-pr-scope.ts
 * Copyright (c) 2026 DeepSeek. MIT License; see the repository LICENSE.
 * Remove this comparison implementation after two reviewed shadow batches authorize candidate selection.
 */
import type { CiPrScope as CurrentCiPrScope } from '../../ci-pr-scope.ts'
import type { WebTestPolicy } from '../../web-test-policy.ts'
import inputs from './inputs.json' with { type: 'json' }

/** Immutable source identity for this migration comparison. */
export const FROZEN_CI_SCOPE_COMMIT = inputs.sourceCommit
/** Digest binding the frozen configuration, browser consumers, and golden owners to this implementation. */
export const FROZEN_CI_SCOPE_DATA_SHA256 = '12532e7ee6426f6ed875b5cc12935bd76eee3926e0fb6e96d208da2c8b289b6b'

/** Classification inputs captured from the frozen Git tree. */
export interface FrozenScopeInputs {
  readonly sourceCommit: string
  readonly scopePolicy: {
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
  readonly webPolicy: WebTestPolicy
  readonly consumerPolicy: {
    readonly lanes: Readonly<Record<'python' | 'gateway' | 'adminUi' | 'android', unknown>>
    readonly standalonePrefixes?: readonly string[]
    readonly relations: readonly {
      readonly id: string
      readonly paths: readonly string[]
      readonly lanes: readonly ('python' | 'gateway' | 'adminUi' | 'android')[]
    }[]
  }
  readonly clientPackages: readonly string[]
  readonly goldenOwners: Readonly<Record<string, readonly string[]>>
}

/**
 * Evaluate the frozen classifier and its original consumer union without consulting current policy.
 * @param paths - Complete current changed-path set.
 * @param diff - Zero-context patch used by the original action-pin classifier.
 * @param inputs - Digest-verified configuration and consumer facts from the frozen tree.
 * @returns The execution decision the frozen implementation makes for these inputs.
 */
export function classifyFrozenCiPrScope(
  paths: readonly string[],
  diff: string,
  inputs: FrozenScopeInputs,
): Omit<CurrentCiPrScope, 'webScenarios'> {
  const scopePolicy = inputs.scopePolicy
  const WEB_TESTS_ROOT = 'apps/web/tests/'
  const ALL_GROUPS = 'all'
  type ConsumerLane = 'python' | 'gateway' | 'adminUi' | 'android'
  /* jscpd:ignore-start -- immutable baseline code must remain independent of candidate fixes during shadow comparison. */


  /** Return rule IDs that justify each additional consumer.
   * @param paths - repository-relative changed inputs, including both rename sides.
   * @returns stable explanations, with empty arrays meaning no registered impact.
   */
  function consumerReasons(paths: readonly string[]): Record<ConsumerLane, string[]> {
    const policy = inputs.consumerPolicy
    const result: Record<ConsumerLane, string[]> = { python: [], gateway: [], adminUi: [], android: [] }
    const standalonePrefixes = (policy as { standalonePrefixes?: readonly string[] }).standalonePrefixes ?? []
    const standaloneOf = (path: string): string | undefined => standalonePrefixes.find(prefix => path.startsWith(prefix))
    // A path inside a standalone subtree only satisfies prefixes rooted inside
    // that same tree: a bare `gateway` prefix must not claim Admin-app pages.
    const claims = (path: string, prefix: string): boolean => {
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return false
      const standalone = standaloneOf(path)
      return standalone === undefined || `${prefix}/` === standalone || prefix.startsWith(standalone)
    }
    for (const relation of policy.relations) {
      if (!paths.some(path => relation.paths.some(prefix => claims(path, prefix)))) continue
      for (const lane of relation.lanes as ConsumerLane[]) result[lane].push(relation.id)
    }
    // Cordis overlays, workers and process launchers can change runtime composition
    // without an import edge. Native build inputs have their own Android rule.
    if (paths.some(path => !path.startsWith('apps/android-shell/')
      && (/(?:^|\/)cordis[^/]*\.ya?ml$/.test(path) || /\/(?:worker|subprocess)[^/]*\.[cm]?ts$/.test(path)))) {
      for (const lane of Object.keys(result) as ConsumerLane[]) result[lane].push('dynamic-composition')
    }
    return result
  }


  /**
   * Expand a package mapping to concrete group names.
   * @param value - Group name, group list, or `all`.
   * @param policy - Policy owning the group vocabulary.
   * @returns The concrete groups the package reaches.
   */
  function expandPackageGroups(
    value: string | readonly string[],
    policy: WebTestPolicy,
  ): readonly string[] {
    if (value === ALL_GROUPS) return policy.groups
    const names = typeof value === 'string' ? [value] : value
    return names
  }


  /** The expensive pull-request CI lanes that a scope decision controls. */
  interface CiPrScope {
    readonly runExpensive: boolean
    readonly reason: 'action-only' | 'docs-only' | 'scoped' | 'python-only' | 'consumer-only' | 'full'
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
  interface WebVerificationPlan {
    readonly mode: 'skip' | 'focused' | 'full'
    /** Selected business groups; non-empty only under `focused`. */
    readonly groups: readonly string[]
  }


  const MAX_SCOPED_PACKAGES = 4


  const FULL_WEB_VERIFICATION: WebVerificationPlan = { mode: 'full', groups: [] }

  const SKIP_WEB_VERIFICATION: WebVerificationPlan = { mode: 'skip', groups: [] }


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


  const policy: CiScopePolicy = scopePolicy

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
   * Golden payloads under any `tests/snapshots/` tree are test data, not docs:
   * their `.md` extension must not read as documentation, or a golden-only diff
   * would skip every lane.
   */
  function isInertPath(path: string): boolean {
    if (/(?:^|\/)tests?\/snapshots\//.test(path)) return false
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
  function classifyWebVerification(
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
  function classifyCiPrScope(
    paths: readonly string[],
    diff: string,
    clientPackages: ReadonlySet<string> = new Set(inputs.clientPackages),
    policy: WebTestPolicy = inputs.webPolicy,
    goldenOwners: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(inputs.goldenOwners)),
  ): CiPrScope {
    const changedSourceFiles = paths.filter(path => /^packages\/[^/]+\/[^/]+\/src\//.test(path))
    const changedPackageFiles = paths.filter(path => path.endsWith('/package.json') || path === 'package.json' || path === 'pnpm-lock.yaml')
    const inertOnly = paths.length > 0 && paths.every(isInertPath)
    const fullRuntime = paths.some(isFullRuntimePath)
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
    const nodeLanesUnreachable = !modelInput && paths.length > 0
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
    const actionOnly = paths.every(path => path.startsWith('.github/workflows/'))
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
      // The keyless consumer aggregate drops the browser snapshot in every
      // snapshot mode; focused and full tiers run it in the dedicated
      // web-verification lane instead.
      snapshotMode: snapshotModeFromWeb[webPlan.mode],
      webGroups: webPlan.groups,
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
      snapshotMode: nodeLanesUnreachable ? 'skip' : snapshotModeFromWeb[webPlan.mode],
      webGroups: nodeLanesUnreachable ? [] : webPlan.groups,
      // The Node compatibility smokes exercise the Node runtime against the
      // TypeScript build; a Python-only change has no Node input to break them.
      compatMode: nodeLanesUnreachable ? 'skip' : 'full',
      pythonMode: pythonLanesReachable ? 'full' : 'skip',
      windowsMode: nodeLanesUnreachable ? 'skip' : 'full',
    }
  }


  /** Preserve the pre-migration consumer decisions for shadow comparison.
   * @param paths - changed paths used for both selectors.
   * @param candidate - new selection; all unchanged upstream lanes are shared.
   * @returns previous consumer decisions without duplicating the upstream classifier.
   */
  function previousConsumerSelection(paths: readonly string[], candidate: CiPrScope): CiPrScope {
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
  function unionConsumerSelection(previous: CiPrScope, candidate: CiPrScope): CiPrScope {
    return {
      ...candidate,
      pythonMode: previous.pythonMode === 'full' ? 'full' : candidate.pythonMode,
      gatewayMode: previous.gatewayMode === 'full' ? 'full' : candidate.gatewayMode,
      adminUiMode: previous.adminUiMode === 'full' ? 'full' : candidate.adminUiMode,
    }
  }
  const candidate = classifyCiPrScope(paths, diff)
  return unionConsumerSelection(previousConsumerSelection(paths, candidate), candidate)
  /* jscpd:ignore-end */
}
