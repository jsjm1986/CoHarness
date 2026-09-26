/**
 * Shared machinery for providers whose CONTINUABLE members run an external
 * agent runtime (Claude Agent SDK, Codex app-server, ACP `session/load`)
 * behind an `LlmAdapter` route: the child is an ordinary in-process Agent —
 * the continuation manager owns its identity, inbox, persistence, and
 * lifecycle — while each model call becomes one resumable external turn.
 *
 * The external side keeps its own durable session; this module owns the only
 * harness-side binding, an append-only JSONL store keyed by the child's
 * durable session id, plus the prompt-window and pending rules that make a
 * crashed turn provable-or-dropped rather than resent.
 *
 * @module @deepseek-ai/dsh-subagent/external
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { Message, MessageId, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Resolve independent model routes and stores for named external Provider instances.
 * @param providerName - Instance name in the subagent registry.
 * @param defaultName - Product's default instance name and legacy store basename.
 * @param defaultRoute - Product's existing default model route.
 * @returns Stable route and filename; the default instance retains its published identity.
 */
export function externalMemberIdentity(
  providerName: string,
  defaultName: string,
  defaultRoute: string,
): { route: string; filename: string } {
  const suffix = providerName === defaultName ? '' : `-${createHash('sha256').update(providerName).digest('hex')}`
  return { route: `${defaultRoute}${suffix}`, filename: `${defaultName}${suffix}.jsonl` }
}

/** The durable harness↔external association for one member child. */
export interface ExternalMemberBinding {
  /** External runtime session identity (Claude session id, Codex thread id, ACP session id). */
  readonly externalId: string
  /**
   * Last child-side user message the external side provably consumed —
   * either settled with a replayed result or abandoned after an unprovable
   * pending turn. User messages after this id are unconsumed.
   */
  readonly consumedMessageId?: MessageId
  /** One issued prompt whose external outcome is unknown; delivery is never retried. */
  readonly pending?: ExternalPendingPrompt
}

/** A prompt issued to the external runtime whose result was never observed. */
export interface ExternalPendingPrompt {
  /** The exact prompt text sent. */
  readonly prompt: string
  /** The newest user message id the prompt consumed. */
  readonly throughMessageId: MessageId
}

/** One settled external turn folded out of the binding store. */
export interface ExternalTurnOutcome {
  /** Assistant text the external runtime produced. */
  readonly text: string
  /** Token usage when the runtime reports it. */
  readonly usage?: TokenUsage
}

/**
 * Mid-turn signal that the external session identity was just minted.
 *
 * Transports that mint inside the first turn yield this the moment the
 * identity exists — BEFORE the prompt issues when the protocol allows — so
 * the caller can persist the binding and mark the prompt pending while the
 * turn is still in flight. A crash between identity mint and binding record
 * otherwise leaves an issued prompt unrecoverable: the retry would resend it
 * to a fresh external session.
 */
export interface ExternalTurnBound {
  /** The freshly minted external session identity. */
  readonly bound: string
}

/** What the external transcript can prove about one previously issued prompt. */
export type ExternalRecovery =
  /** The prompt produced a result; replay this text without resending. */
  | { readonly kind: 'result'; readonly text: string }
  /** The prompt provably never reached the external session; resending is safe. */
  | { readonly kind: 'absent' }
  /** Neither proven — the outcome stays unknown and the prompt is dropped, never resent. */
  | { readonly kind: 'unknown' }

/** A provider's transport for one open external session. */
export interface ExternalMemberSession {
  /**
   * The external session identity this open handles. Fresh sessions mint it
   * during the first `turn`; until then it reads `undefined`.
   */
  readonly externalId: string | undefined
  /**
   * Send one user prompt and stream the external turn's assistant text.
   * @param prompt - the exact text for the external session's next user turn.
   * @param signal - caller cancellation; an aborted turn leaves the outcome unknown.
   * @returns text pieces in order, an {@link ExternalTurnBound} the moment a
   *   fresh identity mints, then the terminal outcome.
   */
  turn(prompt: string, signal: AbortSignal): AsyncIterable<string | ExternalTurnBound | ExternalTurnOutcome>
  /**
   * Prove the state of a previously issued prompt from the external
   * runtime's own durable transcript. Implementations read the external
   * session's log or replay protocol; they never issue another prompt.
   * @param pending - the unknown-outcome prompt exactly as issued.
   * @param signal - caller cancellation.
   * @returns the provable state.
   */
  recover(pending: ExternalPendingPrompt, signal: AbortSignal): Promise<ExternalRecovery>
  /** Release the external session handle and any process it owns. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Provider-owned transport factory. `open` creates the external session when
 * `externalId` is `undefined`, or attaches to the durable external session it
 * names; a freshly minted identity is reported through the session's
 * `externalId` and bound by the caller.
 */
export interface ExternalMemberTransport {
  /**
   * Open the external session for one member turn.
   * @param externalId - the stored binding, or `undefined` for a new external session.
   * @param signal - caller cancellation, owning only this open.
   * @returns a session that must be disposed by the caller.
   */
  open(externalId: string | undefined, signal: AbortSignal): Promise<ExternalMemberSession>
}

/** Error code stamped when an unknown-outcome external prompt is dropped, never resent. */
export const EXTERNAL_TURN_OUTCOME_UNKNOWN = 'EXTERNAL_TURN_OUTCOME_UNKNOWN'

type StoreRecord =
  | { readonly v: 1; readonly kind: 'bind'; readonly child: string; readonly externalId: string }
  | { readonly v: 1; readonly kind: 'pending'; readonly child: string; readonly prompt: string; readonly throughMessageId: string }
  | { readonly v: 1; readonly kind: 'consumed'; readonly child: string; readonly messageId: string }

/** One stored turn window: the trailing user run not yet consumed by the external session. */
export interface ExternalPromptWindow {
  /** The serialized prompt text for the external session. */
  readonly prompt: string
  /** The newest user message id this window consumes. */
  readonly throughMessageId: MessageId
}

/**
 * Append-only binding store for external member sessions. One JSONL record
 * per state transition; the in-memory fold is the read model. The file lives
 * in the provider's configured state directory and is owned by the single
 * harness process that created it — concurrent writers are out of scope.
 */
export class ExternalBindingStore {
  private readonly bindings = new Map<string, ExternalMemberBinding>()
  private loaded = false

  /**
   * @param file - the JSONL backing file, created with its parent directory on first write.
   */
  constructor(private readonly file: string) {}

  /**
   * Read the folded binding for one child.
   * @param child - the durable child session id.
   * @returns the binding, or `undefined` when the child has no external session yet.
   */
  binding(child: SessionId): ExternalMemberBinding | undefined {
    this.ensureLoaded()
    return this.bindings.get(child)
  }

  /**
   * Record a freshly minted external session identity for one child.
   * @param child - the durable child session id.
   * @param externalId - the external session identity just opened.
   */
  bind(child: SessionId, externalId: string): void {
    this.append({ v: 1, kind: 'bind', child, externalId })
    const current = this.bindings.get(child)
    this.bindings.set(child, {
      externalId,
      ...current?.consumedMessageId === undefined ? {} : { consumedMessageId: current.consumedMessageId },
      ...current?.pending === undefined ? {} : { pending: current.pending },
    })
  }

  /**
   * Record an issued prompt before the external turn runs, so a crash or
   * abort leaves the unknown outcome provable on the next call.
   * @param child - the durable child session id.
   * @param pending - the issued prompt and its newest consumed message id.
   */
  markPending(child: SessionId, pending: ExternalPendingPrompt): void {
    const current = this.bindings.get(child)
    if (current === undefined) throw new Error(`external member store: no binding for "${child}"`)
    this.append({ v: 1, kind: 'pending', child, ...pending })
    this.bindings.set(child, { ...current, pending })
  }

  /**
   * Clear the pending prompt WITHOUT advancing the consumed cursor: the
   * external transcript proved the prompt never arrived, so the same
   * trailing user run must be offered again.
   * @param child - the durable child session id.
   */
  clearPending(child: SessionId): void {
    const current = this.bindings.get(child)
    if (current === undefined) throw new Error(`external member store: no binding for "${child}"`)
    this.append({ v: 1, kind: 'consumed', child, messageId: current.consumedMessageId ?? '' })
    this.bindings.set(child, {
      externalId: current.externalId,
      ...current.consumedMessageId === undefined ? {} : { consumedMessageId: current.consumedMessageId },
    })
  }

  /**
   * Clear the pending prompt and advance the consumed cursor to the newest
   * message the external side handled — used both after a live result and
   * after abandoning an unprovable pending turn.
   * @param child - the durable child session id.
   * @param throughMessageId - the newest user message id consumed.
   */
  consumeThrough(child: SessionId, throughMessageId: MessageId): void {
    const current = this.bindings.get(child)
    if (current === undefined) throw new Error(`external member store: no binding for "${child}"`)
    this.append({ v: 1, kind: 'consumed', child, messageId: throughMessageId })
    this.bindings.set(child, { externalId: current.externalId, consumedMessageId: throughMessageId })
  }

  private append(record: StoreRecord): void {
    this.ensureLoaded()
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify(record) + '\n')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      // First use: the file does not exist; any other read failure also starts
      // empty because a corrupt-tail store must not fabricate bindings.
      return
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue
      const record = JSON.parse(line) as StoreRecord
      const current = this.bindings.get(record.child)
      switch (record.kind) {
        case 'bind':
          this.bindings.set(record.child, {
            externalId: record.externalId,
            ...current?.consumedMessageId === undefined ? {} : { consumedMessageId: current.consumedMessageId },
            ...current?.pending === undefined ? {} : { pending: current.pending },
          })
          break
        case 'pending':
          if (current === undefined) break
          this.bindings.set(record.child, {
            ...current,
            pending: { prompt: record.prompt, throughMessageId: record.throughMessageId as MessageId },
          })
          break
        case 'consumed':
          if (current === undefined) break
          this.bindings.set(record.child, {
            externalId: current.externalId,
            ...record.messageId === '' ? {} : { consumedMessageId: record.messageId as MessageId },
          })
          break
      }
    }
  }
}

/**
 * Slice the model-visible message list to the unconsumed trailing user run:
 * every `user` message after `consumedMessageId` (or the last non-user
 * message, whichever is later), serialized as one prompt. Non-text blocks are
 * omitted; a window that would send nothing resolves `undefined`.
 * @param messages - the request's ordered conversation.
 * @param consumedMessageId - the cursor from the member binding, if any.
 * @returns the window to send, or `undefined` when nothing is unconsumed.
 */
export function externalPromptWindow(
  messages: readonly Message[],
  consumedMessageId: MessageId | undefined,
): ExternalPromptWindow | undefined {
  let floor = 0
  if (consumedMessageId !== undefined) {
    const consumedIndex = messages.findIndex(message => message.id === consumedMessageId)
    // A compaction-rewritten history loses the recorded id; the trailing-run
    // rule below still bounds the window to messages no assistant answered.
    if (consumedIndex >= 0) floor = consumedIndex + 1
  }
  let windowStart = messages.length
  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]
    if (message === undefined || message.role !== 'user') break
    windowStart = i
  }
  const parts: string[] = []
  let throughMessageId: MessageId | undefined
  for (let i = windowStart; i < messages.length; i++) {
    const message = messages[i]
    /* v8 ignore next -- the first loop bounds windowStart to a dense run of user messages, so neither guard can fire here. */
    if (message === undefined || message.role !== 'user') return undefined
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text !== '') parts.push(text)
    throughMessageId = message.id
  }
  if (throughMessageId === undefined || parts.length === 0) return undefined
  return { prompt: parts.join('\n\n'), throughMessageId }
}

/**
 * Drive one member model call against the external session: fold the binding
 * store, resolve unknown outcomes conservatively, issue exactly one prompt,
 * and settle the consumed cursor. Shared by every external-member adapter.
 * @param options - the loop-assembled request (requires `sessionId`).
 * @param store - the provider's binding store.
 * @param transport - the provider's open/recover/dispose transport.
 * @returns raw chunks for the adapter's `stream`.
 */
export async function* externalMemberTurn(
  options: { readonly sessionId?: SessionId; readonly messages: readonly Message[]; readonly signal?: AbortSignal },
  store: ExternalBindingStore,
  transport: ExternalMemberTransport,
): AsyncIterable<StreamChunk> {
  const child = options.sessionId
  if (child === undefined) {
    throw new Error('external member adapter: the request carries no session id')
  }
  const signal = options.signal ?? new AbortController().signal
  const binding = store.binding(child)

  if (binding?.pending !== undefined) {
    const session = await transport.open(binding.externalId, signal)
    let recovery: ExternalRecovery
    try {
      recovery = await session.recover(binding.pending, signal)
    } finally {
      await session.dispose()
    }
    switch (recovery.kind) {
      case 'result':
        store.consumeThrough(child, binding.pending.throughMessageId)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: recovery.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: recovery.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      case 'absent':
        // The prompt provably never arrived: clearing pending lets the
        // ordinary window path send it once, with no duplicate delivery.
        store.clearPending(child)
        break
      case 'unknown':
        store.consumeThrough(child, binding.pending.throughMessageId)
        throw Object.assign(
          new Error(
            'external member turn outcome is unknown and was not resent; '
            + 'the member needs a new prompt',
          ),
          { code: EXTERNAL_TURN_OUTCOME_UNKNOWN },
        )
    }
    // Fall through on 'absent' to run the same window against a clean pending state.
    yield* externalMemberTurn(options, store, transport)
    return
  }

  const window = externalPromptWindow(options.messages, binding?.consumedMessageId)
  if (window === undefined) {
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  const session = await transport.open(binding?.externalId, signal)
  try {
    let boundId = store.binding(child)?.externalId
    if (session.externalId !== undefined && session.externalId !== boundId) {
      boundId = session.externalId
      store.bind(child, boundId)
    }
    // Mark the issued prompt as soon as a binding exists. Transports that
    // mint the external id at open (Codex thread, ACP session) mark before
    // the prompt is sent; transports that mint it inside the first turn
    // (Claude session id) mark at first sight below.
    const pending: ExternalPendingPrompt = {
      prompt: window.prompt,
      throughMessageId: window.throughMessageId,
    }
    let pendingMarked = false
    if (boundId !== undefined) {
      store.markPending(child, pending)
      pendingMarked = true
    }
    const collected: string[] = []
    let outcome: ExternalTurnOutcome | undefined
    for await (const piece of session.turn(window.prompt, signal)) {
      // Fresh sessions mint their identity while the first turn runs; the
      // `bound` piece arrives the moment that happens — before the prompt
      // issues for transports that mint at open — so the binding and the
      // pending record are durable before any request bytes leave. The
      // externalId poll below stays as cover for transports that never emit
      // the piece.
      const minted = typeof piece === 'object' && 'bound' in piece
        ? piece.bound
        : session.externalId
      if (minted !== undefined && minted !== boundId) {
        boundId = minted
        store.bind(child, boundId)
        if (!pendingMarked) {
          store.markPending(child, pending)
          pendingMarked = true
        }
      }
      if (typeof piece === 'string') collected.push(piece)
      else if (!('bound' in piece)) outcome = piece
    }
    const text = outcome?.text ?? collected.join('')
    store.consumeThrough(child, window.throughMessageId)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (text !== '') yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (outcome?.usage !== undefined) yield { type: 'usage', usage: outcome.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } finally {
    await session.dispose()
  }
}
