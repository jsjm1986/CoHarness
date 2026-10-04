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
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
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
  private child: SubprocessHandle | undefined
  private wire: CodexAppServerWire | undefined
  private readonly config: CodexMemberConfig
  private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  private readonly signal: AbortSignal

  constructor(
    config: CodexMemberConfig,
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
    externalId: string | undefined,
    signal: AbortSignal,
  ) {
    this.config = config
    this.spawn = spawn
    this.signal = signal
    this.externalId = externalId
  }

  async *turn(
    prompt: string, signal: AbortSignal, started?: (turnId: string) => void,
  ): AsyncIterable<string | ExternalTurnBound | ExternalTurnOutcome> {
    const child = this.spawn({
      argv: codexAppServerArgv(this.config.executable),
      cwd: this.config.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.config.disposeGraceMs,
      env: this.config.env,
      signal: this.signal,
    })
    this.child = child
    const wire = new CodexAppServerWire(
      child.stdout as NonNullable<SubprocessHandle['stdout']>,
      child.stdin as NonNullable<SubprocessHandle['stdin']>,
      this.config.permissionMode,
      this.config.model,
    )
    this.wire = wire
    wire.start()
    await wire.initialize(signal)
    if (this.externalId === undefined) {
      await wire.startThread(this.config.cwd, signal, false)
      this.externalId = wire.collectThreadId()
      // Publish the minted identity before the prompt issues: the consumer
      // persists the binding and marks the prompt pending while this
      // generator is suspended here, so a crash during runTurn leaves the
      // issued prompt recoverable rather than resent to a fresh thread.
      /* v8 ignore else -- wire.startThread throws when the response carries no
         thread id, so collectThreadId cannot return undefined here. */
      if (this.externalId !== undefined) yield { bound: this.externalId }
    } else {
      await wire.resumeThread(this.externalId, signal)
    }
    const result = await wire.runTurn([prompt], signal, started)
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

  async dispose(): Promise<void> {
    const wire = this.wire
    const child = this.child
    this.wire = undefined
    this.child = undefined
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
}

/** Transport factory for Codex member sessions. */
export class CodexMemberTransport implements ExternalMemberTransport {
  private readonly config: CodexMemberConfig
  private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle

  constructor(
    config: CodexMemberConfig,
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  ) {
    this.config = config
    this.spawn = spawn
  }

  open(externalId: string | undefined, signal: AbortSignal): Promise<ExternalMemberSession> {
    return Promise.resolve(new CodexMemberSession(this.config, this.spawn, externalId, signal))
  }
}

/** LLM adapter owning the member route; each model call becomes one external turn. */
export class CodexMemberAdapter extends LlmAdapter {
  private readonly transport: ExternalMemberTransportSource
  private readonly store: ExternalBindingStore

  constructor(transport: ExternalMemberTransportSource, store: ExternalBindingStore) {
    super()
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
