/**
 * Fail-closed protection for reasoning serialized in an ordinary text block.
 *
 * Provider adapters may normalize a tagged response into typed reasoning and
 * text blocks. This guard remains at the provider-neutral LLM boundary so a
 * stale adapter, a second OpenAI-compatible provider, or a middleware-owned
 * route cannot publish the tagged prefix to session consumers. It withholds
 * only the first text prefix while the response dialect is undecided; an
 * ordinary response is emitted byte-for-byte. A tagged or incomplete prefix
 * is rejected without yielding any buffered content.
 *
 * @module dsh-llm/text-thinking-guard
 */

import { HarnessError, UNSAFE_MODEL_OUTPUT_CODE } from './error.ts'
import type { StreamChunk } from './types.ts'

const TAG_NAMES = ['thinking', 'analysis', 'think'] as const
const deferredEncoder = new TextEncoder()
const MAX_OPENING_PROBE_CHARS = 4 * 1024
const MAX_CLOSE_TAIL_CHARS = 128

/** Maximum later-stream chunks retained while an ordinary-text prefix is undecided. */
const MAX_DEFERRED_THINKING_GUARD_CHUNKS = 4_096
/** Maximum UTF-8 bytes retained by the same ordering buffer. */
const MAX_DEFERRED_THINKING_GUARD_BYTES = 8 * 1024 * 1024

class GuardFailure extends HarnessError {}

type PrefixStatus = 'plain' | 'pending' | 'tagged'

interface PendingTextBlock {
  readonly index: number
  readonly buffered: StreamChunk[]
  readonly sourceParts: string[]
  sourceLength: number
  sourceBytes: number
  status: PrefixStatus | undefined
  probe: string | undefined
  closePattern: RegExp | undefined
  closeTail: string
}

interface DeferredChunk {
  readonly chunk: StreamChunk
  readonly bytes: number
}

/** Optional non-secret route facts used in the fail-closed diagnostic. */
export interface TextThinkingGuardOptions {
  /** Registered provider route, when the caller has one. */
  provider?: string
  /** Requested model id, when the caller has one. */
  model?: string
}

function firstNonWhitespace(value: string): number {
  const index = value.search(/\S/u)
  return index < 0 ? value.length : index
}

function openingTag(value: string): { name: string; end: number } | undefined {
  const first = firstNonWhitespace(value)
  const candidate = value.slice(first)
  const match = candidate.match(/^<(thinking|analysis|think)(?:\s[^>]*)?>/iu)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1].toLowerCase(), end: first + match[0].length }
}

function possibleOpening(value: string): boolean {
  const first = firstNonWhitespace(value)
  const candidate = value.slice(first).toLowerCase()
  return TAG_NAMES.some((tag) => {
    const prefix = `<${tag}`
    return prefix.startsWith(candidate) || candidate.startsWith(prefix)
  })
}

function prefixStatus(value: string): PrefixStatus {
  const first = firstNonWhitespace(value)
  if (first === value.length) return 'plain'
  const candidate = value.slice(first)
  const opening = openingTag(value)
  if (opening === undefined) return possibleOpening(value) ? 'pending' : 'plain'
  const close = new RegExp(`</${opening.name}\\s*>`, 'iu')
  return close.test(candidate.slice(opening.end - first)) ? 'tagged' : 'pending'
}

function chunkIndex(chunk: StreamChunk): number | undefined {
  switch (chunk.type) {
    case 'block-start':
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call-delta':
    case 'block-end':
      return chunk.index
    case 'usage':
    case 'finish':
      return undefined
  }
}

function unsafeMessage(options: TextThinkingGuardOptions): string {
  const route = options.provider === undefined || options.model === undefined
    ? ''
    : ` for ${options.provider}/${options.model}`
  return `model response${route} contained a tagged thinking prefix in ordinary text`
}

function assertSafe(value: string, options: TextThinkingGuardOptions): void {
  if (prefixStatus(value) !== 'plain') throw new GuardFailure(unsafeMessage(options), UNSAFE_MODEL_OUTPUT_CODE)
}

function sourceText(state: PendingTextBlock): string {
  return state.sourceParts.join('')
}

function openingState(state: PendingTextBlock, source: string, opening: { name: string; end: number }): void {
  state.probe = undefined
  state.closePattern = new RegExp(`</${opening.name}\\s*>`, 'iu')
  state.closeTail = source.slice(Math.max(opening.end, source.length - MAX_CLOSE_TAIL_CHARS))
}

function assertPendingCapacity(state: PendingTextBlock, bytes: number): void {
  if (bytes > MAX_DEFERRED_THINKING_GUARD_BYTES
    || state.sourceBytes > MAX_DEFERRED_THINKING_GUARD_BYTES
    || state.buffered.length > MAX_DEFERRED_THINKING_GUARD_CHUNKS) {
    throw new GuardFailure(
      `model response prefix exceeded ${String(MAX_DEFERRED_THINKING_GUARD_BYTES)} bytes or ${String(MAX_DEFERRED_THINKING_GUARD_CHUNKS)} chunks while its thinking tag was undecided`,
      'RESPONSE_TOO_LARGE',
    )
  }
}

/**
 * Append one text fragment while retaining only append-only fragments. The
 * undecided prefix is parsed once; after an opening tag is recognized, later
 * fragments are checked against a short close-tag overlap instead of joining
 * the complete response on every delta.
 */
function appendText(state: PendingTextBlock, text: string): PrefixStatus {
  const bytes = deferredEncoder.encode(text).byteLength
  state.sourceParts.push(text)
  state.sourceLength += text.length
  state.sourceBytes += bytes
  if (state.status === 'plain' || state.status === 'tagged') return state.status

  if (state.status === undefined) {
    const source = sourceText(state)
    const status = prefixStatus(source)
    state.status = status
    if (status === 'pending') {
      assertPendingCapacity(state, bytes)
      const opening = openingTag(source)
      if (opening !== undefined) openingState(state, source, opening)
      else {
        if (source.length > MAX_OPENING_PROBE_CHARS) {
          throw new GuardFailure(
            `model response prefix exceeded ${String(MAX_OPENING_PROBE_CHARS)} characters while its thinking tag was undecided`,
            'RESPONSE_TOO_LARGE',
          )
        }
        state.probe = source
      }
    }
    return status
  }

  assertPendingCapacity(state, bytes)
  if (state.closePattern !== undefined) {
    const combined = state.closeTail + text
    if (state.closePattern.test(combined)) {
      state.status = 'tagged'
      return 'tagged'
    }
    state.closeTail = combined.slice(-MAX_CLOSE_TAIL_CHARS)
    return 'pending'
  }

  const probe = `${state.probe ?? ''}${text}`
  if (probe.length > MAX_OPENING_PROBE_CHARS) {
    throw new GuardFailure(
      `model response prefix exceeded ${String(MAX_OPENING_PROBE_CHARS)} characters while its thinking tag was undecided`,
      'RESPONSE_TOO_LARGE',
    )
  }
  state.probe = probe
  const status = prefixStatus(probe)
  state.status = status
  if (status === 'pending') {
    const opening = openingTag(probe)
    if (opening !== undefined) {
      const full = sourceText(state)
      const fullStatus = prefixStatus(full)
      state.status = fullStatus
      if (fullStatus === 'pending') openingState(state, full, opening)
      return fullStatus
    }
  }
  return status
}

function emptyPendingTextBlock(index: number): PendingTextBlock {
  return {
    index,
    buffered: [],
    sourceParts: [],
    sourceLength: 0,
    sourceBytes: 0,
    status: undefined,
    probe: undefined,
    closePattern: undefined,
    closeTail: '',
  }
}

/** Estimate one deferred chunk's JSON footprint without allowing a serializer fault to grow state. */
function deferredChunkBytes(chunk: StreamChunk): number {
  try {
    const serialized = JSON.stringify(chunk) as string | undefined
    if (serialized === undefined) return MAX_DEFERRED_THINKING_GUARD_BYTES + 1
    return deferredEncoder.encode(serialized).byteLength
  } catch {
    return MAX_DEFERRED_THINKING_GUARD_BYTES + 1
  }
}

function lowestPending(states: ReadonlyMap<number, PendingTextBlock>): number | undefined {
  const iterator = states.keys()
  const first = iterator.next()
  if (first.done) return undefined
  let result = first.value
  for (const index of iterator) result = Math.min(result, index)
  return result
}

function shouldDefer(chunk: StreamChunk, states: ReadonlyMap<number, PendingTextBlock>): boolean {
  const pending = lowestPending(states)
  if (pending === undefined) return false
  const index = chunkIndex(chunk)
  return index === undefined || index > pending
}

/**
 * Protect one adapter stream from an unnormalized tagged thinking prefix.
 *
 * @param source - adapter or middleware stream to protect.
 * @param options - optional route facts for the stable failure diagnostic.
 * @returns the source chunks, or a terminal failure from {@link LlmRuntime} if
 * the source starts a tagged or incomplete thinking prefix.
 */
export async function* guardTextThinkingStream(
  source: AsyncIterable<StreamChunk>,
  options: TextThinkingGuardOptions = {},
): AsyncGenerator<StreamChunk> {
  const states = new Map<number, PendingTextBlock>()
  const deferred: DeferredChunk[] = []
  let deferredHead = 0
  let deferredBytes = 0
  const streamState = { finished: false }

  function deferredCount(): number {
    return deferred.length - deferredHead
  }

  function deferredPeek(): StreamChunk | undefined {
    return deferred[deferredHead]?.chunk
  }

  function deferredShift(): StreamChunk | undefined {
    const entry = deferred[deferredHead]
    if (entry === undefined) return undefined
    deferredBytes = Math.max(0, deferredBytes - entry.bytes)
    deferredHead += 1
    if (deferredHead >= 64 && deferredHead * 2 >= deferred.length) {
      deferred.splice(0, deferredHead)
      deferredHead = 0
    }
    return entry.chunk
  }

  function deferredValues(): readonly StreamChunk[] {
    return deferred.slice(deferredHead).map(entry => entry.chunk)
  }

  function defer(chunk: StreamChunk): void {
    const bytes = deferredChunkBytes(chunk)
    if (deferredCount() >= MAX_DEFERRED_THINKING_GUARD_CHUNKS
      || bytes > MAX_DEFERRED_THINKING_GUARD_BYTES
      || deferredBytes + bytes > MAX_DEFERRED_THINKING_GUARD_BYTES) {
      throw new GuardFailure(
        `model response ordering buffer exceeded ${String(MAX_DEFERRED_THINKING_GUARD_BYTES)} bytes or ${String(MAX_DEFERRED_THINKING_GUARD_CHUNKS)} chunks`,
        'RESPONSE_TOO_LARGE',
      )
    }
    deferred.push({ chunk, bytes })
    deferredBytes += bytes
  }

  function* flush(state: PendingTextBlock): Generator<StreamChunk> {
    yield* state.buffered
    states.delete(state.index)
  }

  function* process(chunk: StreamChunk): Generator<StreamChunk> {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType !== 'text') {
          yield chunk
          return
        }
        if (states.has(chunk.index)) {
          yield chunk
          return
        }
        states.set(chunk.index, emptyPendingTextBlock(chunk.index))
        // A block-start carries no model text, so publish it immediately. This
        // keeps cancellation from pulling another provider item merely to
        // decide whether the first text delta is safe.
        yield chunk
        return
      }
      case 'text-delta': {
        const state = states.get(chunk.index) ?? emptyPendingTextBlock(chunk.index)
        states.set(chunk.index, state)
        state.buffered.push(chunk)
        const status = appendText(state, chunk.text)
        if (status === 'tagged') throw new GuardFailure(unsafeMessage(options), UNSAFE_MODEL_OUTPUT_CODE)
        if (status === 'plain') yield* flush(state)
        return
      }
      case 'block-end': {
        if (chunk.block.type !== 'text') {
          yield chunk
          return
        }
        const state = states.get(chunk.index)
        if (state === undefined) {
          assertSafe(chunk.block.text, options)
          yield chunk
          return
        }
        state.buffered.push(chunk)
        const sourceStatus = state.status ?? prefixStatus(sourceText(state))
        const finalStatus = prefixStatus(chunk.block.text)
        if (sourceStatus !== 'plain' || finalStatus !== 'plain') {
          throw new GuardFailure(unsafeMessage(options), UNSAFE_MODEL_OUTPUT_CODE)
        }
        yield* flush(state)
        return
      }
      case 'finish': {
        /* v8 ignore next -- a finish is deferred while any pending text state exists. */
        for (const state of [...states.values()].sort((left, right) => left.index - right.index)) {
          assertSafe(sourceText(state), options)
          yield* flush(state)
        }
        streamState.finished = true
        yield chunk
        return
      }
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'usage':
        yield chunk
        return
    }
  }

  function* drain(): Generator<StreamChunk> {
    while (deferredCount() > 0) {
      const next = deferredPeek()
      /* v8 ignore next -- the length check above keeps the queue head present. */
      if (next === undefined || shouldDefer(next, states)) return
      deferredShift()
      yield* process(next)
    }
  }

  try {
    for await (const chunk of source) {
      if (shouldDefer(chunk, states)) {
        defer(chunk)
        continue
      }
      yield* process(chunk)
      yield* drain()
    }

    if (deferredCount() > 0 || states.size > 0 || !streamState.finished) {
      for (const state of [...states.values()].sort((left, right) => left.index - right.index)) {
        assertSafe(sourceText(state), options)
        yield* flush(state)
      }
      while (deferredCount() > 0) {
        const next = deferredShift()
        /* v8 ignore next -- the length check above keeps a queued chunk present. */
        if (next !== undefined) yield* process(next)
      }
    }
    if (!streamState.finished) throw new GuardFailure('model stream ended without a terminal finish chunk', 'STREAM_CLOSED')
  } catch (error: unknown) {
    if (error instanceof GuardFailure
      || error instanceof HarnessError && error.code === UNSAFE_MODEL_OUTPUT_CODE) {
      // Usage carries no model text. Preserve a provider usage sample that was
      // queued behind the undecided prefix so rejecting the response does not
      // silently turn a billable attempt into an unmeasured one.
      for (const queued of deferredValues()) {
        if (queued.type === 'usage') yield queued
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error.message, code: error.code } } }
      return
    }
    throw error
  }
}
