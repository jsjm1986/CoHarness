/** Files and installed package edges that determine the managed Runtime payload. */
import { createHash, type Hash } from 'node:crypto'
import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

interface PackageManifest {
  files?: string[]
  main?: string
  module?: string
  bin?: unknown
  exports?: unknown
  imports?: unknown
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const RELEASE_FINGERPRINT = 'gateway/lib/runtime-dependencies.json'

function isWithin(root: string, path: string): boolean {
  const name = relative(root, path)
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

function runtimeFile(name: string): boolean {
  return !/(?:\.d\.[cm]?ts|\.map|\.tsbuildinfo|\.(?:test|spec)\.[cm]?[jt]sx?)$/u.test(name)
}

function runtimeDirectory(name: string): boolean {
  return name !== 'node_modules' && name !== 'tests' && name !== '__tests__' && !name.startsWith('.')
}

function hashFile(hash: Hash, root: string, path: string): void {
  const name = relative(root, path).split(sep).join('/')
  hash.update(JSON.stringify([name, createHash('sha256').update(readFileSync(path)).digest('hex')]) + '\n')
}

function collectFiles(directory: string, files: Set<string>): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && runtimeDirectory(entry.name)) collectFiles(path, files)
    else if (entry.isFile() && runtimeFile(entry.name)) files.add(path)
  }
}

/** @param directory - copied policy bundle's shipped directory. @returns a digest of its runtime files. */
export function runtimeTreeDigest(directory: string): string {
  const hash = createHash('sha256')
  const files = new Set<string>()
  collectFiles(directory, files)
  for (const file of [...files].sort()) hashFile(hash, directory, file)
  return hash.digest('hex')
}

function entryTargets(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : []
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(entryTargets)
}

function filesMatching(pattern: string, root: string): string[] {
  if (/[?*\[\]{!]/u.test(pattern)) {
    return globSync(pattern, { cwd: root, exclude: ['**/node_modules', '**/node_modules/**'] }).map(name => join(root, name))
  }
  return [join(root, pattern)]
}

function shippedFiles(root: string, manifest: PackageManifest, source: boolean): string[] {
  const files = new Set<string>()
  const declared = manifest.files ?? []
  const patterns = [
    ...declared.filter(pattern => !pattern.startsWith('!')),
    ...(source ? ['src'] : []),
    ...[manifest.main, manifest.module].filter((entry): entry is string => typeof entry === 'string'),
    ...entryTargets(manifest.exports), ...entryTargets(manifest.imports),
    ...Object.values(typeof manifest.bin === 'string' ? { bin: manifest.bin } : manifest.bin ?? {}),
  ]
  const excluded = new Set(declared.filter(pattern => pattern.startsWith('!'))
    .flatMap(pattern => filesMatching(pattern.slice(1), root)))
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split(/[\\/]/u).includes('..') || !runtimeFile(pattern)) continue
    for (const path of filesMatching(pattern, root)) {
      const info = statSync(path, { throwIfNoEntry: false })
      if (info?.isDirectory()) collectFiles(path, files)
      else if (info?.isFile() && runtimeFile(path)) files.add(path)
    }
  }
  if (manifest.files === undefined) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory() && runtimeDirectory(entry.name) && !/^(?:doc|docs|examples?|test|coverage)$/iu.test(entry.name)) {
        collectFiles(path, files)
      } else if (entry.isFile() && runtimeFile(entry.name) && !/^(?:readme|licen[sc]e|changelog|notice|authors)(?:[._-]|$)/iu.test(entry.name)) {
        files.add(path)
      }
    }
  }
  files.delete(join(root, 'package.json'))
  const omitted = [...excluded]
  return [...files].filter(file => !omitted.some(path => isWithin(path, file))).sort()
}

/**
 * Digest the installed dependency graph of the selected launch packages, including module and asset bytes.
 * @param roots - packages known to own the CLI and its served Web assets.
 * @param source - include source entry points for a source launch.
 * @param releaseRoot - immutable release directory that must contain every resolved dependency.
 * @returns a digest independent of release directory names and unrelated workspace files.
 */
export function runtimeDependencyDigest(roots: readonly string[], source: boolean, releaseRoot?: string): string {
  const hash = createHash('sha256')
  const immutableRoot = releaseRoot === undefined ? undefined : realpathSync(releaseRoot)
  const packages: string[] = []
  const indices = new Map<string, number>()
  const record = (directory: string): number => {
    const path = realpathSync(directory)
    if (immutableRoot !== undefined && !isWithin(immutableRoot, path)) {
      throw new Error(`Runtime dependency resolves outside the release: ${directory}`)
    }
    const existing = indices.get(path)
    if (existing !== undefined) return existing
    const index = packages.length
    packages.push(path)
    indices.set(path, index)
    return index
  }
  hash.update(JSON.stringify(roots.map(record)) + '\n')
  for (const [index, directory] of packages.entries()) {
    const manifestPath = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
    hash.update(`package ${String(index)}\n`)
    hashFile(hash, directory, manifestPath)
    for (const file of shippedFiles(directory, manifest, source)) {
      if (immutableRoot !== undefined && !isWithin(immutableRoot, realpathSync(file))) {
        throw new Error(`Runtime file resolves outside the release: ${file}`)
      }
      hashFile(hash, directory, file)
    }
    const require = createRequire(manifestPath)
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(dependencies).sort()) {
      if (name.startsWith('@types/')) continue
      if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*$/u.test(name)) throw new Error('Invalid Runtime package dependency name')
      const locations = require.resolve.paths(name) ?? []
      const dependency = locations.map(location => join(location, name, 'package.json')).find(existsSync)
      if (dependency === undefined && manifest.optionalDependencies?.[name] === undefined && manifest.peerDependenciesMeta?.[name]?.optional !== true) {
        throw new Error(`Missing Runtime package dependency ${name} from ${manifestPath}`)
      }
      hash.update(JSON.stringify([name, dependency === undefined ? null : record(dirname(dependency))]) + '\n')
    }
  }
  return hash.digest('hex')
}

function releaseDigest(root: string): string {
  return runtimeDependencyDigest([join(root, 'apps', 'cli'), join(root, 'apps', 'web')], false, realpathSync(root))
}

/** @param root - built release root. @returns the recorded digest, or absence in an earlier release. */
export function readReleaseRuntimeDigest(root: string): string | undefined {
  const path = join(root, RELEASE_FINGERPRINT)
  if (!existsSync(path)) return undefined
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1
    || !('platform' in manifest) || manifest.platform !== process.platform || !('arch' in manifest) || manifest.arch !== process.arch
    || !('digest' in manifest) || typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest)) {
    throw new Error(`Invalid Runtime dependency fingerprint: ${path}`)
  }
  return manifest.digest
}

/** @param root - built release root. Records the payload fingerprint after the workspace build. */
export function writeReleaseRuntimeDigest(root: string): void {
  const manifest = { version: 1, platform: process.platform, arch: process.arch, digest: releaseDigest(root) }
  writeFileSync(join(root, RELEASE_FINGERPRINT), `${JSON.stringify(manifest)}\n`)
}

/** @param root - staged immutable release root. Throws when any recorded Runtime artifact changed. */
export function verifyReleaseRuntimeDigest(root: string): void {
  const recorded = readReleaseRuntimeDigest(root)
  if (recorded === undefined || recorded !== releaseDigest(root)) throw new Error('Release Runtime dependencies differ from the built fingerprint')
}

if (import.meta.main) {
  const [, , command, root] = process.argv
  if (command !== '--verify-release' || root === undefined || !isAbsolute(root)) throw new Error('Expected --verify-release followed by the absolute release root')
  verifyReleaseRuntimeDigest(root)
}
