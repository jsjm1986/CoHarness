import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { installPrimaryRuntime, readPrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../src/primary-runtime.ts'
import * as workspaceDependencies from '../src/index.ts'

/** Destinations a staged rename must refuse, exercising installPayload's swap rollback. */
const renameRefusals = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    rename: vi.fn(async (source: string, destination: string) => {
      if (renameRefusals.delete(destination)) throw new Error(`primary-runtime.spec: refused rename into ${destination}`)
      return original.rename(source, destination)
    }),
  }
})

const roots: string[] = []
afterEach(async () => {
  renameRefusals.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-primary-runtime-'))
  roots.push(directory)
  const source = join(directory, 'resources')
  const root = join(directory, 'home', 'dsh-runtimes', 'dsh-primary-runtime')
  const manifest: PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' },
    pythonPackages: { 'python-docx': '1.2.0', 'python-pptx': '1.0.2', openpyxl: '3.1.5' },
  }
  const paths = workspaceDependencyPaths(source, manifest)
  for (const path of [paths.python, paths.node, paths.pnpm]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'interpreter')
  }
  await mkdir(paths.pythonPackages, { recursive: true })
  await mkdir(paths.nodePackages, { recursive: true })
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  return { source, root, manifest, directory }
}

it.each(['win32', 'darwin', 'linux'])('returns %s interpreter and package paths', (platform) => {
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform, arch: 'x64', components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' } }
  const paths = workspaceDependencyPaths('/runtime', manifest)
  expect(paths.pythonDistributions).toEqual({})
  expect(paths.python).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])))
  expect(paths.pythonPackages).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'))
})

it('installs offline, reuses the same release, and leaves environment and user packages unchanged', async () => {
  const { source, root, manifest } = await fixture()
  const environment = { ...process.env }
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(installed.pythonPackages, 'user-package.py'), 'user content')
  expect(await installPrimaryRuntime(source, root)).toEqual(installed)
  expect(installed.pythonDistributions).toEqual(manifest.pythonPackages)
  expect(await readFile(join(installed.pythonPackages, 'user-package.py'), 'utf8')).toBe('user content')
  expect(process.env).toEqual(environment)
})

it('replaces release components and recovers an interrupted directory swap', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await rename(root, `${root}.previous`)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await installPrimaryRuntime(source, root)
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('2.0.0')
})

it('replaces dependencies when the locked payload changes without a Desktop version change', async () => {
  const { source, root, manifest } = await fixture()
  const first = { ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.1.2' } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(first))
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(installed.pythonPackages, 'old-package.py'), 'old dependency')
  const next = { ...first, payloadDigest: 'b'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(next))
  await writeFile(join(workspaceDependencyPaths(source, next).pythonPackages, 'new-package.py'), 'new dependency')
  await installPrimaryRuntime(source, root)
  expect(await readPrimaryRuntime(root)).toEqual(next)
  expect(await readFile(join(installed.pythonPackages, 'new-package.py'), 'utf8')).toBe('new dependency')
  await expect(readFile(join(installed.pythonPackages, 'old-package.py'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('upgrades a release manifest without a payload digest', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }))
  await installPrimaryRuntime(source, root)
  expect((await readPrimaryRuntime(root)).payloadDigest).toBe('a'.repeat(64))
})

it('replaces changed payload bytes when only the digest changes', async () => {
  const { source, root, manifest } = await fixture()
  const first = { ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }
  const sourceFile = join(workspaceDependencyPaths(source, first).pythonPackages, 'library.py')
  await writeFile(join(source, 'runtime.json'), JSON.stringify(first))
  await writeFile(sourceFile, 'first wheel bytes')
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...first, payloadDigest: 'b'.repeat(64) }))
  await writeFile(sourceFile, 'repacked wheel bytes')
  await installPrimaryRuntime(source, root)
  expect(await readFile(join(installed.pythonPackages, 'library.py'), 'utf8')).toBe('repacked wheel bytes')
  expect((await readPrimaryRuntime(root)).pythonPackages).toEqual(first.pythonPackages)
})

it('keeps the installed release when the replacement payload is incomplete', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await rm(workspaceDependencyPaths(source, manifest).python)
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow()
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('1.0.0')
})

it('refuses linked installation directories without modifying their targets', async () => {
  const { source, root, directory } = await fixture()
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'untouched')
  await mkdir(dirname(root), { recursive: true })
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('filesystem link')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
})

it('rejects malformed metadata and incompatible targets', async () => {
  const { source, root, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, arch: process.arch === 'x64' ? 'arm64' : 'x64' }))
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('incompatible')
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, components: { ...manifest.components, python: '../escape' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it.each([['numpy', 'numpy'], ['pandas', 'pandas'], ['Numpy', 'numpy'], ['PANDAS', 'pandas']] as const)('rejects conflicting %s component and distribution versions', async (distribution, name) => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, pythonPackages: { [distribution]: '0.0.1' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow(`conflicting ${name} distribution version`)
  const consistent = { ...manifest, pythonPackages: { [distribution]: manifest.components[name] } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(consistent))
  expect(await readPrimaryRuntime(source)).toEqual(consistent)
})

it.each([
  { payloadDigest: 'invalid' },
  { pythonPackages: ['python-docx'] },
  { pythonPackages: { 'python-docx': '../escape' } },
  { pythonPackages: { '../escape': '1.2.0' } },
  { pythonPackages: { numpy: '2.3.5', Numpy: '2.3.5' } },
  { pythonPackages: { Pillow: '12.3.0', pillow: '12.3.0' } },
  { pythonPackages: { typing_extensions: '4.16.0', 'typing.extensions': '4.16.0' } },
])('rejects invalid locked payload metadata: %j', async (invalid) => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, ...invalid }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it('loads the real tool through Cordis, exposes installed paths, and unregisters on disposal', async () => {
  const { source, root, manifest, directory } = await fixture()
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['fs', LocalFileSystem], ['dependencies', workspaceDependencies],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(directory, 'cordis.yml')
    await writeFile(config, `- name: agents\n- name: systemPrompt\n- name: tools\n- name: fs\n- name: dependencies\n  config:\n    source: ${JSON.stringify(source)}\n    root: ${JSON.stringify(root)}\n`)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const environment = { ...process.env }
    const request = { signal: new AbortController().signal, name: 'load_workspace_dependencies', arguments: {} }
    const inaccessible = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    try {
      const rejected = await ctx.tools.execute({ ...request, callId: ToolCallId('remote') })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain('unavailable in the current execution target')
      await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { inaccessible.mockRestore() }
    const results = await Promise.all(['first', 'second'].map(id => ctx.tools.execute({ ...request, callId: ToolCallId(id) })))
    for (const result of results) {
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(workspaceDependencyPaths(root, manifest), undefined, 2) }])
    }
    expect(process.env).toEqual(environment)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dependencies')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'load_workspace_dependencies')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects installation inside its payload through a linked parent', async () => {
  const { source, directory } = await fixture()
  const alias = join(directory, 'alias')
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installPrimaryRuntime(source, join(alias, 'installed'))).rejects.toThrow('must not overlap')
  await expect(readFile(join(source, 'installed', 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects non-object runtime metadata and manifests without locked distributions', async () => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), '42')
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
  const unlocked = {
    desktopVersion: manifest.desktopVersion, platform: manifest.platform, arch: manifest.arch,
    components: manifest.components,
  }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(unlocked))
  await expect(readPrimaryRuntime(source)).resolves.toEqual(unlocked)
})

it('rejects non-absolute or overlapping source and installation paths', async () => {
  const { source, root } = await fixture()
  await expect(installPrimaryRuntime('relative', root)).rejects.toThrow('must be absolute')
  await expect(installPrimaryRuntime(source, 'relative')).rejects.toThrow('must be absolute')
  await expect(installPrimaryRuntime(source, join(source, 'installed'))).rejects.toThrow('must not overlap')
  await expect(installPrimaryRuntime(source, dirname(source))).rejects.toThrow('must not overlap')
})

it('restores the previous release when the staged swap cannot land', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  renameRefusals.add(root)
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('refused rename')
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('1.0.0')
})

it('reports a failed staged swap on a clean installation', async () => {
  const { source, root } = await fixture()
  renameRefusals.add(root)
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('refused rename')
  await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

interface RegisteredDependencyTool {
  execute(args: unknown, exec: { readonly signal: AbortSignal }): Promise<unknown>
  presentCall(args: unknown): unknown
}

function toolHarness(ctx: Context) {
  const state: { tool?: RegisteredDependencyTool } = {}
  ctx.provide('tools', {
    register: (tool: unknown) => {
      state.tool = tool as RegisteredDependencyTool
      return () => {}
    },
  } as never)
  ctx.provide('fs', { processPathFromHostPath: (path: string) => path } as never)
  return state
}

it('requires absolute deployment paths before registering its tool', async () => {
  const { source, root } = await fixture()
  const ctx = new Context()
  const harness = toolHarness(ctx)
  try {
    expect(() => workspaceDependencies.apply(ctx, { source: 'relative', root })).toThrow('must be absolute')
    expect(() => workspaceDependencies.apply(ctx, { source, root: 'relative' })).toThrow('must be absolute')
    expect(harness.tool).toBeUndefined()
    workspaceDependencies.apply(ctx, { source, root })
    expect(harness.tool?.presentCall({})).toEqual({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('unwinds a pending installation on disposal and retries a failed one', async () => {
  const { source, root, manifest } = await fixture()
  const ctx = new Context()
  const harness = toolHarness(ctx)
  workspaceDependencies.apply(ctx, { source, root })
  const execute = harness.tool?.execute.bind(harness.tool)
  if (execute === undefined) throw new Error('tool was not registered')
  // A manually held writer lock parks the install until contention times out.
  await mkdir(dirname(root), { recursive: true })
  const canonical = join(await realpath(dirname(root)), basename(root))
  const held = `${canonical}.lock`
  await writeFile(held, `${process.pid}\n`)
  const running = execute({}, { signal: new AbortController().signal })
  try {
    await ctx.fiber.dispose()
    await expect(running).rejects.toThrow('timed out waiting for the writer lock')
  } finally {
    await rm(held, { force: true })
  }
  const recovered = new Context()
  const second = toolHarness(recovered)
  try {
    workspaceDependencies.apply(recovered, { source, root })
    await expect(second.tool!.execute({}, { signal: new AbortController().signal }))
      .resolves.toEqual(workspaceDependencyPaths(root, manifest))
  } finally {
    await recovered.fiber.dispose()
  }
})
