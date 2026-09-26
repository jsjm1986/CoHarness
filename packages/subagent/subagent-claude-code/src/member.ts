/**
 * Persistent-member support: an `LlmAdapter` route that turns each model call
 * into one turn on a durable Claude Agent SDK session, plus the
 * `ExternalMemberTransport` that opens, prompts, recovers, and disposes it.
 * The SDK persists sessions under `~/.claude/projects/`; recovery reads that
 * transcript directly and never issues another prompt.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/member
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  query as officialQuery,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
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
import { claudeQueryOptions, disposeClaudeCodeChild, type ClaudeCodeRunSpec } from './run.ts'

/** The registered LLM route this package's continuable members resolve to. */
export const CLAUDE_MEMBER_ROUTE = 'claude-code-member'

/** Fixed model id advertised on the member route; the configured Claude model governs the external session. */
export const CLAUDE_MEMBER_MODEL = 'claude-code'

/**
 * Options carried from the provider's resolved config into each member turn.
 * The workspace is the provider's configured directory, defaulting to the
 * harness launch directory when unset.
 */
export interface ClaudeMemberConfig {
  readonly cwd: string
  readonly model?: string
  readonly permissionMode: NonNullable<Parameters<typeof claudeQueryOptions>[0]['permissionMode']>
  readonly env: Record<string, string>
  readonly disposeGraceMs: number
}

interface ClaudeSessionFileEntry {
  readonly type?: string
  readonly message?: {
    readonly role?: string
    readonly content?: string | readonly { readonly type?: string; readonly text?: string }[]
  }
}

/**
 * Claude Code's project-directory slug under `~/.claude/projects/`: the
 * product flattens every character outside `[a-zA-Z0-9]` to `-`, so
 * separators, drive colons, dots, underscores, and non-ASCII text all fold
 * (`C:\git\cc-plus` reads as `C--git-cc-plus`). The mapping is intentionally
 * lossy — distinct workspaces can share one slug — and recovery accepts that
 * product behavior rather than inventing a decodable scheme.
 * @param cwd - the workspace whose sessions Claude Code files under the slug.
 * @returns the product-encoded project directory name.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Join the text blocks of one session-file message; string content reads as-is. */
function entryText(entry: ClaudeSessionFileEntry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (content === undefined) return ''
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

/**
 * Read the durable Claude session transcript and prove the state of one
 * issued prompt: a later assistant turn means `result`, no matching user
 * entry means `absent`, and a matched user entry with no later assistant turn
 * means `unknown`.
 * @param cwd - the workspace whose project slug holds the session file.
 * @param sessionId - the external session identity.
 * @param pending - the issued prompt exactly as sent.
 * @returns the provable state.
 */
export function recoverClaudeSession(
  cwd: string,
  sessionId: string,
  pending: ExternalPendingPrompt,
): ExternalRecovery {
  let raw: string
  try {
    raw = readFileSync(
      join(homedir(), '.claude', 'projects', projectSlug(cwd), `${sessionId}.jsonl`),
      'utf8',
    )
  } catch {
    return { kind: 'unknown' }
  }
  const entries: ClaudeSessionFileEntry[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      entries.push(JSON.parse(line) as ClaudeSessionFileEntry)
    } catch {
      // A torn tail write is ordinary after a crash; the parseable prefix stays authoritative.
      break
    }
  }
  const promptIndex = entries.findLastIndex(
    entry => entry.type === 'user' && entryText(entry) === pending.prompt,
  )
  if (promptIndex < 0) return { kind: 'absent' }
  const texts: string[] = []
  for (let i = promptIndex + 1; i < entries.length; i++) {
    const entry = entries[i]
    if (entry === undefined || entry.type !== 'assistant') continue
    const text = entryText(entry)
    if (text !== '') texts.push(text)
  }
  return texts.length === 0 ? { kind: 'unknown' } : { kind: 'result', text: texts.join('\n') }
}

/** One open Claude session bound to one member turn or recovery pass. */
class ClaudeMemberSession implements ExternalMemberSession {
  /** The SDK-issued session id; minted inside the first turn's messages. */
  externalId: string | undefined
  private child: SubprocessHandle | undefined
  private queryHandle: Query | undefined
  private readonly controller = new AbortController()

  constructor(
    private readonly config: ClaudeMemberConfig,
    private readonly spawn: ClaudeCodeRunSpec['spawn'],
    externalId: string | undefined,
    signal: AbortSignal,
  ) {
    this.externalId = externalId
    if (signal.aborted) this.controller.abort()
    else signal.addEventListener('abort', () => { this.controller.abort() }, { once: true })
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<string | ExternalTurnBound | ExternalTurnOutcome> {
    const spec: ClaudeCodeRunSpec = {
      cwd: this.config.cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: this.spawn,
      onError: () => undefined,
    }
    const options = {
      ...claudeQueryOptions(spec, this.controller, (child) => {
        this.child = child
      }, () => undefined),
      persistSession: true,
      ...this.externalId === undefined ? {} : { resume: this.externalId },
    }
    const q = officialQuery({ prompt, options })
    this.queryHandle = q
    let result: ExternalTurnOutcome | undefined
    let failure: Error | undefined
    // A fresh session reports its id on the init message, while the prompt is
    // still in flight; publishing it immediately lets the caller persist the
    // binding and pending record before the result can arrive unrecorded.
    let needsBind = this.externalId === undefined
    try {
      for await (const message of q) {
        signal.throwIfAborted()
        this.captureSessionId(message)
        if (needsBind && this.externalId !== undefined) {
          needsBind = false
          yield { bound: this.externalId }
        }
        if (message.type !== 'result') continue
        if (message.subtype === 'success') {
          result = {
            text: message.result,
            usage: {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              cacheReadTokens: message.usage.cache_read_input_tokens,
              cacheWriteTokens: message.usage.cache_creation_input_tokens,
            },
          }
        } else {
          failure = new Error(
            `claude member turn failed (${message.subtype}): `
            + ('errors' in message && Array.isArray(message.errors)
              ? message.errors.join('; ')
              : 'no result'),
          )
        }
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (failure !== undefined) throw failure
    if (result === undefined) throw new Error('claude member turn ended without a result')
    yield result
  }

  recover(pending: ExternalPendingPrompt, _signal: AbortSignal): Promise<ExternalRecovery> {
    if (this.externalId === undefined) return Promise.resolve({ kind: 'absent' })
    return Promise.resolve(recoverClaudeSession(this.config.cwd, this.externalId, pending))
  }

  async dispose(): Promise<void> {
    this.controller.abort()
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.queryHandle?.close()
      return
    }
    await disposeClaudeCodeChild(this.queryHandle, child)
  }

  private captureSessionId(message: SDKMessage): void {
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== '') {
      this.externalId = message.session_id
    }
  }
}

/** Transport factory for Claude member sessions. */
export class ClaudeMemberTransport implements ExternalMemberTransport {
  constructor(
    private readonly config: ClaudeMemberConfig,
    private readonly spawn: ClaudeCodeRunSpec['spawn'],
  ) {}

  open(externalId: string | undefined, signal: AbortSignal): Promise<ExternalMemberSession> {
    return Promise.resolve(new ClaudeMemberSession(this.config, this.spawn, externalId, signal))
  }
}

/** LLM adapter owning the member route; each model call becomes one external turn. */
export class ClaudeMemberAdapter extends LlmAdapter {
  constructor(
    private readonly transport: ExternalMemberTransport,
    private readonly store: ExternalBindingStore,
  ) {
    super()
  }

  override providerInfo(provider: string): { readonly id: string; readonly name: string } {
    return { id: provider, name: 'Claude Code member' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: CLAUDE_MEMBER_MODEL, name: 'Claude Code member' }])
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      throw new Error(
        'claude-code member: auxiliary model calls (compaction, titles, reviews) '
        + 'have no external turn; this member route serves conversation only',
      )
    }
    return externalMemberTurn(options, this.store, this.transport)
  }
}
