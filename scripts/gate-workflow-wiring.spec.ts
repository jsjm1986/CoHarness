import { existsSync, readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { gatesForMode } from './run-gates.ts'

interface Step { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { needs?: string[] | string; if?: string; steps?: Step[]; env?: Record<string, string>; strategy?: unknown }
interface Workflow { jobs: Record<string, Job>; env?: Record<string, string> }
const workflow = (name: string): Workflow => load(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow

describe('public gate and workflow wiring', () => {
  it('resolves each Sandbox native-build command to an existing workspace script', () => {
    const steps = workflow('sandbox').jobs['sandbox-e2e']!.steps!
    const commands = steps.flatMap(step => [...step.run?.matchAll(/pnpm --dir (\S+) run (\S+)/g) ?? []])
    expect(commands.length).toBeGreaterThan(0)
    for (const [, directory, script] of commands) {
      const path = `${directory}/package.json`
      expect(existsSync(path), path).toBe(true)
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { scripts: Record<string, string> }
      expect(manifest.scripts[script!], `${directory}/${script}`).toBeTruthy()
    }
  })

  it('names evidence within each producer job and distinguishes matrix legs and retries', () => {
    const ci = workflow('ci')
    expect(Object.values(ci.env ?? {}).some(value => value.includes('strategy.') || value.includes('github.job'))).toBe(false)
    const names = new Set<string>()
    for (const [id, job] of Object.entries(ci.jobs)) {
      if (!job.steps?.some(step => step.uses === './.github/actions/gate-evidence')) continue
      const name = job.env?.DSH_EVIDENCE_ARTIFACT_NAME
      expect(name, id).toContain('${{ github.run_attempt }}')
      expect(names.has(name!), id).toBe(false)
      names.add(name!)
      if (job.strategy !== undefined) expect(name, id).toContain('${{ strategy.job-index }}')
    }
  })

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

  it('keeps Android manual-only and executes pinned Ruff in required Python CI', () => {
    const jobs = workflow('ci').jobs
    expect(jobs['all-checks-passed']!.needs).not.toContain('android-build')
    expect(jobs['all-checks-passed']!.needs).not.toContain('android-bridge')
    expect(jobs['all-checks-passed']!.steps![0]!.if).not.toContain('needs.android-bridge.result')
    for (const id of ['android-build', 'android-bridge']) {
      expect(jobs[id]!.if).toBe("github.event_name == 'workflow_dispatch' && inputs.suite == 'android-audit'")
    }
    expect(jobs['python-sdk']!.steps!.some(step => step.run?.includes('--locked --project python/sdk --group quality ruff check'))).toBe(true)
    expect(jobs['android-build']!.steps!.some(step => step.run === 'pnpm run check:android')).toBe(true)
    expect(jobs['android-build']!.steps!.find(step => step.uses?.startsWith('android-actions/setup-android@'))?.with?.packages).toBe('platform-tools')
    expect(jobs['android-bridge']!.steps!.some(step => step.with?.script === 'node scripts/check-android.ts --connected')).toBe(true)
    expect(jobs['android-bridge']!.steps!.some(step => step.with?.name === '${{ needs.android-build.outputs.apk_artifact }}')).toBe(true)
    expect(jobs['android-bridge']!.steps!.some(step => step.run?.includes('assemble'))).toBe(false)
  })

  it('prepares a functioning kernel sandbox before source compatibility smokes', () => {
    const steps = workflow('ci').jobs['node-compat']!.steps!
    const prepare = steps.findIndex(step => step.run === 'bash scripts/prepare-ci-bubblewrap.sh')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(steps.findIndex(step => step.run === 'pnpm run check:node-compat')).toBeGreaterThan(prepare)
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
