import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWebSnapshotPlan, type WebSnapshotPlan } from './run-web-snapshots.ts'
import { loadWebTestPolicy, WEB_TESTS_ROOT } from './web-test-policy.ts'

const root = resolve(import.meta.dirname, '..')
const policy = loadWebTestPolicy(root)
const exact = [...policy.smokeScenarios, 'goal-bar.e2e.ts'].sort()
const expectedSerial = [
  'hmr-live.e2e.ts',
  'cordis-tool-round.e2e.ts',
  'agent-preset-selection.e2e.ts',
  'composer-model-mobile.e2e.ts',
  'live-interactions.e2e.ts',
  'lossless-history-wire.e2e.ts',
  'queue-actions.e2e.ts',
  'workflow-run.e2e.ts',
].map(file => `${WEB_TESTS_ROOT}${file}`)

describe('browser execution plan', () => {
  it('keeps all eight independent owners and every other scenario in the full pool', () => {
    const plan = createWebSnapshotPlan(root, [], {})
    expect(plan.mode).toBe('full')
    expect(plan.serial).toEqual(expectedSerial)
    expect([...plan.serial, ...plan.pool].sort()).toEqual(Object.keys(policy.scenarios).map(file => `${WEB_TESTS_ROOT}${file}`).sort())
    expect(new Set([...plan.serial, ...plan.pool]).size).toBe(plan.scenarios.length)
  })

  it('keeps exact selections out of unrelated scenarios and preserves serial ownership', () => {
    const plan = createWebSnapshotPlan(root, ['--focused', '--scenarios', JSON.stringify([...exact, 'queue-actions.e2e.ts'])], {})
    expect(plan.mode).toBe('scenarios')
    expect(plan.serial).toEqual([`${WEB_TESTS_ROOT}queue-actions.e2e.ts`])
    expect(plan.pool).toEqual(exact.map(file => `${WEB_TESTS_ROOT}${file}`))
    expect(plan.scenarios).not.toContain('workbench.e2e.ts')
    expect(plan.groups).toEqual([])
  })

  it('retains business-group selection with its shared smokes', () => {
    const plan = createWebSnapshotPlan(root, ['--focused', '--groups', 'conversation'], {})
    expect(plan.mode).toBe('groups')
    expect(plan.scenarios).toContain('goal-bar.e2e.ts')
    expect(plan.scenarios).not.toContain('workbench.e2e.ts')
    for (const smoke of policy.smokeScenarios) expect(plan.scenarios).toContain(smoke)
  })

  it('lets argv override its own environment selection without accepting mixed selectors', () => {
    const plan = createWebSnapshotPlan(root, ['--focused', '--scenarios', JSON.stringify(exact)], {
      DSH_WEB_SCENARIOS: JSON.stringify([...policy.smokeScenarios, 'workbench.e2e.ts']),
    })
    expect(plan.scenarios).toEqual(exact)
    expect(() => createWebSnapshotPlan(root, ['--focused', '--scenarios', JSON.stringify(exact)], {
      DSH_WEB_GROUPS: 'conversation',
    })).toThrow(/mutually exclusive/)
  })

  it('rejects missing and unregistered disk entries before a focused or full run', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'web-run-plan-'))
    const write = (file: string, text = ''): void => {
      const path = join(fixture, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    try {
      write('scripts/web-test-policy.json', JSON.stringify(policy))
      for (const file of Object.keys(policy.scenarios)) write(`${WEB_TESTS_ROOT}${file}`)
      expect(createWebSnapshotPlan(fixture, ['--focused', '--scenarios', JSON.stringify(exact)], {}).scenarios).toEqual(exact)
      rmSync(join(fixture, WEB_TESTS_ROOT, 'goal-bar.e2e.ts'))
      expect(() => createWebSnapshotPlan(fixture, ['--focused', '--scenarios', JSON.stringify(exact)], {})).toThrow(/missing=.*goal-bar/)
      write(`${WEB_TESTS_ROOT}goal-bar.e2e.ts`)
      write(`${WEB_TESTS_ROOT}unregistered.e2e.ts`)
      expect(() => createWebSnapshotPlan(fixture, [], {})).toThrow(/unregistered=.*unregistered/)
      rmSync(join(fixture, WEB_TESTS_ROOT, 'unregistered.e2e.ts'))
      rmSync(join(fixture, WEB_TESTS_ROOT, 'hmr-live.e2e.ts'))
      const scenarios = Object.fromEntries(Object.entries(policy.scenarios).filter(([file]) => file !== 'hmr-live.e2e.ts'))
      write('scripts/web-test-policy.json', JSON.stringify({ ...policy, scenarios }))
      expect(() => createWebSnapshotPlan(fixture, [], {})).toThrow(/serial owners are missing/)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

/** Run the real argument and inventory checks without starting browsers. */
function cli(args: readonly string[], additions: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', join(root, 'scripts/run-web-snapshots.ts'), ...args, '--print-plan'], {
    cwd: root,
    env: { ...process.env, DSH_WEB_GROUPS: '', DSH_WEB_SCENARIOS: '', DSH_WEB_SNAPSHOT_WORKERS: '2', ...additions },
    encoding: 'utf8',
    timeout: 20_000,
  })
}

describe('browser runner CLI', () => {
  it('prints the full inventory without requiring pnpm or starting a browser', { timeout: 30_000 }, () => {
    const result = cli([], { npm_execpath: undefined })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const plan = JSON.parse(result.stdout) as WebSnapshotPlan
    expect(plan.mode).toBe('full')
    expect(plan.serial).toEqual(expectedSerial)
    expect(plan.scenarios).toEqual(Object.keys(policy.scenarios).sort())
  })

  // A child owns its 20-second startup deadline; the case leaves room for exit observation under CI contention.
  it.each(['argv', 'environment'])('accepts an exact selection through %s without running browsers', { timeout: 30_000 }, (source) => {
    const result = source === 'argv'
      ? cli(['--focused', '--scenarios', JSON.stringify(exact)])
      : cli(['--focused'], { DSH_WEB_SCENARIOS: JSON.stringify(exact) })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const plan = JSON.parse(result.stdout) as WebSnapshotPlan
    expect(plan).toMatchObject({ mode: 'scenarios', scenarios: exact, serial: [], workers: 2 })
    expect(plan.pool).toEqual(exact.map(file => `${WEB_TESTS_ROOT}${file}`))
  })

  it.each([
    { name: 'full argv narrowing', args: ['--scenarios', JSON.stringify(exact)], env: {}, error: /full inventory cannot be narrowed/ },
    { name: 'full environment narrowing', args: [], env: { DSH_WEB_SCENARIOS: JSON.stringify(exact) }, error: /full inventory cannot be narrowed/ },
    { name: 'mixed sources', args: ['--focused', '--groups', 'conversation'], env: { DSH_WEB_SCENARIOS: JSON.stringify(exact) }, error: /mutually exclusive/ },
    { name: 'empty exact list', args: ['--focused', '--scenarios', '[]'], env: {}, error: /non-empty/ },
    { name: 'invalid JSON', args: ['--focused', '--scenarios', 'goal-bar.e2e.ts'], env: {}, error: /JSON array/ },
    { name: 'unknown entry', args: ['--focused', '--scenarios', '["missing.e2e.ts"]'], env: {}, error: /unknown scenario/ },
    { name: 'omitted smoke', args: ['--focused', '--scenarios', '["goal-bar.e2e.ts"]'], env: {}, error: /omits required smoke/ },
    { name: 'duplicate entries', args: ['--focused', '--scenarios', JSON.stringify([...exact, exact[0]])], env: {}, error: /duplicates/ },
    { name: 'missing option value', args: ['--focused', '--scenarios'], env: {}, error: /requires a JSON/ },
  ])('rejects $name through the real CLI', { timeout: 30_000 }, ({ args, env, error }) => {
    const result = cli(args, env)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(error)
  })
})
