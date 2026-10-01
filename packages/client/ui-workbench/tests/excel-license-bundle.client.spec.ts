/** Published spreadsheet chunks retain their bundled license notices and Worker source. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const bundlePath = join(packageRoot, 'lib/client.js')
const excelChunkPath = join(packageRoot, 'lib/client.excel.js')
const require = createRequire(import.meta.url)

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

describe('published spreadsheet licenses', () => {
  it.skipIf(!existsSync(bundlePath))('keeps bundled licenses in the packed lazy chunks', ({ task }) => {
    expect(existsSync(excelChunkPath)).toBe(true)
    const output = mkdtempSync(join(tmpdir(), 'dsh-workbench-pack-'))
    try {
      const packed = JSON.parse(runPnpm([
        'pack', '--json', '--pack-destination', output,
      ], packageRoot, task.timeout)) as { filename: string; files: { path: string }[] }
      for (const file of ['lib/client.js', 'lib/client.LazyExcelBody.js', 'lib/client.excel.js']) {
        expect(packed.files.map(entry => entry.path)).toContain(file)
      }
      const client = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.js'], packageRoot, task.timeout)
      const lazy = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.LazyExcelBody.js'], packageRoot, task.timeout)
      const excel = run('tar', ['-xOf', resolve(packageRoot, packed.filename), 'package/lib/client.excel.js'], packageRoot, task.timeout)
      expect([...client.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1]))
        .toEqual(expect.arrayContaining(['./client.pdf.js', './client.LazyExcelBody.js']))
      expect(client).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect([...lazy.matchAll(/require\.async\("(\.\/client[^"/]*\.js)"\)/gu)].map(match => match[1])).toEqual(['./client.excel.js'])
      expect(lazy).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(excel).not.toMatch(/\brequire\("\.\/client[^"/]*\.js"\)/u)
      expect(client).not.toContain('FortuneSheet')
      expect(excel).toContain('//! Bundled spreadsheet license notices')
      expect(excel).toContain('Copyright (c) 2022 Suzhou Ruilisi Technology Co., Ltd')
      expect(excel).toContain('Permission is hereby granted, free of charge')
      for (const dependency of ['xlsx', 'papaparse']) {
        const root = dirname(require.resolve(dependency === 'xlsx' ? dependency : `${dependency}/package.json`))
        const license = readFileSync(join(root, 'LICENSE'), 'utf8').trimEnd()
        expect(excel).toContain(license.split('\n').map(line => `// ${line}`).join('\n'))
      }
      let initialized = false
      runInNewContext(excel, { window: { __ModuleLoader__: { load: (registration: {
        factory: (resolve: (specifier: string) => unknown) => { ExcelBody: unknown }
      }) => {
        const loaded = registration.factory((specifier) => {
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
          if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom') return require(specifier)
          throw new Error(`Unexpected browser dependency: ${specifier}`)
        })
        expect(typeof loaded.ExcelBody).toBe('function')
        initialized = true
      } } } })
      expect(initialized).toBe(true)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
