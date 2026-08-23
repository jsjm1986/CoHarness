/**
 * Verify the repository's runtime-plugin, bundle, and static-client surfaces.
 *
 * The report is build-time only. It keeps the "everything is a plugin"
 * principle scoped to replaceable runtime capabilities without adding tier
 * metadata, reflection, or work to a running process.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const GATE = 'verify-plugin-surfaces'
const PACKAGE_GLOB = 'packages/*/*/package.json'
const EXTERNAL_PLUGIN_GLOB = 'plugins/*/package.json'
const WEB_PATCH = 'packages/bundle/web-app/cordis.patch.yml'

/** Package paths whose main role is static infrastructure rather than a runtime row. */
const STATIC_INFRASTRUCTURE_PREFIXES = [
  'packages/boot/',
  'packages/client/web/',
  'packages/client/ui-primitives/',
  'packages/client/ui-slots/',
  'packages/core/scope/',
  'packages/hooks/hook-protocol/',
  'packages/runtime-diagnostics/',
  'packages/sdk/client/',
  'packages/sdk/protocol/',
  'packages/test-support/',
  'packages/typert/generator/',
  'packages/util/',
] as const

/** Package groups whose manifests describe composition rather than one runtime capability. */
const COMPOSITION_PREFIXES = ['packages/bundle/', 'packages/examples/'] as const

/** Infrastructure rows allowed to prefetch during browser boot. */
export const IMMEDIATE_CLIENT_ALLOWLIST = new Set([
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-gateway',
])

/** Minimal manifest fields needed by this gate. */
interface Manifest {
  name?: string
  exports?: Record<string, unknown>
  dsh?: {
    client?: { immediately?: unknown }
    bundle?: { patch?: unknown }
  }
}

/** One static fact set consumed by the verifier and its JSON report. */
export interface PluginSurfaceFacts {
  /** Number of package manifests under the two-level packages workspace. */
  packageCount: number
  /** Packages classified as static infrastructure or support. */
  staticInfrastructurePackages: readonly string[]
  /** Packages classified as profile/example composition carriers. */
  compositionPackages: readonly string[]
  /** Remaining packages that provide runtime capability rows. */
  runtimePackages: readonly string[]
  /** Packages declaring a profile Bundle patch. */
  bundles: readonly string[]
  /** Tree-external plugin packages declaring a Bundle patch. */
  externalPluginBundles: readonly string[]
  /** Browser packages delivered through the Loader module graph. */
  dynamicClientPackages: readonly string[]
  /** Browser packages linked into the static shell. */
  staticClientPackages: readonly string[]
  /** Dynamic browser rows marked for stage-one prefetch. */
  immediateClientPackages: readonly string[]
  /** Number of base-composition Loader rows. */
  baseRowCount: number
}

/** A parsed record with its repository-relative manifest path. */
interface ManifestRecord {
  path: string
  manifest: Manifest
}

/** Narrow an unknown value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one JSON manifest. */
function readManifest(root: string, path: string): Manifest {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
}

/** Whether a package manifest exposes a browser `./client` entry. */
function shipsClient(manifest: Manifest): boolean {
  return manifest.exports !== undefined && Object.hasOwn(manifest.exports, './client')
}

/** Whether the package's client build uses the static shell preset. */
function isStaticClient(root: string, manifestPath: string): boolean {
  const config = resolve(root, dirname(manifestPath), 'tsdown.config.ts')
  return existsSync(config) && readFileSync(config, 'utf8').includes('staticLinked(')
}

/** Read all package manifests at the workspace package depth. */
function readPackages(root: string): ManifestRecord[] {
  return globSync(PACKAGE_GLOB, { cwd: root })
    .sort()
    .map(path => ({ path, manifest: readManifest(root, path) }))
}

/** Read tree-external plugin manifests that are built outside pnpm workspaces. */
function readExternalPluginPackages(root: string): ManifestRecord[] {
  return globSync(EXTERNAL_PLUGIN_GLOB, { cwd: root })
    .sort()
    .map(path => ({ path, manifest: readManifest(root, path) }))
}

/** Read package records that declare a browser Loader face or static browser build. */
function readBrowserPackages(root: string, packages = readPackages(root)): ManifestRecord[] {
  return packages.filter(record => (
    record.manifest.dsh?.client !== undefined || isStaticClient(root, record.path)
  ))
}

/** Test one repository-relative package path against a prefix list. */
function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => path.startsWith(prefix))
}

/** Flatten rows nested in one or more Include patch objects. */
function patchRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const rows: Record<string, unknown>[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.id === 'string') rows.push(item)
    if (Array.isArray(item.insert)) rows.push(...patchRows(item.insert))
    if (Array.isArray(item.config)) rows.push(...patchRows(item.config))
  }
  return rows
}

/** Read one Bundle patch and return every directly or nested declared row. */
function rowsFromPatch(root: string, path: string): Record<string, unknown>[] {
  const parsed = yaml.load(readFileSync(resolve(root, path), 'utf8'), { schema: entryListSchema })
  return patchRows(parsed)
}

/** Read and count the Web bundle's base rows. */
function baseRowCount(root: string): number {
  return rowsFromPatch(root, 'packages/bundle/base/cordis.patch.yml').length
}

/** Collect deterministic plugin-surface facts from source manifests and patches. */
export function collectPluginSurfaceFacts(root: string): PluginSurfaceFacts {
  const packages = readPackages(root)
  const externalPlugins = readExternalPluginPackages(root)
  const clientRecords = readBrowserPackages(root, packages)
  const dynamicClientPackages = clientRecords
    .filter(record => record.manifest.dsh?.client !== undefined)
    .map(record => record.manifest.name ?? record.path)
  const staticClientPackages = clientRecords
    .filter(record => isStaticClient(root, record.path))
    .map(record => record.manifest.name ?? record.path)
  const immediateClientPackages = packages
    .filter(record => record.manifest.dsh?.client?.immediately === true)
    .map(record => record.manifest.name ?? record.path)
  const bundles = packages
    .filter(record => record.manifest.dsh?.bundle !== undefined)
    .map(record => record.manifest.name ?? record.path)
  const staticInfrastructurePackages = packages
    .filter(record => hasPrefix(record.path, STATIC_INFRASTRUCTURE_PREFIXES))
    .map(record => record.manifest.name ?? record.path)
  const compositionPackages = packages
    .filter(record => hasPrefix(record.path, COMPOSITION_PREFIXES))
    .map(record => record.manifest.name ?? record.path)
  const runtimePackages = packages
    .filter(record => !hasPrefix(record.path, STATIC_INFRASTRUCTURE_PREFIXES))
    .filter(record => !hasPrefix(record.path, COMPOSITION_PREFIXES))
    .map(record => record.manifest.name ?? record.path)
  return {
    packageCount: packages.length,
    staticInfrastructurePackages,
    compositionPackages,
    runtimePackages,
    bundles,
    externalPluginBundles: externalPlugins
      .filter(record => record.manifest.dsh?.bundle !== undefined)
      .map(record => record.manifest.name ?? record.path),
    dynamicClientPackages,
    staticClientPackages,
    immediateClientPackages,
    baseRowCount: baseRowCount(root),
  }
}

/** Find one row by id in a parsed Web patch. */
function rowById(root: string, id: string): Record<string, unknown> | undefined {
  return rowsFromPatch(root, WEB_PATCH).find(row => row.id === id)
}

/** Collect every surface declaration violation. */
export function collectPluginSurfaceViolations(root: string, facts = collectPluginSurfaceFacts(root)): string[] {
  const violations: string[] = []
  const clientRecords = readBrowserPackages(root)
  for (const record of clientRecords) {
    const declared = record.manifest.dsh?.client !== undefined
    const staticLinked = isStaticClient(root, record.path)
    const shipped = shipsClient(record.manifest)
    const label = record.manifest.name ?? record.path
    if (declared && staticLinked) violations.push(`${label}: dsh.client and staticLinked are mutually exclusive`)
    if (declared !== shipped && !(staticLinked && shipped && !declared)) {
      violations.push(`${label}: browser export and dsh.client declaration disagree`)
    }
    if (!declared && !staticLinked) violations.push(`${label}: client package is neither dynamic nor static-linked`)
  }
  for (const packageName of facts.immediateClientPackages) {
    if (!IMMEDIATE_CLIENT_ALLOWLIST.has(packageName)) {
      violations.push(`${packageName}: immediately=true requires an explicit infrastructure allowlist entry`)
    }
  }
  for (const record of [...readPackages(root), ...readExternalPluginPackages(root)]) {
    const { path, manifest } = record
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') continue
    const patchPath = resolve(root, dirname(path), patch)
    if (!existsSync(patchPath)) violations.push(`${manifest.name ?? path}: Bundle patch ${patch} does not exist`)
  }
  const hmr = rowById(root, 'client-hmr')
  const expression = isRecord(hmr?.disabled) ? hmr.disabled.__jsExpr : undefined
  if (hmr?.name !== '@deepseek-ai/dsh-client-hmr') {
    violations.push(`${WEB_PATCH}: client-hmr row is missing or names a different package`)
  } else if (expression !== "process.env.DSH_CLIENT_HMR !== '1'") {
    violations.push(`${WEB_PATCH}: client-hmr must be disabled unless DSH_CLIENT_HMR is exactly "1"`)
  }
  return violations.sort((left, right) => left.localeCompare(right))
}

/** Render a stable human-readable surface summary. */
export function renderPluginSurfaceReport(facts: PluginSurfaceFacts): string {
  return [
    `${GATE}: ${String(facts.packageCount)} packages; ${String(facts.bundles.length)} Bundles; `
      + `${String(facts.externalPluginBundles.length)} tree-external plugin Bundles; `
      + `${String(facts.dynamicClientPackages.length)} dynamic client packages; `
      + `${String(facts.staticClientPackages.length)} static client packages; `
      + `${String(facts.immediateClientPackages.length)} immediate client rows; `
      + `${String(facts.baseRowCount)} base Loader rows.`,
  ].join('\n')
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')
  const facts = collectPluginSurfaceFacts(root)
  const violations = collectPluginSurfaceViolations(root, facts)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...facts, violations }, null, 2))
  } else if (violations.length > 0) {
    console.error(`${GATE}: ${String(violations.length)} violation(s):`)
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
  } else {
    console.log(renderPluginSurfaceReport(facts))
  }
}
