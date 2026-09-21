import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectTestHonesty } from './verify-test-honesty.ts'

describe('test honesty source rules', () => {
  it('accepts inline, preceding and region explanations without inspecting strings', () => {
    const source = [
      'const sample = "/* v8 ignore next */";',
      '// An operating-system failure cannot be scheduled through this API.',
      '/* v8 ignore next */',
      'const value = 1;',
      '/* v8 ignore start -- native-only error callback */',
      'void value;',
      '/* v8 ignore stop */',
    ].join('\n')
    expect(inspectTestHonesty('packages/a/b/src/index.ts', source)).toEqual([])
  })
  it('rejects missing reasons and a detached explanation', () => {
    expect(inspectTestHonesty('scripts/guard.ts', '// explanation\nconst a = 1;\n/* v8 ignore next */\nvoid a;'))
      .toEqual([expect.objectContaining({ rule: 'coverage-ignore', line: 3 })])
    expect(inspectTestHonesty('scripts/guard.ts', '/* v8 ignore start */\nconst a = 1;\n/* v8 ignore stop */'))
      .toHaveLength(1)
  })
  it('keeps conditional skips and requires a reference for unconditional skips, including aliases', () => {
    const path = 'scripts/guard.spec.ts'
    expect(inspectTestHonesty(path, 'describe.skipIf(process.platform !== "win32")("native", () => {});')).toEqual([])
    expect(inspectTestHonesty(path, 'const native = process.platform === "win32" ? describe : describe.skip; native("host", () => {});')).toEqual([])
    expect(inspectTestHonesty(path, 'it.skip.each([1, 2])("case", () => {});')).toHaveLength(1)
    expect(inspectTestHonesty(path, 'import * as v from "vitest"; v.test["skip"]("case", () => {});')).toHaveLength(1)
    expect(inspectTestHonesty(path, 'import { describe as suite } from "vitest"; suite.skip("legacy", () => {});'))
      .toEqual([expect.objectContaining({ rule: 'test-skip' })])
    expect(inspectTestHonesty(path, '// test-skip: awaiting the external endpoint; docs/testing.md\nit.skip("live", () => {});')).toEqual([])
  })
  // Two sequential children each own a 20-second startup deadline.
  it('executes the real checker against a private repository with valid and invalid source', { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'test-honesty-'))
    try {
      execFileSync('git', ['init', '--quiet', root])
      mkdirSync(join(root, 'scripts'))
      const path = join(root, 'scripts/probe.spec.ts')
      const run = (): SpawnSyncReturns<string> => spawnSync(process.execPath, [
        '--import', 'tsx/esm', resolve(import.meta.dirname, 'verify-test-honesty.ts'), '--root', root,
      ], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000 })
      writeFileSync(path, '// test-skip: external provider requirement; docs/testing.md\nit.skip("live", () => {});\n')
      const accepted = run()
      expect(accepted.error).toBeUndefined()
      expect(accepted.signal).toBeNull()
      expect(accepted.status, accepted.stderr).toBe(0)
      writeFileSync(path, 'it.skip("live", () => {});\n')
      const rejected = run()
      expect(rejected.error).toBeUndefined()
      expect(rejected.signal).toBeNull()
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('unconditional skip')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
