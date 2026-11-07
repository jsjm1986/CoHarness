import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const pdfChunkPath = join(packageRoot, 'lib/client.pdf.js')
const require = createRequire(import.meta.url)
const licenseNames = [
  'LICENSE',
  'cmaps/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS',
] as const
const resourceGroups = [
  { file: 'client.cmaps.js', field: 'cMaps', dir: 'cmaps' },
  { file: 'client.fonts.js', field: 'fonts', dir: 'standard_fonts' },
  { file: 'client.wasm.js', field: 'wasm', dir: 'wasm' },
] as const
type ResourceModule = Record<string, Readonly<Record<string, string>>>

function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function runPnpm(args: string[], cwd: string, timeout: number): string {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    if (process.platform === 'win32') throw new Error('npm_execpath is required to run pnpm on Windows')
    return run('pnpm', args, cwd, timeout)
  }
  return /\.[cm]?js$/iu.test(entrypoint)
    ? run(process.execPath, [entrypoint, ...args], cwd, timeout)
    : run(entrypoint, args, cwd, timeout)
}

describe('published PDF.js licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps every bundled license in the packed PDF chunk', ({ task }) => {
    expect(existsSync(pdfChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-document-preview-pack-'))
    try {
      const packed = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] }
      expect(packed.files.map(file => file.path)).toContain('lib/client.js')
      expect(packed.files.map(file => file.path)).toContain('lib/client.pdf.js')
      for (const group of resourceGroups) expect(packed.files.map(file => file.path)).toContain(`lib/${group.file}`)
      expect(packed.files.map(file => file.path)).toContain('lib/client.frontmatter-fields.js')
      expect(packed.files.some(file => file.path.endsWith('pdfjs-NOTICES.txt'))).toBe(false)

      const client = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.js'], packageRoot, task.timeout)
      const pdf = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.pdf.js'], packageRoot, task.timeout)
      expect([...client.matchAll(/require\.async\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2]).sort())
        .toEqual(['./client.excel.js', './client.frontmatter-fields.js', './client.pdf.js'])
      expect(client).not.toMatch(/\brequire\((["'`])\.\/client[^"'`/]*\.js\1\)/u)
      expect([...pdf.matchAll(/require\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2]))
        .toEqual([])
      expect([...pdf.matchAll(/require\.async\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2]).sort())
        .toEqual(resourceGroups.map(group => `./${group.file}`).sort())
      expect(client).not.toContain('//! Bundled PDF.js license notices')
      expect(client).not.toContain('/pdfjs-dist/')
      expect(pdf).toContain('//! Bundled PDF.js license notices')
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
      for (const name of licenseNames) {
        const source = readFileSync(join(pdfRoot, name), 'utf8').trimEnd()
        const commented = [`//! ${name}`, '//! ', ...source.split('\n').map(line => `//! ${line}`)].join('\n')
        expect(pdf, `${name} must be visible in package/lib/client.pdf.js`).toContain(commented)
      }
      for (const group of resourceGroups) {
        const source = run('tar', ['-xOf', resolve(packageRoot, packed.filename), `package/lib/${group.file}`], packageRoot, task.timeout)
        expect(source).not.toMatch(/\brequire(?:\.async)?\(/u)
        const registrations: Array<{ factory: (require: (specifier: string) => never) => ResourceModule }> = []
        runInNewContext(source, { window: { __ModuleLoader__: {
          load(value: (typeof registrations)[number]) { registrations.push(value) },
        } } })
        expect(registrations).toHaveLength(1)
        const registered = registrations[0]!
        const data = registered.factory((specifier) => { throw new Error(`Data-only chunk imported ${specifier}`) })[group.field]!
        const names = readdirSync(join(pdfRoot, group.dir)).filter(name => !name.startsWith('LICENSE')).sort()
        expect(Object.keys(data).sort()).toEqual(names)
        for (const name of names) {
          const bytes = readFileSync(join(pdfRoot, group.dir, name))
          expect(Buffer.from(data[name]!, 'base64').equals(bytes), `${group.dir}/${name} bytes`).toBe(true)
          expect(pdf.includes(bytes.toString('base64')), `${group.dir}/${name} must stay outside the core viewer`).toBe(false)
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
