/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified provider-managed process ranges with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'
import { ResourceAdmissionError, resourceBudgetOf, type ResourceBudget, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

/** Provider-owned cleanup proof consumed before a failed allocation reaches its caller. */
class QuiescentAllocationFailure extends Error {
  constructor(readonly failure: unknown) { super('Subprocess allocation cleanup confirmed', { cause: failure }) }
}

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalActivity,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * The ambient parent environment minus credential-shaped names, the systemd
 * `CREDENTIALS_DIRECTORY` locator, and all `DSH_*` names — the canonical base every harness child starts from. `PATH`,
 * `HOME`, locale, and proxy variables survive, so child CLIs run normally;
 * harness identity never leaks implicitly (a deliberately forwarded
 * credential or current `DSH_*` fact goes through the spec's explicit `env`,
 * which merges after this scrub). Both scrubs match case-insensitively:
 * Windows environment names are case-insensitive, so a parent `dsh_*` entry
 * would otherwise survive and read back as `$env:DSH_*` in the child;
 * deliberate lowercase `dsh_*` names on POSIX are implausible. Exported as a plain function so spawners
 * that cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 *
 * A parent chain launched without a locale (launchd, systemd, a stripped
 * service environment) leaves children in the POSIX `C` locale, where
 * non-ASCII text — CJK filenames are the visible case — renders as `?`.
 * The scrub therefore defaults `LANG` to a UTF-8 locale when the parent
 * exported none; per POSIX precedence an ambient `LC_ALL`/`LC_CTYPE` still
 * wins, and a spec `env` entry or `undefined` tombstone can still override.
 *
 * When a proxy is active the result also carries the resolved proxy names and the flag a child Node
 * needs to honor them, so a child inherits the same routing as its parent.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)
      && key.toUpperCase() !== 'CREDENTIALS_DIRECTORY') env[key] = value
  }
  // A child Node ignores the inherited proxy variables unless the flag this adds is set, so an MCP
  // stdio server or subagent CLI would connect directly while its parent proxies. The same overlay
  // restores each proxy name to what the user exported, undoing this process's own normalization —
  // `undefined` removes a name the user never set.
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === undefined) Reflect.deleteProperty(env, name)
    else env[name] = value
  }
  if (!('LANG' in env)) env.LANG = 'C.UTF-8'
  return env
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * Abstract subprocess service. Subclass, implement its allocation methods, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Executable paths belong to one execution world shared with the mounted
 *   filesystem provider.
 * - {@link spawn} waits for resource admission and verifies its original provider before allocation.
 *   A provider withdrawn or replaced during the wait refuses allocation and returns the unused grant.
 *   Target identity remains
 *   provider-private; `done` resolves with the spawned command's exit facts and
 *   may reject for spawn or provider failures.
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.terminate} (and the spec's abort signal) starts the
 *   provider's documented procedure against its managed range.
 *   {@link SubprocessHandle.waitForExit} observes that same range so a
 *   consumer-owned teardown ladder can hold each tier on real quiescence; each
 *   provider documents its signalling and observability limits.
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 * - {@link spawnTerminal} owns terminal allocation, text transport,
 *   foreground groups, signalling, and whole-session quiescence behind one
 *   awaited termination method; readiness and persistent-shell policy stay
 *   in the PTY consumer. Its output stream ends after queued terminal output
 *   when the top-level process exits.
 */
export abstract class SubprocessRuntime extends Service {
  private readonly allocationLifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'subprocess')
    ctx.effect(() => async () => {
      this.allocationLifetime.abort(new Error('Subprocess provider disposed'))
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
    })
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }

  private async admission(spec: Pick<SubprocessSpawnSpec, 'signal' | 'sessionId' | 'resourceOrigin'>): Promise<{
    owner: ResourceBudget | undefined
    lease: ResourceLease | undefined
    signal: AbortSignal
  }> {
    const caller = spec.signal === undefined
      ? this.allocationLifetime.signal : AbortSignal.any([spec.signal, this.allocationLifetime.signal])
    caller.throwIfAborted()
    const owner = resourceBudgetOf(this.ctx)
    const lease = await owner?.acquire({ kind: 'process', signal: caller,
      ...(spec.sessionId === undefined ? {} : { sessionId: spec.sessionId }),
      ...(spec.resourceOrigin === undefined ? {} : { origin: spec.resourceOrigin }),
    })
    const signal = lease === undefined ? caller : AbortSignal.any([caller, lease.signal])
    return { owner, lease, signal }
  }

  /** Refuse a cancelled grant or a resource owner changed before provider allocation. */
  private assertAdmission(owner: ResourceBudget | undefined, signal: AbortSignal): void {
    signal.throwIfAborted()
    const current = resourceBudgetOf(this.ctx)
    const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
      (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
    if (original(current) !== original(owner)) {
      throw new ResourceAdmissionError('unavailable', 'Process resource admission changed; retry with its current provider.')
    }
  }

  /**
   * Retain admission at provider entry for checks after asynchronous preparation.
   * @param spec - allocation request carrying the shared service's cancellation signal.
   * @returns a synchronous check to call immediately before physical start dispatch.
   */
  protected captureAdmissionCheck(spec: Pick<SubprocessSpawnSpec, 'signal'>): () => void {
    const owner = resourceBudgetOf(this.ctx)
    const signal = spec.signal ?? this.allocationLifetime.signal
    return () => { this.assertAdmission(owner, signal) }
  }

  /**
   * Reject an allocation whose provider has confirmed all physical work stopped.
   * @param failure - original allocation error to preserve after permit completion.
   * @returns never; the public allocation rejects with the original failure after releasing its permit.
   */
  protected rejectAfterCleanup(failure: unknown): never {
    throw new QuiescentAllocationFailure(failure)
  }

  private async rejectAllocation(error: unknown, lease: ResourceLease | undefined): Promise<never> {
    const confirmed = error instanceof QuiescentAllocationFailure
    const failure = confirmed ? error.failure : error
    try {
      if (confirmed) await lease?.release()
      else await lease?.uncertain()
    } catch (completionError) {
      throw new AggregateError([failure, completionError], 'Subprocess allocation and resource accounting failed.')
    }
    throw failure
  }

  /**
   * Resolve one configured executable in this provider's execution world.
   * Absolute paths are verified; bare names use the provider's scrubbed PATH
   * plus explicit environment overrides. Relative paths containing separators
   * are rejected: the resolution base is undefined, so providers fail loud
   * instead of guessing.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts remote or local lookup.
   * @returns a canonical executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  /**
   * Inspect shell-selection facts in the provider's execution environment.
   * @param signal - cancellation of remote environment inspection.
   * @returns platform and preferred shell; executable lookup and allocation remain separate operations.
   */
  abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle after admission and allocation; rejection may retain uncertain accounting.
   */
  spawn(spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
    return this.track(this.allocateProcess(spec))
  }

  private async allocateProcess(spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
    const { owner, lease, signal } = await this.admission(spec)
    try { this.assertAdmission(owner, signal) } catch (error) { await lease?.release(); throw error }
    let handle: SubprocessHandle
    try { handle = await this.spawnProcess({ ...spec, signal }) } catch (error) {
      return this.rejectAllocation(error, lease)
    }
    if (lease === undefined) return handle
    const waitForExit = async (bound?: AbortSignal): Promise<boolean> => {
      let exited: boolean
      try { exited = await handle.waitForExit(bound) } catch (error) {
        await lease.uncertain()
        throw error
      }
      if (exited) await lease.release()
      else await lease.uncertain()
      return exited
    }
    const observe = (): Promise<unknown> => waitForExit()
    void this.track(handle.done.then(observe, observe)).catch((error: unknown) => { this.ctx.logger.error(error) })
    return {
      stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control,
      collected: handle.collected, done: handle.done, terminate: () => { handle.terminate() }, waitForExit,
    }
  }

  /**
   * Allocate a provider-owned process after admission; failures may leave unconfirmed work.
   * @param spec - fully specified allocation with combined owner cancellation.
   * @returns a handle whose waitForExit observes every process in its managed range.
   */
  protected abstract spawnProcess(spec: SubprocessSpawnSpec): SubprocessHandle | Promise<SubprocessHandle>

  /**
   * Allocate a real terminal and start one owned process session. This is the
   * only non-pipe process primitive: implementations own terminal byte I/O,
   * foreground groups, signals, and whole-session quiescence.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation succeeds.
   */
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return this.track(this.allocateTerminal(spec))
  }

  private async allocateTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const allocation = new AbortController()
    const cancelled = (): void => { allocation.abort(spec.signal?.reason) }
    spec.signal?.addEventListener('abort', cancelled, { once: true })
    if (spec.signal?.aborted) cancelled()
    try {
      const terminal = await this.allocateTerminalSession({ ...spec, signal: allocation.signal })
      if (spec.signal?.aborted) { await terminal.terminate(); spec.signal.throwIfAborted() }
      return terminal
    } finally { spec.signal?.removeEventListener('abort', cancelled) }
  }

  private async allocateTerminalSession(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const { owner, lease, signal } = await this.admission(spec)
    try { this.assertAdmission(owner, signal) } catch (error) { await lease?.release(); throw error }
    let handle: SubprocessTerminalHandle
    try { handle = await this.spawnTerminalProcess({ ...spec, signal }) } catch (error) {
      return this.rejectAllocation(error, lease)
    }
    if (lease === undefined) return handle
    const terminate = async (): Promise<void> => {
      try { await handle.terminate() } catch (error) {
        await lease.uncertain()
        throw error
      }
      signal.removeEventListener('abort', onAbort)
      await lease.release()
    }
    const onAbort = (): void => {
      void this.track(terminate()).catch((error: unknown) => { this.ctx.logger.error(error) })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    void this.track(handle.done.then(terminate, terminate)).catch((error: unknown) => { this.ctx.logger.error(error) })
    return {
      pid: handle.pid, output: handle.output, done: handle.done,
      write: data => handle.write(data), resize: (cols, rows) => handle.resize(cols, rows),
      inspectActivity: () => handle.inspectActivity(), inspectForeground: () => handle.inspectForeground(),
      signalForeground: value => handle.signalForeground(value), terminate,
    }
  }

  /**
   * Allocate a provider-owned terminal after admission; failures may leave unconfirmed work.
   * @param spec - fully specified allocation with combined owner cancellation.
   * @returns a terminal whose termination confirms whole-session quiescence.
   */
  protected abstract spawnTerminalProcess(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessRuntime

/** Executable lookup completed without finding an executable file. */
export class SubprocessExecutableNotFoundError extends Error {
  /**
   * @param message - provider-specific lookup diagnostic.
   * @param options - original provider failure, when available.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SubprocessExecutableNotFoundError'
  }
}
