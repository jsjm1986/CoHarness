/**
 * Fresh-process SDK subagent client. Drives one child DeepSeek Harness
 * runtime over stdio JSON-RPC through `@deepseek-ai/dsh-sdk-client` and owns
 * cancellation and quiescent disposal. It publishes after the child
 * handshake, maps child failures to stop reasons, and tears down to
 * quiescence. The SDK client spawns the child rather than using
 * `ctx.subprocess` — the subprocess seam's documented exception for
 * SDK-managed transports — so this driver applies the seam's shared env scrub.
 *
 * @module @deepseek-ai/dsh-subagent-dsh-sdk/run
 */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type HarnessNotification,
  JsonRpcResponseError,
  SdkProtocolError,
  TransportClosedError,
} from '@deepseek-ai/dsh-sdk-client'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'

/** Resolved spawn spec for an SDK runtime child process (no defaults — see Config). */
export interface SdkRunSpec {
  /** Synchronous owner check before native startup, first turn dispatch and publication. */
  assertOwnership?: () => void
  /** Managed parent verification after the SDK handshake and before publication. */
  onInitialized?: () => void
  /** Explicit dsh CLI module; omission resolves the SDK client's same-version dependency. */
  dshBin?: string
  /** Named child profile. */
  profile: string
  /** Ordered per-launch profile patch files. */
  patches: string[]
  /** Absolute isolated Harness home for the nested runtime. */
  dshHome: string
  /** Absolute initial working directory selected by the delegating runtime. */
  cwd: string
  /** Parent origin directory recorded independently of the child's effective directory. */
  originCwd?: string | undefined
  /** Provider route the child runtime initializes with. */
  provider: string
  /** Model the child runtime initializes with. */
  model: string
  /** Optional adapter-owned reasoning effort sent in the child runtime's initialize handshake. */
  reasoningEffort?: ReasoningEffortId
  /** Optional per-request output-token cap sent in the child runtime's initialize handshake. */
  maxTokens?: number
  /**
   * Extra environment variables to ADD for the child (e.g. the child
   * runtime's own `DEEPSEEK_API_KEY`). Merged after
   * the seam's `scrubbedParentEnv()` base, so an explicit credential or
   * current `DSH_*` fact survives while ambient namesakes never leak.
   */
  env: Record<string, string>
  /** Bound (ms) on the protocol `initialize` handshake during start. */
  initializeTimeoutMs: number
  /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
  shutdownTimeoutMs: number
  /** Grace period (ms) for the child's EOF-driven quiesce on dispose. */
  disposeEofGraceMs: number
  /** Termination confirmation window (ms), including forced exit on every platform. */
  disposeGraceMs: number
  /**
   * Host sink for startup, published-run, or shutdown failures. Model-visible
   * text uses fixed safe facts, while this callback retains the original Error.
   * A throw from the sink itself is contained.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Default bound on the protocol `initialize` handshake during start. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000

/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Default bound on the protocol `shutdown` exchange during dispose. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000

/** A rejected unpublished SDK start retains its original cleanup owner. */
export class SdkStartupCleanupError extends AggregateError {
  private completion: Promise<void> | undefined

  /** @param failure - original startup and cleanup failures. @param rollback - original process and accounting cleanup. */
  constructor(failure: Error, private readonly rollback: () => Promise<void>) {
    super(failure instanceof AggregateError ? failure.errors : [failure], failure.message, { cause: failure })
    this.name = 'SdkStartupCleanupError'
  }

  /** Retry retained cleanup without reallocating the child. @returns acknowledged cleanup, shared while pending and after success. */
  cleanup(): Promise<void> {
    return this.completion ??= Promise.resolve().then(() => this.rollback()).catch((error: unknown) => {
      this.completion = undefined
      throw error
    })
  }
}

type SdkFailureStage = 'initialize' | 'session-run' | 'shutdown'

type SdkFailureCategory =
  | 'configuration'
  | 'protocol'
  | 'transport'
  | 'child-error'
  | 'child-disposed'
  | 'child-unknown'
  | 'missing-terminal'
  | 'unknown'

interface SdkFailureFacts {
  readonly stage: SdkFailureStage
  readonly category: SdkFailureCategory
}

/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(facts: SdkFailureFacts): string {
  const fields = [
    'provider: DSH SDK',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  return `Subagent failure (${fields.join('; ')})`
}

class SdkRunFailure extends Error {
  constructor(readonly facts: SdkFailureFacts, cause: unknown) {
    super(`subagent-dsh-sdk: ${failureDiagnostic(facts)}`, { cause })
    this.name = 'SdkRunFailure'
  }
}

/** Runtime constructor seam replaced only by package-local fake-runtime tests. */
export const internals: { createHarness(options: DeepSeekHarnessOptions): DeepSeekHarness } = {
  createHarness: options => new DeepSeekHarness(options),
}

/**
 * Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
 * @param cause - original Host failure retained on the Error cause chain.
 * @returns an Error whose message contains only the fixed DSH SDK failure line.
 */
export function sdkConfigurationFailure(cause: unknown): Error {
  return new SdkRunFailure({ stage: 'initialize', category: 'configuration' }, cause)
}

/** Classify one SDK rejection without reading its message or stderr tail. */
function sdkFailure(error: unknown, stage: SdkFailureStage): SdkRunFailure {
  const facts: SdkFailureFacts = error instanceof TransportClosedError
    ? { stage, category: 'transport' }
    : error instanceof SdkProtocolError || error instanceof JsonRpcResponseError
      ? { stage, category: 'protocol' }
      : { stage, category: 'unknown' }
  return new SdkRunFailure(facts, error)
}

/**
 * Map one child terminal reason to its complete shared result outcome.
 * @param reason - the owned child run's final durable turn reason, or
 * `undefined` when it settled without running a turn.
 * @returns the shared stop reason and any additional safe diagnostic.
 */
export function sdkChildOutcome(
  reason: TurnEndReason | undefined,
): Pick<SubagentResult, 'stopReason' | 'diagnostic'> {
  switch (reason?.kind) {
    case 'completed':
      return { stopReason: 'completed' }
    case 'max-tokens':
      return { stopReason: 'max-tokens' }
    case 'aborted':
      return reason.reason.kind === 'disposed'
        ? {
          stopReason: 'aborted',
          diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-disposed' }),
        }
        : { stopReason: 'aborted' }
    case 'blocked':
      return { stopReason: 'refusal' }
    case 'error':
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-error' }),
      }
    case 'interrupted':
      return { stopReason: 'error' }
    case undefined:
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'missing-terminal' }),
      }
    default:
      return {
        stopReason: 'error',
        diagnostic: failureDiagnostic({ stage: 'session-run', category: 'child-unknown' }),
      }
  }
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The catch only sees rejections from the SDK client, which are always
  // `Error`s; the `String(value)` arm is a defensive fallback for a non-Error
  // throw that the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Report an original Host failure without letting the observation sink replace it. */
function reportFailure(spec: SdkRunSpec, error: unknown): void {
  try {
    spec.onError?.(toError(error), 'error')
  } catch {
    // Host diagnostic logging cannot replace the child failure.
  }
}

/** Map an SDK-owned failed-start aggregate into safe initialize/shutdown lines. */
function sdkStartupFailure(spec: SdkRunSpec, error: unknown): Error {
  if (!(error instanceof AggregateError) || error.errors.length < 2) {
    reportFailure(spec, error)
    return sdkFailure(error, 'initialize')
  }
  const initializeError: unknown = error.errors[0]
  const cleanupError: unknown = error.errors[1]
  reportFailure(spec, initializeError)
  reportFailure(spec, cleanupError)
  const initializeFailure = sdkFailure(initializeError, 'initialize')
  const cleanupFailure = new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, cleanupError)
  return new AggregateError(
    [initializeFailure, cleanupFailure],
    `${initializeFailure.message}; ${cleanupFailure.message}`,
  )
}

/**
 * Start and publish one SDK runtime child after its `initialize` handshake.
 * Child failures resolve through the run result. Startup rejects with fixed
 * safe facts after SDK-owned cleanup; successful cleanup proves process reap.
 * Cleanup failure transfers retryable ownership through SdkStartupCleanupError
 * and preserves initialize plus shutdown for an ordinary failure,
 * or shutdown alone after cancellation, without claiming quiescence. Disposal
 * shuts the runtime down and reaps it.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: profile/patches/home/cwd, the child's
 * provider/model/reasoning route, output cap, env, timeouts, and the optional
 * error sink.
 * @param admission - optional process permit transferred to this function, including failed startup cleanup.
 * @returns the ready run handle for the child subprocess.
 * @throws SdkStartupCleanupError when rollback still owns a process, control endpoint or unacknowledged permit.
 */
export async function startSdkRun(request: SubagentStartRequest, spec: SdkRunSpec, admission?: ResourceLease): Promise<SubagentRun> {
  if (request.signal.aborted) {
    const failure = new Error('subagent request was aborted before the SDK child started')
    try { await admission?.release() } catch (cleanupError) {
      throw new SdkStartupCleanupError(new AggregateError([failure, cleanupError], 'SDK cancelled startup and unused permit release failed.'),
        async () => { await admission?.release() })
    }
    throw failure
  }
  // The run id lives in the parent namespace; the child runtime's session id
  // (minted below, private to the wire) exists only inside the child process.
  const id = brandString<SessionId>(randomUUID())

  let harness: DeepSeekHarness
  try {
    spec.assertOwnership?.()
    harness = internals.createHarness({
      ...spec.dshBin === undefined ? {} : { dshBin: spec.dshBin },
      profile: spec.profile,
      patches: spec.patches,
      dshHome: spec.dshHome,
      processCwd: spec.cwd,
      env: { ...scrubbedParentEnv(), ...spec.env },
      initializeTimeoutMs: spec.initializeTimeoutMs,
      shutdownTimeoutMs: spec.shutdownTimeoutMs,
      disposeEofGraceMs: spec.disposeEofGraceMs,
      disposeGraceMs: spec.disposeGraceMs,
      cwd: spec.originCwd ?? spec.cwd,
      provider: spec.provider,
      model: spec.model,
      ...spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort },
      ...spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens },
    })
  } catch (error: unknown) {
    try { await admission?.release() } catch (releaseError: unknown) {
      throw new SdkStartupCleanupError(new AggregateError([error, releaseError], 'SDK child construction and unused permit release failed.'),
        async () => { await admission?.release() })
    }
    throw error
  }
  const closeOwned = async (): Promise<void> => {
    try { await harness.close() } catch (error: unknown) {
      try { await admission?.uncertain() } catch (accountingError: unknown) {
        throw new AggregateError([error, accountingError], 'SDK child cleanup and uncertain accounting failed.')
      }
      throw error
    }
    await admission?.release()
  }

  // Cancellation settles the result without waiting for a cooperative child.
  const flags = { cancelled: false }
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const cancelledStartup = new Error('subagent cancelled before the SDK child initialized')

  // Establish the child handshake before publishing a handle. Any failure
  // owns the still-private process and reaps it before rejecting.
  try {
    spec.assertOwnership?.()
    await Promise.race([
      harness.start(),
      cancelSettled.then((): never => { throw cancelledStartup }),
    ])
    // Defensive: an abort() is a macrotask and no user callback runs inside
    // the microtask drain between handshake fulfillment and this continuation,
    // so current callback ordering cannot schedule the recheck; it guards future reentrancy.
    /* v8 ignore next */
    if (flags.cancelled) throw cancelledStartup
    spec.assertOwnership?.()
    spec.onInitialized?.()
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    try {
      await closeOwned()
    } catch (cleanupError: unknown) {
      if (error !== cancelledStartup) {
        const initializeError: unknown = error instanceof AggregateError ? error.errors[0] : error
        throw new SdkStartupCleanupError(sdkStartupFailure(spec,
          new AggregateError([initializeError, cleanupError], 'SDK child start and cleanup failed.')), closeOwned)
      }
      reportFailure(spec, cleanupError)
      const cleanupFailure = new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, cleanupError)
      // Preserve failed cleanup as a failed Job; settleStart treats only an
      // aborted non-AggregateError rejection as a cleanly killed startup.
      throw new SdkStartupCleanupError(new AggregateError([cleanupFailure], cleanupFailure.message), closeOwned)
    }
    if (error !== cancelledStartup) throw sdkStartupFailure(spec, error)
    throw new Error('subagent request was aborted before the SDK child started')
  }

  const childSessionId = `session-${randomUUID().replaceAll('-', '')}`
  // The child's final answer under the seam's canonical selection rule
  // (`AssistantOutputFold`); a partial answer survives cancel and error paths.
  const fold = new AssistantOutputFold()
  const observe = (notification: HarnessNotification): void => {
    if (notification.method !== 'session.event' || notification.params.sessionId !== childSessionId) return
    fold.push(notification.params.event as SessionEvent)
  }
  const collectOutput = (): readonly ContentBlock[] => fold.collect() ?? []
  const teardown = async (): Promise<void> => {
    try {
      await closeOwned()
    } catch (error: unknown) {
      reportFailure(spec, error)
      throw new SdkRunFailure({ stage: 'shutdown', category: 'unknown' }, error)
    }
  }

  // Race the child turn against local cancellation; the shared settlement
  // flattens failures under the seam's never-reject contract.
  let diagnostic: string | undefined
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        // The child session's origin is the parent's project root; move its
        // effective directory to the delegation-selected cwd before the turn.
        await harness.session(childSessionId).setWorkingDirectory(spec.cwd)
        spec.assertOwnership?.()
        const turn = await Promise.race([
          harness.session(childSessionId).run(request.prompt, { onNotification: observe }),
          cancelSettled.then(() => 'cancelled' as const),
        ])
        if (turn === 'cancelled') return { output: collectOutput(), stopReason: 'aborted' }
        const lastEnd = turn.events.findLast(
          (event): event is Extract<SessionEvent, { type: 'turn/end' }> => event.type === 'turn/end',
        )
        const outcome = sdkChildOutcome(lastEnd?.data.reason)
        diagnostic = outcome.diagnostic
        return {
          output: collectOutput(),
          ...outcome,
        }
      } catch (error: unknown) {
        diagnostic = failureDiagnostic(sdkFailure(error, 'session-run').facts)
        throw error
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  // There is no wire-level prompt cancel: dispose settles the result locally,
  // then the bounded shutdown request + dispose ladder tears the child down.
  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown,
  })
}
