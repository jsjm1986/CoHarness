/** Assistant block classifier (moved here with sessions/conversation.ts). */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-api-remotes/client'
import { sanitizeAssistantText, toAssistantBlock, toAssistantBlocks } from '../src/client/sessions/conversation.ts'

describe('toAssistantBlock', () => {
  it('classifies the four block shapes', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 1,
      height: 1,
    }
    const blocks: ContentBlock[] = [
      { type: 'text', text: '正文' },
      { type: 'reasoning', text: '思考' },
      { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' } as ContentBlock,
      { type: 'image', attachment },
    ]
    expect(toAssistantBlocks(blocks)).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'reasoning', text: '思考' },
      { kind: 'tool-call', callId: 'c1', name: 'echo', argsRaw: '{}' },
      { kind: 'image', attachment },
    ])
    expect(toAssistantBlock(blocks[0] as ContentBlock)).toEqual({ kind: 'text', text: '正文' })
  })

  it('hides tagged thinking prefixes from historical visible text', () => {
    expect(sanitizeAssistantText('<thinking>private</thinking>answer')).toBe('answer')
    expect(sanitizeAssistantText('<thinking>private')).toBe('')
    expect(sanitizeAssistantText('Use <thinking> as an example')).toBe('Use <thinking> as an example')
    expect(toAssistantBlock({ type: 'text', text: '<analysis>private</analysis>answer' })).toEqual({ kind: 'text', text: 'answer' })
    expect(toAssistantBlocks([{ type: 'text', text: '<think>private</think>' }])).toEqual([{ kind: 'text', text: '' }])
  })
})
