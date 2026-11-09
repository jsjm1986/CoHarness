/** Windows parent-side launch and ownership for the private Job runner. */

import { controlPipe } from './control-spawn.ts'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  loadWin32ProcessBindings,
  probeCurrentTokenJobSupport,
} from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import {
  type SerializedRunnerError,
  type WindowsRunnerResult,
  deserializeRunnerError,
  parseWindowsRunnerResult,
} from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'

/** Test seams for runner launch and dynamic capability checks. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadWin32ProcessBindings?: typeof loadWin32ProcessBindings
  probeCurrentTokenJobSupport?: typeof probeCurrentTokenJobSupport
}

/** Bound for a connected runner to act on a terminate request before it is presumed wedged. */
const RUNNER_TERMINATE_TIMEOUT_MS = 5_000

type RunnerProcess = Omit<ReturnType<typeof spawn>, 'send' | 'stdio'> & {
  send?: ReturnType<typeof spawn>['send']
  stdio: Array<Readable | Writable | null>
}

function isWindowsStartCancellationError(error: SerializedRunnerError): boolean {
  return error.name === 'Error'
    && error.message === 'subprocess target start was cancelled'
    && error.code === undefined
    && error.syscall === undefined
    && error.path === undefined
}

/**
 * Re-check the runner entry, bindings, and current Job capability for every spawn.
 * @param internals - optional runner and Win32 capability seams used by tests.
 * @returns whether the Windows native containment path is currently available.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  try {
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    if (!(internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)) return false
    const api = (internals.loadWin32ProcessBindings ?? loadWin32ProcessBindings)()
    ;(internals.probeCurrentTokenJobSupport ?? probeCurrentTokenJobSupport)(api)
    return true
  } catch {
    return false
  }
}

class WindowsJobOwner implements BoundProcessOwner {
  private cancellationReason: unknown
  private cancellationReasonSet = false
  private terminationSent = false
  private infrastructureFailed = false

  constructor(
    private readonly runner: RunnerProcess,
    private readonly exited: Promise<void>,
    private readonly directResultType: () => WindowsRunnerResult['type'] | undefined,
    private readonly failInfrastructure: (error: unknown) => void,
  ) {
    void this.exited.catch(() => {})
  }

  signal(_signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void {
    if (!this.cancellationReasonSet) {
      this.cancellationReason = cancellationReason
      this.cancellationReasonSet = true
    }
    if (this.terminationSent) return
    this.terminationSent = true
    // A runner that accepts the IPC write but never processes it — or whose
    // channel is already gone — still owns its Job; bound the wait and let
    // Job close sweep the tree when the deadline path kills the owner.
    const deadline = setTimeout(() => {
      this.failAndKill(new Error('Windows Job runner did not process its terminate request'), true)
    }, RUNNER_TERMINATE_TIMEOUT_MS)
    deadline.unref()
    void this.exited.then(() => { clearTimeout(deadline) }, () => { clearTimeout(deadline) })
    if (!this.runner.connected) {
      // No result can ever arrive over a dead channel; fail fast while the
      // armed deadline still covers a wedged process holding its Job.
      this.failAndKill(new Error('Windows Job runner lost its IPC channel before its terminate request'))
      return
    }
    try {
      this.runner.send?.({ type: 'terminate' }, (error) => {
        if (error === null) return
        this.failAndKill(error)
      })
    } catch (error) {
      this.failAndKill(error)
    }
  }

  private failAndKill(error: unknown, wedged = false): void {
    // A latched direct result must not be rewritten by an infrastructure
    // failure, and a mere delivery failure needs no kill — the runner is
    // already on its own exit path. A wedge (deadline or dead channel) is
    // different: the runner still owns the Job handle, so kill it and let
    // the exit path settle the managed range.
    if (this.directResultType() !== undefined) {
      if (wedged) this.terminateForHostExit()
      return
    }
    if (this.infrastructureFailed) return
    this.infrastructureFailed = true
    this.failInfrastructure(error)
    this.terminateForHostExit()
  }

  mapStartFailure(failure: unknown, serialized: SerializedRunnerError): unknown {
    return this.cancellationReasonSet && isWindowsStartCancellationError(serialized)
      ? this.cancellationReason
      : failure
  }

  async waitForExit(): Promise<void> {
    await this.exited
  }

  terminateForHostExit(): void {
    try { this.runner.kill('SIGKILL') } catch { /* Host exit continues with other live runners. */ }
  }
}

/**
 * Launch one target through a runner that uniquely owns its Job handle.
 * @param spec - ordinary target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner launch seams used by tests.
 * @returns direct streams, result, and runner-owned managed range.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  const ignoredStdinFd = spec.stdio.stdin === 'ignore' ? openSync(devNull, 'r') : undefined
  let child: RunnerProcess
  try {
    child = (internals.spawn ?? spawn)(command, [
      ...prefix,
      '--',
      ...spec.argv,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      env: runnerEnvironment(WINDOWS_RUNNER_SELECTION, invocation),
      stdio: runnerStdio(spec, true, ignoredStdinFd ?? 'pipe'),
    }) as RunnerProcess
  } finally {
    if (ignoredStdinFd !== undefined) closeSync(ignoredStdinFd)
  }
  const targetStdin = child.stdio[4] as Writable | null

  const direct = Promise.withResolvers<SubprocessOutcome>()
  const rangeExit = Promise.withResolvers<undefined>()
  let directResultType: WindowsRunnerResult['type'] | undefined
  let runnerSpawned = false
  let runnerExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
  let ipcDisconnected = false
  const failInfrastructure = (error: unknown): void => {
    direct.reject(error)
    rangeExit.reject(error)
  }
  const settleRange = (): void => {
    if (!runnerSpawned || runnerExit === undefined) return
    const { exitCode, signal } = runnerExit
    if (exitCode === 0 && signal === null) {
      if (directResultType !== undefined) {
        rangeExit.resolve(undefined)
        return
      }
      // The private IPC result may arrive after the process-exit notification.
      if (!ipcDisconnected) return
    }
    const status = signal !== null
      ? `signal ${signal}`
      : exitCode === null ? 'without an exit status' : `exit code ${String(exitCode)}`
    failInfrastructure(new Error(
      `subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`,
    ))
  }

  const owner = new WindowsJobOwner(
    child,
    rangeExit.promise,
    () => directResultType,
    failInfrastructure,
  )
  child.on('message', (value: unknown) => {
    if (directResultType !== undefined) {
      const error = new Error('subprocess-local: Windows runner emitted more than one direct result')
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    let result: ReturnType<typeof parseWindowsRunnerResult>
    try {
      result = parseWindowsRunnerResult(value)
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    directResultType = result.type
    if (result.type === 'target-exit') {
      direct.resolve({ exitCode: result.exitCode, signal: null })
    } else {
      direct.reject(owner.mapStartFailure(deserializeRunnerError(result.error), result.error))
    }
    settleRange()
  })
  child.once('spawn', () => {
    runnerSpawned = true
    try {
      if (child.send === undefined) throw new Error('subprocess-local: Windows runner has no IPC channel')
      child.send({ type: 'start', cwd: spec.cwd, env: targetEnv, ...spec.stdio.control === undefined ? {} : { control: spec.stdio.control } }, (error) => {
        if (error === null) return
        failInfrastructure(error)
        owner.terminateForHostExit()
      })
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
    }
  })
  child.once('error', (error) => {
    if (!runnerSpawned) {
      direct.reject(error)
      rangeExit.resolve(undefined)
      return
    }
    failInfrastructure(error)
  })
  child.once('exit', (exitCode, signal) => {
    runnerExit = { exitCode, signal }
    settleRange()
  })
  child.once('disconnect', () => {
    ipcDisconnected = true
    settleRange()
  })

  return {
    stdin: spec.stdio.stdin === 'ignore' ? null : targetStdin,
    stdout: child.stdio[5] as Readable | null,
    stderr: child.stdio[6] as Readable | null,
    control: controlPipe(child, spec.stdio.control),
    direct: direct.promise,
    owner,
  }
}
