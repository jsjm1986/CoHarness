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
let serialStatus = 0
for (const file of serialFiles) {
  serialStatus = await run(invocation.command, [...invocation.args, file])
  if (serialStatus !== 0) break
}
if (serialStatus === 0) {
  process.exitCode = await run(invocation.command, [
    ...invocation.args,
    ...serialFiles.map(file => `--exclude=${file}`),
    '--fileParallelism',
    `--maxWorkers=${String(workers)}`,
  ])
} else {
  process.exitCode = serialStatus
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
