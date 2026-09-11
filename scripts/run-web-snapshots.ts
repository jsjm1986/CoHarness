/** Run serial browser owners before one bounded snapshot pool, full or focused by business group. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { pnpmInvocation } from './pnpm-invocation.ts'
import { focusedScenarioFiles, loadWebTestPolicy, WEB_TESTS_ROOT } from './web-test-policy.ts'

const serialFiles = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/cordis-tool-round.e2e.ts',
  // These suites own long-lived browser/session state. Run each in a fresh
  // Vitest process so a previous suite cannot leave timing or environment
  // state that changes the next suite's replayed surface.
  'apps/web/tests/agent-preset-selection.e2e.ts',
  'apps/web/tests/composer-model-mobile.e2e.ts',
  'apps/web/tests/live-interactions.e2e.ts',
  'apps/web/tests/lossless-history-wire.e2e.ts',
  'apps/web/tests/queue-actions.e2e.ts',
  'apps/web/tests/workflow-run.e2e.ts',
]

/** Group selection for a focused run: `--groups` argv wins over `DSH_WEB_GROUPS`. */
function requestedGroups(fromArgv: string | undefined, focused: boolean): readonly string[] | undefined {
  if (!focused) {
    const fullModeEnv = process.env.DSH_WEB_GROUPS
    if (fullModeEnv !== undefined && fullModeEnv !== '') {
      throw new Error('run-web-snapshots: DSH_WEB_GROUPS is set but the full inventory was requested; unset it or pass --focused.')
    }
    return undefined
  }
  const fromEnv = process.env.DSH_WEB_GROUPS === '' ? undefined : process.env.DSH_WEB_GROUPS
  if (fromArgv !== undefined && fromEnv !== undefined) {
    console.error('run-web-snapshots: both --groups and DSH_WEB_GROUPS are set; using --groups.')
  }
  const raw = fromArgv ?? fromEnv
  if (raw === undefined) {
    throw new Error('run-web-snapshots: focused mode requires business groups via --groups <a,b> or DSH_WEB_GROUPS.')
  }
  const groups = raw.split(',').map(group => group.trim()).filter(group => group !== '')
  if (groups.length === 0) {
    throw new Error(`run-web-snapshots: group selection is empty, got ${JSON.stringify(raw)}.`)
  }
  return groups
}

interface ParsedArgs {
  readonly focused: boolean
  readonly groups?: string
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { focused: boolean; groups?: string } = { focused: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--focused') {
      parsed.focused = true
    } else if (arg === '--') {
      // `pnpm run` forwards the npm-style option separator verbatim.
      continue
    } else if (arg === '--groups') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        throw new Error('run-web-snapshots: --groups requires a comma-separated group list.')
      }
      parsed.groups = value
      index++
    } else if (arg?.startsWith('--groups=')) {
      parsed.groups = arg.slice('--groups='.length)
    } else {
      throw new Error(`run-web-snapshots: unknown argument ${JSON.stringify(arg)}; expected --focused, --groups <list>, or no arguments for the full inventory.`)
    }
  }
  if (parsed.groups !== undefined && !parsed.focused) {
    throw new Error('run-web-snapshots: --groups requires --focused; the full inventory cannot be narrowed.')
  }
  return parsed
}

const argv = parseArgs(process.argv.slice(2))
const groups = requestedGroups(argv.groups, argv.focused)

const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
let workers = 1
if (workerRaw !== undefined && workerRaw !== '') {
  const parsed = Number.parseInt(workerRaw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== workerRaw) {
    throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be a positive integer, got ${JSON.stringify(workerRaw)}.`)
  }
  workers = parsed
}
const invocation = pnpmInvocation(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts'])

// Focused runs resolve their scenario selection from the checked-in policy
// before spawning Vitest, so an unknown group, an empty selection, or a
// policy entry whose file is missing fails here instead of as a Vitest
// filter error with no policy context.
const selectedFiles = groups === undefined
  ? undefined
  : focusedScenarioFiles(loadWebTestPolicy(resolve(import.meta.dirname, '..')), groups)
    .map((file) => {
      const path = `${WEB_TESTS_ROOT}${file}`
      if (!existsSync(path)) {
        throw new Error(`run-web-snapshots: policy scenario ${JSON.stringify(file)} does not exist on disk.`)
      }
      return path
    })
if (selectedFiles !== undefined) {
  const serialSelected = selectedFiles.filter(file => serialFiles.includes(file))
  console.error(`web snapshots: focused groups=${groups?.join(',')} scenarios=${selectedFiles.length} serial=${serialSelected.length} pooled=${selectedFiles.length - serialSelected.length}`)
}

// Every serial owner runs even when an earlier one fails. Each suite already
// gets its own Vitest process, so a failure cannot corrupt the next one;
// stopping at the first failure only hides the remaining ones until the next CI
// round, which makes a change that touches many goldens converge one file per
// round instead of in one round.
const failedSerial: string[] = []
for (const file of selectedFiles === undefined ? serialFiles : selectedFiles.filter(file => serialFiles.includes(file))) {
  const status = await run(invocation.command, [...invocation.args, file])
  if (status !== 0) failedSerial.push(file)
}

// The pool owns exactly the selected files the serial list excludes, so a
// serial failure says nothing about it. Running it regardless reports the whole
// failure set in one round rather than spending another round to discover the
// pooled failures. In full mode the pool arguments are the serial exclusions
// over the whole inventory; in focused mode they are the selected non-serial
// files, and the pool is skipped when every selected scenario runs serially.
const poolArgs = selectedFiles === undefined
  ? serialFiles.map(file => `--exclude=${file}`)
  : selectedFiles.filter(file => !serialFiles.includes(file))
let poolStatus = 0
if (poolArgs.length > 0) {
  poolStatus = await run(invocation.command, [
    ...invocation.args,
    ...poolArgs,
    '--fileParallelism',
    `--maxWorkers=${String(workers)}`,
  ])
}

if (failedSerial.length > 0) {
  console.error(`web snapshots failed in serial owners: ${failedSerial.join(', ')}`)
  process.exitCode = 1
} else {
  process.exitCode = poolStatus
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode, signalCode) => {
      if (signalCode !== null) {
        console.error(`web snapshots terminated by ${signalCode}`)
        resolveRun(1)
        return
      }
      resolveRun(exitCode ?? 1)
    })
  })
}
