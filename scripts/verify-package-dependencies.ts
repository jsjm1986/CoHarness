/** Verify workspace dependency sections and Host runtime ownership. */

import { globSync, readFileSync } from 'node:fs'
import { posix, resolve, sep } from 'node:path'
import { collectRuntimeSourcePackageUses } from './verify-client-packages.ts'

const GATE = 'verify-package-dependencies'
const DSH_PREFIX = '@deepseek-ai/dsh-'
const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const
const PRODUCTION_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
const MANIFEST_GLOBS = [
  'packages/*/*/package.json',
  'apps/*/package.json',
  'vendor/*/package.json',
  'native/landlock-run/package.json',
  'native/landlock-run/packages/*/package.json',
]

type DependencySection = typeof DEPENDENCY_SECTIONS[number]

/** Parsed workspace package manifest used by the dependency verifier. */
export interface WorkspaceDependencyManifest {
  /** Repository-relative manifest path. */
  readonly manifestPath: string
  /** Repository-relative package directory. */
  readonly directory: string
  /** Package name. */
  readonly name: string
  /** Parsed package manifest. */
  readonly manifest: PackageManifest
}

/** Summary emitted after a dependency check succeeds. */
export interface PackageDependencySummary {
  /** Number of workspace manifests inspected. */
  readonly packageCount: number
  /** Number of source runtime edges inspected. */
  readonly runtimeEdgeCount: number
}

/** Package manifest fields relevant to dependency ownership. */
export interface PackageManifest {
  readonly name?: unknown
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?: unknown
  readonly devDependencies?: unknown
  readonly peerDependenciesMeta?: unknown
  readonly dsh?: unknown
}

/** Read every workspace manifest in a stable path order. */
export function readWorkspaceDependencyManifests(root: string): WorkspaceDependencyManifest[] {
  return globSync(MANIFEST_GLOBS, { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()
    .map((manifestPath) => {
      const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as PackageManifest
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`${manifestPath}: package name must be a non-empty string`)
      }
      return {
        manifestPath,
        directory: posix.dirname(manifestPath),
        name: manifest.name,
        manifest,
      }
    })
}

/** Collect all dependency policy violations without modifying manifests. */
export function collectPackageDependencyViolations(
  root: string,
  packages = readWorkspaceDependencyManifests(root),
): string[] {
  const workspaceNames = new Set(packages.map(pkg => pkg.name))
  const violations: string[] = []
  for (const pkg of packages) {
    const sections = sectionValues(pkg.manifest, pkg.manifestPath, violations)
    checkDuplicateProductionDeclarations(pkg, sections, violations)
    checkWorkspaceRanges(pkg, sections, workspaceNames, violations)
    checkPeerDevelopmentMirrors(pkg, sections, violations)
    checkPeerMetadata(pkg, sections, violations)
    checkHostRuntimeImports(root, pkg, workspaceNames, sections, violations)
  }
  return [...new Set(violations)].sort((left, right) => left.localeCompare(right))
}

/** Verify the repository and return the counts used by the command-line report. */
export function verifyPackageDependencies(root: string): PackageDependencySummary {
  const packages = readWorkspaceDependencyManifests(root)
  const violations = collectPackageDependencyViolations(root, packages)
  if (violations.length > 0) {
    throw new Error(`${GATE}: ${String(violations.length)} violation(s):\n${violations.map(v => `  ${v}`).join('\n')}`)
  }
  return {
    packageCount: packages.length,
    runtimeEdgeCount: countHostRuntimeEdges(root, packages),
  }
}

type DependencyRecord = Record<string, unknown>

function isRecord(value: unknown): value is DependencyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sectionValues(
  manifest: PackageManifest,
  manifestPath: string,
  violations: string[],
): Partial<Record<DependencySection, DependencyRecord>> {
  const values: Partial<Record<DependencySection, DependencyRecord>> = {}
  for (const section of DEPENDENCY_SECTIONS) {
    const value = manifest[section]
    if (value === undefined) continue
    if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== 'string')) {
      violations.push(`${manifestPath}: ${section} must be an object of string ranges`)
      continue
    }
    values[section] = value
  }
  return values
}

function checkDuplicateProductionDeclarations(
  pkg: WorkspaceDependencyManifest,
  sections: Partial<Record<DependencySection, DependencyRecord>>,
  violations: string[],
): void {
  const names = new Set(PRODUCTION_SECTIONS.flatMap(section => Object.keys(sections[section] ?? {})))
  for (const name of [...names].sort()) {
    const declared = PRODUCTION_SECTIONS.filter(section => sections[section]?.[name] !== undefined)
    if (declared.length > 1) {
      violations.push(`${pkg.manifestPath}: ${name} is declared in multiple production sections (${declared.join(' + ')})`)
    }
  }
}

function checkWorkspaceRanges(
  pkg: WorkspaceDependencyManifest,
  sections: Partial<Record<DependencySection, DependencyRecord>>,
  workspaceNames: ReadonlySet<string>,
  violations: string[],
): void {
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(sections[section] ?? {})) {
      if (!workspaceNames.has(name) || typeof range !== 'string') continue
      if (!range.startsWith('workspace:')) {
        violations.push(`${pkg.manifestPath}: ${section}.${name} must use the workspace: protocol, found ${range}`)
      }
    }
  }
}

function checkPeerDevelopmentMirrors(
  pkg: WorkspaceDependencyManifest,
  sections: Partial<Record<DependencySection, DependencyRecord>>,
  violations: string[],
): void {
  // Vendored packages follow their upstream peer policy. Harness packages keep
  // every peer available during source builds with the exact same range.
  if (!pkg.directory.startsWith('packages/') || !pkg.name.startsWith(DSH_PREFIX)) return
  const peers = sections.peerDependencies ?? {}
  const dev = sections.devDependencies ?? {}
  for (const name of Object.keys(peers).sort()) {
    if (dev[name] !== peers[name]) {
      violations.push(`${pkg.manifestPath}: peerDependencies.${name} and devDependencies.${name} must have the same range`)
    }
  }
}

function checkPeerMetadata(
  pkg: WorkspaceDependencyManifest,
  sections: Partial<Record<DependencySection, DependencyRecord>>,
  violations: string[],
): void {
  const peers = sections.peerDependencies ?? {}
  const metadata = isRecord(pkg.manifest.peerDependenciesMeta) ? pkg.manifest.peerDependenciesMeta : {}
  for (const name of Object.keys(metadata).sort()) {
    if (peers[name] === undefined) {
      violations.push(`${pkg.manifestPath}: peerDependenciesMeta.${name} has no matching peerDependencies entry`)
    }
  }
}

function hasClientDeclaration(manifest: PackageManifest): boolean {
  return isRecord(manifest.dsh) && Object.hasOwn(manifest.dsh, 'client')
}

/** Client bundles and composition bundles have their own dependency policy. */
function skipsHostRuntimeScan(pkg: WorkspaceDependencyManifest): boolean {
  return pkg.directory.startsWith('packages/client/')
    || pkg.directory.startsWith('packages/bundle/')
    || hasClientDeclaration(pkg.manifest)
    || pkg.directory.startsWith('apps/')
    || pkg.directory.startsWith('vendor/')
    || pkg.directory.startsWith('native/')
}

function checkHostRuntimeImports(
  root: string,
  pkg: WorkspaceDependencyManifest,
  workspaceNames: ReadonlySet<string>,
  sections: Partial<Record<DependencySection, DependencyRecord>>,
  violations: string[],
): void {
  if (skipsHostRuntimeScan(pkg)) return
  const production = new Set(PRODUCTION_SECTIONS.flatMap(section => Object.keys(sections[section] ?? {})))
  for (const sourcePath of sourceFiles(root, pkg.directory)) {
    const source = readFileSync(resolve(root, sourcePath), 'utf8')
    for (const dependency of collectRuntimeSourcePackageUses(sourcePath, source)) {
      if (!workspaceNames.has(dependency) || dependency === pkg.name || production.has(dependency)) continue
      violations.push(`${sourcePath}: runtime import ${dependency} is absent from dependencies, optionalDependencies, and peerDependencies`)
    }
  }
}

function sourceFiles(root: string, directory: string): string[] {
  return globSync(`${directory}/src/**/*.{ts,tsx,mts,cts}`, { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()
}

function countHostRuntimeEdges(root: string, packages: readonly WorkspaceDependencyManifest[]): number {
  const workspaceNames = new Set(packages.map(pkg => pkg.name))
  let count = 0
  for (const pkg of packages) {
    if (skipsHostRuntimeScan(pkg)) continue
    const seen = new Set<string>()
    for (const sourcePath of sourceFiles(root, pkg.directory)) {
      const source = readFileSync(resolve(root, sourcePath), 'utf8')
      for (const dependency of collectRuntimeSourcePackageUses(sourcePath, source)) {
        if (workspaceNames.has(dependency) && dependency !== pkg.name) seen.add(dependency)
      }
    }
    count += seen.size
  }
  return count
}

function main(): void {
  try {
    const summary = verifyPackageDependencies(resolve(import.meta.dirname, '..'))
    console.log(`${GATE}: ${String(summary.packageCount)} workspace package(s), ${String(summary.runtimeEdgeCount)} Host runtime edge(s) verified.`)
  } catch (error: unknown) {
    console.error(`${GATE}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (import.meta.main) main()
