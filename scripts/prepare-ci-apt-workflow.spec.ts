/** Structural acceptance for hosted-APT preparation wiring: every material consumer is enumerated, not sampled. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '..')
const PREPARE = './.github/actions/prepare-ci-apt'

type Step = Record<string, unknown>
type Workflow = Record<string, unknown>

function load(path: string): Workflow {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrepareStep(step: Step): boolean {
  return step.uses === PREPARE
}

const norm = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : undefined

/** Every step whose run block performs an APT transaction or a hosted package provisioning. */
function aptConsumers(workflow: Workflow): Array<{ job: string; index: number; step: Step; steps: Step[] }> {
  if (!isRecord(workflow.jobs)) throw new TypeError('workflow must define jobs')
  const out: Array<{ job: string; index: number; step: Step; steps: Step[] }> = []
  for (const [job, value] of Object.entries(workflow.jobs)) {
    if (!isRecord(value) || !Array.isArray(value.steps)) continue
    const steps = value.steps as Step[]
    steps.forEach((step, index) => {
      if (!isRecord(step)) return
      const run = typeof step.run === 'string' ? step.run : ''
      if (/\b(?:apt-get|apt)\b/.test(run) || /install --with-deps/.test(run)) out.push({ job, index, step, steps })
    })
  }
  return out
}

/** Asserts the complete APT/provisioning inventory and its per-consumer preparation, condition, and budget. */
function verifyConsumers(workflow: Workflow, expectedCount: number): void {
  const consumers = aptConsumers(workflow)
  expect(consumers.length).toBe(expectedCount)
  for (const { index, step, steps } of consumers) {
    expect(step['timeout-minutes'], `${String(step.name)} must carry the 5m provisioning budget`).toBe(5)
    const prior = steps[index - 1]
    expect(prior !== undefined && isPrepareStep(prior), `preparation must run immediately before ${String(step.name)}`).toBe(true)
    expect(norm(prior?.if), `preparation condition must match ${String(step.name)}`).toBe(norm(step.if))
  }
}

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('prepare-ci-apt workflow wiring', () => {
  it('prepares every ci.yml APT or hosted provisioning consumer under its own condition', () => {
    const workflow = load('.github/workflows/ci.yml')
    verifyConsumers(workflow, 5)
    const consumers = aptConsumers(workflow)
    const playwright = consumers.filter(({ step }) => typeof step.run === 'string' && step.run.includes('install --with-deps'))
    expect(playwright.length).toBe(4)
    const wine = consumers.filter(({ step }) => step.name === 'Install Wine')
    expect(wine.length).toBe(1)
    const wineRun = String(wine[0]!.step.run)
    expect(wineRun).toContain('dpkg -i "$HOME"/wine-debs/*.deb')
    expect(wineRun).toContain('apt-get install -y --no-install-recommends --download-only wine')
    // The persistent failover VM keeps its own image provisioning and stays APT-free.
    const failover = consumers.filter(({ step }) => step.name === 'Install Playwright Chromium on the failover VM')
    expect(failover.length).toBe(0)
    const webConditional = playwright.find(({ step }) => String(step.run).includes('webkit'))!
    expect(norm(webConditional.step.if)).toBe(
      "(needs.pr-scope.outputs.snapshot_mode == 'focused' || needs.pr-scope.outputs.snapshot_mode == 'full') && (vars.DSH_CI_FAILOVER_LINUX != 'selfhosted' || github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.login == 'dependabot[bot]')",
    )
    const webJob = isRecord(workflow.jobs) ? workflow.jobs['web-verification'] : undefined
    const vmSteps = isRecord(webJob) && Array.isArray(webJob.steps) ? (webJob.steps as Step[]).filter(isRecord) : []
    const vm = vmSteps.find(step => step.name === 'Install Playwright Chromium on the failover VM')
    expect(vm?.run).toBe('pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install chromium webkit')
    expect(String(vm?.if)).toContain('DSH_CI_FAILOVER_LINUX')
  })

  it('checks out and prepares only on the ci-master Wine cache miss', () => {
    const workflow = load('.github/workflows/ci-master.yml')
    verifyConsumers(workflow, 1)
    const cacheJob = isRecord(workflow.jobs) ? workflow.jobs['wine-apt-cache'] : undefined
    const steps = isRecord(cacheJob) && Array.isArray(cacheJob.steps) ? (cacheJob.steps as Step[]).filter(isRecord) : []
    const download = steps.findIndex(step => step.name === 'Download the Wine dependency closure')
    expect(download).toBeGreaterThan(1)
    expect(steps[download]!.if).toBe("steps.wine-cache.outputs.cache-hit != 'true'")
    const prepare = steps[download - 1]
    const checkout = steps[download - 2]
    expect(prepare?.uses).toBe(PREPARE)
    expect(prepare?.if).toBe("steps.wine-cache.outputs.cache-hit != 'true'")
    expect(checkout?.uses).toBe('actions/checkout@v7')
    expect(checkout?.if).toBe("steps.wine-cache.outputs.cache-hit != 'true'")
    expect((checkout?.with as Record<string, unknown> | undefined)?.['persist-credentials']).toBe(false)
  })

  it.each(['.github/workflows/landlock-run.yml', '.github/workflows/landlock-run-release.yml'])(
    'prepares the Linux musl transaction in %s under the same runner.os condition',
    (path) => {
      const workflow = load(path)
      verifyConsumers(workflow, 1)
      const musl = aptConsumers(workflow)[0]!.step
      expect(musl.name).toBe('Install musl toolchain')
      expect(String(musl.if)).toBe("runner.os == 'Linux'")
      expect(String(musl.run)).toContain('apt-get install -yq musl-tools')
    },
  )

  it('pins the bubblewrap payload in sandbox.yml, prepares Landlock, and keeps product proof outside APT time', () => {
    const workflow = load('.github/workflows/sandbox.yml')
    verifyConsumers(workflow, 1)
    const steps = aptConsumers(workflow)
    const musl = steps[0]!.step
    expect(musl.name).toBe('Install musl toolchain')
    expect(musl.if).toBe("matrix.runner == 'landlock'")
    expect(String(musl.run)).toContain('apt-get install -yq musl-tools')
    const jobs = workflow.jobs
    if (!isRecord(jobs)) throw new TypeError('sandbox.yml must define jobs')
    const all: Step[] = Object.values(jobs).flatMap((job) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return (job.steps as Step[]).filter(isRecord)
    })
    const bwrap = all.find(step => step.name === 'Install bubblewrap (unrestrict userns)')!
    expect(bwrap.if).toBe("matrix.runner == 'bwrap'")
    expect(bwrap['timeout-minutes']).toBe(3)
    expect(bwrap.run).toBe('bash scripts/prepare-ci-bubblewrap.sh')
    expect(String(bwrap.run)).not.toContain('apt-get')
    const build = all.find(step => step.name === 'Build Landlock launcher for this architecture')!
    expect(build.if).toBe("matrix.runner == 'landlock'")
    expect(String(build.run)).not.toContain('apt-get')
    expect(String(build.run)).toContain('pnpm --dir native/system run build:native')
  })

  it('rejects a missing preparation action', () => {
    const workflow = load('.github/workflows/ci.yml')
    const consumers = aptConsumers(workflow)
    const { index, steps } = consumers[0]!
    steps.splice(index - 1, 1)
    expect(() => { verifyConsumers(workflow, 5) }).toThrow()
  })

  it('rejects a narrowed preparation condition', () => {
    const workflow = load('.github/workflows/ci.yml')
    const consumers = aptConsumers(workflow)
    for (const { index, steps } of consumers) {
      const prior = steps[index - 1]
      if (isPrepareStep(prior!)) prior!.if = 'false'
    }
    expect(() => { verifyConsumers(workflow, 5) }).toThrow()
  })

  it('rejects a removed consumer deadline', () => {
    const workflow = load('.github/workflows/ci.yml')
    const consumers = aptConsumers(workflow)
    for (const { step } of consumers) delete step['timeout-minutes']
    expect(() => { verifyConsumers(workflow, 5) }).toThrow()
  })

  it('rejects a new unprepared APT step appended to a job', () => {
    const workflow = load('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('jobs')
    const first = Object.values(workflow.jobs).find((v): v is Record<string, unknown> => isRecord(v) && Array.isArray(v.steps))
    if (first === undefined) throw new TypeError('ci.yml must define a job with steps')
    const steps = first.steps as Step[]
    steps.push({ name: 'Unexpected apt', run: 'sudo apt-get install -y x' })
    expect(() => { verifyConsumers(workflow, 5) }).toThrow()
  })

  it('pins the bubblewrap payload literals and probes', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    expect(script).toContain("readonly BUBBLEWRAP_VERSION='0.9.0-1ubuntu0.3'")
    expect(script).toContain("readonly BUBBLEWRAP_SHA256='2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094'")
    expect(script).toContain('readonly BUBBLEWRAP_URL="https://snapshot.ubuntu.com/ubuntu/20260921T000000Z/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"')
    expect(script).toContain('--connect-timeout 15 --max-time 60 --retry-max-time 120')
    expect(script).toContain('--retry 3')
    expect(script).toContain('sha256sum --check')
    expect(script).toContain('dpkg-deb --extract')
    expect(script).toContain('--unshare-pid')
    expect(script).toContain('apparmor_restrict_unprivileged_userns')
  })
})

describe.runIf(process.platform !== 'win32')('prepare-ci-apt composite action', () => {
  it('invokes the real Bash run block only on GitHub-hosted Linux', () => {
    const action: unknown = yaml.load(readFileSync(resolve(root, '.github/actions/prepare-ci-apt/action.yml'), 'utf8'))
    if (!isRecord(action) || !isRecord(action.runs) || !Array.isArray(action.runs.steps)) throw new TypeError('action must define steps')
    const bashStep = (action.runs.steps as Step[]).find(step => isRecord(step) && step.shell === 'bash')
    if (!isRecord(bashStep) || typeof bashStep.run !== 'string') throw new TypeError('action must define a bash run block')

    const markerDir = mkdtempSync(join(tmpdir(), 'apt-action-'))
    const stubDir = mkdtempSync(join(tmpdir(), 'apt-action-bin-'))
    tempRoots.push(markerDir, stubDir)
    writeFileSync(join(stubDir, 'sudo'), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$APT_PROBE_MARKER"\n', { mode: 0o755 })
    const nodeBin = dirname(process.execPath)

    const run = (environment: Record<string, string | undefined>): { status: number | null; marker: string | undefined } => {
      const marker = join(markerDir, `marker-${Math.random().toString(36).slice(2)}`)
      const env: Record<string, string> = {
        PATH: `${stubDir}:${nodeBin}`,
        APT_PROBE_MARKER: marker,
        HOME: markerDir,
      }
      if (environment.RUNNER_ENVIRONMENT !== undefined) env.RUNNER_ENVIRONMENT = environment.RUNNER_ENVIRONMENT
      if (environment.RUNNER_OS !== undefined) env.RUNNER_OS = environment.RUNNER_OS
      let status: number | null = null
      try {
        execFileSync('/bin/bash', ['-c', bashStep.run], { env, cwd: markerDir, timeout: 5_000, stdio: 'pipe' })
        status = 0
      } catch (error) {
        status = (error as { status?: number }).status ?? null
      }
      return { status, marker: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined }
    }

    const hosted = run({ RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' })
    expect(hosted.status).toBe(0)
    expect(hosted.marker).toMatch(/node.*prepare-ci-apt\.mjs --apply$/)

    for (const environment of [
      { RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Linux' },
      { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS' },
      { RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows' },
      { RUNNER_ENVIRONMENT: undefined, RUNNER_OS: undefined },
    ]) {
      const result = run(environment)
      expect(result.status).not.toBe(0)
      expect(result.marker).toBeUndefined()
    }
  })
})
