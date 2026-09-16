import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import { estimateMessage } from '../src/estimate.ts'
import { foldSurfaceTokens } from '../src/surface-fold.ts'
import type { TokenSurfaceNode } from '../src/types.ts'

function append(seq: number, text: string): SurfaceEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

function replace(seq: number, start: SessionSeq, end: SessionSeq, text = 'summary'): SurfaceEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'test' },
    }),
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [start, end],
  }
}

describe('foldSurfaceTokens', () => {
  it('prices the message override instead of the durable message', () => {
    const fold = foldSurfaceTokens([], append(1, 'the durable text'), createUserMessage({
      content: [{ type: 'text', text: 'a much longer override text' }],
      source: { kind: 'user' },
    }))
    expect(fold.nodes).toHaveLength(1)
    // A null override prices a known-empty derivation (e.g. provider content
    // absent) without inventing tokens for the durable text.
    expect(foldSurfaceTokens([], append(1, 'durable'), null).tokens).toBe(0)
    expect(fold.tokens).toBe(estimateMessage(createUserMessage({
      content: [{ type: 'text', text: 'a much longer override text' }],
      source: { kind: 'user' },
    })))
  })

  it('rejects an event that carries no surface operation', () => {
    // A non-surface record reaches the fold only when a caller misroutes it;
    // validateSurfaceMetadata returns no operation for it rather than throwing.
    const misplaced = {
      type: 'step/start',
      seq: SessionSeq(1),
      time: 0,
      data: { turn: 1, step: 1 },
    } as unknown as SurfaceEvent
    expect(() => foldSurfaceTokens([], misplaced)).toThrow('carries no surface operation')
  })

  it('rejects a replacement range that does not resolve on the folded nodes', () => {
    const nodes: TokenSurfaceNode[] = [
      { seq: SessionSeq(1), tokens: 4, heuristicTokens: 4 },
      { seq: SessionSeq(2), tokens: 4, heuristicTokens: 4 },
    ]
    // Each arm fails before any node is copied: the start absent from the
    // surface, the end absent, and an inverted pair that both resolve.
    expect(() => foldSurfaceTokens(nodes, replace(10, SessionSeq(5), SessionSeq(1))))
      .toThrow('invalid current range 5-1')
    expect(() => foldSurfaceTokens(nodes, replace(10, SessionSeq(1), SessionSeq(5))))
      .toThrow('invalid current range 1-5')
    expect(() => foldSurfaceTokens(nodes, replace(10, SessionSeq(2), SessionSeq(1))))
      .toThrow('invalid current range 2-1')
  })
})
