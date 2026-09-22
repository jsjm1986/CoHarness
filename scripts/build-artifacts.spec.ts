/** Actual create/verify commands over private committed source and generated-output fixtures. */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from './client-build-environment.ts'
import type { BuildArtifactManifest } from './build-artifacts.ts'

const script = fileURLToPath(new URL('./build-artifacts.ts', import.meta.url))
const tsx = createRequire(import.meta.url).resolve('tsx/esm')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function fixture(options: { appDirectory?: string; appOutput?: string; appExport?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-artifacts-'))
  roots.push(root)
  const write = (path: string, contents: string | object): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '-q')
  write('.gitignore', 'lib/\ndist/\n.typecheck/\n.dsh-build/\n.artifacts/\n.tools/\nnative/system/packages/*/bin/\n')
  write('package.json', { name: 'build-fixture', version: '1.0.0', type: 'module', packageManager: 'pnpm@11.7.0' })
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  const appDirectory = options.appDirectory ?? 'apps/web'
  const packages = ['vendor/cordis', 'packages/core/probe', 'packages/client/probe', 'apps/cli', appDirectory, 'native/system/packages/entry']
  write('tsconfig.json', { files: [], references: [{ path: './tsconfig.host.json' }] })
  write('host.ts', 'export const host = true\n')
  write('tsconfig.host.json', {
    files: ['host.ts'], compilerOptions: { composite: true, noEmit: true, tsBuildInfoFile: '.typecheck/host.tsbuildinfo' },
    references: packages.map(path => ({ path })),
  })
  for (const directory of packages) {
    const webApp = directory === appDirectory
    write(directory + '/package.json', {
      name: 'fixture-' + directory.replaceAll('/', '-'), type: 'module',
      ...webApp ? { exports: { './output/*': options.appExport ?? './dist/*' } } : {
        main: './lib/index.js', types: './lib/types/index.d.ts',
        exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
          ...directory === 'apps/cli' ? { './lib/*': './lib/*' } : {},
          ...directory === 'packages/core/probe' ? { './typert': './lib/typert.host.js' } : {} },
      },
      ...directory === 'apps/cli' ? { bin: { fixture: './lib/bin.js' } } : {},
    })
    write(directory + '/src/index.ts', 'export const value = 1\n')
    write(directory + '/tsconfig.json', {
      compilerOptions: {
        composite: true, declaration: true, rootDir: webApp ? '.' : './src',
        outDir: webApp ? options.appOutput ?? './lib/types' : './lib/types',
        tsBuildInfoFile: webApp ? './lib/types/tsconfig.tsbuildinfo' : './lib/build.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
    })
  }
  let native: string | undefined
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const target = `${process.platform}-${process.arch}`
    const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
    const libc = process.platform === 'linux' ? header.glibcVersionRuntime === undefined ? 'musl' : 'glibc' : undefined
    native = `native/system/packages/${target}/bin/system.node`
    write(`native/system/packages/${target}/prebuilds.json`, {
      platform: target, binaries: [{ tool: 'flock', kind: 'node-api', path: 'bin/system.node', ...libc === undefined ? {} : { libc } }],
    })
  }
  git('add', '.')
  git('-c', 'user.name=Build fixture', '-c', 'user.email=build@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${join(root, '.tools/hooks')}`, 'commit', '-qm', 'source fixture')
  const commit = git('rev-parse', 'HEAD')
  for (const directory of packages) {
    if (directory === appDirectory) {
      write(directory + '/lib/types/src/index.d.ts', 'export declare const value = 1\n')
      write(directory + '/lib/types/src/index.js', 'export const value = 1\n')
      write(directory + '/lib/types/tsconfig.tsbuildinfo', '{}')
      continue
    }
    write(directory + '/lib/index.js', 'export const value = 1\n')
    write(directory + '/lib/types/index.d.ts', 'export declare const value = 1\n')
    write(directory + '/lib/types/index.js', 'export const value = 1\n')
    write(directory + '/lib/build.tsbuildinfo', '{}')
  }
  write('.typecheck/host.tsbuildinfo', '{}')
  write('packages/core/probe/lib/typert.host.js', 'export const models = []\n')
  write('packages/client/probe/lib/client.js', 'export const client = true\n')
  write('apps/cli/lib/bin.js', '#!/usr/bin/env node\n')
  chmodSync(join(root, 'apps/cli/lib/bin.js'), 0o755)
  write('apps/web/dist/index.html', '<!doctype html><title>fixture</title>')
  if (native !== undefined) write(native, 'fixture native output')
  writeClientBuildRecord(root, officialClientBuildEnvironment(root, { DSH_CLIENT_COMMIT_HASH: commit }))
  // The tool query is real; this private executable supplies a controlled
  // package-manager version without running installation or repository hooks.
  write('.tools/pnpm.cjs', "if(process.argv[2]!=='--version')process.exit(2);process.stdout.write('11.7.0\\n')\n")
  const manifest = join(root, '.artifacts/build.json')
  const cli = (mode: string, extra: string[] = []) => {
    const result = spawnSync(process.execPath, ['--import', tsx, script, mode, '--manifest', manifest, ...extra], {
      cwd: root,
      env: { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].flatMap(name =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]])), npm_execpath: join(root, '.tools/pnpm.cjs') },
      encoding: 'utf8', timeout: 15_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const read = (): BuildArtifactManifest => JSON.parse(readFileSync(manifest, 'utf8')) as BuildArtifactManifest
  return { root, manifest, write, cli, read, commit, native }
}

describe('workspace build artifact CLI', () => {
  it('accepts a complete same-commit build including generated declarations, Typert, Client, Web and native outputs', () => {
    const f = fixture()
    const created = f.cli('create')
    expect(created.status, created.output).toBe(0)
    const manifest = f.read()
    expect(manifest.identity).toMatchObject({ commit: f.commit, node: process.version, pnpm: '11.7.0', profile: 'official' })
    expect(manifest.identity.tree).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'vendor/cordis/lib/types/index.d.ts', 'packages/core/probe/lib/typert.host.js',
      'packages/client/probe/lib/client.js', 'apps/web/dist/index.html', 'apps/cli/lib/bin.js',
      'apps/web/lib/types/src/index.js', 'apps/web/lib/types/src/index.d.ts',
      'apps/web/lib/types/tsconfig.tsbuildinfo',
      '.dsh-build/client-build-environment.json',
      '.typecheck/host.tsbuildinfo', 'packages/core/probe/lib/build.tsbuildinfo',
    ]))
    if (f.native !== undefined) expect(manifest.files.some(file => file.path === f.native)).toBe(true)
    const verified = f.cli('verify')
    expect(verified.status, verified.output).toBe(0)
  })

  it('accepts another app declared by the compiler graph without a name-specific output list', () => {
    const f = fixture({ appDirectory: 'apps/dashboard' })
    const created = f.cli('create')
    expect(created.status, created.output).toBe(0)
    expect(f.read().files.some(file => file.path === 'apps/dashboard/lib/types/src/index.d.ts')).toBe(true)
    const verified = f.cli('verify')
    expect(verified.status, verified.output).toBe(0)
  })

  it.each(['./src/generated', './generated', '../cli/lib/types', '../../unknown/lib/types'])(
    'rejects the app compiler output outside its owned lib root: %s', (appOutput) => {
      const f = fixture({ appOutput })
      const result = f.cli('create')
      expect(result.status, result.output).toBe(1)
      expect(result.output).toMatch(/not a generated repository path|unsupported compiler output root|belongs to another package/)
    },
  )

  it.each(['missing', 'stale', 'source'] as const)('rejects %s files inside the emitted app src directory', (kind) => {
    const f = fixture()
    if (kind === 'missing') rmSync(join(f.root, 'apps/web/lib/types/src/index.d.ts'))
    if (kind === 'stale') f.write('apps/web/lib/types/src/deleted.js', 'export const stale = true')
    if (kind === 'source') f.write('apps/web/lib/types/src/leak.ts', 'export const secret = true')
    const result = f.cli('create')
    expect(result.status, result.output).toBe(1)
    expect(result.output).toMatch(/missing or stale compiler outputs|non-generated file/)
  })

  it('requires wildcard exports to match an emitted file, not only a directory', () => {
    const f = fixture({ appExport: './lib/missing/*' })
    mkdirSync(join(f.root, 'apps/web/lib/missing/empty'), { recursive: true })
    const result = f.cli('create')
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('declared entry is missing')
  })

  it.each(['commit', 'tree', 'node', 'architecture', 'pnpm', 'lockSha256', 'profile', 'publicClientEnvironment'] as const)(
    'rejects a mismatched %s even when every restored file is intact', (field) => {
      const f = fixture()
      const created = f.cli('create')
      expect(created.status, created.output).toBe(0)
      const manifest = f.read()
      const identity = manifest.identity as unknown as Record<string, unknown>
      // The wrong commit deliberately retains the client record's seven-byte prefix.
      identity[field] = field === 'commit' ? f.commit.slice(0, 7) + '0'.repeat(33) : 'different'
      f.write('.artifacts/build.json', manifest)
      const result = f.cli('verify')
      expect(result.status, result.output).toBe(1)
      expect(result.output).toContain('mismatch')
    },
  )

  it.each(['damaged', 'missing', 'extra', 'source', 'dirty', 'invalid-manifest'] as const)(
    'rejects %s input through the actual verification command', (kind) => {
      const f = fixture()
      const created = f.cli('create')
      expect(created.status, created.output).toBe(0)
      if (kind === 'damaged') f.write('packages/core/probe/lib/index.js', 'damaged')
      if (kind === 'missing') rmSync(join(f.root, 'packages/core/probe/lib/types/index.d.ts'))
      if (kind === 'extra') f.write('packages/core/probe/lib/unexpected.js', 'extra')
      if (kind === 'source') f.write('packages/core/probe/lib/source.ts', 'export const secret = 1')
      if (kind === 'dirty') f.write('packages/core/probe/src/index.ts', 'export const value = 2')
      if (kind === 'invalid-manifest') f.write('.artifacts/build.json', '{')
      const result = f.cli('verify')
      expect(result.status, result.output).toBe(1)
    },
  )

  it('requires public declarations even before recording a producer inventory', () => {
    const f = fixture()
    rmSync(join(f.root, 'packages/core/probe/lib/typert.host.js'))
    const result = f.cli('create')
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('declared entry is missing')
  })

  it('rejects leftover compiler output whose source is absent before recording an inventory', () => {
    const f = fixture()
    f.write('packages/core/probe/lib/types/deleted-source.js', 'export const stale = true')
    const result = f.cli('create')
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('stale compiler outputs')
  })

  it('requires the no-emit aggregate build information as well as package outputs', () => {
    const f = fixture()
    rmSync(join(f.root, '.typecheck/host.tsbuildinfo'))
    expect(f.cli('create').status).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a lost executable mode and a symlink into an output tree', () => {
    const f = fixture()
    const created = f.cli('create')
    expect(created.status, created.output).toBe(0)
    chmodSync(join(f.root, 'apps/cli/lib/bin.js'), 0o644)
    expect(f.cli('verify').status).toBe(1)
    chmodSync(join(f.root, 'apps/cli/lib/bin.js'), 0o755)
    symlinkSync(resolve(f.root, 'packages/core/probe/src/index.ts'), join(f.root, 'packages/core/probe/lib/leak.js'))
    const result = f.cli('verify')
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('symlinked output')
  })
})
