import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, sessionFormatV3ToV4 } from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 3, id: 'fold', createdAt: 1, isSeeded: false, delegationDepth: 0,
}

function run(rows: readonly Omit<SessionFormatEvent, 'seq'>[]) {
  const stage = sessionFormatV3ToV4.createStage({
    sourceHeader: header,
    targetHeader: sessionFormatV3ToV4.migrateHeader(header),
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const [seq, row] of rows.entries()) stage.transformEvent({ ...row, seq } as SessionFormatEvent, collector)
  return { events: collector.values, inheritedEventCount: stage.finish(collector) }
}

describe('v3-to-v4 chunk folding', () => {
  it('folds a chunk group into its settling assistant/message stream', () => {
    const { events } = run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'assistant/chunk', time: 2, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
      { type: 'assistant/chunk', time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
      { type: 'assistant/message', time: 4, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [] } } },
      { type: 'turn/end', time: 5, data: { turn: 1, reason: 'done' } },
    ])
    expect(events.map(event => event.type)).toEqual(['turn/start', 'assistant/message', 'turn/end'])
    expect(events.map(event => event.seq)).toEqual([0, 1, 2])
    const stream = (events[1] as SessionFormatEvent).data as { stream: unknown }
    expect(JSON.stringify(stream)).toContain('hi')
  })

  it('synthesizes assistant/attempt for a group closed without settlement', () => {
    const { events } = run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'assistant/chunk', time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
      { type: 'turn/end', time: 3, data: { turn: 1, reason: 'done' } },
    ])
    expect(events.map(event => event.type)).toEqual(['turn/start', 'assistant/attempt', 'turn/end'])
  })

  it('remaps compaction shadowedSeqs across the fold', () => {
    const { events } = run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'assistant/chunk', time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
      { type: 'assistant/message', time: 3, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [] } } },
      {
        type: 'compaction/summary', time: 4,
        data: {
          compactionId: 'c', provider: 'p', model: 'm', summary: [], shadowedTokenCount: 1,
          shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0, 2],
        },
      },
    ])
    expect(events.at(-1)).toMatchObject({
      data: { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0, 1] },
    })
  })
})

describe('v4 admission', () => {
  it('refuses assistant/chunk rows and events', () => {
    const decoder = releasedV4SessionFormatCodec.createDecoder(
      { type: 'session', ...header, version: 4 }, 'strict',
    )
    const collector = new SessionFormatEventCollector()
    expect(() => {
      decoder.decodeRow(
        { type: 'assistant/chunk', seq: 0, time: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } },
        collector,
      )
    }).toThrow(/assistant\/chunk/)
  })
})
