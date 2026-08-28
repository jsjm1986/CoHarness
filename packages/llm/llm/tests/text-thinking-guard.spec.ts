import { describe, expect, it } from 'vitest'
import { CallId } from '../src/brand.ts'
import { HarnessError, UNSAFE_MODEL_OUTPUT_CODE } from '../src/error.ts'
import { guardTextThinkingStream } from '../src/text-thinking-guard.ts'
import type { StreamChunk } from '../src/types.ts'

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

async function* feed(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks
}

const finish = (reason: 'stop' | 'error' = 'stop'): StreamChunk => reason === 'stop'
  ? { type: 'finish', reason: { kind: 'stop' } }
  : { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER', message: 'provider failed' } } }

describe('guardTextThinkingStream', () => {
  it('passes an ordinary stream byte-for-byte', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source), { provider: 'p', model: 'm' }))).resolves.toEqual(source)
  })

  it('flushes a text block that has no deltas when its terminal text is ordinary', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'terminal text' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('fails closed before publishing a complete tagged prefix', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>private</thinking>answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>private</thinking>answer' } },
      finish(),
    ]), { provider: 'org-glm', model: 'deepseek-v4-pro-0813' }))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: UNSAFE_MODEL_OUTPUT_CODE,
          message: 'model response for org-glm/deepseek-v4-pro-0813 contained a tagged thinking prefix in ordinary text',
        },
      },
    })
  })

  it('holds later blocks while a split prefix is undecided', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thi' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: CallId('call-1'), name: 'noop', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-1'), name: 'noop', arguments: '{}' } },
      { type: 'text-delta', index: 0, text: 'nking>private</thinking>answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>private</thinking>answer' } },
      finish(),
    ])))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
  })

  it('checks a fragmented close tag without rebuilding the pending body', async () => {
    const body = 'private'
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>private' },
      { type: 'text-delta', index: 0, text: '</thi' },
      { type: 'text-delta', index: 0, text: 'nking>answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: `<thinking>${body}</thinking>answer` } },
      finish(),
    ])))
    expect(chunks).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } },
    })
  })

  it('caps a pending thinking prefix even when later chunks share its index', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>private' },
      ...Array.from({ length: 4_096 }, () => ({ type: 'text-delta' as const, index: 0, text: 'x' })),
    ]
    const chunks = await collect(guardTextThinkingStream(feed(source)))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'RESPONSE_TOO_LARGE' } },
    })
  })

  it('rejects a tagged terminal block even when the provider omitted deltas', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-end', index: 0, block: { type: 'text', text: '<analysis>private</analysis>answer' } },
      finish(),
    ])))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
    expect(chunks).toHaveLength(1)
  })

  it('rejects an incomplete terminal thinking prefix', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>private' } },
      finish(),
    ])))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
  })

  it('preserves usage queued behind an unsafe prefix before the failure finish', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thi' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } },
      { type: 'text-delta', index: 0, text: 'nking>private</thinking>answer' },
      finish(),
    ])))
    expect(chunks).toHaveLength(3)
    expect(chunks[1]).toEqual({ type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } })
    expect(chunks[2]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
  })

  it('fails with a bounded-response error when the ordering buffer grows too large', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thi' },
      ...Array.from({ length: 4_097 }, (_, index) => ({
        type: 'tool-call-delta' as const,
        index: 1,
        id: CallId(`call-${String(index)}`),
        name: 'noop',
        argumentsDelta: '{}',
      })),
    ]
    const chunks = await collect(guardTextThinkingStream(feed(source)))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'RESPONSE_TOO_LARGE' } },
    })
  })

  it('rejects case-insensitive and attribute-bearing thinking tags', async () => {
    for (const text of ['<THINKING>private</THINKING>answer', '<think mode="hidden">private</think>answer']) {
      const chunks = await collect(guardTextThinkingStream(feed([
        { type: 'block-end', index: 0, block: { type: 'text', text } },
        finish(),
      ])))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
    }
  })

  it('keeps an inline XML mention ordinary', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Use <thinking> as an example.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Use <thinking> as an example.' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('passes native reasoning, tool, usage, and terminal-only ordinary text blocks', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'native' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'native' } },
      { type: 'tool-call-delta', index: 1, id: CallId('call-1'), name: 'noop', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-1'), name: 'noop', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'terminal text' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('passes a text delta without a preceding block-start when it is ordinary', async () => {
    const source: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'ordinary' },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('does not publish tagged text deltas when block-start is missing', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'text-delta', index: 0, text: '<thinking>private</thinking>answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>private</thinking>answer' } },
      finish(),
    ])))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } },
    })
  })

  it('flushes deferred later blocks when a suspected prefix becomes ordinary', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thi' },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'native' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'native' } },
      { type: 'text-delta', index: 0, text: 'n' },
      { type: 'text-delta', index: 0, text: 'x is ordinary' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<thinx is ordinary' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual([
      source[0], source[1], source[5], source[6], source[2], source[3], source[4], source[7], source[8],
    ])
  })

  it('handles multiple pending text indexes and a duplicate start without reordering', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'zero' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'zero' } },
      { type: 'text-delta', index: 1, text: 'one' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'one' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('selects the lowest pending index when insertion order is not sorted', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 3, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'zero' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'zero' } },
      { type: 'text-delta', index: 2, text: 'two' },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'two' } },
      { type: 'text-delta', index: 3, text: 'three' },
      { type: 'block-end', index: 3, block: { type: 'text', text: 'three' } },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual([
      source[0], source[1], source[3], source[2], source[4], source[5], source[6], source[7], source[8], source[9],
    ])
  })

  it('drains later chunks after an empty pending state reaches end-of-stream', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'later' },
    ]
    const chunks = await collect(guardTextThinkingStream(feed(source)))
    expect(chunks).toEqual([
      source[0], source[1], source[2],
      { type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'model stream ended without a terminal finish chunk' } } },
    ])
  })

  it('flushes multiple pending states and the deferred finish at end-of-stream', async () => {
    const source: StreamChunk[] = [
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-start', index: 0, blockType: 'text' },
      finish(),
    ]
    await expect(collect(guardTextThinkingStream(feed(source)))).resolves.toEqual(source)
  })

  it('rejects a state whose streamed prefix and terminal text disagree', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ordinary' } },
      finish(),
    ])))
    expect(chunks).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: UNSAFE_MODEL_OUTPUT_CODE } } })
  })

  it('normalizes an upstream EOF to a terminal stream failure', async () => {
    const chunks = await collect(guardTextThinkingStream(feed([
      { type: 'block-start', index: 0, blockType: 'text' },
    ])))
    expect(chunks).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED' } } })
  })

  it('does not contain unrelated source errors', async () => {
    async function* broken(): AsyncGenerator<StreamChunk> {
      throw new Error('source failed')
    }
    await expect(collect(guardTextThinkingStream(broken()))).rejects.toThrow('source failed')
  })

  it('does not rewrite an upstream STREAM_CLOSED error', async () => {
    async function* broken(): AsyncGenerator<StreamChunk> {
      throw new HarnessError('upstream closed', 'STREAM_CLOSED')
    }
    await expect(collect(guardTextThinkingStream(broken()))).rejects.toThrow('upstream closed')
  })
})
