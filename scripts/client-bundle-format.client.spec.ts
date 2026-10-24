/** Exercises the dynamic Client preset through emitted JavaScript and the production module table. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { build, type UserConfig } from 'tsdown'
import { describe, expect, it } from 'vitest'
import { clientBundle, staticLinked } from '../packages/client/tsdown.client.ts'
import { ClientModuleSystem } from '../packages/client/modules/src/client/system.ts'
import { parseBootManifest, type ClientModuleLoaderTarget } from '../packages/client/modules/src/client/manifest.ts'
import { clientContentRevision, stampClientArtifact } from '../packages/client/modules/src/artifact-revision.ts'

const PACKAGE_ID = '@deepseek-ai/dsh-client-ui-conversation'
const ENTRY_SOURCE = [
  '/*! @license fixture-preserved-license */',
  '/** Format fixture documentation: original sources remain in the source map. */',
  'export function NamedPlugin() { return "plugin" }',
  'export class NamedService { value() { return "service" } }',
  'export const NamedArrow = () => "arrow"',
  'export const names = [NamedPlugin.name, NamedService.name, NamedArrow.name]',
  'export const lazy = () => import("./lazy.js")',
].join('\n')
const LAZY_SOURCE = [
  'export function LazyPlugin() { return "lazy-plugin" }',
  'export class LazyService { value() { return "lazy-service" } }',
  'export const LazyArrow = () => "lazy-arrow"',
  'export const names = [LazyPlugin.name, LazyService.name, LazyArrow.name]',
  'export const marker = "lazy-loaded"',
].join('\n')

async function emitSource(root: string, name: string, source: string): Promise<void> {
  const sourceDirectory = join(root, 'src/client')
  const outputDirectory = join(root, 'lib/types/client')
  await mkdir(sourceDirectory, { recursive: true })
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, `${name}.ts`), source)
  const output = ts.transpileModule(source, {
    fileName: `${name}.ts`,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSources: true,
      sourceRoot: '../../../src/client/',
    },
  })
  await writeFile(join(outputDirectory, `${name}.js`), output.outputText)
  await writeFile(join(outputDirectory, `${name}.js.map`), output.sourceMapText!)
}

function clientConfig(): UserConfig {
  const config = clientBundle(PACKAGE_ID, ['lib/types/index.js'])(
    { env: { DSH_BUILD_FACE: 'client' } },
  ).find(config => config.platform === 'browser')
  if (config === undefined) throw new Error('Client preset missing')
  return config
}

async function bundle(root: string, config: UserConfig, directory: string): Promise<string> {
  await build({
    ...config,
    config: false,
    cwd: root,
    outDir: join(root, directory),
    tsconfig: false,
    logLevel: 'silent',
    report: false,
  })
  return readFile(join(root, directory, 'client.js'), 'utf8')
}

describe('dynamic Client output formatting', () => {
  it('keeps repeated builds content-identical and revises the entry for a lazy-only edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-identity-'))
    try {
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await emitSource(root, 'index', ENTRY_SOURCE)
      await emitSource(root, 'lazy', LAZY_SOURCE)
      const original = await bundle(root, clientConfig(), 'first')
      const repeated = await bundle(root, clientConfig(), 'second')
      expect(repeated).toBe(original)
      const lazy = await readFile(join(root, 'first/client.lazy.js'), 'utf8')
      expect(stampClientArtifact(original, [{ fileName: 'client.lazy.js', code: lazy }])).toBe(original)
      await emitSource(root, 'lazy', LAZY_SOURCE.replace('lazy-loaded', 'lazy-updated'))
      const changed = await bundle(root, clientConfig(), 'changed')
      const stripStamp = (source: string) => source.replace(/^\/\/# dsh-client-artifact=.*\n/gmu, '')
      expect(stripStamp(changed)).toBe(stripStamp(original))
      expect(clientContentRevision(Buffer.from(changed))).not.toBe(clientContentRevision(Buffer.from(original)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps Node and statically linked output settings independent', () => {
    const configs = clientBundle(PACKAGE_ID, ['lib/types/index.js'])({ env: {} })
    const node = configs.find(config => config.platform === 'node')
    expect(node).toBeDefined()
    expect(node?.minify).toBeUndefined()
    const linked = staticLinked('@deepseek-ai/dsh-client-ui-primitives', ['lib/types/index.js'])(
      { env: { DSH_BUILD_FACE: 'client' } },
    )
    expect(linked).toHaveLength(1)
    expect(linked[0]?.minify).toBeUndefined()
  })

  it('removes formatting while preserving names, licenses, source maps, and lazy module loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-format-'))
    try {
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await emitSource(root, 'index', ENTRY_SOURCE)
      await emitSource(root, 'lazy', LAZY_SOURCE)
      const preset = clientConfig()
      expect(preset.minify).toEqual({ compress: false, mangle: false })
      if (typeof preset.outputOptions !== 'object' || preset.outputOptions === null) {
        throw new Error('Client output settings missing')
      }
      const originalOutput = { ...preset.outputOptions }
      delete originalOutput.keepNames
      delete originalOutput.minifyInternalExports
      delete originalOutput.comments
      const originalPreset = { ...preset, outputOptions: originalOutput }
      delete originalPreset.minify
      const original = await bundle(root, originalPreset, 'original')
      const generatedImports: string[] = []
      if (!Array.isArray(preset.plugins)) throw new Error('Client preset plugins missing')
      const formatted = await bundle(root, {
        ...preset,
        plugins: [{
          name: 'fixture-observe-before-async-rewrite',
          renderChunk(code, chunk) {
            if (chunk.isEntry) generatedImports.push(code)
          },
        }, ...preset.plugins],
      }, 'formatted')

      // The compiler renders ordinary quoted imports before output minification.
      expect(generatedImports).toHaveLength(1)
      expect(generatedImports[0]).toContain('require("./client.lazy.js")')
      expect(Buffer.byteLength(formatted)).toBeLessThan(Buffer.byteLength(original))
      expect(formatted).not.toContain('Format fixture documentation:')
      expect(formatted).toContain('@license fixture-preserved-license')
      expect(formatted).toContain('require.async(')
      expect(formatted).not.toMatch(/\brequire\(["'`]\.\/client\./)
      const map = JSON.parse(await readFile(join(root, 'formatted/client.js.map'), 'utf8')) as {
        sources: string[]
        sourcesContent: string[]
        mappings: string
      }
      expect(map.sources.some(source => source.endsWith('/src/client/index.ts'))).toBe(true)
      expect(map.sourcesContent).toContain(ENTRY_SOURCE)
      expect(map.sources.some(source => source.includes('/lib/types/'))).toBe(false)
      expect(map.mappings).not.toBe('')

      for (const directory of ['original', 'formatted']) {
        const scripts = (await readdir(join(root, directory))).filter(file => file.endsWith('.js')).sort()
        expect(scripts).toEqual(['client.js', 'client.lazy.js'])
        for (const file of scripts) {
          expect(await readFile(join(root, directory, file), 'utf8')).not.toMatch(/\brequire\(["'`]\.\/client\./)
        }
        const requested: string[] = []
        const target: ClientModuleLoaderTarget = {
          mode: 'queue',
          pendingQueue: [],
          load(registration) { this.pendingQueue.push(registration) },
          create() { throw new Error('fixture constructs its module table directly') },
        }
        const realm = createContext({ window: { __ModuleLoader__: target } })
        const url = `plugins/??${PACKAGE_ID}/client.js&rev=fixture`
        const modules = new ClientModuleSystem({
          manifest: parseBootManifest({
            rev: 'fixture',
            entries: [{ id: PACKAGE_ID, url, rev: 'fixture' }],
            batches: [{ phase: 'application', url, rev: 'fixture', entries: [PACKAGE_ID] }],
          }),
          staticModules: {},
          registrationTarget: target,
          bootstrapModule: { id: '@fixture/bootstrap', exports: {} },
          async loadBundle(request) {
            requested.push(request)
            const file = request === url ? 'client.js' : new URL(request, 'https://fixture.invalid/').pathname.split('/').at(-1)!
            const source = await readFile(join(root, directory, file), 'utf8')
            runInContext(source, realm, { filename: file })
          },
        })
        const entry = await modules.import(PACKAGE_ID) as {
          names: string[]
          lazy: () => Promise<{ marker: string; names: string[] }>
        }
        expect([...entry.names]).toEqual(['NamedPlugin', 'NamedService', 'NamedArrow'])
        expect(requested).toEqual([url])
        const lazy = await entry.lazy()
        expect(lazy.marker).toBe('lazy-loaded')
        expect([...lazy.names]).toEqual(['LazyPlugin', 'LazyService', 'LazyArrow'])
        expect(requested).toEqual([url, `plugins/${PACKAGE_ID}/client.lazy.js?rev=fixture`])
        await entry.lazy()
        expect(requested).toHaveLength(2)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
