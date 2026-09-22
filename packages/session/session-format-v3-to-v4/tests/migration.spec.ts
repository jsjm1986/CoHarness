import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV4Header,
  assertV4EventAdmission,
  assertV4RowAdmission,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
  sessionFormatV3ToV4,
} from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 3, id: 'fold', createdAt: 1, isSeeded: false, delegationDepth: 0,
}
const seeded: SessionFormatHeader = { ...header, isSeeded: true }

function run(rows: readonly { type: string; time: number; data?: unknown }[], sourceHeader = header, cut: number | undefined = 0) {
  const stage = sessionFormatV3ToV4.createStage({
    sourceHeader,
    targetHeader: sessionFormatV3ToV4.migrateHeader(sourceHeader),
    sourceInheritedEventCount: cut,
    sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const [seq, row] of rows.entries()) stage.transformEvent({ ...row, seq } as unknown as SessionFormatEvent, collector)
  return { events: collector.values, inheritedEventCount: stage.finish(collector) }
}

const chunk = (seq: number, body: Record<string, unknown>, turn = 1, step = 1) =>
  ({ type: 'assistant/chunk', time: seq + 1, data: { turn, step, chunk: body } })
const textDelta = (text: string, index = 0) => ({ type: 'text-delta', index, text })

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
    const stream = events[1]!.data as { stream: unknown }
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

describe('v3-to-v4 stage guards', () => {
  it('rejects non-dense source events', () => {
    const stage = sessionFormatV3ToV4.createStage({
      sourceHeader: header,
      targetHeader: sessionFormatV3ToV4.migrateHeader(header),
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    expect(() => {
      stage.transformEvent(
        { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
        new SessionFormatEventCollector(),
      )
    }).toThrow('format v3 source events must be dense')
  })

  it('expands runs through the same event path', () => {
    const stage = sessionFormatV3ToV4.createStage({
      sourceHeader: header,
      targetHeader: sessionFormatV3ToV4.migrateHeader(header),
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    const collector = new SessionFormatEventCollector()
    stage.transformRun({
      runType: 'test-run', firstSeq: 0, eventCount: 1,
      *expand() { yield { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
    }, collector)
    expect(stage.finish(collector)).toBe(0)
    expect(collector.values.map(item => item.type)).toEqual(['turn/start'])
  })

  it('validates only a v4 target header', () => {
    expect(() => { sessionFormatV3ToV4.validateTargetHeader({ ...header, version: 4 }) }).not.toThrow()
    expect(() => { sessionFormatV3ToV4.validateTargetHeader(header) }).toThrow('expected format v4 header')
  })
})

describe('v3-to-v4 inherited cut', () => {
  it('carries a bare marker at the seed count and accepts the flagged form', () => {
    const bare = run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', time: 2, data: {} },
      { type: 'turn/start', time: 3, data: { turn: 2 } },
    ], seeded, 1)
    expect(bare.inheritedEventCount).toBe(1)

    const flagged = run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', time: 2, data: { inherited: true } },
    ], seeded, 1)
    expect(flagged.inheritedEventCount).toBe(1)
  })

  it('accepts a flagged marker at any position when the source cut is undeclared', () => {
    const migrated = run([
      { type: 'session/end-seed', time: 1, data: { inherited: true } },
      { type: 'turn/start', time: 2, data: { turn: 1 } },
    ], seeded, undefined)
    expect(migrated.inheritedEventCount).toBe(0)
  })

  it('rejects a flagged marker in an unseeded log and one off the declared cut', () => {
    expect(() => run([
      { type: 'session/end-seed', time: 1, data: { inherited: true } },
    ], header, 0)).toThrow('unseeded Session contains an inherited end-seed marker')
    expect(() => run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'session/end-seed', time: 2, data: { inherited: true } },
    ], seeded, 5)).toThrow('disagrees with its seed cut')
  })

  it('treats later end-seed events as ordinary delimiters', () => {
    const { events } = run([
      { type: 'session/end-seed', time: 1, data: { inherited: true } },
      { type: 'session/end-seed', time: 2, data: { inherited: true } },
      { type: 'turn/end', time: 3, data: { turn: 1, reason: 'done' } },
    ], seeded, 0)
    expect(events.filter(item => item.type === 'session/end-seed')).toHaveLength(2)
  })

  it('passes an end-seed delimiter with non-record data through unseeded logs', () => {
    const { events } = run([
      { type: 'session/end-seed', time: 1, data: 'x' },
      { type: 'turn/start', time: 2, data: { turn: 1 } },
    ])
    expect(events[0]!.data).toBe('x')
  })

  it('rejects a seeded log missing its marker and a cut inside an open chunk group', () => {
    expect(() => run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
    ], seeded, 1)).toThrow('lacks its inherited end-seed marker')
    expect(() => run([
      chunk(0, textDelta('a')),
      { type: 'session/end-seed', time: 2, data: { inherited: true } },
    ], seeded, 1)).toThrow('splits one Assistant attempt')
  })

  it('separates inherited and live chunk groups across the marker', () => {
    const { events, inheritedEventCount } = run([
      chunk(0, textDelta('a')),
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [] } },
      { type: 'session/end-seed', time: 3, data: { inherited: true } },
      chunk(3, textDelta('b')),
      { type: 'turn/end', time: 5, data: { turn: 1, reason: 'done' } },
    ], seeded, 2)
    expect(inheritedEventCount).toBe(1)
    expect(events.filter(item => item.type === 'assistant/attempt')).toHaveLength(1)
  })
})

describe('v3-to-v4 chunk group edges', () => {
  it('rejects chunk events lacking coordinates or a record chunk body', () => {
    expect(() => run([{ type: 'assistant/chunk', time: 1, data: { turn: 1 } }])).toThrow('lacks turn, step, or chunk')
    expect(() => run([{ type: 'assistant/chunk', time: 1, data: 7 }] as never)).toThrow('lacks turn, step, or chunk')
  })

  it('closes a group at a turn boundary and after a terminal chunk', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      chunk(1, textDelta('b'), 2, 1),
      chunk(2, { type: 'finish', reason: 'stop' }, 2, 1),
      chunk(3, textDelta('c'), 2, 1),
      { type: 'turn/end', time: 5, data: { turn: 2, reason: 'done' } },
    ])
    expect(events.filter(item => item.type === 'assistant/attempt')).toHaveLength(3)
  })

  it('flushes buffered interleaved events ahead of a settlement', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      { type: 'session/title', time: 2, data: { title: 't' } },
      chunk(2, textDelta('b')),
      { type: 'assistant/message', time: 4, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [{ type: 'chunk', time: 4, chunk: textDelta('ab') }] } },
    ])
    expect(events.map(item => item.type)).toEqual(['session/title', 'assistant/message'])
  })

  it('attaches the folded stream to a settlement that lacks one', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] } } },
    ])
    expect(JSON.stringify((events.at(-1)!.data as { stream: unknown }).stream)).toContain('a')
  })

  it('settles a mismatched group aside and emits group-free settlements with an empty stream', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      { type: 'assistant/message', time: 2, data: { turn: 2, step: 1, message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [] } },
      { type: 'assistant/attempt', time: 3, data: 'x' },
    ])
    expect(events.map(item => item.type)).toEqual(['assistant/attempt', 'assistant/message', 'assistant/attempt'])
    expect(events.at(-1)!.data).toEqual({ stream: [] })
  })
})

describe('v3-to-v4 reference remapping', () => {
  it('passes append and remaps replace surface operations', () => {
    const { events } = run([
      { type: 'system/message', time: 1, data: { turn: 1, step: 1, message: { id: 's', role: 'system', source: { kind: 'model' }, content: [] } } },
      { type: 'session/title', time: 2, data: { title: 't' }, surfaceOp: 'append' } as never,
      { type: 'user/message', time: 3, data: { role: 'user', id: 'u', content: [] }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as never,
    ])
    expect(events[1]).toMatchObject({ surfaceOp: 'append' })
    expect(events[2]).toMatchObject({ surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } })
  })

  it.each([7, { op: 'append' }, { op: 'replace', startSeq: 0 }] as const)(
    'rejects a malformed surfaceOp %j', (surfaceOp) => {
      expect(() => run([{ type: 'session/title', time: 1, data: { title: 't' }, surfaceOp } as never]))
        .toThrow('requires exact replace fields')
    })

  it('remaps envelope sourceEventSeqs on non-settlement events', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [] } },
      { type: 'session/title', time: 3, data: { title: 't' }, sourceEventSeqs: [1] } as never,
    ])
    expect(events[1]).toMatchObject({ sourceEventSeqs: [0] })
  })

  it('drops a settlement envelope sourceEventSeqs before remapping', () => {
    const { events } = run([
      { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [] }, sourceEventSeqs: [] } as never,
    ])
    expect(events[0]).not.toHaveProperty('sourceEventSeqs')
  })

  it('remaps command/done, compaction, and title references or rejects the malformed', () => {
    const { events } = run([
      chunk(0, textDelta('a')),
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [] }, stream: [] } },
      { type: 'command/done', time: 3, data: {} },
      { type: 'command/done', time: 4, data: { sourceEventSeq: 1 } },
      { type: 'session/title', time: 5, data: { title: 't' } },
      { type: 'session/title-llm-request', time: 6, data: { messageSeqs: [1] } },
    ])
    expect(events[2]!.data).toMatchObject({ sourceEventSeq: 0 })
    expect(events[4]!.data).toMatchObject({ messageSeqs: [0] })

    expect(() => run([{ type: 'compaction/prune', time: 1, data: { shadowedSeqs: [] } }]))
      .toThrow('lacks its shadowedRange')
    expect(() => run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'compaction/prune', time: 2, data: { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: 'x' } },
    ])).toThrow('v3 shadowedSeqs must be an array')
    expect(() => run([{ type: 'session/title', time: 1, data: { messageSeqs: 'x' } }]))
      .toThrow('v3 messageSeqs must be an array')
  })

  it('rejects references that do not name an earlier event', () => {
    expect(() => run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'command/done', time: 2, data: { sourceEventSeq: 'x' } },
    ])).toThrow('does not name an earlier event')
    expect(() => run([
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'command/done', time: 2, data: { sourceEventSeq: 9 } },
    ])).toThrow('does not name an earlier event')
  })

  it('passes non-record event data through unchanged', () => {
    const { events } = run([{ type: 'feedback/record', time: 1, data: 'x' }])
    expect(events[0]!.data).toBe('x')
  })
})

describe('v4 codec and validation', () => {
  const physicalHeader = { type: 'session', ...header, version: 4 }
  const turn = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }

  it('round-trips the v4 header and one event row', () => {
    expect(releasedV4SessionFormatCodec.decodeHeader(physicalHeader)).toEqual({ ...header, version: 4 })
    expect(() => releasedV4SessionFormatCodec.decodeHeader({ ...physicalHeader, version: 3 }))
      .toThrow('expected format v4 physical Session header')
    expect(() => releasedV4SessionFormatCodec.decodeHeader('x'))
      .toThrow('format v4 physical Session header')

    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const collector = new SessionFormatEventCollector()
    decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent(turn), collector)
    expect(decoder.finish(collector)).toBe(0)
    expect(collector.values.map(item => item.type)).toEqual(['turn/start'])
  })

  it('encodes v4 headers and events through the admission checks', () => {
    const encoded = releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, 0)
    expect(encoded).toMatchObject({ type: 'session', version: 4 })
    expect(() => releasedV4SessionFormatCodec.encodeHeader(header, 0)).toThrow('expected format v4 header')
    expect(() => releasedV4SessionFormatCodec.encodeEvent(
      { type: 'assistant/chunk', seq: 0, time: 1, data: {} },
    )).toThrow('assistant/chunk is a v3 row')
  })

  it('refuses non-ignorable dispatch events and admits the ignorable form', () => {
    for (const type of ['tool/code-dispatch-start', 'tool/code-dispatch']) {
      expect(() => { assertV4EventAdmission({ type, seq: 0, time: 1, data: {} }) })
        .toThrow(`format v4 contains unknown event type ${JSON.stringify(type)}`)
      expect(() => {
        assertV4EventAdmission({ type, seq: 0, time: 1, data: {}, ignorable: true })
      }).not.toThrow()
    }
  })

  it('admits non-object rows through the v3 row rules only', () => {
    expect(() => { assertV4RowAdmission('[]') }).not.toThrow()
    expect(() => {
      assertV4RowAdmission({ type: 'assistant/chunk', seq: 0, time: 1, data: {} })
    }).toThrow('assistant/chunk is a v3 row')
  })

  it('restores a v4 artifact under the v3 rules and refuses chunks', () => {
    const artifact = {
      header: { ...header, version: 4 },
      inheritedEventCount: 0,
      events: [turn],
    }
    expect(restoreReleasedV4Artifact(artifact, new Set())).toEqual(artifact)
    expect(() => { assertReleasedV4Header(header) }).toThrow('expected format v4 header')
    expect(() => restoreReleasedV4Artifact({
      ...artifact,
      events: [{ type: 'assistant/chunk', seq: 0, time: 1, data: {} }],
    }, new Set())).toThrow('assistant/chunk is a v3 row')
  })
})
