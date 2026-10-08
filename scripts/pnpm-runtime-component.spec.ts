/** Contract for the bundled pnpm JavaScript distribution the runtime payloads ship. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const requireRoot = createRequire(join(root, 'package.json'))

function manifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
}

const pin = (manifest('package.json')['packageManager'] as string).split('@')[1] ?? ''
const resolvedManifestPath = requireRoot.resolve('pnpm')
const resolvedManifest = JSON.parse(readFileSync(resolvedManifestPath, 'utf8')) as Record<string, unknown>

describe('pnpm runtime component', () => {
  it('pins one pnpm version across the package manager fields and declared dependencies', () => {
    const declared = new Map<string, unknown>([
      ['root packageManager', manifest('package.json').packageManager],
      ['native/system packageManager', manifest('native/system/package.json').packageManager],
      ['root devDependencies.pnpm', (manifest('package.json').devDependencies as Record<string, unknown>).pnpm],
      ['plugin-manager devDependencies.pnpm', (manifest('packages/boot/plugin-manager/package.json').devDependencies as Record<string, unknown>).pnpm],
    ])
    expect(declared.get('root packageManager')).toBe(`pnpm@${pin}`)
    expect(declared.get('native/system packageManager')).toBe(`pnpm@${pin}`)
    expect(declared.get('root devDependencies.pnpm')).toBe(pin)
    expect(declared.get('plugin-manager devDependencies.pnpm')).toBe(pin)
    // The resolved payload must be the declared pin, not a range drift.
    expect(resolvedManifest.version).toBe(pin)
  })

  it('resolves package metadata and ships a script-free JavaScript entrypoint', () => {
    expect(resolvedManifestPath).toMatch(/pnpm[/\\]package\.json$/)
    expect((resolvedManifest.exports as Record<string, unknown>)['.']).toBe('./package.json')
    const scripts = (resolvedManifest.scripts ?? {}) as Record<string, unknown>
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(scripts[hook], `no ${hook} hook may run at payload install`).toBeUndefined()
    }
    const bin = resolve(resolvedManifestPath, '..', 'bin/pnpm.mjs')
    expect(existsSync(bin), 'bin/pnpm.mjs must ship the JavaScript entrypoint').toBe(true)
    const spawned = spawnSync(process.execPath, [bin, '--pm-on-fail=ignore', '--version'],
      { encoding: 'utf8', timeout: 20_000 })
    expect(spawned.error).toBeUndefined()
    expect(spawned.signal).toBeNull()
    expect(spawned.status, spawned.stderr).toBe(0)
    expect(spawned.stdout.trim()).toBe(pin)
  })

  it('runs the relocated payload copy without system pnpm or PATH', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pnpm-runtime-payload-'))
    onTestFinished(() => { rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) })
    const target = join(fixture, 'dependencies', 'pnpm')
    cpSync(resolve(resolvedManifestPath, '..'), target, { recursive: true, dereference: true })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
    const spawned = spawnSync(process.execPath, [join(target, 'bin/pnpm.mjs'), '--pm-on-fail=ignore', '--version'],
      { encoding: 'utf8', timeout: 20_000, env })
    expect(spawned.error).toBeUndefined()
    expect(spawned.signal).toBeNull()
    expect(spawned.status, spawned.stderr).toBe(0)
    expect(spawned.stdout.trim()).toBe(pin)
  }, 60_000)

  it('keeps the Wine lane on a single immutable install without affinity or rename retries', () => {
    const script = readFileSync(join(root, 'scripts/wine-windows-gates.sh'), 'utf8')
    expect(script).not.toContain('taskset')
    expect(script).not.toContain('ERR_PNPM_ENOENT')
    const installs = script.match(/pnpm install --frozen-lockfile --ignore-scripts/g) ?? []
    expect(installs).toHaveLength(1)
    expect(script).toContain('install.log')
    expect(script).toContain('tail -40 "$scratch/logs/install.log"')
  })
})
