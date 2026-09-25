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

import { readdirSync, readFileSync } from 'node:fs'
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
import type { CodexPermissionMode } from './run.ts'

/** The registered LLM route this package's continuable members resolve to. */
export const CODEX_MEMBER_ROUTE = 'codex-member'

/** Fixed model id advertised on the member route; the configured Codex model governs the external thread. */
export const CODEX_MEMBER_MODEL = 'codex'

/** Options carried from the provider's resolved config into each member turn. */
export interface CodexMemberConfig {
  readonly cwd: string
  readonly model?: string
  readonly permissionMode: CodexPermissionMode
  readonly env: Record<string, string>
  readonly disposeGraceMs: number
}

interface CodexRolloutPayload {
  readonly type?: string
  readonly role?: string
  readonly message?: string
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

interface CodexRolloutEntry {
  readonly type?: string
  readonly payload?: CodexRolloutPayload
}

/** Extract user-authored text from one rollout entry, across codex-rs payload variants. */
function rolloutUserText(entry: CodexRolloutEntry): string | undefined {
  const payload = entry.payload
  if (payload === undefined) return undefined
  if (payload.type === 'user_message') return payload.message ?? ''
  if (payload.type === 'message' && payload.role === 'user') {
    return (payload.content ?? [])
      .filter(block => block.type === 'input_text')
      .map(block => block.text ?? '')
      .join('')
  }
  return undefined
}

/** Extract assistant-authored text from one rollout entry, across codex-rs payload variants. */
function rolloutAgentText(entry: CodexRolloutEntry): string | undefined {
  const payload = entry.payload
  if (payload === undefined) return undefined
  if (payload.type === 'agent_message') return payload.message ?? ''
  if (payload.type === 'message' && payload.role === 'assistant') {
    return (payload.content ?? [])
      .filter(block => block.type === 'output_text')
      .map(block => block.text ?? '')
      .join('')
  }
  return undefined
}

/**
 * Locate the rollout file for one durable thread under `~/.codex/sessions`.
 * @param externalId - the thread identity encoded in the rollout filename.
 * @returns the absolute rollout path, or `undefined` when absent.
 */
function codexRolloutPath(externalId: string): string | undefined {
  const root = join(homedir(), '.codex', 'sessions')
  const queue: string[] = [root]
  while (queue.length > 0) {
    const dir = queue.pop() as string
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && entry.name.endsWith(`${externalId}.jsonl`)) return path
    }
  }
  return undefined
}

/**
 * Read the durable Codex rollout transcript and prove the state of one issued
 * prompt: a later agent message means `result`, no matching user message
 * means `absent`, and a matched user message with no later agent message
 * means `unknown`.
 * @param externalId - the durable thread identity.
 * @param pending - the issued prompt exactly as sent.
 * @returns the provable state.
 */
export function recoverCodexThread(
  externalId: string,
  pending: ExternalPendingPrompt,
): ExternalRecovery {
  const path = codexRolloutPath(externalId)
  if (path === undefined) return { kind: 'absent' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'unknown' }
  }
  const entries: CodexRolloutEntry[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      entries.push(JSON.parse(line) as CodexRolloutEntry)
    } catch {
      // A torn tail write is ordinary after a crash; the parseable prefix stays authoritative.
      break
    }
  }
  const promptIndex = entries.findLastIndex(entry => rolloutUserText(entry) === pending.prompt)
  if (promptIndex < 0) return { kind: 'absent' }
  const texts: string[] = []
  for (let i = promptIndex + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === undefined) continue
    const text = rolloutAgentText(entry)
    if (text !== undefined && text !== '') texts.push(text)
  }
  return texts.length === 0 ? { kind: 'unknown' } : { kind: 'result', text: texts.join('\n') }
}

/** One open Codex thread bound to one member turn or recovery pass. */
class CodexMemberSession implements ExternalMemberSession {
  /** The durable thread id; minted at `thread/start` inside the first turn. */
  externalId: string | undefined
  private child: SubprocessHandle | undefined
  private wire: CodexAppServerWire | undefined

  constructor(
    private readonly config: CodexMemberConfig,
    private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
    externalId: string | undefined,
    private readonly signal: AbortSignal,
  ) {
    this.externalId = externalId
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<string | ExternalTurnBound | ExternalTurnOutcome> {
    const child = this.spawn({
      argv: codexAppServerArgv(),
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
      if (this.externalId !== undefined) yield { bound: this.externalId }
    } else {
      await wire.resumeThread(this.externalId, signal)
    }
    const result = await wire.runTurn([prompt], signal)
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
    return Promise.resolve(recoverCodexThread(this.externalId, pending))
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
  constructor(
    private readonly config: CodexMemberConfig,
    private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  ) {}

  open(externalId: string | undefined, signal: AbortSignal): Promise<ExternalMemberSession> {
    return Promise.resolve(new CodexMemberSession(this.config, this.spawn, externalId, signal))
  }
}

/** LLM adapter owning the member route; each model call becomes one external turn. */
export class CodexMemberAdapter extends LlmAdapter {
  constructor(
    private readonly transport: ExternalMemberTransport,
    private readonly store: ExternalBindingStore,
  ) {
    super()
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
