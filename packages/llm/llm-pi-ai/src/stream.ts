/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, ProviderResponse, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'
import { TextThinkingParser } from './text-thinking.ts'

type NonTerminalAssistantMessageEvent = Exclude<AssistantMessageEvent, { type: 'done' | 'error' }>

/** Fixed safety limits for events held behind an undecided text-thinking prefix. */
const MAX_ORDERING_QUEUE_EVENTS = 4_096
const MAX_ORDERING_QUEUE_BYTES = 8 * 1024 * 1024
const orderingEncoder = new TextEncoder()

interface QueuedEvent {
  readonly event: NonTerminalAssistantMessageEvent
  readonly bytes: number
}

interface TextBlockState {
  parser: TextThinkingParser
  nativeIndex: number
  /** Assigned when a transformed block first emits a reasoning part. */
  reasoningIndex: number | undefined
  /** Assigned when the text side is first emitted, or when an empty block is preserved. */
  textIndex: number | undefined
  /** Incremental fragments joined only when a block-end is emitted. */
  reasoningParts: string[]
  /** Incremental fragments joined only when a block-end is emitted. */
  textParts: string[]
  textStarted: boolean
  textClosed: boolean
}

/** Estimate one provider event's JSON footprint without retaining an unbounded queue. */
function queuedEventBytes(event: NonTerminalAssistantMessageEvent): number {
  try {
    const serialized = JSON.stringify(event) as string | undefined
    if (serialized === undefined) return MAX_ORDERING_QUEUE_BYTES + 1
    return orderingEncoder.encode(serialized).byteLength
  } catch {
    return MAX_ORDERING_QUEUE_BYTES + 1
  }
}

function textStateOf(states: Map<number, TextBlockState>, nativeIndex: number): TextBlockState {
  let state = states.get(nativeIndex)
  if (state === undefined) {
    state = {
      parser: new TextThinkingParser(),
      nativeIndex,
      reasoningIndex: undefined,
      textIndex: undefined,
      reasoningParts: [],
      textParts: [],
      textStarted: false,
      textClosed: false,
    }
    states.set(nativeIndex, state)
  }
  return state
}

/** Apply parser output to one text block and preserve append-only chunk order. */
function* applyTextUpdate(
  state: TextBlockState,
  update: ReturnType<TextThinkingParser['append']>,
  indexes: { reasoningIndex: number; textIndex: number },
): Generator<StreamChunk> {
  for (const part of update.parts) {
    if (part.type === 'reasoning') {
      yield { type: 'block-start', index: indexes.reasoningIndex, blockType: 'reasoning' }
      state.reasoningParts.push(part.text)
      yield { type: 'reasoning-delta', index: indexes.reasoningIndex, text: part.text }
      yield { type: 'block-end', index: indexes.reasoningIndex, block: { type: 'reasoning', text: state.reasoningParts.join('') } }
      continue
    }

    if (!state.textStarted) {
      state.textStarted = true
      yield { type: 'block-start', index: indexes.textIndex, blockType: 'text' }
    }
    /* v8 ignore next -- pi-ai emits no text delta after text_end; retain containment for extension streams. */
    if (state.textClosed) continue
    state.textParts.push(part.text)
    yield { type: 'text-delta', index: indexes.textIndex, text: part.text }
    if (part.complete) {
      state.textClosed = true
      yield { type: 'block-end', index: indexes.textIndex, block: { type: 'text', text: state.textParts.join('') } }
    }
  }
}

/**
 * Close an open parsed text block at native `text_end` or terminal stream.
 * @param state - accumulated parser and emitted-block state.
 * @param finalText - provider's cumulative ordinary text, which remains
 *   authoritative even when its deltas were incomplete or inconsistent.
 * @returns the remaining block-end chunks.
 */
function* closeTextState(state: TextBlockState, finalText?: string): Generator<StreamChunk> {
  if (!state.parser.transformed && finalText !== undefined) state.textParts = [finalText]
  if (state.textStarted && !state.textClosed) {
    /* v8 ignore next -- every emitted text part receives indexesForText before this close path. */
    if (state.textIndex === undefined) throw new Error('text-thinking text index was not assigned')
    state.textClosed = true
    yield { type: 'block-end', index: state.textIndex, block: { type: 'text', text: state.textParts.join('') } }
  }
}

/** Preserve an empty native text block when no reasoning conversion occurred. */
function* preserveEmptyNativeText(state: TextBlockState): Generator<StreamChunk> {
  if (state.parser.transformed) return
  if (state.textStarted) return
  /* v8 ignore next -- preserve runs only after indexesForText assigns the untouched text index. */
  if (state.textIndex === undefined) throw new Error('text-thinking text index was not assigned')
  state.textStarted = true
  state.textClosed = true
  yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
  yield { type: 'block-end', index: state.textIndex, block: { type: 'text', text: '' } }
}

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
const STREAM_TRUNCATION_PATTERN = /stream ended (?:before|without)\b/i

function classifyPiAiError(message: string): string {
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (STREAM_TRUNCATION_PATTERN.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/** Read one response header without relying on pi-ai's header-name casing. */
function responseHeader(response: ProviderResponse, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [candidate, value] of Object.entries(response.headers)) {
    if (candidate.toLowerCase() === wanted) return value
  }
  return undefined
}

/** Diagnose a terminal-event parser error whose HTTP response was not an SSE stream. */
function malformedStreamFailure(
  message: AssistantMessage,
  response: ProviderResponse | undefined,
): LlmFailure | undefined {
  if (response === undefined || message.errorMessage === undefined
    || !STREAM_TRUNCATION_PATTERN.test(message.errorMessage)) return undefined
  const contentType = responseHeader(response, 'content-type')
  if (contentType === undefined
    || contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') return undefined
  const openAiHint = message.api === 'openai-completions' || message.api === 'openai-responses'
    ? '; OpenAI-compatible base URLs commonly end in "/v1"'
    : ''
  return {
    message: `pi-ai provider "${message.provider}" received HTTP ${response.status} content-type "${contentType}"`
      + ` for protocol "${message.api}" instead of an SSE stream; check the baseURL and protocol${openAiHint}`,
    code: 'MALFORMED_RESPONSE',
    status: response.status,
  }
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param response - HTTP response metadata captured before the body was consumed.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error.
 */
export function mapStopReason(
  message: AssistantMessage,
  contextWindow?: number,
  response?: ProviderResponse,
): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const malformed = malformedStreamFailure(message, response)
      if (malformed !== undefined) return { kind: 'error', failure: malformed }
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param parseTextThinkingOrCallerSignal - legacy text-thinking switch or the
 *   canonical caller cancellation signal.
 * @param response - read the HTTP response metadata captured for this stream.
 * @param callerSignal - caller cancellation signal for the legacy argument form.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  parseTextThinkingOrCallerSignal: boolean | AbortSignal = false,
  response?: () => ProviderResponse | undefined,
  callerSignal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // The upstream API uses the third argument for caller cancellation. Keep the
  // CoHarness text-thinking probe and response hook available through the
  // legacy boolean/fourth-argument form while accepting that canonical call.
  const parseTextThinking = typeof parseTextThinkingOrCallerSignal === 'boolean'
    ? parseTextThinkingOrCallerSignal
    : false
  const effectiveCallerSignal = typeof parseTextThinkingOrCallerSignal === 'boolean'
    ? callerSignal
    : parseTextThinkingOrCallerSignal
  // pi-ai contentIndex ↔ our block index map is 1:1 until a text block is
  // actually split. A transformed block consumes one extra logical slot, and
  // later native indexes are shifted by that one slot. Ordinary text keeps its
  // original index, so enabling the probe does not perturb normal streams.
  const toolIds = new Map<number, { id: string; name: string }>()
  const textStates = new Map<number, TextBlockState>()
  const expandedTextIndices = new Set<number>()
  const queuedEvents: QueuedEvent[] = []
  let queuedHead = 0
  let queuedBytes = 0

  function queuedCount(): number {
    return queuedEvents.length - queuedHead
  }

  function queuedPeek(): NonTerminalAssistantMessageEvent | undefined {
    return queuedEvents[queuedHead]?.event
  }

  function queuedShift(): NonTerminalAssistantMessageEvent | undefined {
    const entry = queuedEvents[queuedHead]
    if (entry === undefined) return undefined
    queuedBytes = Math.max(0, queuedBytes - entry.bytes)
    queuedHead += 1
    if (queuedHead >= 64 && queuedHead * 2 >= queuedEvents.length) {
      queuedEvents.splice(0, queuedHead)
      queuedHead = 0
    }
    return entry.event
  }

  function expansionCountBefore(nativeIndex: number): number {
    let count = 0
    for (const expanded of expandedTextIndices) {
      if (expanded < nativeIndex) count += 1
    }
    return count
  }

  function logicalBase(nativeIndex: number): number {
    return nativeIndex + expansionCountBefore(nativeIndex)
  }

  function indexesForText(state: TextBlockState): { reasoningIndex: number; textIndex: number } {
    if (state.parser.transformed) {
      if (state.reasoningIndex === undefined) {
        const base = logicalBase(state.nativeIndex)
        state.reasoningIndex = base
        state.textIndex = base + 1
        expandedTextIndices.add(state.nativeIndex)
      }
      // The reasoning path always reserves the following slot for a possible
      // answer. Later-index events are held until text_end when no answer is
      // produced, so this reservation cannot collide with another block.
      return { reasoningIndex: state.reasoningIndex, textIndex: state.reasoningIndex + 1 }
    }

    const index = logicalBase(state.nativeIndex)
    state.textIndex ??= index
    return { reasoningIndex: state.reasoningIndex ?? index, textIndex: state.textIndex }
  }

  function indexOf(nativeIndex: number): number {
    if (!parseTextThinking) return nativeIndex
    return logicalBase(nativeIndex)
  }

  function releaseUnusedExpansion(state: TextBlockState): void {
    if (!state.parser.transformed || state.textStarted) return
    // A transformed block with no answer text is semantically one emitted
    // reasoning block. Once its native end arrives, let following blocks use
    // the immediately following index instead of leaving a hole.
    state.textClosed = true
    expandedTextIndices.delete(state.nativeIndex)
  }

  function pendingNativeIndex(): number | undefined {
    let pending: number | undefined
    for (const [nativeIndex, state] of textStates) {
      const layoutPending = state.parser.transformed && !state.textStarted && !state.textClosed
      if (!state.parser.pending && !layoutPending) continue
      if (pending === undefined || nativeIndex < pending) pending = nativeIndex
    }
    return pending
  }

  function eventContentIndex(event: NonTerminalAssistantMessageEvent): number | undefined {
    switch (event.type) {
      case 'start':
        return undefined
      case 'text_start':
      case 'text_delta':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        return event.contentIndex
    }
  }

  /** Hold blocks that follow an unresolved lower-index text prefix. */
  function shouldQueue(event: NonTerminalAssistantMessageEvent): boolean {
    if (!parseTextThinking) return false
    const pending = pendingNativeIndex()
    if (pending === undefined) return false
    const index = eventContentIndex(event)
    return index !== undefined && index > pending
  }

  function* flushTextStates(message: AssistantMessage): Generator<StreamChunk> {
    // A provider may omit all text events and expose the cumulative block
    // only on its terminal assistant message. Materialize those states
    // before flushing so the answer is not silently lost.
    for (const [nativeIndex, block] of message.content.entries()) {
      if (block.type === 'text') textStateOf(textStates, nativeIndex)
    }
    const states = [...textStates.entries()].sort(([left], [right]) => left - right)
    for (const [nativeIndex, state] of states) {
      const final = message.content[nativeIndex]
      const finalText = final?.type === 'text' ? final.text : undefined
      const update = state.parser.finish(finalText)
      yield* applyTextUpdate(state, update, indexesForText(state))
      yield* closeTextState(state, finalText)
      yield* preserveEmptyNativeText(state)
      releaseUnusedExpansion(state)
    }
  }

  function* emitNonTerminal(event: NonTerminalAssistantMessageEvent): Generator<StreamChunk> {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        if (parseTextThinking) {
          textStateOf(textStates, event.contentIndex)
          break
        }
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        if (parseTextThinking) {
          const state = textStateOf(textStates, event.contentIndex)
          const update = state.parser.append(event.delta)
          yield* applyTextUpdate(state, update, indexesForText(state))
          break
        }
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        if (parseTextThinking) {
          const state = textStateOf(textStates, event.contentIndex)
          const update = state.parser.finish(event.content)
          yield* applyTextUpdate(state, update, indexesForText(state))
          yield* closeTextState(state, event.content)
          yield* preserveEmptyNativeText(state)
          releaseUnusedExpansion(state)
          break
        }
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: indexOf(event.contentIndex), blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: indexOf(event.contentIndex), text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: indexOf(event.contentIndex), block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        const index = indexOf(event.contentIndex)
        toolIds.set(index, { id, name })
        yield { type: 'block-start', index, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const index = indexOf(event.contentIndex)
        const known = toolIds.get(index)
        yield {
          type: 'tool-call-delta',
          index,
          id: CallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: indexOf(event.contentIndex),
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
    }
  }

  function* drainQueued(): Generator<StreamChunk> {
    while (queuedCount() > 0) {
      const next = queuedPeek()
      /* v8 ignore next -- the count check above keeps the queue head present. */
      if (next === undefined) return
      if (shouldQueue(next)) {
        return
      }
      queuedShift()
      yield* emitNonTerminal(next)
    }
  }

  for await (const event of events) {
    if (event.type === 'done') {
      if (parseTextThinking) {
        // Terminal messages can carry cumulative text for blocks whose deltas
        // were missing. Repeat the flush after draining because queued events
        // may create a later text state of their own.
        do {
          yield* flushTextStates(event.message)
          yield* drainQueued()
        } while (queuedCount() > 0 || pendingNativeIndex() !== undefined)
      }
      const transformedTextThinking = [...textStates.values()]
        .some(state => state.parser.transformed)
      yield { type: 'usage', usage: mapUsage(event.message.usage) }
      yield {
        type: 'finish',
        reason: mapStopReason(
          effectiveCallerSignal?.aborted ? { ...event.message, stopReason: 'aborted' } : event.message,
          contextWindow,
          response?.(),
        ),
        ...transformedTextThinking ? {} : { replayState: toPiReplayState(event.message) },
      }
      return
    }
    if (event.type === 'error') {
      // In-stream error delivery (pi-ai's style) → error finish chunk
      // (the harness's other sanctioned error path besides throwing).
      if (parseTextThinking) {
        do {
          yield* flushTextStates(event.error)
          yield* drainQueued()
        } while (queuedCount() > 0 || pendingNativeIndex() !== undefined)
      }
      yield { type: 'usage', usage: mapUsage(event.error.usage) }
      yield {
        type: 'finish',
        reason: mapStopReason(
          effectiveCallerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
          contextWindow,
          response?.(),
        ),
      }
      return
    }

    if (parseTextThinking) {
      // Partial messages sometimes reveal a lower-index text block before its
      // dedicated events arrive. Recording the state lets ordering hold back
      // later tool/reasoning events until that text is classified or flushed.
      for (const [nativeIndex, block] of event.partial.content.entries()) {
        if (block.type === 'text') textStateOf(textStates, nativeIndex)
      }
    }
    if (shouldQueue(event)) {
      const bytes = queuedEventBytes(event)
      if (queuedCount() >= MAX_ORDERING_QUEUE_EVENTS
        || bytes > MAX_ORDERING_QUEUE_BYTES
        || queuedBytes + bytes > MAX_ORDERING_QUEUE_BYTES) {
        throw new LlmError(
          `pi-ai response ordering buffer exceeded ${String(MAX_ORDERING_QUEUE_BYTES)} bytes or ${String(MAX_ORDERING_QUEUE_EVENTS)} events`,
          'RESPONSE_TOO_LARGE',
        )
      }
      queuedEvents.push({ event, bytes })
      queuedBytes += bytes
      continue
    }
    yield* emitNonTerminal(event)
    if (parseTextThinking) yield* drainQueued()
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
