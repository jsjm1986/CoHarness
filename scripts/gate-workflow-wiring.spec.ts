import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { gatesForMode } from './run-gates.ts'

interface Step { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { needs?: string[] | string; if?: string; steps?: Step[] }
interface Workflow { jobs: Record<string, Job> }
const workflow = (name: string): Workflow => load(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow

describe('public gate and workflow wiring', () => {
  it('runs every hygiene leaf through the actual static or artifact consumer CI modes', () => {
    vi.stubEnv('npm_execpath', '/fixture/pnpm.cjs')
    try {
      const modes = ['ci-static', 'ci-consumers-scoped'] as const
      const ids = new Set(modes.flatMap(mode => gatesForMode(mode).map(gate => gate.id)))
      const hygiene = gatesForMode('hygiene').map(gate => gate.id)
      expect(hygiene.filter(id => !ids.has(id))).toEqual([])
      expect(gatesForMode('ci-static').map(gate => gate.id)).toContain('vendored-links')
      const scripts = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
      expect(scripts.scripts.hygiene).toBe('tsx scripts/run-gates.ts hygiene')
      expect(workflow('ci').jobs['node-24']!.steps!.some(step => step.run === 'pnpm run check:ci:static')).toBe(true)
      expect(workflow('ci').jobs['node-24-consumers']!.steps!.some(step => step.run === 'pnpm run check:ci:consumers:scoped')).toBe(true)
    } finally { vi.unstubAllEnvs() }
  })

  it('keeps full build as the sole Web writer and retains build-backed consumer ordering', () => {
    vi.stubEnv('npm_execpath', '/fixture/pnpm.cjs')
    try {
      for (const mode of ['check-all', 'ci-primary', 'ci-linux-primary', 'ci-consumers-scoped', 'node-compat'] as const) {
        const gates = gatesForMode(mode)
        expect(gates.filter(gate => gate.id === 'build:web'), mode).toEqual([])
        expect(new Set(gates.map(gate => gate.id)).size, mode).toBe(gates.length)
        for (const gate of gates) for (const dependency of [...gate.needs ?? [], ...gate.after ?? []]) {
          expect(gates.some(item => item.id === dependency), `${mode}/${gate.id}/${dependency}`).toBe(true)
        }
      }
    } finally { vi.unstubAllEnvs() }
  })

  it('blocks the aggregate on selected Android checks and executes pinned Ruff in Python CI', () => {
    const jobs = workflow('ci').jobs
    expect(jobs['all-checks-passed']!.needs).toContain('android-build')
    expect(jobs['all-checks-passed']!.needs).toContain('android-bridge')
    expect(jobs['all-checks-passed']!.steps![0]!.if).toContain('needs.android-bridge.result')
    expect(jobs['python-sdk']!.steps!.some(step => step.run?.includes('--locked --project python/sdk --group quality ruff check'))).toBe(true)
    expect(jobs['android-build']!.steps!.some(step => step.run === 'pnpm run check:android')).toBe(true)
    expect(jobs['android-bridge']!.steps!.some(step => step.with?.script === 'node scripts/check-android.ts --connected')).toBe(true)
    expect(jobs['android-bridge']!.steps!.some(step => step.with?.name === '${{ needs.android-build.outputs.apk_artifact }}')).toBe(true)
    expect(jobs['android-bridge']!.steps!.some(step => step.run?.includes('assemble'))).toBe(false)
  })

  it.each(['release', 'release-vendor', 'python-release', 'landlock-run-release'])(
    '%s validates evidence before registry writers without rebuilding', (name) => {
      const jobs = workflow(name).jobs
      for (const [id, job] of Object.entries(jobs).filter(([id]) => id === 'publish' || id.startsWith('publish-'))) {
        const steps = job.steps!
        const guard = steps.findIndex(step => step.run?.includes('release:prepare') && step.run.includes('--phase publish'))
        const publish = steps.findIndex(step => step.uses?.startsWith('pypa/gh-action-pypi-publish')
          || step.run?.includes('release:publish') || step.run?.includes('./scripts/publish-release.mjs'))
        expect(guard, `${name}/${id}`).toBeGreaterThanOrEqual(0)
        expect(publish, `${name}/${id}`).toBeGreaterThan(guard)
        expect(steps.some(step => step.run?.match(/(?:pnpm|npm)\s+(?:run\s+)?build/))).toBe(false)
      }
    },
  )
})
