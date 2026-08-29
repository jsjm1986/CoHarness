/**
 * Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
 * call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
 * @module dsh-llm-deepseek/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  /** Incremental fragments; joined once at block close to avoid O(n²) concatenation. */
  parts: string[]
  /** tool-call only */
  callId?: string
  name?: string
}

/** Response accumulation limits enforced while translating one stream. */
export interface TranslateLimits {
  /** Maximum UTF-8 bytes across visible text and reasoning content. */
  maxGeneratedTextBytes?: number
  /** Maximum UTF-8 bytes accumulated for one tool-call argument string. */
  maxToolArgumentBytes?: number
}

/** Conservative defaults used by direct callers that do not pass provider config. */
export const DEFAULT_MAX_GENERATED_TEXT_BYTES = 16 * 1024 * 1024
/** Default UTF-8 byte bound for one streamed tool-call argument string. */
export const DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024
/** Fixed protocol safety bound for distinct streamed tool-call blocks. */
export const MAX_TOOL_CALL_BLOCKS = 1024
/** Fixed protocol safety bound for one chunk's tool-call delta list. */
export const MAX_TOOL_CALL_DELTAS_PER_CHUNK = 2048
/** Fixed protocol safety bound for one streamed tool-call id or name. */
export const MAX_TOOL_CALL_METADATA_BYTES = 16 * 1024
/** Fixed protocol safety bound for a streamed finish-reason label. */
export const MAX_FINISH_REASON_BYTES = 256

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * api/create-chat-completion); the harness TokenUsage convention is
 * DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; an exact total is present only when the
 *   aggregate prompt/completion counters are valid and agree with any wire total.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const promptTokens = usageInteger(usage.prompt_tokens, 'prompt_tokens')
  const completionTokens = usageInteger(usage.completion_tokens, 'completion_tokens')
  const details: unknown = usage.prompt_tokens_details
  if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) {
    throw malformed('usage.prompt_tokens_details must be an object')
  }
  const completionDetails: unknown = usage.completion_tokens_details
  if (completionDetails !== undefined && (typeof completionDetails !== 'object' || completionDetails === null || Array.isArray(completionDetails))) {
    throw malformed('usage.completion_tokens_details must be an object')
  }
  const cacheReadRaw = details === undefined
    ? usage.prompt_cache_hit_tokens
    : (details as { cached_tokens?: unknown }).cached_tokens ?? usage.prompt_cache_hit_tokens
  const cacheRead = cacheReadRaw === undefined ? undefined : usageInteger(cacheReadRaw, 'cached_tokens')
  const cacheMiss = usage.prompt_cache_miss_tokens === undefined
    ? undefined : usageInteger(usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens')
  if (cacheRead !== undefined && cacheRead > promptTokens) throw malformed('usage cached tokens exceed prompt tokens')
  if (cacheMiss !== undefined && cacheRead !== undefined && cacheRead + cacheMiss > promptTokens) {
    throw malformed('usage cache token counts exceed prompt tokens')
  }
  const reasoningRaw = completionDetails === undefined
    ? undefined : (completionDetails as { reasoning_tokens?: unknown }).reasoning_tokens
  const reasoning = reasoningRaw === undefined ? undefined : usageInteger(reasoningRaw, 'reasoning_tokens')
  if (reasoning !== undefined && reasoning > completionTokens) throw malformed('usage reasoning tokens exceed completion tokens')
  const combined = promptTokens + completionTokens
  const hasExactTotal = Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined
      || (Number.isSafeInteger(usage.total_tokens)
        && usage.total_tokens >= 0
        && usage.total_tokens === combined))
  return {
    inputTokens: promptTokens - (cacheRead ?? 0),
    outputTokens: completionTokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

function usageInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformed(`usage.${field} must be a non-negative safe integer`)
  }
  return value as number
}

function malformed(message: string): LlmError {
  return new LlmError(`malformed SSE payload: ${message}`, 'MALFORMED_RESPONSE')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasUsageFields(value: Record<string, unknown>): value is Record<string, unknown> & WireUsage {
  return Object.hasOwn(value, 'prompt_tokens') && Object.hasOwn(value, 'completion_tokens')
}

function boundedString(value: unknown, field: string, maxBytes: number, allowEmpty = true): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || utf8Bytes(value) > maxBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw malformed(`${field} is invalid`)
  }
  return value
}

/** Validate the untrusted JSON object before the translation loop dereferences it. */
function parseChunk(value: unknown): WireChunk {
  if (!isRecord(value)) throw malformed('chunk must be an object')
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices) || value.choices.length > 16) throw malformed('choices must be a bounded array')
    for (const rawChoice of value.choices) {
      if (!isRecord(rawChoice)) throw malformed('choice must be an object')
      if (rawChoice.finish_reason !== undefined && rawChoice.finish_reason !== null) {
        boundedString(rawChoice.finish_reason, 'finish_reason', MAX_FINISH_REASON_BYTES, false)
      }
      const rawDelta = rawChoice.delta
      if (rawDelta !== undefined && rawDelta !== null) {
        if (!isRecord(rawDelta)) throw malformed('delta must be an object')
        for (const field of ['content', 'reasoning_content'] as const) {
          const item = rawDelta[field]
          if (item !== undefined && item !== null && typeof item !== 'string') throw malformed(`delta.${field} must be a string or null`)
        }
        const calls = rawDelta.tool_calls
        if (calls !== undefined) {
          if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALL_DELTAS_PER_CHUNK) {
            throw malformed('delta.tool_calls must be a bounded array')
          }
          for (const rawCall of calls) {
            if (!isRecord(rawCall)) throw malformed('tool call must be an object')
            if (!Number.isSafeInteger(rawCall.index) || (rawCall.index as number) < 0) throw malformed('tool-call index is invalid')
            if (rawCall.type !== undefined && rawCall.type !== 'function') throw malformed('tool-call type is invalid')
            boundedString(rawCall.id, 'tool-call id', MAX_TOOL_CALL_METADATA_BYTES)
            const fn = rawCall.function
            if (fn !== undefined) {
              if (!isRecord(fn)) throw malformed('tool-call function must be an object')
              boundedString(fn.name, 'tool-call name', MAX_TOOL_CALL_METADATA_BYTES)
              boundedString(fn.arguments, 'tool-call arguments', Number.MAX_SAFE_INTEGER)
            }
          }
        }
      }
    }
  }
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) throw malformed('usage must be an object or null')
    if (!hasUsageFields(value.usage)) throw malformed('usage requires prompt_tokens and completion_tokens')
    // mapUsage performs the numeric and nested-object checks and returns the
    // normalized value only after all fields have been validated.
    mapUsage(value.usage)
  }
  return value
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  const text = block.parts.join('')
  switch (block.kind) {
    case 'text': return { type: 'text', text }
    case 'reasoning': return { type: 'reasoning', text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @param limits - optional UTF-8 accumulation limits for generated text and tool arguments.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(
  payloads: AsyncIterable<string>,
  limits: TranslateLimits = {},
): AsyncGenerator<StreamChunk> {
  const maxGeneratedTextBytes = limits.maxGeneratedTextBytes ?? DEFAULT_MAX_GENERATED_TEXT_BYTES
  const maxToolArgumentBytes = limits.maxToolArgumentBytes ?? DEFAULT_MAX_TOOL_ARGUMENT_BYTES
  if (!Number.isSafeInteger(maxGeneratedTextBytes) || maxGeneratedTextBytes < 1
    || !Number.isSafeInteger(maxToolArgumentBytes) || maxToolArgumentBytes < 1) {
    throw new RangeError('DeepSeek translation limits must be positive safe integers')
  }
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  let generatedTextBytes = 0
  const toolArgumentBytes = new Map<number, number>()

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, parts: [] }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload) as unknown
    } catch {
      // Preserve the stable error class/code while avoiding the raw payload in
      // diagnostics (a malformed frame may contain credentials or megabytes of
      // attacker-controlled text).
      throw new LlmError('malformed SSE payload: invalid JSON', 'MALFORMED_RESPONSE')
    }
    const chunk = parseChunk(parsed)
    for (const choice of chunk.choices ?? []) {
      const choiceObject = choice
      const delta = choiceObject.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        generatedTextBytes += utf8Bytes(reasoning)
        if (generatedTextBytes > maxGeneratedTextBytes) {
          throw new LlmError('DeepSeek generated text exceeded the configured response limit', 'RESPONSE_TOO_LARGE')
        }
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.parts.push(reasoning)
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        generatedTextBytes += utf8Bytes(content)
        if (generatedTextBytes > maxGeneratedTextBytes) {
          throw new LlmError('DeepSeek generated text exceeded the configured response limit', 'RESPONSE_TOO_LARGE')
        }
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.parts.push(content)
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        if (!Number.isSafeInteger(call.index) || call.index < 0) {
          throw new LlmError('malformed SSE payload: tool-call index is invalid', 'MALFORMED_RESPONSE')
        }
        if (call.function?.arguments !== undefined && typeof call.function.arguments !== 'string') {
          throw new LlmError('malformed SSE payload: tool-call arguments must be a string', 'MALFORMED_RESPONSE')
        }
        let block = toolBlocks.get(call.index)
        if (!block) {
          if (toolBlocks.size >= MAX_TOOL_CALL_BLOCKS) {
            throw malformed('tool-call block count exceeds the configured protocol limit')
          }
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        const bytes = (toolArgumentBytes.get(call.index) ?? 0) + utf8Bytes(fragment)
        if (bytes > maxToolArgumentBytes) {
          throw new LlmError('DeepSeek tool-call arguments exceeded the configured response limit', 'RESPONSE_TOO_LARGE')
        }
        toolArgumentBytes.set(call.index, bytes)
        block.parts.push(fragment)
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choiceObject.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choiceObject.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
