import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COVERAGE_LINT_PROBE, isPureTypeSource, selectCoverageSources, staleCoverageExclusions } from './coverage-selection.ts'
import { resolveCoveragePolicy } from './coverage-policy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('coverage measurement selection', () => {
  it('measures execution admission on every platform with either PowerShell capability', () => {
    const sources = [
      'packages/interaction/commands/src/index.ts', 'packages/interaction/user-questions/src/index.ts',
      'packages/subagent/subagent/src/index.ts',
    ]
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const pwshAvailable of [false, true]) {
        expect(selectCoverageSources(sources, resolveCoveragePolicy(platform, pwshAvailable))).toEqual(sources)
      }
    }
  })

  it('measures project participant parsing on every platform with either PowerShell capability', () => {
    const sources = ['packages/context/collaboration-context/src/participant.ts']
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const pwshAvailable of [false, true]) {
        expect(selectCoverageSources(sources, resolveCoveragePolicy(platform, pwshAvailable))).toEqual(sources)
      }
    }
  })

  it('measures SSH cleanup on supported POSIX hosts and excludes unsupported Windows carriers', () => {
    const sources = ['packages/ssh/ssh/src/helper-processes.ts', 'packages/ssh/ssh/src/helper.ts']
    for (const platform of ['linux', 'darwin'] as const) {
      expect(selectCoverageSources(sources, resolveCoveragePolicy(platform, false))).toEqual(sources)
    }
    expect(selectCoverageSources(sources, resolveCoveragePolicy('win32', false))).toEqual([])
  })

  it('gates activity requests and ownership while retaining its view and store exemptions', () => {
    const sources = [
      'packages/client/ui-project-activity/src/client/index.ts',
      'packages/client/ui-project-activity/src/client/feed.ts',
      'packages/client/ui-project-activity/src/client/store.ts',
      'packages/client/ui-project-activity/src/client/ActivityBody.tsx',
    ]
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(selectCoverageSources(sources, resolveCoveragePolicy(platform, false))).toEqual(sources.slice(0, 2).sort())
    }
  })

  it('measures private Session presentation ownership and chat persistence outside GUI composition debt', () => {
    const sources = [
      'packages/client/runtime/src/client/session-persistence.ts',
      'packages/client/ui-conversation/src/client/stores.ts',
      'packages/client/ui-conversation/src/client/apply.ts',
      'packages/client/ui-conversation/src/client/ConversationRoot.tsx',
    ]
    expect(selectCoverageSources(sources, resolveCoveragePolicy('linux', false))).toEqual(sources.slice(0, 2))
  })
  it('keeps native PowerShell measured on Windows while excluding unsupported POSIX providers', () => {
    const pwsh = 'packages/shell/pwsh-local/src/index.ts'
    const bash = 'packages/shell/bash-local/src/index.ts'
    expect(selectCoverageSources([pwsh, bash], resolveCoveragePolicy('win32', true))).toEqual([pwsh])
    expect(selectCoverageSources([pwsh, bash], resolveCoveragePolicy('linux', false))).toEqual([bash])
  })
  it('derives erased declarations while keeping side-effect imports, enums and initializers measured', () => {
    for (const source of [
      'import type { X } from "x"; export interface Y { value: X };',
      'import { type X } from "x"; export type { X };',
      'declare const host: string; export {};',
      'export type * from "x";',
      'import {} from "setup";',
      'export {} from "setup";',
      'interface Value {} export { Value };',
      'import { Value } from "x"; export interface Item { value: Value };',
    ]) expect(isPureTypeSource('types.ts', source), source).toBe(true)
    for (const source of ['import "setup";', 'export enum E { A }', 'export const value = 1', 'function unused() {}']) {
      expect(isPureTypeSource('index.ts', source), source).toBe(false)
    }
  })
  const include = ['packages/*/*/src/**/*.{ts,tsx}']
  it('shares exclusions for pure types, separate entries, and recorded debt', () => {
    const exclude = ['**/types.ts', '**/worker.ts', '**/debt.ts']
    expect(selectCoverageSources([
      'packages/core/a/src/types.ts', 'packages/core/a/src/worker.ts',
      'packages/core/a/src/debt.ts', 'packages/core/a/src/index.d.ts',
      'packages/core/a/src/index.ts', 'packages/core/a/src/View.tsx',
      'packages\\core\\a\\src\\index.ts', 'scripts/gate.ts',
    ], { include, exclude })).toEqual(['packages/core/a/src/View.tsx', 'packages/core/a/src/index.ts'])
  })
  it('keeps runtime branches without adding a new filename exemption', () => {
    expect(selectCoverageSources(['packages/core/a/src/guard.ts'], { include, exclude: [] }))
      .toEqual(['packages/core/a/src/guard.ts'])
  })
  it('rejects dead literals and globs but allows the temporary lint residue pattern', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-selection-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/core/a/src'), { recursive: true })
    writeFileSync(join(root, 'packages/core/a/src/index.ts'), 'export const value = 1\n')
    expect(staleCoverageExclusions(root, {
      include, exclude: ['packages/core/a/src/index.ts', '**/retired.ts', 'packages/retired/*/src/**', COVERAGE_LINT_PROBE],
    })).toEqual(['**/retired.ts', 'packages/retired/*/src/**'])
    expect(() => staleCoverageExclusions(root, { include: ['missing/**/*.ts'], exclude: [] })).toThrow('corpus is empty')
  })
})
