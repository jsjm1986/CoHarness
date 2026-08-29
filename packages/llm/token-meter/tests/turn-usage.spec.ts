import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '../src/turn-usage.ts'

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq, type, data } as unknown as SessionEvent
}

type UsageOverrides = { [Key in keyof TokenUsage]?: TokenUsage[Key] | undefined }

function usage(overrides: UsageOverrides = {}): TokenUsage {
  const value = { inputTokens: 100, outputTokens: 20, totalTokens: 170, cacheReadTokens: 50, ...overrides }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as unknown as TokenUsage
}

function message(seq: number, value?: TokenUsage, provider = 'deepseek', model = 'deepseek-chat', step = 1): SessionEvent {
  return event(seq, 'assistant/message', {
    turn: 1, step,
    message: { id: `message-${seq}`, role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider, model } },
    ...value === undefined ? {} : { usage: value },
  })
}

function complete(...middle: readonly SessionEvent[]): SessionEvent[] {
  return [event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 }), ...middle, event(90, 'step/end', { turn: 1, step: 1 }), event(91, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]
}

describe('deriveTurnTokenUsage', () => {
  it('aggregates exact buckets and route attribution', () => {
    expect(deriveTurnTokenUsage(complete(message(3, usage({ cacheWriteTokens: 0, reasoningTokens: 8 }))))).toEqual({
      uncachedInputTokens: 100, outputTokens: 20, totalTokens: 170,
      cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 8,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    })
  })

  it('replaces a streaming sample and adds a retried attempt once', () => {
    const result = deriveTurnTokenUsage(complete(
      event(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: usage() } }),
      event(4, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } } }),
      event(5, 'llm/retry', { turn: 1, step: 1 }),
      event(6, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
      message(7, usage({ inputTokens: 40, outputTokens: 10, totalTokens: 70, cacheReadTokens: 20 })),
    ))
    expect(result).toEqual({ uncachedInputTokens: 140, outputTokens: 30, totalTokens: 240, cacheReadTokens: 70 })
  })

  it('fails closed for incomplete or contradictory usage', () => {
    expect(deriveTurnTokenUsage(complete(message(3)))).toBeUndefined()
    expect(deriveTurnTokenUsage(complete(message(3, usage({ totalTokens: 171, cacheWriteTokens: 0 }))))).toBeUndefined()
    expect(deriveTurnTokenUsage(complete(message(3, usage({ totalTokens: undefined, cacheWriteTokens: undefined }))))).toBeUndefined()
  })

  it('omits optional aggregates when one attempt lacks them', () => {
    const events = [
      event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 }), message(3, usage()),
      event(4, 'step/end', { turn: 1, step: 1 }), event(5, 'step/start', { turn: 1, step: 2 }),
      message(6, usage({ cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }), '', '', 2),
      event(7, 'step/end', { turn: 1, step: 2 }), event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(deriveTurnTokenUsage(events)).toEqual({ uncachedInputTokens: 200, outputTokens: 40, totalTokens: 340 })
  })
})
