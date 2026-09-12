/**
 * Versioned policy for the tiered web browser verification lane.
 *
 * The JSON file classifies browser-rendered work into business groups; the
 * CI scope classifier maps changed paths to a verification mode through it.
 * Every browser scenario belongs to exactly one group, package directories
 * map to one or more groups, and any path the policy cannot classify falls
 * back to the full browser inventory so a policy gap can never silently skip
 * verification.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Reserved package mapping that expands to every business group. */
const ALL_GROUPS = 'all'

/** Repository-relative prefix of the web browser test tree; `scenarios` keys are paths below it. */
export const WEB_TESTS_ROOT = 'apps/web/tests/'

/** A `snapshots/<directory>` segment in scenario source, capturing the golden directory name. */
const GOLDEN_DIRECTORY_REFERENCE = /(?:^|[^A-Za-z0-9_-])snapshots\/([A-Za-z0-9_.-]+)/g

/** The checked-in policy document. */
export interface WebTestPolicy {
  readonly version: number
  readonly groups: readonly string[]
  /** Browser scenario path relative to {@link WEB_TESTS_ROOT} to its single business group. */
  readonly scenarios: Readonly<Record<string, string>>
  /**
   * Browser-rendered package key (`<group>/<name>`) to one group, several
   * groups, or `all`. An unmapped browser-rendered package falls back to the
   * full inventory in the classifier.
   */
  readonly packages: Readonly<Record<string, string | readonly string[]>>
  /** Path prefixes whose changes require the full browser inventory. */
  readonly fullPrefixes: readonly string[]
  /** Path prefixes feeding the web verification lane itself (runner, policy, configs, gateway runtime). */
  readonly webInfraPrefixes: readonly string[]
  /** Scenarios included in every focused run: stable boot, composition, and session-load smoke. */
  readonly smokeScenarios: readonly string[]
  readonly unknown: 'full'
}

/**
 * Load and validate the checked-in policy document.
 * @param root - Repository root holding `scripts/web-test-policy.json`.
 * @returns The validated policy; throws when the document is absent, malformed,
 *   or references a group outside `groups`.
 */
export function loadWebTestPolicy(root: string): WebTestPolicy {
  const path = resolve(root, 'scripts/web-test-policy.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`web-test-policy: cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateWebTestPolicy(raw, path)
}

/**
 * Validate a parsed policy document.
 * @param raw - Parsed JSON value.
 * @param source - Path used in error messages.
 * @returns The validated policy.
 */
export function validateWebTestPolicy(raw: unknown, source: string): WebTestPolicy {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`web-test-policy: ${source} must hold a JSON object.`)
  }
  const policy = raw as Record<string, unknown>
  if (policy.version !== 1) {
    throw new Error(`web-test-policy: ${source} version must be 1, got ${JSON.stringify(policy.version)}.`)
  }
  if (policy.unknown !== 'full') {
    throw new Error(`web-test-policy: ${source} unknown must be "full", got ${JSON.stringify(policy.unknown)}.`)
  }
  const groups = requireStringArray(policy.groups, 'groups', source)
  if (groups.length === 0) {
    throw new Error(`web-test-policy: ${source} groups must not be empty.`)
  }
  const known = new Set(groups)
  if (known.size !== groups.length) {
    throw new Error(`web-test-policy: ${source} groups contain duplicates.`)
  }
  const scenarios = requireRecord(policy.scenarios, 'scenarios', source)
  for (const [scenario, group] of Object.entries(scenarios)) {
    if (!known.has(group)) {
      throw new Error(`web-test-policy: ${source} scenario ${JSON.stringify(scenario)} names unknown group ${JSON.stringify(group)}.`)
    }
  }
  const smoke = requireStringArray(policy.smokeScenarios, 'smokeScenarios', source)
  for (const scenario of smoke) {
    if (!(scenario in scenarios)) {
      throw new Error(`web-test-policy: ${source} smoke scenario ${JSON.stringify(scenario)} is not in scenarios.`)
    }
  }
  const packages = requireRecord(policy.packages, 'packages', source)
  for (const [pkg, value] of Object.entries(packages)) {
    const names = typeof value === 'string' ? [value] : requireStringArray(value, `packages.${pkg}`, source)
    if (names.length === 0) {
      throw new Error(`web-test-policy: ${source} package ${JSON.stringify(pkg)} maps to an empty group list.`)
    }
    if (typeof value !== 'string' && names.includes(ALL_GROUPS)) {
      throw new Error(`web-test-policy: ${source} package ${JSON.stringify(pkg)} lists "all" inside a group list; write the bare string "all".`)
    }
    for (const name of names) {
      if (name !== ALL_GROUPS && !known.has(name)) {
        throw new Error(`web-test-policy: ${source} package ${JSON.stringify(pkg)} names unknown group ${JSON.stringify(name)}.`)
      }
    }
  }
  return {
    version: 1,
    groups,
    scenarios,
    packages,
    fullPrefixes: requireStringArray(policy.fullPrefixes, 'fullPrefixes', source),
    webInfraPrefixes: requireStringArray(policy.webInfraPrefixes, 'webInfraPrefixes', source),
    smokeScenarios: smoke,
    unknown: 'full',
  }
}

/**
 * Expand a package mapping to concrete group names.
 * @param value - Group name, group list, or `all`.
 * @param policy - Policy owning the group vocabulary.
 * @returns The concrete groups the package reaches.
 */
export function expandPackageGroups(
  value: string | readonly string[],
  policy: WebTestPolicy,
): readonly string[] {
  if (value === ALL_GROUPS) return policy.groups
  const names = typeof value === 'string' ? [value] : value
  return names
}

/**
 * Resolve the scenario files one focused run must execute.
 * @param policy - Policy owning the scenario membership.
 * @param groups - Selected business groups; must all be known.
 * @returns Scenario paths relative to `WEB_TESTS_ROOT`: the selected groups'
 *   scenarios plus the smoke set, sorted for deterministic ordering.
 */
export function focusedScenarioFiles(
  policy: WebTestPolicy,
  groups: readonly string[],
): readonly string[] {
  const unknown = groups.filter(group => !policy.groups.includes(group))
  if (unknown.length > 0) {
    throw new Error(`web-test-policy: unknown group(s) ${JSON.stringify(unknown)}; known groups: ${JSON.stringify(policy.groups)}.`)
  }
  const selected = new Set(groups)
  return Object.entries(policy.scenarios)
    .filter(([file, group]) => selected.has(group) || policy.smokeScenarios.includes(file))
    .map(([file]) => file)
    .sort()
}

/**
 * Discover every browser scenario file under {@link WEB_TESTS_ROOT}.
 * @param root - Repository root holding `apps/web/tests/`.
 * @returns Scenario paths relative to `WEB_TESTS_ROOT`, matching the
 *   `vitest.web.config.ts` include globs, sorted for deterministic ordering.
 */
export function listWebScenarioFiles(root: string): readonly string[] {
  return readdirSync(resolve(root, WEB_TESTS_ROOT), { encoding: 'utf8', recursive: true })
    .map(entry => entry.replaceAll('\\', '/'))
    .filter(entry => (entry.endsWith('.e2e.ts') || entry.endsWith('.snapshot.ts'))
      && !entry.split('/').includes('snapshots'))
    .sort()
}

/**
 * Attribute every golden directory under `apps/web/tests/snapshots/` to the
 * scenario files whose sources reference it.
 * @param root - Repository root holding `apps/web/tests/`.
 * @returns Golden directory name to the sorted, de-duplicated scenario keys
 *   that reference it. A reference is any `snapshots/<name>` path segment in
 *   the scenario source, so the scan may over-attribute but cannot miss a
 *   directory a scenario reads.
 */
export function scanGoldenOwners(root: string): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, Set<string>>()
  for (const file of listWebScenarioFiles(root)) {
    const source = readFileSync(resolve(root, WEB_TESTS_ROOT, file), 'utf8')
    for (const match of source.matchAll(GOLDEN_DIRECTORY_REFERENCE)) {
      const directory = match[1]
      if (directory === undefined) continue
      let list = owners.get(directory)
      if (list === undefined) {
        list = new Set<string>()
        owners.set(directory, list)
      }
      list.add(file)
    }
  }
  return new Map([...owners.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, files]) => [directory, [...files].sort()]))
}

function requireStringArray(value: unknown, field: string, source: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`web-test-policy: ${source} ${field} must be a string array, got ${JSON.stringify(value)}.`)
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`web-test-policy: ${source} ${field} must hold only strings, got ${JSON.stringify(entry)}.`)
    }
    entries.push(entry)
  }
  return entries
}

function requireRecord(value: unknown, field: string, source: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`web-test-policy: ${source} ${field} must be an object, got ${JSON.stringify(value)}.`)
  }
  return value as Record<string, string>
}
