/** Describe and verify complete named-profile workspace outputs without transferring test verdicts. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import ts from 'typescript'
import { CLIENT_BUILD_RECORD_PATH, coharnessClientBuildEnvironment, officialClientBuildEnvironment, readClientBuildRecord, type ClientBuildProfile } from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { repositoryConfigHost } from './ts-project.ts'

const COMPILER_OUTPUT_ROOT = /^(?:vendor\/[^/]+|packages\/[^/]+\/[^/]+|apps\/[^/]+|native\/system\/packages\/entry)\/lib(?=\/|$)/

/** Same-commit build identity and the exact generated inventory a consumer must receive. */
export interface BuildArtifactManifest {
  readonly version: 2
  readonly mode: 'workspace'
  readonly identity: {
    readonly commit: string
    readonly tree: string
    readonly platform: string
    readonly architecture: string
    readonly node: string
    readonly pnpm: string
    readonly libc: string | null
    readonly lockSha256: string
    readonly buildInputsSha256: string
    readonly profile: ClientBuildProfile
    readonly publicClientEnvironment: Readonly<Record<string, string>>
  }
  readonly files: readonly {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly mode: number
  }[]
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
}

function digest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`build artifacts: invalid ${label}`)
  return value as Record<string, unknown>
}

function json(path: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(path, 'utf8')) as unknown, path)
}

/** Resolve a declared output without permitting traversal or a symlinked parent. */
function ownedPath(root: string, path: string): string {
  const child = relative(root, resolve(root, path)).split(sep).join('/')
  if (child === '' || child.startsWith('../') || isAbsolute(child)
    || child.split('/').some(part => part === 'node_modules' || part === '.git')
    // Projects rooted above src preserve that directory inside their emitted lib.
    || child.split('/').includes('src') && !COMPILER_OUTPUT_ROOT.test(child)) {
    throw new Error(`build artifacts: not a generated repository path: ${path}`)
  }
  let parent = root
  for (const part of child.split('/')) {
    parent = join(parent, part)
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new Error(`build artifacts: symlinked output is not transferable: ${child}`)
    }
  }
  return child
}

/** Compiler declarations, runtime bundles and generated Typert contributions share these output roots. */
function compilerOutputs(root: string): {
  roots: string[]
  emitted: Map<string, ReadonlySet<string>>
  buildInfo: Set<string>
} {
  const pending = [join(root, 'tsconfig.json')]
  const visited = new Set<string>()
  const outputs = new Set<string>()
  const emitted = new Map<string, ReadonlySet<string>>()
  const buildInfo = new Set<string>()
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined) break
    if (visited.has(path)) continue
    visited.add(path)
    const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, repositoryConfigHost)
    if (parsed === undefined || parsed.errors.length > 0) {
      throw new Error(`build artifacts: cannot read compiler output declarations from ${path}`)
    }
    const information = ts.getTsBuildInfoEmitOutputFilePath(parsed.options)
    if (information !== undefined && parsed.fileNames.length > 0) buildInfo.add(ownedPath(root, information))
    if (parsed.options.outDir !== undefined && parsed.options.noEmit !== true) {
      const output = basename(parsed.options.outDir) === 'types' ? dirname(parsed.options.outDir) : parsed.options.outDir
      const child = ownedPath(root, output)
      if (COMPILER_OUTPUT_ROOT.exec(child)?.[0] !== child) {
        throw new Error(`build artifacts: unsupported compiler output root: ${child}`)
      }
      const owner = join(root, dirname(child))
      const configPath = relative(owner, path)
      if (configPath.startsWith('..' + sep) || isAbsolute(configPath)) {
        throw new Error(`build artifacts: compiler output belongs to another package: ${child}`)
      }
      outputs.add(child)
      const directory = ownedPath(root, parsed.options.outDir)
      const expected = new Set(emitted.get(directory))
      for (const source of parsed.fileNames) {
        for (const outputFile of ts.getOutputFileNames(parsed, source, !ts.sys.useCaseSensitiveFileNames)) {
          expected.add(ownedPath(root, outputFile))
        }
      }
      emitted.set(directory, expected)
    }
    for (const reference of parsed.projectReferences ?? []) pending.push(ts.resolveProjectReferencePath(reference))
  }
  if (outputs.size === 0) throw new Error('build artifacts: compiler graph declares no outputs')
  return { roots: [...outputs].sort(), emitted, buildInfo }
}

function exportPaths(value: unknown): string[] {
  if (typeof value === 'string') return value.replace(/^\.\//, '').startsWith('lib/') ? [value.replace(/^\.\//, '')] : []
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(exportPaths)
}

/** Check entry declarations before accepting even a newly created inventory. */
function assertDeclaredEntries(root: string, output: string): void {
  const packageDirectory = dirname(output)
  const manifest = json(join(root, packageDirectory, 'package.json'))
  const paths = new Set([manifest.exports, manifest.main, manifest.types, manifest.bin].flatMap(exportPaths))
  for (const path of paths) {
    const pattern = ownedPath(root, join(packageDirectory, path))
    if (!pattern.startsWith(output + '/')) throw new Error(`build artifacts: entry escapes its output root: ${pattern}`)
    const matches = [...globSync(pattern, { cwd: root })]
    if (!matches.some(match => lstatSync(join(root, match)).isFile())) {
      throw new Error(`build artifacts: declared entry is missing: ${pattern}`)
    }
  }
}

function nativeOutputs(root: string, libc: string | null, tracked: ReadonlySet<string>): string[] {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return []
  const directory = `native/system/packages/${process.platform}-${process.arch}`
  const manifest = json(join(root, directory, 'prebuilds.json'))
  if (manifest.platform !== `${process.platform}-${process.arch}` || !Array.isArray(manifest.binaries)) {
    throw new Error('build artifacts: invalid native target declarations')
  }
  const declared = new Set<string>()
  const required = manifest.binaries.flatMap((raw: unknown) => {
    const binary = record(raw, 'native binary')
    if (typeof binary.path !== 'string' || !binary.path.startsWith('bin/')) throw new Error('build artifacts: invalid native output path')
    const path = ownedPath(root, join(directory, binary.path))
    if (!path.startsWith(directory + '/bin/')) throw new Error('build artifacts: native output escapes its binary directory')
    declared.add(path)
    if (binary.kind !== 'node-api' || binary.libc !== undefined && binary.libc !== (libc === null ? 'musl' : 'glibc')) return []
    return [path]
  })
  if (required.length === 0) throw new Error('build artifacts: no declared host native addon')
  const files = generatedFiles(root, directory + '/bin', tracked)
  if (required.some(path => !files.includes(path)) || files.some(path => !declared.has(path))) {
    throw new Error('build artifacts: missing or undeclared native output')
  }
  return files
}

/** Collect a closed set of ordinary generated files; never follow links or include package sources. */
function generatedFiles(root: string, directory: string, tracked: ReadonlySet<string>): string[] {
  const child = ownedPath(root, directory)
  const path = join(root, child)
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    return readdirSync(path).sort().flatMap(name => generatedFiles(root, join(child, name), tracked))
  }
  if (!stat.isFile() || (stat.mode & 0o7000) !== 0 || tracked.has(child) || /(?<!\.d)\.(?:ts|tsx|mts|cts)$/.test(child)) {
    throw new Error(`build artifacts: non-generated file in output inventory: ${child}`)
  }
  return [child]
}

/** Git resolves 8.3 spellings (RUNNER~1) to the long name; realpathSync.native canonicalizes both sides the same way. */
function sameCheckoutRoot(declared: string, given: string): boolean {
  if (process.platform !== 'win32') return declared === given
  return realpathSync.native(declared).toLowerCase() === realpathSync.native(given).toLowerCase()
}

/** Capture a complete build's identities and bytes; this does not assert that tests passed.
 * @param root - clean committed checkout with a completed build of the requested product profile.
 * @param profile - product profile required by the caller, never selected by a transferred report.
 * @returns manifest suitable for transport beside the generated files.
 */
export function createBuildArtifactManifest(root: string, profile: ClientBuildProfile = 'coharness'): BuildArtifactManifest {
  root = realpathSync(root)
  const declaredRoot = realpathSync(git(root, ['rev-parse', '--show-toplevel']))
  if (!sameCheckoutRoot(declaredRoot, root)) throw new Error(`build artifacts: root must be the Git checkout root (declared ${declaredRoot}, got ${root})`)
  if (git(root, ['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('build artifacts: source tree must be clean and committed')
  const commit = git(root, ['rev-parse', 'HEAD'])
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
  if (![commit, tree].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('build artifacts: full 40-character Git identities are required')
  const invocation = pnpmInvocation(['--version'])
  const pnpm = execFileSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8' }).trim()
  const packageManager = json(join(root, 'package.json')).packageManager
  if (typeof packageManager !== 'string' || (packageManager !== `pnpm@${pnpm}` && !packageManager.startsWith(`pnpm@${pnpm}+`))
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pnpm)) throw new Error('build artifacts: actual pnpm does not match packageManager')
  const publicClientEnvironment = (profile === 'official' ? officialClientBuildEnvironment : coharnessClientBuildEnvironment)(root, { DSH_CLIENT_COMMIT_HASH: commit })
  readClientBuildRecord(root, publicClientEnvironment)
  const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
  const libc = header.glibcVersionRuntime ?? null
  const lockSha256 = digest(readFileSync(join(root, 'pnpm-lock.yaml')))
  // The complete committed tree conservatively includes every source/configuration
  // input, including ones dynamically discovered by a bundler or generator.
  const buildInputsSha256 = digest(JSON.stringify({ tree, lockSha256, publicClientEnvironment, node: process.version, pnpm }))
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0'))
  const outputs = compilerOutputs(root)
  const inventory = new Set<string>()
  for (const output of [...outputs.roots, 'apps/web/dist']) {
    const files = generatedFiles(root, output, tracked)
    if (files.length === 0) throw new Error(`build artifacts: empty output root: ${output}`)
    for (const file of files) inventory.add(file)
  }
  for (const output of outputs.roots) assertDeclaredEntries(root, output)
  for (const output of outputs.buildInfo) {
    for (const file of generatedFiles(root, output, tracked)) inventory.add(file)
  }
  for (const [directory, expected] of outputs.emitted) {
    const actual = [...inventory].filter(path => path.startsWith(directory + '/') && !outputs.buildInfo.has(path))
    if (actual.some(path => !expected.has(path)) || [...expected].some(path => !inventory.has(path))) {
      throw new Error(`build artifacts: missing or stale compiler outputs in ${directory}; clean and rebuild`)
    }
  }
  if (!inventory.has('apps/web/dist/index.html')) throw new Error('build artifacts: Web entry index.html is missing')
  for (const output of nativeOutputs(root, libc, tracked)) inventory.add(output)
  for (const output of generatedFiles(root, CLIENT_BUILD_RECORD_PATH, tracked)) inventory.add(output)
  const files = [...inventory].sort().map((path) => {
    const stat = lstatSync(join(root, path))
    return { path, sha256: digest(readFileSync(join(root, path))), bytes: stat.size, mode: stat.mode & 0o777 }
  })
  return { version: 2, mode: 'workspace', identity: {
    commit, tree, platform: process.platform, architecture: process.arch, node: process.version,
    pnpm, libc, lockSha256, buildInputsSha256, profile, publicClientEnvironment,
  }, files }
}

/** Verify restored bytes and local identities; mismatch requires a fresh build, never a cached verdict.
 * @param root - clean consumer checkout with restored generated files.
 * @param manifest - untrusted parsed transfer manifest.
 * @param expectedProfile - authoritative product profile required by this consumer.
 * @returns verified complete inventory.
 */
export function verifyBuildArtifactManifest(root: string, manifest: unknown, expectedProfile: ClientBuildProfile = 'coharness'): BuildArtifactManifest {
  const raw = record(manifest, 'transfer manifest')
  const current = createBuildArtifactManifest(root, expectedProfile)
  if (raw.version !== 2 || raw.mode !== 'workspace') throw new Error('build artifacts: unsupported manifest version or mode')
  if (!isDeepStrictEqual(raw.identity, current.identity)) throw new Error('build artifacts: candidate, toolchain, build inputs or client environment mismatch')
  if (!isDeepStrictEqual(raw.files, current.files)) throw new Error('build artifacts: missing, extra, damaged or mode-mismatched generated outputs')
  if (!isDeepStrictEqual(raw, current)) throw new Error('build artifacts: unexpected transfer manifest fields')
  return current
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      options: { root: { type: 'string' }, manifest: { type: 'string' }, profile: { type: 'string', default: 'coharness' } },
      allowPositionals: true,
    })
    if (positionals.length !== 1 || !['create', 'verify'].includes(positionals[0] ?? '') || values.manifest === undefined
      || (values.profile !== 'official' && values.profile !== 'coharness')) throw new Error('usage: build-artifacts.ts <create|verify> --manifest PATH [--root PATH] [--profile coharness|official]')
    const root = resolve(values.root ?? process.cwd())
    const path = resolve(values.manifest)
    if (positionals[0] === 'create') {
      const manifest = createBuildArtifactManifest(root, values.profile)
      if (manifest.files.some(file => resolve(root, file.path) === path)
        || compilerOutputs(root).roots.some(output => path.startsWith(resolve(root, output) + sep))
        || path.startsWith(resolve(root, 'apps/web/dist') + sep)
        || relative(root, path).split(sep).join('/').startsWith(`native/system/packages/${process.platform}-${process.arch}/bin/`)) {
        throw new Error('build artifacts: manifest must be outside transferred output roots')
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
      console.log(`build artifacts: recorded ${manifest.files.length} files for ${manifest.identity.commit}`)
    } else {
      const manifest = verifyBuildArtifactManifest(root, JSON.parse(readFileSync(path, 'utf8')) as unknown, values.profile)
      console.log(`build artifacts: verified ${manifest.files.length} files for ${manifest.identity.commit}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
