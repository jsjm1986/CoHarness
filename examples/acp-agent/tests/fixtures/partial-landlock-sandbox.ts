import { join } from 'node:path'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const MISSING_RUNNER_ENV = 'DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER'
/**
 * Spawn delay for the missing-runner mode. The scenario's background job is
 * read back with `job_output wait=true` in the following step; holding the
 * spawn attempt past that step boundary makes the job settle while a waiter
 * is registered, so the reported-instead-of-noticed ordering is identical on
 * platforms with fast (POSIX direct) and slow (launch-protocol) spawn-error
 * propagation.
 */
const MISSING_RUNNER_DELAY_MS = 1000

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Snapshot-only provider for deterministic runner classification. Its default
 * launch reproduces older-ABI Landlock; an explicit scenario flag selects a
 * missing executable under the valid workspace cwd. Keep the Landlock tuple
 * aligned with `RUNNER_FAILURE_RULES` in `packages/sandbox/sandbox-local/src/index.ts`.
 */
export default class PartialLandlockSandboxProvider extends SandboxProvider {
  confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    if (process.env[MISSING_RUNNER_ENV] === '1') {
      return delay(MISSING_RUNNER_DELAY_MS).then(() => ({
        argv: [join(policy.workspaceRoot, '.dsh-missing-sandbox-runner'), ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [{ fatalSignatures: ['snapshot-runner: '] }],
      }))
    }
    return Promise.resolve({
      argv: [
        'bash',
        '-c',
        `printf '%s\\n' '${NOTICE}' >&2; exec "$@"`,
        'partial-landlock-run',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [125],
        fatalSignatures: ['landlock-run: '],
        informationalLines: [NOTICE],
      }],
    })
  }
}
