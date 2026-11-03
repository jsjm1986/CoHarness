/**
 * Persistent-member support: an `LlmAdapter` route that turns each model call
 * into one turn on a durable Codex app-server thread, plus the
 * `ExternalMemberTransport` that spawns the app-server, resumes the thread,
 * prompts, recovers, and disposes it. The app-server persists threads under
 * `~/.codex/sessions/`; recovery reads that rollout transcript directly and
 * never issues another prompt.
 *
 * @module @deepseek-ai/dsh-subagent-codex/member
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallKind, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { ManagedCodexModel } from './managed-model.ts'
import {
  ExternalBindingStore,
  externalMemberTurn,
  type ExternalMemberSession,
  type ExternalMemberTransport,
  type ExternalMemberTransportSource,
  type ExternalPendingPrompt,
  type ExternalRecovery,
  type ExternalTurnBound,
  type ExternalTurnOutcome,
} from '@deepseek-ai/dsh-subagent/external'
import {
  codexAppServerArgv,
  disposeCodexChild,
} from './run.ts'
import { CodexAppServerWire } from './wire.ts'
import { recoverCodexThread } from './rollout.ts'
export { recoverCodexThread } from './rollout.ts'
import type { CodexPermissionMode } from './run.ts'

/** The registered LLM route this package's continuable members resolve to. */
export const CODEX_MEMBER_ROUTE = 'codex-member'

/** Fixed model id advertised on the member route; the configured Codex model governs the external thread. */
export const CODEX_MEMBER_MODEL = 'codex'

/** Options carried from the provider's resolved config into each member turn. */
export interface CodexMemberConfig {
  /** Target-local command; absent uses the bundled Host program. */
  readonly executable?: string
  /** Remote rollouts cannot be read from Host storage. */
  readonly remote?: boolean
  readonly cwd: string
  readonly model?: string
  readonly permissionMode: CodexPermissionMode
  readonly env: Record<string, string>
  readonly disposeGraceMs: number
}

/** One open Codex thread bound to one member turn or recovery pass. */
class CodexMemberSession implements ExternalMemberSession {
  /** The durable thread id; minted at `thread/start` inside the first turn. */
  externalId: string | undefined
  private child: Promise<SubprocessHandle> | undefined
  private model: Promise<ManagedCodexModel> | undefined
  private wire: CodexAppServerWire | undefined
  private readonly lifetime = new AbortController()
  private closeTask: Promise<void> | undefined
  private readonly config: CodexMemberConfig
  private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle | Promise<SubprocessHandle>
  private readonly signal: AbortSignal
  private readonly callerSignal: AbortSignal

  constructor(
    config: CodexMemberConfig,
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle | Promise<SubprocessHandle>,
    externalId: string | undefined,
    signal: AbortSignal,
    private readonly openModel?: (signal: AbortSignal) => Promise<ManagedCodexModel>,
  ) {
    this.config = config
    this.spawn = spawn
    this.signal = AbortSignal.any([signal, this.lifetime.signal])
    this.callerSignal = signal
    this.externalId = externalId
  }

  async *turn(
    prompt: string, signal: AbortSignal, started?: (turnId: string) => void,
  ): AsyncIterable<string | ExternalTurnBound | ExternalTurnOutcome> {
    const effective = AbortSignal.any([signal, this.signal])
    effective.throwIfAborted()
    const model = this.openModel === undefined ? undefined : await (this.model ??= this.openModel(effective))
    effective.throwIfAborted()
    this.child = this.spawnOwned({
      argv: codexAppServerArgv(this.config.executable, model?.config),
      cwd: this.config.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.config.disposeGraceMs,
      env: model === undefined ? this.config.env : {
        ...Object.fromEntries(Object.entries(this.config.env).filter(([key]) => !SENSITIVE_ENV_PATTERN.test(key))),
        ...model.env,
      },
    }, AbortSignal.any([signal, this.callerSignal]))
    const child = await this.child
    effective.throwIfAborted()
    const wire = new CodexAppServerWire(
      child.stdout as NonNullable<SubprocessHandle['stdout']>,
      child.stdin as NonNullable<SubprocessHandle['stdin']>,
      this.config.permissionMode,
      model?.model ?? this.config.model,
    )
    this.wire = wire
    wire.start()
    await wire.initialize(effective)
    if (this.externalId === undefined) {
      await wire.startThread(this.config.cwd, effective, false)
      this.externalId = wire.collectThreadId()
      // Publish the minted identity before the prompt issues: the consumer
      // persists the binding and marks the prompt pending while this
      // generator is suspended here, so a crash during runTurn leaves the
      // issued prompt recoverable rather than resent to a fresh thread.
      /* v8 ignore else -- wire.startThread throws when the response carries no
         thread id, so collectThreadId cannot return undefined here. */
      if (this.externalId !== undefined) yield { bound: this.externalId }
    } else {
      await wire.resumeThread(this.externalId, effective)
    }
    const result = await wire.runTurn([prompt], effective, started)
    const text = result.output
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (result.stopReason !== 'completed') {
      throw new Error(`codex member turn ended with stop reason "${result.stopReason}"`)
    }
    yield { text }
  }

  recover(pending: ExternalPendingPrompt, _signal: AbortSignal): Promise<ExternalRecovery> {
    if (this.externalId === undefined) return Promise.resolve({ kind: 'absent' })
    if (this.config.remote === true) return Promise.resolve({ kind: 'unknown' })
    const storageRoot = this.config.env.CODEX_HOME
      ?? join(this.config.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] ?? homedir(), '.codex')
    return Promise.resolve(recoverCodexThread(this.externalId, pending, storageRoot))
  }

  private async spawnOwned(spec: SubprocessSpawnSpec, caller: AbortSignal): Promise<SubprocessHandle> {
    this.lifetime.signal.throwIfAborted()
    const admission = new AbortController()
    const cancel = (): void => { admission.abort(this.lifetime.signal.reason) }
    this.lifetime.signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.spawn({ ...spec, signal: AbortSignal.any([caller, admission.signal]) })
    } finally {
      // A published handle closes through the wire before process termination;
      // owner cancellation applies only while process admission is pending.
      this.lifetime.signal.removeEventListener('abort', cancel)
    }
  }

  dispose(): Promise<void> {
    this.closeTask ??= this.closeOwned()
    return this.closeTask
  }

  private async closeOwned(): Promise<void> {
    this.lifetime.abort()
    const closeProcess = async (): Promise<void> => {
      // Rejected spawn owns no process; the turn already reports its failure.
      const child = await this.child?.catch(() => undefined)
      const wire = this.wire
      this.wire = undefined
      if (wire !== undefined && child !== undefined) {
        await disposeCodexChild(wire, child)
        return
      }
      wire?.close()
      if (child !== undefined) {
        child.terminate()
        await child.waitForExit()
      }
    }
    const model = this.model?.then(owner => owner.close(), () => {
      // Failed preparation publishes no listener; the turn reports that failure.
    })
    const outcomes = await Promise.allSettled([closeProcess(), model])
    const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Codex member model transport and process cleanup failed.')
  }
}

/** Transport factory for Codex member sessions. */
export class CodexMemberTransport implements ExternalMemberTransport {
  private readonly config: CodexMemberConfig
  private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle | Promise<SubprocessHandle>

  constructor(
    config: CodexMemberConfig,
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle | Promise<SubprocessHandle>,
    private readonly openModel?: (signal: AbortSignal) => Promise<ManagedCodexModel>,
  ) {
    this.config = config
    this.spawn = spawn
  }

  open(externalId: string | undefined, signal: AbortSignal): Promise<ExternalMemberSession> {
    return Promise.resolve(new CodexMemberSession(this.config, this.spawn, externalId, signal, this.openModel))
  }
}

/** LLM adapter owning the member route; each model call becomes one external turn. */
export class CodexMemberAdapter extends LlmAdapter {
  override readonly callKind: LlmCallKind
  private readonly transport: ExternalMemberTransportSource
  private readonly store: ExternalBindingStore

  constructor(transport: ExternalMemberTransportSource, store: ExternalBindingStore) {
    super()
    this.callKind = 'orchestration'
    this.transport = transport
    this.store = store
  }

  override providerInfo(provider: string): { readonly id: string; readonly name: string } {
    return { id: provider, name: 'Codex member' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: CODEX_MEMBER_MODEL, name: 'Codex member' }])
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      throw new Error(
        'codex member: auxiliary model calls (compaction, titles, reviews) '
        + 'have no external turn; this member route serves conversation only',
      )
    }
    return externalMemberTurn(options, this.store, this.transport)
  }
}
