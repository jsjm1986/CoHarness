/** Run serial browser owners before one bounded pool, with validated full, group, or exact selection. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { pnpmInvocation } from './pnpm-invocation.ts'
import {
  exactScenarioFiles, focusedScenarioFiles, loadWebTestPolicy, verifiedWebScenarioFiles, WEB_TESTS_ROOT,
} from './web-test-policy.ts'

const serialFiles = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/cordis-tool-round.e2e.ts',
  // These suites own long-lived browser/session state and need separate Vitest processes.
  'apps/web/tests/agent-preset-selection.e2e.ts',
  'apps/web/tests/composer-model-mobile.e2e.ts',
  'apps/web/tests/live-interactions.e2e.ts',
  'apps/web/tests/lossless-history-wire.e2e.ts',
  'apps/web/tests/queue-actions.e2e.ts',
  'apps/web/tests/workflow-run.e2e.ts',
]

interface ParsedArgs {
  focused: boolean
  printPlan: boolean
  groups?: string
  scenarios?: string
}

/** The validated browser inventory and its existing process ownership. */
export interface WebSnapshotPlan {
  readonly mode: 'full' | 'groups' | 'scenarios'
  readonly groups: readonly string[]
  /** Selected policy keys, including every smoke scenario in a focused run. */
  readonly scenarios: readonly string[]
  /** Repository-relative entries, executed in separate processes before the pool. */
  readonly serial: readonly string[]
  /** Repository-relative entries sharing the bounded Vitest pool. */
  readonly pool: readonly string[]
  readonly workers: number
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { focused: false, printPlan: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--focused') parsed.focused = true
    else if (arg === '--print-plan') parsed.printPlan = true
    else if (arg === '--') continue
    else {
      const field = arg === '--groups' || arg?.startsWith('--groups=') ? 'groups'
        : arg === '--scenarios' || arg?.startsWith('--scenarios=') ? 'scenarios' : undefined
      if (field === undefined) {
        throw new Error(`run-web-snapshots: unknown argument ${JSON.stringify(arg)}; expected --focused, --groups <list>, --scenarios <JSON>, or --print-plan.`)
      }
      if (parsed[field] !== undefined) throw new Error(`run-web-snapshots: --${field} must be supplied once.`)
      const inline = arg?.startsWith(`--${field}=`) === true
      const value = inline ? arg.slice(field.length + 3) : argv[++index]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error(`run-web-snapshots: --${field} requires ${field === 'groups' ? 'a comma-separated group list' : 'a JSON scenario array'}.`)
      }
      parsed[field] = value
    }
  }
  return parsed
}

function selectedScenarios(raw: string): readonly string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error('run-web-snapshots: scenarios must be a JSON array of registered scenario keys.', { cause: error })
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) {
    throw new Error('run-web-snapshots: scenarios must be a non-empty JSON string array.')
  }
  if (new Set(value).size !== value.length) throw new Error('run-web-snapshots: scenario selection contains duplicates.')
  return value
}

/**
 * Validate selection before spawning any browser process.
 * @param root - Source checkout whose policy and scenario files must agree.
 * @param argv - CLI arguments; explicit selection overrides the same selection environment variable.
 * @param environment - Group, exact-scenario and worker settings; defaults to the current process.
 * @returns One plan shared by execution and `--print-plan` inspection.
 * @throws If full mode is narrowed, selection kinds conflict, a smoke is omitted, or a referenced entry is absent.
 */
export function createWebSnapshotPlan(
  root: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): WebSnapshotPlan {
  const parsed = parseArgs(argv)
  const groupInput = parsed.groups ?? (environment.DSH_WEB_GROUPS || undefined)
  const scenarioInput = parsed.scenarios ?? (environment.DSH_WEB_SCENARIOS || undefined)
  if (!parsed.focused && (groupInput !== undefined || scenarioInput !== undefined)) {
    throw new Error('run-web-snapshots: groups and scenarios require --focused; the full inventory cannot be narrowed.')
  }
  if (groupInput !== undefined && scenarioInput !== undefined) {
    throw new Error('run-web-snapshots: groups and scenarios are mutually exclusive, including environment selections.')
  }
  if (parsed.focused && groupInput === undefined && scenarioInput === undefined) {
    throw new Error('run-web-snapshots: focused mode requires --groups, --scenarios, DSH_WEB_GROUPS, or DSH_WEB_SCENARIOS.')
  }
  let workers = 1
  const workerRaw = environment.DSH_WEB_SNAPSHOT_WORKERS
  if (workerRaw !== undefined && workerRaw !== '') {
    workers = Number.parseInt(workerRaw, 10)
    if (!Number.isSafeInteger(workers) || workers < 1 || String(workers) !== workerRaw) {
      throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be a positive integer, got ${JSON.stringify(workerRaw)}.`)
    }
  }
  const policy = loadWebTestPolicy(root)
  const inventory = verifiedWebScenarioFiles(root, policy)
  const missingSerial = serialFiles.filter(file => !inventory.includes(file.slice(WEB_TESTS_ROOT.length)))
  if (missingSerial.length > 0) {
    throw new Error(`run-web-snapshots: serial owners are missing from the scenario inventory: ${JSON.stringify(missingSerial)}.`)
  }
  let scenarios = inventory
  let groups: readonly string[] = []
  let mode: WebSnapshotPlan['mode'] = 'full'
  if (scenarioInput !== undefined) {
    const requested = selectedScenarios(scenarioInput)
    scenarios = exactScenarioFiles(policy, requested)
    const missingSmoke = policy.smokeScenarios.filter(file => !requested.includes(file))
    if (missingSmoke.length > 0) {
      throw new Error(`run-web-snapshots: exact selection omits required smoke scenarios ${JSON.stringify(missingSmoke)}.`)
    }
    mode = 'scenarios'
  } else if (groupInput !== undefined) {
    groups = groupInput.split(',').map(group => group.trim()).filter(Boolean)
    if (groups.length === 0) throw new Error('run-web-snapshots: group selection is empty.')
    scenarios = focusedScenarioFiles(policy, groups)
    mode = 'groups'
  }
  const files = scenarios.map(file => `${WEB_TESTS_ROOT}${file}`)
  const serial = serialFiles.filter(file => files.includes(file))
  const pool = files.filter(file => !serialFiles.includes(file))
  return { mode, groups, scenarios, serial, pool, workers }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const argv = process.argv.slice(2)
  const plan = createWebSnapshotPlan(root, argv)
  if (parseArgs(argv).printPlan) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
    return
  }
  const invocation = pnpmInvocation(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts'])
  if (plan.mode !== 'full') {
    console.error(`web snapshots: focused ${plan.mode} scenarios=${plan.scenarios.length} serial=${plan.serial.length} pooled=${plan.pool.length}`)
  }
  // Independent owners continue after a failure so one CI run reports every selected result.
  const failedSerial: string[] = []
  for (const file of plan.serial) {
    const status = await run(invocation.command, [...invocation.args, file], root)
    if (status !== 0) failedSerial.push(file)
  }
  const poolArgs = plan.mode === 'full' ? serialFiles.map(file => `--exclude=${file}`) : plan.pool
  let poolStatus = 0
  if (plan.pool.length > 0) {
    poolStatus = await run(invocation.command, [
      ...invocation.args, ...poolArgs, '--fileParallelism', `--maxWorkers=${String(plan.workers)}`,
    ], root)
  }
  if (failedSerial.length > 0) {
    console.error(`web snapshots failed in serial owners: ${failedSerial.join(', ')}`)
    process.exitCode = 1
  } else process.exitCode = poolStatus
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error(`web snapshots terminated by ${signalCode}`)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}

if (import.meta.main) await main()
