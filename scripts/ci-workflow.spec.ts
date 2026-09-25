import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatesForMode } from './run-gates.ts'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'

describe('CI workflow', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('requires the root-locked plugin suites through both runtime consumer branches', () => {
    vi.stubEnv('npm_execpath', '/private/pnpm.cjs')
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')
    const consumer = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!isRecord(consumer) || !Array.isArray(consumer.steps) || !isRecord(aggregate)) {
      throw new TypeError('CI must define runtime consumers and the required aggregate')
    }
    expect(aggregate.needs).toContain('node-24-consumers')
    expect(consumer['continue-on-error']).not.toBe(true)
    const steps = consumer.steps.filter(isRecord)
    expect(steps.some(step => typeof step.run === 'string' && step.run.includes('pnpm install --frozen-lockfile'))).toBe(true)
    const runtime = steps.find(step => step.name === 'Run keyless compatibility, snapshot, and artifact gates')
    expect(runtime?.['continue-on-error']).not.toBe(true)
    expect(runtime?.run).toBe('pnpm run check:ci:consumers:scoped')
    const sweep = workflow.jobs['web-snapshot-sweep']
    if (!isRecord(sweep) || !Array.isArray(sweep.steps)) throw new TypeError('CI must define the consumer sweep')
    expect(sweep.steps.filter(isRecord).some(step => step.run === 'pnpm run check:ci:consumers')).toBe(true)
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const [script, mode] of [
      ['check:ci:consumers', 'ci-consumers'],
      ['check:ci:consumers:scoped', 'ci-consumers-scoped'],
    ] as const) {
      expect(manifest.scripts[script]).toBe(`tsx scripts/run-gates.ts ${mode}`)
      const plugins = gatesForMode(mode).filter(gate => gate.id.startsWith('test-dsh-'))
      expect(plugins.map(gate => gate.displayCommand)).toEqual([
        'pnpm exec vitest run --config plugins/dsh-directory-guard/vitest.config.ts',
        'pnpm exec vitest run --config plugins/dsh-model-governance/vitest.config.ts',
      ])
      expect(plugins.every(gate => gate.allowFailure !== true)).toBe(true)
    }
    expect(steps.some(step => typeof step.run === 'string' && /(?:npm ci|pnpm install).*plugins\//.test(step.run))).toBe(false)
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) return []
        return [{ jobName, step }]
      })
    })

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: { dest: runnerPrivatePnpmDestination },
      })
    }
  })

  it('runs selected keyless Gateway execution with isolated PostgreSQL and one evidence upload', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const consumer = workflowJob(workflow, 'node-24-consumers')
    expect(consumer.services).toMatchObject({
      'execution-postgres': {
        image: "${{ needs.pr-scope.outputs.gateway_mode == 'full' && 'postgres:16' || '' }}",
        env: { POSTGRES_USER: 'hgw', POSTGRES_PASSWORD: 'hgw', POSTGRES_DB: 'hgw_execution' },
        ports: ['5432/tcp'],
      },
    })
    const steps = (consumer.steps as unknown[]).filter(isRecord)
    const install = steps.findIndex(step => step.run === 'npm ci --prefix gateway --omit=dev')
    const execution = steps.findIndex(step => step.id === 'gateway-execution')
    const record = steps.findIndex(step => step.name === 'Record Gateway execution evidence')
    const upload = steps.findIndex(step => step.uses === './.github/actions/gate-evidence')
    expect(execution).toBeGreaterThan(install)
    expect(record).toBeGreaterThan(execution)
    expect(upload).toBeGreaterThan(record)
    expect(steps[execution]).toMatchObject({
      if: "needs.pr-scope.outputs.gateway_mode == 'full'",
      run: 'pnpm run test:gateway:execution',
      env: { HGW_TEST_DATABASE_URL: "postgres://hgw:hgw@127.0.0.1:${{ job.services.execution-postgres.ports['5432'] }}/hgw_execution" },
    })
    expect(steps[execution]?.['continue-on-error']).toBeUndefined()
    expect(steps[record]).toMatchObject({
      if: "always() && needs.pr-scope.outputs.gateway_mode == 'full'",
      run: 'node scripts/gate-evidence.ts',
      env: {
        EVIDENCE_CHECK: 'gateway-execution',
        EVIDENCE_COMMAND: 'pnpm run test:gateway:execution',
        EVIDENCE_STATUS: "${{ steps.gateway-execution.outcome == 'skipped' && 'cancelled' || steps.gateway-execution.outcome }}",
      },
    })
    expect(steps.filter(step => step.uses === './.github/actions/gate-evidence')).toHaveLength(1)
    expect(steps.filter(step => step.run === 'npm ci --prefix gateway --omit=dev')).toHaveLength(1)
    expect(isRecord(consumer.env) && consumer.env.HGW_TEST_DATABASE_URL).toBeUndefined()
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['test:gateway:execution']).toBe(
      'node -e "if (!process.env.HGW_TEST_DATABASE_URL) throw new Error(\'HGW_TEST_DATABASE_URL must select a disposable test database\')"'
      + ' && vitest run --config vitest.e2e.config.ts packages/context/gateway-execution/tests/pg-composition.e2e.ts --retry=0',
    )
  })

  it('keeps portable pools and requires native Windows for selected platform changes', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs.windows)
      || !isRecord(workflow.jobs['windows-native'])
      || !isRecord(workflow.jobs['wine-apt-cache'])
      || !isRecord(workflow.jobs['serial-windows'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-bench'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['pr-scope'])
      || !isRecord(workflow.jobs['all-checks-passed'])) {
      throw new TypeError('CI workflow must define pr-scope, windows, windows-native, wine-apt-cache, serial-windows, node-24, node-24-coverage, node-24-bench, node-24-consumers, and all-checks-passed jobs')
    }

    const windows = workflow.jobs.windows
    const windowsNative = workflow.jobs['windows-native']
    const wineAptCache = workflow.jobs['wine-apt-cache']
    const serialWindows = workflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Bench = workflow.jobs['node-24-bench']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const prScope = workflow.jobs['pr-scope']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(windows.steps)
      || !Array.isArray(aggregate.needs)
      || !isRecord(windowsNative.env)
      || !isRecord(node24Coverage.env)
      || !isRecord(node24Consumers.env)
      || !Array.isArray(node24Consumers.steps)) {
      throw new TypeError('CI worker jobs must define environment maps and steps, and the aggregate must define needs')
    }
    const commandSteps = windows.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))

    // Required PR job: Wine on ubuntu-latest, runs wine-windows-gates.sh.
    expect(windows['runs-on']).toBe('ubuntu-latest')
    expect(windows.name).toBe('windows node 24 / wine blocking')
    expect(windows.if).toContain("github.event_name == 'pull_request'")
    expect(windows.if).toContain('needs.pr-scope.outputs.windows_mode')
    expect(commandSteps.some(step => step.run.includes('wine-windows-gates.sh'))).toBe(true)

    // windows-native: portable standard Windows by default, optional enterprise
    // capacity, and the Windows-specific self-hosted failover switch.
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(windowsNative['runs-on']).toContain('DSH_CI_ENTERPRISE_RUNNERS_ENABLED')
    expect(windowsNative['runs-on']).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(windowsNative['runs-on']).toContain('self-hosted')
    expect(windowsNative['runs-on']).toContain('dsh-win-ci')
    expect(windowsNative['runs-on']).toContain('dsh-windows-2025-16core')
    expect(windowsNative['runs-on']).toContain('windows-2025')
    expect(windowsNative.name).toBe('windows node 24 / native complete')
    // Native platform changes require the real kernel; unrelated changes keep the sweep.
    expect(windowsNative.if).toContain("github.event_name == 'schedule'")
    expect(windowsNative.if).toContain("github.ref == 'refs/heads/master'")
    expect(windowsNative.if).toContain("needs.pr-scope.outputs.proof_native_windows == 'true'")
    expect(windowsNative.needs).toBe('pr-scope')
    expect(windowsNative.env).toMatchObject({
      DSH_COVERAGE_TEST_TIMEOUT_MS: '30000',
    })
    expectExternalCapacityExpression(windowsNative.env.DSH_COVERAGE_PARTITIONS, '8', '2')
    expectExternalCapacityExpression(windowsNative.env.DSH_GATE_CONCURRENCY, '4', '1')
    expectExternalCapacityExpression(windowsNative.env.DSH_PUBLINT_CONCURRENCY, '8', '1')
    const nativeCommandSteps = (windowsNative.steps as unknown[]).filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(nativeCommandSteps.map(step => step.run)).toContain('pnpm run check:ci:windows-complete')
    // The upstream sovereignty gate diffs mirrored release tags, which a
    // depth-1 clone does not carry; the same applies to serial-windows below.
    const windowsNativeCheckout = (windowsNative.steps as unknown[]).filter(isRecord)
      .find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(windowsNativeCheckout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // wine-apt-cache: master-only, seeds the Wine apt cache.
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')

    // serial-windows: explicitly enabled master-only standby, self-hosted, non-blocking.
    expect(serialWindows.if).toContain("github.event_name == 'push'")
    expect(serialWindows.if).toContain("github.ref == 'refs/heads/master'")
    expect(serialWindows.if).toContain("vars.DSH_CI_SELF_HOSTED_STANDBY_ENABLED == 'true'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')
    if (!Array.isArray(serialWindows.steps)) throw new TypeError('serial-windows must define steps')
    const serialWindowsCheckout = serialWindows.steps.filter(isRecord)
      .find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    expect(serialWindowsCheckout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Both Windows owners participate when selected; standby drills do not.
    expect(aggregate.needs).toContain('pr-scope')
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs).toContain('windows-native')
    expect(aggregate.needs).not.toContain('serial-windows')

    // Linux uses standard hosted capacity by default, with explicit enterprise
    // opt-in and the separate Linux self-hosted failover switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('DSH_CI_ENTERPRISE_RUNNERS_ENABLED')
      expect(job['runs-on']).toContain('github.event.pull_request.head.repo.full_name == github.repository')
      expect(job['runs-on']).toContain('vm-backup')
      expect(job['runs-on']).toContain('dsh-ubuntu-24-04-16core')
      expect(job['runs-on']).toContain('ubuntu-latest')
    }
    expect(node24Coverage.env.DSH_COVERAGE_TEST_TIMEOUT_MS).toBe('30000')
    expectExternalCapacityExpression(node24Coverage.env.DSH_COVERAGE_PARTITIONS, '4', '2')
    expectExternalCapacityExpression(node24Coverage.env.DSH_GATE_CONCURRENCY, '3', '1')
    expectExternalCapacityExpression(node24Consumers.env.DSH_GATE_CONCURRENCY, '8', '1')
    expectExternalCapacityExpression(node24Consumers.env.DSH_OXLINT_THREADS, '8', '1')
    expectExternalCapacityExpression(node24Consumers.env.DSH_PUBLINT_CONCURRENCY, '8', '1')
    expectExternalCapacityExpression(node24Consumers.env.DSH_SNAPSHOT_MAX_CONCURRENCY, '32', '1')
    expect(String(node24Consumers.env.DSH_SNAPSHOT_MAX_CONCURRENCY)).toContain("&& '12'")
    const consumerSteps = node24Consumers.steps.filter(isRecord)
    const gatewayInstallIndex = consumerSteps.findIndex(step => step.name === 'Install Gateway runtime dependencies')
    const consumerGateIndex = consumerSteps.findIndex(step => step.name === 'Run keyless compatibility, snapshot, and artifact gates')
    expect(gatewayInstallIndex).toBeGreaterThanOrEqual(0)
    expect(consumerSteps[gatewayInstallIndex]).toMatchObject({
      run: 'npm ci --prefix gateway --omit=dev',
    })
    expect(consumerGateIndex).toBeGreaterThan(gatewayInstallIndex)
    expect(consumerSteps[consumerGateIndex]).toMatchObject({ run: 'pnpm run check:ci:consumers:scoped' })
    // The browser tier moved to the web-verification job; no Playwright work
    // (cache, install) stays in the consumer aggregate.
    expect(consumerSteps.some(step => typeof step.name === 'string' && step.name.includes('Playwright'))).toBe(false)

    // The benchmark lane is a required verdict input and runs alone so its
    // wall-clock budgets never share a runner with a concurrent aggregate.
    expect(aggregate.needs).toContain('node-24-bench')
    expect(node24Bench.name).toBe('node 24 / benchmarks')
    expect(node24Bench.env).toBeUndefined()
    expect(node24Bench.steps).toContainEqual({
      name: 'Install benchmark browser and hosted dependencies',
      run: 'pnpm --filter @deepseek-ai/dsh-benchmarks exec playwright install --with-deps chromium',
    })
    expect(JSON.stringify(node24Bench.steps)).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(node24Bench.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })

    // The dedicated web verification lane: one stable required check whose
    // steps branch on the selector's snapshot mode.
    const webVerification = workflow.jobs['web-verification']
    if (!isRecord(webVerification) || !Array.isArray(webVerification.steps) || !isRecord(webVerification.env)) {
      throw new TypeError('CI workflow must define the web-verification job with steps and environment')
    }
    expect(webVerification.if).toBe("github.event_name == 'pull_request'")
    expect(webVerification.needs).toContain('pr-scope')
    expect(String(webVerification['runs-on'])).toContain('DSH_CI_FAILOVER_LINUX')
    expectExternalCapacityExpression(webVerification.env.DSH_WEB_SNAPSHOT_WORKERS, '6', '1')
    // One stable check name lets branch protection require the lane; the
    // selected tier and groups surface in the job summary instead.
    expect(webVerification.name).toBe('web verification')
    const webSteps = webVerification.steps.filter(isRecord)
    expect(webSteps.some(step => step.name === 'Record skipped web verification')).toBe(true)
    expect(webSteps.find(step => step.name === 'Record web verification tier')).toMatchObject({
      if: "needs.pr-scope.outputs.snapshot_mode == 'focused' || needs.pr-scope.outputs.snapshot_mode == 'full'",
    })
    expect(String(webSteps.find(step => step.name === 'Record web verification tier')?.run)).toContain('web_groups')
    expect(webSteps.find(step => step.name === 'Run focused web verification')).toMatchObject({
      run: 'pnpm run check:ci:web:focused',
      env: {
        DSH_WEB_GROUPS: '${{ needs.pr-scope.outputs.web_groups }}',
        DSH_WEB_SNAPSHOT_WORKERS: '2',
      },
    })
    expect(webSteps.find(step => step.name === 'Run full web verification')).toMatchObject({
      run: 'pnpm run check:ci:web:full',
    })
    expect(webSteps.filter(step => typeof step.name === 'string' && step.name.includes('Playwright')).length).toBe(2)
    // Every step beyond the skip record only runs when the selector chose a
    // browser tier, so a skipped lane spends no runner minutes on setup.
    for (const step of webSteps) {
      if (step.if === undefined || step.name === 'Record skipped web verification') continue
      const condition = typeof step.if === 'string' ? step.if : ''
      expect(condition, String(step.name)).toMatch(/snapshot_mode == '(?:focused|full)'/)
    }
    expect(aggregate.needs).toContain('web-verification')
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
    expect(prScope.if).toBe("github.event_name == 'pull_request'")
    expect(prScope.outputs).toMatchObject({
      run_expensive: '${{ steps.scope.outputs.run_expensive }}',
      reason: '${{ steps.scope.outputs.reason }}',
      web_groups: '${{ steps.scope.outputs.web_groups }}',
    })
  })

  it('exempts push from cancellation, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('CI workflow must define jobs and a workflow-level concurrency block')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master. The
    // expression is evaluated against the NEWLY TRIGGERED run, so a dispatch on
    // master still cancels a mid-flight drill; the runbook records that bound.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only and require explicit standby enablement.
      expect(job.if).toContain("github.event_name == 'push'")
      expect(job.if).toContain("github.ref == 'refs/heads/master'")
      expect(job.if).toContain("vars.DSH_CI_SELF_HOSTED_STANDBY_ENABLED == 'true'")
    }

    // What bounds the cost of exempting push: a master push carries the cache
    // seeder, the two drills, the native Windows inventory, and the browser
    // sweep. Any job reachable on push starts accumulating uncancelled runs, so
    // the set is pinned here. `windows-native` and `web-snapshot-sweep` were
    // deliberately added when those two inventories moved off the pull-request
    // path: they are the compensating post-merge sweeps, and the nightly
    // schedule covers a quiet master.
    //
    // Classification is an exact allowlist of the conditions in use, not a
    // substring match: `github.event_name != 'pull_request'` mentions
    // `pull_request` yet IS push-reachable, so matching on the event name alone
    // would silently misclassify it as gated.
    const NOT_PUSH_REACHABLE = new Set([
      ...['release_pack', 'vendor_pack', 'native_pack', 'sandbox', 'provider', 'pi_ai'].map(proof =>
        `github.event_name == 'pull_request' && needs.pr-scope.outputs.proof_${proof} == 'true'`),
      ...['compat', 'python', 'gateway', 'admin_ui'].map(mode =>
        `always() && ((github.event_name == 'workflow_dispatch' && inputs.suite == 'full-audit') || (github.event_name == 'pull_request' && needs.pr-scope.outputs.${mode}_mode == 'full'))`),
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'android-audit'",
      "github.event_name == 'pull_request'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.run_expensive == 'true'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.compat_mode == 'full'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.python_mode == 'full'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.windows_mode == 'full'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.gateway_mode == 'full'",
      "github.event_name == 'pull_request' && needs.pr-scope.outputs.admin_ui_mode == 'full'",
      "always() && github.event_name == 'pull_request'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark' && vars.DSH_CI_ENTERPRISE_RUNNERS_ENABLED == 'true'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark' && vars.DSH_CI_ENTERPRISE_RUNNERS_ENABLED == 'true'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'full-audit'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'web-snapshot-sweep', 'windows-native', 'wine-apt-cache'])

    // The browser sweep is the other compensating post-merge lane. The browser
    // suite only ran on pull requests, and a red pull request stays mergeable,
    // so the workbench tree change broke ~15 e2e files on master without
    // anything surfacing it.
    const browserSweep = workflow.jobs['web-snapshot-sweep']
    if (!isRecord(browserSweep)) throw new TypeError('web-snapshot-sweep must be defined')
    expect(browserSweep.if).toContain("github.event_name == 'schedule'")
    expect(browserSweep.if).toContain("github.ref == 'refs/heads/master'")
    expect(browserSweep.if).not.toContain('pull_request')
    expect(browserSweep.needs).toBeUndefined()
    const sweepSteps = (browserSweep.steps as unknown[]).filter(isRecord)
    const sweepRuns = sweepSteps.filter((step): step is Record<string, unknown> & { run: string } => (
      typeof step.run === 'string'
    ))
    expect(sweepRuns.some(step => step.run.includes('check:ci:consumers'))).toBe(true)

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.if).toContain("vars.DSH_CI_ENTERPRISE_RUNNERS_ENABLED == 'true'")
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('keeps the post-merge consumer sweep bounded like the pull-request lane', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const sweep = workflowJob(workflow, 'web-snapshot-sweep')
    if (!isRecord(sweep.env)) throw new TypeError('web-snapshot-sweep must define an environment map')
    expect(sweep.env).toMatchObject({
      DSH_GATE_CONCURRENCY: '1',
      DSH_NODE_COMPAT_SKIP_TYPECHECK: '1',
      DSH_OXLINT_THREADS: '1',
      DSH_PUBLINT_CONCURRENCY: '1',
      DSH_SNAPSHOT_MAX_CONCURRENCY: '1',
    })
    const consumers = workflowJob(workflow, 'node-24-consumers')
    const nodeCompat = (consumers.steps as unknown[]).find(step => isRecord(step) && step.name === 'Run keyless compatibility, snapshot, and artifact gates')
    expect(nodeCompat).toBeDefined()

    // The consumer inventory spawns built bins; a step-level DSH_SNAPSHOT would
    // leak the replay config swap into their children and kill them at boot.
    // Every snapshot consumer defaults to replay on its own.
    const consumerStep = (sweep.steps as unknown[]).find(step =>
      isRecord(step) && typeof step.run === 'string' && step.run.includes('check:ci:consumers'))
    if (!isRecord(consumerStep)) throw new TypeError('web-snapshot-sweep must run check:ci:consumers')
    expect(!isRecord(consumerStep.env) || consumerStep.env.DSH_SNAPSHOT === undefined).toBe(true)
  })

  it('runs the independent Gateway checks only for their own selected mode', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const gateway = workflowJob(workflow, 'gateway')
    const adminUi = workflowJob(workflow, 'gateway-admin-ui')
    expect(gateway.if).toContain("needs.pr-scope.outputs.gateway_mode == 'full'")
    expect(adminUi.if).toContain("needs.pr-scope.outputs.admin_ui_mode == 'full'")
    expect(gateway.env).toMatchObject({
      HGW_TEST_DATABASE_URL: 'postgres://hgw:hgw@127.0.0.1:5432/hgw_test',
    })
    expect(gateway.services).toHaveProperty('postgres')
    const gatewayRuns = (gateway.steps as unknown[]).filter(isRecord).flatMap(step => typeof step.run === 'string' ? [step.run] : [])
    expect(gatewayRuns).toEqual(expect.arrayContaining([
      'npm run typecheck --prefix gateway',
      'npm run build:check --prefix gateway',
      'npm test --prefix gateway',
      'npm run test:postgres --prefix gateway',
    ]))
    const gatewaySteps = (gateway.steps as unknown[]).filter(isRecord)
    const unitIndex = gatewaySteps.findIndex(step => step.run === 'npm test --prefix gateway')
    const postgresIndex = gatewaySteps.findIndex(step => step.run === 'npm run test:postgres --prefix gateway')
    const evidenceIndex = gatewaySteps.findIndex(step => step.name === 'Preserve gate evidence')
    expect(postgresIndex).toBeGreaterThan(unitIndex)
    expect(evidenceIndex).toBeGreaterThan(postgresIndex)
    expect(gatewaySteps[postgresIndex]?.if).toBeUndefined()
    expect(gatewaySteps[postgresIndex]?.['continue-on-error']).toBeUndefined()
    expect(gatewaySteps[evidenceIndex]?.with).toMatchObject({
      external: 'gateway',
      command: 'npm test --prefix gateway && npm run test:postgres --prefix gateway',
    })
    const manifest = JSON.parse(readFileSync(resolve(root, 'gateway/package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['test:postgres']).toContain('--no-file-parallelism')
    for (const suite of ['postgres', 'access-invalidation', 'execution']) {
      expect(manifest.scripts['test:postgres']).toContain(`tests/${suite}.spec.ts`)
      expect(manifest.scripts.test).toContain(`--exclude tests/${suite}.spec.ts`)
    }
  })

  it('limits release and sandbox workflows to relevant changes while retaining manual or scheduled runs', () => {
    for (const [file, expected] of [
      ['.github/workflows/release.yml', 'apps/**'],
      ['.github/workflows/release-vendor.yml', 'vendor/**'],
      ['.github/workflows/sandbox.yml', 'native/**'],
    ] as const) {
      const workflow = loadWorkflow(file)
      const trigger = workflow.on
      if (!isRecord(trigger)) throw new TypeError(`${file} must define trigger mappings`)
      expect(isRecord(trigger.workflow_call)).toBe(true)
      expect(trigger.pull_request).toBeUndefined()
      const push = trigger.push
      if (isRecord(push)) {
        const paths = push.paths
        expect(paths).toContain(expected)
      }
      if (file.endsWith('sandbox.yml')) {
        expect(trigger.schedule).toBeDefined()
        expect(trigger.workflow_dispatch).toBeDefined()
      }
    }
  })

  it('requires release-shaped Python runtime targets on every pull request', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      name: 'python runtime / release-shaped matrix',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-win-x64',
        ci: true,
      },
    })
    expect(pythonRuntime.if).toContain("github.event_name == 'pull_request'")
    expect(pythonRuntime.if).toContain('needs.pr-scope.outputs.python_mode')
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('runs required benchmarks on standard hosted Linux independently of failover', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const benchmark = workflowJob(workflow, 'node-24-bench')
    const aggregate = workflowJob(workflow, 'all-checks-passed')

    expect(benchmark['runs-on']).toBe('ubuntu-24.04')
    expect(benchmark.if).toBe("github.event_name == 'pull_request'")
    expect(benchmark.needs).toBeUndefined()
    expect(benchmark['continue-on-error']).toBeUndefined()
    expect(benchmark.env).toBeUndefined()
    expect(aggregate.needs).toContain('node-24-bench')
  })

  it('bounds the complete benchmark job to fifteen minutes', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')

    expect(benchmark['timeout-minutes']).toBe(15)
    expect(benchmark.steps).toContainEqual({
      name: 'Run performance benchmarks',
      env: { DSH_GATE_VERBOSE: '1' },
      run: 'pnpm run check:ci:bench',
    })
  })

  it('always restores the hosted benchmark pnpm cache', () => {
    const benchmark = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-bench')
    if (!Array.isArray(benchmark.steps)) throw new TypeError('benchmark job must define steps')
    const caches = benchmark.steps.filter(step => isRecord(step) && step.uses === 'actions/cache/restore@v4')

    expect(caches).toHaveLength(1)
    expect(caches[0]).not.toHaveProperty('if')
    expect(caches[0]).toMatchObject({
      with: {
        path: '${{ steps.pnpm-store.outputs.path }}',
        key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
      },
    })
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(e2e.if).toContain("github.repository == 'jsjm1986/CoHarness'")
    expect(e2e.if).toContain("vars.DSH_REAL_API_E2E_ENABLED == 'true'")
    expect(e2e.if).toContain("github.event_name == 'workflow_dispatch' || vars.DSH_REAL_API_E2E_ENABLED == 'true'")
    expect(e2e.if).toContain('github.event.pull_request.head.repo.fork')
    expect(e2e.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(JSON.stringify(workflow)).not.toContain('pull_request_target')
    expect(steps.find(step => step.name === 'Preflight (require DEEPSEEK_API_KEY)')).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    // Source checkout supplies the shared readiness guard; publication still consumes downloaded wheels.
    for (const steps of [runtimeSteps, sdkSteps]) {
      expect(steps.some(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))).toBe(true)
      expect(steps.some(step => typeof step.run === 'string' && /(?:pnpm|npm) run build/.test(step.run))).toBe(false)
      expect(steps.some(step => typeof step.run === 'string' && step.run.includes('release:prepare'))).toBe(true)
    }
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('win_amd64')
    expect(workflowJson).toContain('deepseek-harness-sdk-runtime-win-x64.exe')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('uses explicit review handoff events without rerunning when a draft becomes ready', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toContain("github.repository == 'jsjm1986/CoHarness'")
    expect(lifecycleJob.if).toContain("vars.DSH_ISSUE_AUTOMATION_ENABLED == 'true'")
    expect(lifecycleJob.if).toContain('github.event.pull_request.head.repo.fork')
    expect(lifecycleJob.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(lifecycleJob.if).toContain("github.event.review.state == 'changes_requested'")
    expect(policyPullRequest.types).toContain('ready_for_review')

    const policyJobDefinition = workflowJob(policy, 'policy')
    expect(policyJobDefinition.if).toContain("github.repository == 'jsjm1986/CoHarness'")
    expect(policyJobDefinition.if).toContain("vars.DSH_ISSUE_AUTOMATION_ENABLED == 'true'")
    expect(policyJobDefinition.if).toContain('github.event.pull_request.head.repo.fork')
    expect(policyJobDefinition.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(policyJobDefinition.permissions).toBeUndefined()
    expect(policy.permissions).toMatchObject({ contents: 'read', issues: 'read', 'pull-requests': 'read' })
    expect(JSON.stringify(lifecycle)).toContain('"owner":"jsjm1986"')
    expect(JSON.stringify(lifecycle)).toContain('"repositories":"CoHarness"')
    expect(JSON.stringify(policy)).toContain('"owner":"jsjm1986"')
    expect(JSON.stringify(policy)).toContain('"repositories":"CoHarness"')
    expect(JSON.stringify(policy)).toContain('"GH_TOKEN":"${{ steps.app-token.outputs.token }}"')
    expect(JSON.stringify(policy)).not.toContain('"GITHUB_TOKEN":"${{ github.token }}"')
  })
})

describe('Documentation workflow', () => {
  it('publishes only through an explicit release dispatch and verifies the release tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })

    const build = workflowJob(workflow, 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('Documentation build must define steps')
    const steps = build.steps.filter(isRecord)
    const checkout = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    const verify = steps.find(step => step.name === 'Verify release version')

    expect(checkout).toMatchObject({
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    })
    // Tag verification only: the docs deployment proves the tag names a
    // releasable candidate but produces no publish-path readiness report.
    expect(verify).toMatchObject({
      env: { RELEASE_VERIFY_TAG: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function expectExternalCapacityExpression(value: unknown, external: string, portable: string): void {
  expect(typeof value).toBe('string')
  if (typeof value !== 'string') throw new TypeError('capacity expression must be a string')
  expect(value).toContain('DSH_CI_ENTERPRISE_RUNNERS_ENABLED')
  expect(value).toContain(`&& '${external}'`)
  expect(value).toContain(`|| '${portable}'`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
