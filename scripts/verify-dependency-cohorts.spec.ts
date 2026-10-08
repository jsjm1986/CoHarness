/** Lockfile cohort checks for directly declared Vitest family members. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { collectDependencyCohortViolations } from './verify-dependency-cohorts.ts'

const script = resolve(import.meta.dirname, 'verify-dependency-cohorts.ts')

function fixture(
  rootVitest: string | Record<string, unknown>,
  importers: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-cohorts-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const devDependencies = typeof rootVitest === 'string'
    ? { vitest: { specifier: `^${rootVitest}`, version: rootVitest } }
    : rootVitest
  const lock = {
    lockfileVersion: '9.0',
    importers: { '.': { devDependencies }, ...importers },
  }
  writeFileSync(join(dir, 'pnpm-lock.yaml'), dumpYaml(lock))
  return dir
}

function bare(lock: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-cohorts-shape-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'pnpm-lock.yaml'), dumpYaml(lock))
  return dir
}

describe('collectDependencyCohortViolations', () => {
  it('accepts coherent Vitest families on either major with differing peer suffixes', () => {
    expect(collectDependencyCohortViolations(fixture('4.1.8', {
      'packages/test-support/remote-mock': { dependencies: { '@vitest/spy': { version: '4.1.8' } } },
    }))).toEqual([])
    expect(collectDependencyCohortViolations(fixture('5.0.0', {
      'packages/test-support/remote-mock': { dependencies: { '@vitest/spy': { version: '5.0.0(@types/node@25.8.1)' } } },
      'tools/probe': { optionalDependencies: { vitest: { version: '5.0.0' } } },
    }))).toEqual([])
  })

  it('rejects a direct Vitest member resolved on a different version', () => {
    const errors = collectDependencyCohortViolations(fixture('4.1.8', {
      'packages/test-support/remote-mock': { dependencies: { '@vitest/spy': { version: '5.0.0' } } },
    }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('packages/test-support/remote-mock')
    expect(errors[0]).toContain('5.0.0')
    expect(errors[0]).toContain('4.1.8')
  })

  it('rejects a vitest runner mismatch, not only family helpers', () => {
    expect(collectDependencyCohortViolations(fixture('4.1.8', {
      'gateway': { devDependencies: { vitest: { version: '5.0.0' } } },
    }))).toHaveLength(1)
  })

  it('rejects a patch mismatch on a Vitest family member', () => {
    expect(collectDependencyCohortViolations(fixture('4.1.8', {
      'gateway': { devDependencies: { '@vitest/coverage-v8': { version: '4.1.9' } } },
    }))).toHaveLength(1)
  })

  it('checks every importer and every declared dependency section', () => {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const errors = collectDependencyCohortViolations(fixture('4.1.8', {
        'tools/probe': { [section]: { '@vitest/mocker': { version: '5.0.0' } } },
      }))
      expect(errors, section).toHaveLength(1)
      expect(errors[0]).toContain(`tools/probe ${section}`)
    }
  })

  it('ignores packages outside the Vitest family', () => {
    expect(collectDependencyCohortViolations(fixture('4.1.8', {
      'packages/util/timeout': {
        dependencies: { '@vitest-other/x': { version: '9.9.9' }, 'vitest-extra': { version: '9.9.9' } },
      },
    }))).toEqual([])
  })

  it('fails loudly on missing or uninterpretable lockfile records', () => {
    const missing = mkdtempSync(join(tmpdir(), 'dependency-cohorts-empty-'))
    onTestFinished(() => { rmSync(missing, { recursive: true, force: true }) })
    expect(() => collectDependencyCohortViolations(missing)).toThrow()
    expect(() => collectDependencyCohortViolations(bare({ lockfileVersion: '9.0' }))).toThrow('importers')
    expect(() => collectDependencyCohortViolations(bare({ lockfileVersion: '9.0', importers: [] }))).toThrow('importers')
    expect(() => collectDependencyCohortViolations(bare({
      importers: { 'packages/x': {} },
    }))).toThrow('importer .')
    expect(() => collectDependencyCohortViolations(bare({
      importers: { '.': { dependencies: {} } },
    }))).toThrow('devDependencies')
    expect(() => collectDependencyCohortViolations(bare({
      importers: { '.': { devDependencies: { tsx: { version: '4.23.12' } } } },
    }))).toThrow('devDependencies.vitest')
  })

  it('rejects malformed importers, sections, entries and non-registry versions', () => {
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': 'not-an-object',
    }))).toThrow('importer tools/probe')
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': { devDependencies: ['vitest'] },
    }))).toThrow('devDependencies')
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': { devDependencies: { vitest: 'not-an-object' } },
    }))).toThrow('devDependencies.vitest must be an object')
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': { devDependencies: { vitest: { specifier: '^4.1.8' } } },
    }))).toThrow('version')
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': { devDependencies: { vitest: { version: 418 } } },
    }))).toThrow('version')
    expect(() => collectDependencyCohortViolations(fixture('4.1.8', {
      'tools/probe': { devDependencies: { vitest: { version: 'link:../vitest' } } },
    }))).toThrow('version')
  })

  it('admits a coherent fixture and rejects a mismatch through the CLI', () => {
    const coherent = fixture('4.1.8', {
      'tools/probe': { devDependencies: { '@vitest/spy': { version: '4.1.8' } } },
    })
    const accepted = spawnSync(process.execPath, ['--import', 'tsx/esm', script, coherent], { encoding: 'utf8' })
    expect(accepted.error).toBeUndefined()
    expect(accepted.signal).toBeNull()
    expect(accepted.status, accepted.stderr).toBe(0)
    const drifted = fixture('4.1.8', {
      'tools/probe': { devDependencies: { '@vitest/spy': { version: '5.0.0' } } },
    })
    const rejected = spawnSync(process.execPath, ['--import', 'tsx/esm', script, drifted], { encoding: 'utf8' })
    expect(rejected.error).toBeUndefined()
    expect(rejected.signal).toBeNull()
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('tools/probe')
  })
})
