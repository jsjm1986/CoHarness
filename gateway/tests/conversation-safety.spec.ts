import { describe, expect, it } from 'vitest'
import { assertSafeAssistantEvent, hasTaggedThinkingPrefix } from '../src/conversation-safety.ts'

describe('conversation safety', () => {
  it('recognizes tagged and incomplete thinking prefixes only at the text start', () => {
    expect(hasTaggedThinkingPrefix('<thinking>private</thinking>answer')).toBe(true)
    expect(hasTaggedThinkingPrefix('<analysis>private')).toBe(true)
    expect(hasTaggedThinkingPrefix('Use <thinking> as an example')).toBe(false)
    expect(hasTaggedThinkingPrefix('ordinary response')).toBe(false)
  })

  it('rejects unsafe assistant surface events without inspecting their text', () => {
    expect(() => assertSafeAssistantEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '<think>private</think>answer' }] } },
    })).toThrow('unnormalized tagged thinking')
    expect(() => assertSafeAssistantEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>private</thinking>' } } },
    })).toThrow('unnormalized tagged thinking')
  })

  it('accepts ordinary and non-text assistant events', () => {
    expect(() => assertSafeAssistantEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'answer' }] } },
    })).not.toThrow()
    expect(() => assertSafeAssistantEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'private' }] } },
    })).not.toThrow()
    expect(() => assertSafeAssistantEvent({ type: 'turn/end', data: {} })).not.toThrow()
  })
})
