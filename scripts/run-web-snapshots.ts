/** Run serial browser owners before one bounded snapshot pool. */
import { spawn } from 'node:child_process'
import { pnpmInvocation } from './pnpm-invocation.ts'

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
const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
const workers = Number.parseInt(workerRaw ?? '', 10)
if (!Number.isSafeInteger(workers) || workers < 1 || String(workers) !== workerRaw) {
  throw new Error(`DSH_WEB_SNAPSHOT_WORKERS must be a positive integer, got ${JSON.stringify(workerRaw)}.`)
}
const invocation = pnpmInvocation(['exec', 'vitest', 'run', '--config', 'vitest.web.config.ts'])

// Every serial owner runs even when an earlier one fails. Each suite already
// gets its own Vitest process, so a failure cannot corrupt the next one;
// stopping at the first failure only hides the remaining ones until the next CI
// round, which makes a change that touches many goldens converge one file per
// round instead of in one round.
const failedSerial: string[] = []
for (const file of serialFiles) {
  const status = await run(invocation.command, [...invocation.args, file])
  if (status !== 0) failedSerial.push(file)
}

// The pool owns exactly the files the serial list excludes, so a serial failure
// says nothing about it. Running it regardless reports the whole failure set in
// one round rather than spending another round to discover the pooled failures.
const poolStatus = await run(invocation.command, [
  ...invocation.args,
  ...serialFiles.map(file => `--exclude=${file}`),
  '--fileParallelism',
  `--maxWorkers=${String(workers)}`,
])

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
