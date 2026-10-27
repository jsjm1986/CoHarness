/**
 * Stylesheets enter client bundles through virtual modules, so the loader must
 * register their physical files as watch dependencies while keeping emitted
 * scopes independent of the checkout directory.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

function cssPlugin(
  name: 'dsh-css-modules-inline' | 'dsh-css-global-inline' | 'dsh-css-text-inline',
  packageId = '@deepseek-ai/dsh-client-test',
): CssPlugin {
  const configs = clientBundle(
    packageId,
    ['lib/types/index.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === name)
  if (plugin === undefined) throw new Error(`${name} missing from client config`)
  return plugin
}

async function compiledStylesheet(root: string, packageId: string, fileName: string, css: string) {
  const source = join(root, 'src')
  const stylesheet = join(source, fileName)
  await mkdir(join(stylesheet, '..'), { recursive: true })
  await writeFile(stylesheet, css)
  const plugin = cssPlugin('dsh-css-modules-inline', packageId)
  const virtualId = plugin.resolveId?.(`./${fileName}`, join(source, 'index.ts'))
  if (typeof virtualId !== 'string' || plugin.load === undefined) throw new Error('CSS Modules plugin hooks are incomplete')
  const watched: string[] = []
  const output = await plugin.load.call({ addWatchFile: (id) => { watched.push(id) } }, virtualId)
  if (typeof output !== 'string') throw new Error('CSS Modules compiler returned no source')
  const map = output.match(/export default (\{[^\n]+\});$/u)
  const serializedClasses = map?.[1]
  if (serializedClasses === undefined) throw new Error('CSS Modules compiler returned no class map')
  const classes = JSON.parse(serializedClasses) as { root?: string }
  if (typeof classes.root !== 'string') throw new Error('Fixture stylesheet has no root class')
  return { output, rootClass: classes.root, watched, stylesheet }
}

describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-watch-'))
    try {
      const stylesheet = join(root, 'Fixture.module.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      const plugin = cssPlugin('dsh-css-modules-inline')
      const virtualId = plugin.resolveId?.('./Fixture.module.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('CSS Modules plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keys the injector dedup tag by src-relative path so same-named files stay distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-tagid-'))
    try {
      const plugin = cssPlugin('dsh-css-modules-inline')
      const tagIds: string[] = []
      for (const dir of ['a', 'b']) {
        const dirPath = join(root, 'src', dir)
        await mkdir(dirPath, { recursive: true })
        const stylesheet = join(dirPath, 'Fixture.module.css')
        await writeFile(stylesheet, `.root { color: ${dir === 'a' ? 'red' : 'blue'}; }\n`)
        const importer = join(dirPath, 'index.ts')
        const virtualId = plugin.resolveId?.('./Fixture.module.css', importer)
        if (typeof virtualId !== 'string' || plugin.load === undefined) {
          throw new Error('CSS Modules plugin hooks are incomplete')
        }
        const output = await plugin.load.call({ addWatchFile: () => {} }, virtualId)
        tagIds.push(output?.match(/const tagId = "([^"]+)"/)?.[1] ?? '')
      }

      expect(tagIds[0]).not.toBe('')
      expect(tagIds[0]).not.toBe(tagIds[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('client bundle stylesheet identity', () => {
  it('emits identical CSS modules for equivalent source paths in independent build roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-roots-'))
    try {
      const [first, second] = await Promise.all(['checkout-a', 'checkout-b'].map(name =>
        compiledStylesheet(join(root, name), '@deepseek-ai/dsh-client-test', 'pdf/Fixture.module.css', '.root { color: red; }\n')))
      expect(first.output).toBe(second.output)
      expect(first.rootClass).toBe(second.rootClass)
      expect(first.watched).toEqual([first.stylesheet])
      expect(second.watched).toEqual([second.stylesheet])
      expect(first.stylesheet).not.toBe(second.stylesheet)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps package scopes and same-named source directories distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-scopes-'))
    try {
      const first = await compiledStylesheet(root, '@deepseek-ai/dsh-client-one', 'a/Fixture.module.css', '.root { color: red; }\n')
      const otherPackage = await compiledStylesheet(root, '@deepseek-ai/dsh-client-two', 'a/Fixture.module.css', '.root { color: red; }\n')
      const otherDirectory = await compiledStylesheet(root, '@deepseek-ai/dsh-client-one', 'b/Fixture.module.css', '.root { color: red; }\n')
      expect(first.rootClass).not.toBe(otherPackage.rootClass)
      expect(first.rootClass).not.toBe(otherDirectory.rootClass)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('retains source edits in emitted styles under the same logical filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-content-'))
    try {
      const first = await compiledStylesheet(root, '@deepseek-ai/dsh-client-test', 'Fixture.module.css', '.root { color: red; }\n')
      const second = await compiledStylesheet(root, '@deepseek-ai/dsh-client-test', 'Fixture.module.css', '.root { color: blue; }\n')
      expect(first.output).not.toBe(second.output)
      expect(first.output).toContain('color:red')
      expect(second.output).toContain('color:#00f')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('client bundle global CSS', () => {
  it('compiles a side-effect stylesheet into a watched style injector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-global-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = cssPlugin('dsh-css-global-inline')
      const virtualId = plugin.resolveId?.('./base.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('global CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
      expect(output).toContain('body{color:red}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compiles inline stylesheets as watched text without a module side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-inline-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = cssPlugin('dsh-css-text-inline')
      const virtualId = plugin.resolveId?.('./base.css?inline', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('inline CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('export default "body{color:red}"')
      expect(output).not.toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
