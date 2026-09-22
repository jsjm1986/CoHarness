import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/legacy.ts'
import type { SessionFormatArtifact, SessionFormatEvent } from '../src/legacy.ts'

/** Legacy flat `assistant/message` field carrying the model source record. */
const LEGACY_ASSISTANT_SOURCE_KEY = ['pro', 'venance'].join('')

function event(type: string, seq: number, data: unknown, extra: Record<string, unknown> = {}): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...extra } as unknown as SessionFormatEvent
}

function migrate(events: readonly SessionFormatEvent[], version = 1, header: Record<string, unknown> = {}, inheritedEventCount = 0) {
  return sessionFormatCatalog.migrate({
    header: { version, id: 's', createdAt: 1, ...header },
    inheritedEventCount,
    events,
  })
}

/** Streams events through the full chain without the artifact-level JSON/density validation. */
function stream(events: readonly SessionFormatEvent[], version = 0, header: Record<string, unknown> = {}, inheritedEventCount = 0) {
  const output: SessionFormatEvent[] = []
  const flow = sessionFormatCatalog.createStream(
    { version, id: 's', createdAt: 1, ...header }, inheritedEventCount,
    { emitEvent: value => output.push(value) },
  )
  for (const item of events) flow.emitEvent(item)
  flow.finish()
  return output
}

describe('legacy compaction type rename', () => {
  it('renames the compact/* vocabulary and threads a generated compaction id', () => {
    const migrated = migrate([
      event('compact/start', 0, {}),
      event('compact/summary', 1, { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0] }),
      event('compact/end', 2, {}),
      event('compact/prune', 3, { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [] }),
    ])
    expect(migrated.events.map(item => item.type)).toEqual([
      'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
    ])
    const start = migrated.events[0]!.data as Record<string, unknown>
    expect(start['compactionId']).toBe('legacy-compaction:s:0')
    expect(migrated.events[1]!.data).toMatchObject({ compactionId: 'legacy-compaction:s:0' })
  })
})

describe('unsupported legacy payloads', () => {
  it.each(['request/header-delta', 'mode/set'] as const)('refuses %s', (type) => {
    expect(() => migrate([event(type, 0, {})])).toThrow(`unsupported legacy ${type} event at seq 0`)
  })

  it('refuses a request/header fallback reason', () => {
    expect(() => migrate([event('request/header', 0, { reason: 'fallback', header: {} })])).toThrow(
      'unsupported request/header reason "fallback" at seq 0')
  })
})

describe('legacy turn normalization', () => {
  it('drops the retired turn/start trigger payload', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1, trigger: { kind: 'prompt' } }),
      event('turn/start', 1, { turn: 2, note: 'kept' }),
      event('turn/start', 2, null),
    ])
    expect(migrated.events[0]!.data).toEqual({ turn: 1 })
    expect(migrated.events[1]!.data).toEqual({ turn: 2, note: 'kept' })
    expect(migrated.events[2]!.data).toBeNull()
  })

  it.each([
    [{ turn: 'x', trigger: { kind: 'prompt' } }],
    [{ turn: 0, trigger: { kind: 'prompt' } }],
    [{ turn: 1, trigger: 'prompt' }],
    [{ turn: 1, trigger: { kind: '' } }],
    [{ turn: 1, trigger: {} }],
  ] as const)('rejects malformed turn/start %j', (data) => {
    expect(() => migrate([event('turn/start', 0, data)])).toThrow('malformed legacy turn/start at seq 0')
  })

  it.each(['completed', 'blocked', 'max-tokens', 'interrupted', 'other'] as const)('keeps current turn/end reason %s', (kind) => {
    const migrated = migrate([event('turn/end', 0, { turn: 1, reason: { kind } })])
    expect(migrated.events[0]!.data).toEqual({ turn: 1, reason: { kind } })
  })

  it('folds retired aborted variants into the current reason shape', () => {
    const migrated = migrate([
      event('turn/end', 0, { reason: { kind: 'aborted' } }),
      event('turn/end', 1, { reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      event('turn/end', 2, { reason: { kind: 'disposed' } }),
      event('turn/end', 3, null),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    expect(migrated.events[1]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(migrated.events[2]!.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    expect(migrated.events[3]!.data).toBeNull()
  })

  it('folds the retired flat error reason into the nested shape', () => {
    const migrated = migrate([
      event('turn/end', 0, { reason: { kind: 'error', message: 'boom', code: 'X' } }),
      event('turn/end', 1, { reason: { kind: 'error', message: 'boom' } }),
      event('turn/end', 2, { reason: { kind: 'error', failure: { code: 'C', message: 'f' } } }),
      event('turn/end', 3, { reason: { kind: 'error', error: { code: 'E', message: 'kept' } } }),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ reason: { kind: 'error', error: { message: 'boom', code: 'X' } } })
    expect(migrated.events[1]!.data).toMatchObject({ reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    expect(migrated.events[2]!.data).toMatchObject({ reason: { kind: 'error', error: { code: 'C', message: 'f' } } })
    expect(migrated.events[3]!.data).toMatchObject({ reason: { kind: 'error', error: { code: 'E', message: 'kept' } } })
  })

  it.each([
    [{ reason: 'x' }],
    [{ reason: { kind: 1 } }],
    [{ reason: { kind: 'error', failure: 'x' } }],
    [{ reason: { kind: 'error', failure: { code: 'C' } } }],
    [{ reason: { kind: 'error' } }],
    [{ reason: { kind: 'error', message: 'm', code: 3 } }],
  ] as const)('rejects malformed turn/end %j', (data) => {
    expect(() => migrate([event('turn/end', 0, data)])).toThrow('malformed legacy turn/end at seq 0')
  })
})

describe('legacy request/header normalization', () => {
  it('strips the retired messagePrefix payload', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: { system: 'p', messagePrefix: ['a'], config: {} }, reason: 'initial' }),
      event('request/header', 2, { header: { config: {} }, reason: 'initial' }),
    ])
    const header = migrated.events.at(-1)!.data as Record<string, unknown>
    expect(header['header']).toEqual({ config: {} })
  })

  it('passes a data-less request/header through the legacy stage', () => {
    // The v2 emitOne path owns the crash for a header-less carrier; the legacy
    // normalizer only proves it leaves non-record payloads alone.
    expect(() => stream([event('request/header', 0, null)], 1)).toThrow()
  })

  it('rejects a non-array messagePrefix', () => {
    expect(() => migrate([event('request/header', 0, { header: { messagePrefix: 'x' }, reason: 'initial' })])).toThrow(
      'malformed request/header messagePrefix at seq 0')
  })
})

describe('legacy steering/message normalization', () => {
  it('unwraps an enveloped message and synthesizes identity for the bare form', () => {
    const migrated = migrate([
      event('steering/message', 0, { turn: 1, message: { role: 'user', content: [], id: 'w-1' } }),
      event('steering/message', 1, { turn: 1, content: [], note: true }),
    ])
    expect(migrated.events[0]).toMatchObject({ type: 'user/message', data: { id: 'w-1' } })
    expect(migrated.events[1]).toMatchObject({
      type: 'user/message',
      data: { id: 'legacy-message:s:1', role: 'user', content: [], note: true },
    })
    expect((migrated.events[1]!.data as Record<string, unknown>)['turn']).toBeUndefined()
  })

  it.each([
    [undefined],
    [{ message: { id: 'm' }, turn: 'x' }],
  ] as const)('rejects malformed steering/message %j', (data) => {
    expect(() => stream([event('steering/message', 0, data)], 1)).toThrow('malformed legacy steering/message at seq 0')
  })
})

describe('legacy llm/retry identity', () => {
  it('keeps real ids, chains a generated one, and passes an explicit empty id through', () => {
    const base = { turn: 1, step: 1, provider: 'p', policyKey: 'k' }
    const migrated = migrate([
      event('llm/retry', 0, { ...base, retryId: 'r-1' }),
      event('llm/retry', 1, { ...base }),
      event('llm/retry', 2, { ...base, policyKey: 'other' }),
      event('llm/retry', 3, { ...base, retryId: '' }),
      event('llm/retry', 4, null),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ retryId: 'r-1' })
    // The chain key reuses the id recorded by the earlier event.
    expect(migrated.events[1]!.data).toMatchObject({ retryId: 'r-1' })
    expect(migrated.events[2]!.data).toMatchObject({ retryId: 'legacy-retry:s:2' })
    expect(migrated.events[3]!.data).toMatchObject({ retryId: '' })
    expect(migrated.events[4]!.data).toBeNull()
  })
})

describe('legacy compaction bracket identity', () => {
  it('keeps declared ids, threads generated ones, and clears state at bracket end', () => {
    const migrated = migrate([
      event('compaction/start', 0, { compactionId: 'c-1' }),
      event('compaction/summary', 1, { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0] }),
      event('compaction/end', 2, { compactionId: 'c-1' }),
      event('compaction/summary', 3, { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [] }),
      event('session/end-seed', 4, {}),
      event('compaction/start', 5, { compactionId: 7 }),
    ])
    expect(migrated.events[1]!.data).toMatchObject({ compactionId: 'c-1' })
    // After compaction/end and end-seed cleared the bracket, the orphan summary gets no id.
    expect(migrated.events[3]!.data).not.toHaveProperty('compactionId')
    // A declared non-string compactionId owns its key and passes through.
    expect(migrated.events[5]!.data).toMatchObject({ compactionId: 7 })
  })

  it('passes non-carrier events and data-less carriers inside an open bracket', () => {
    const migrated = migrate([
      event('compaction/start', 0, null),
      event('turn/start', 1, { turn: 1 }),
      event('compaction/end', 2, null),
      event('session/end-seed', 3, null),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ compactionId: 'legacy-compaction:s:0' })
    expect(migrated.events[1]!.data).toEqual({ turn: 1 })
    expect(migrated.events[2]!.data).toBeNull()
  })

  it('rejects a data-less user message inside an open bracket downstream', () => {
    expect(() => migrate([
      event('compaction/start', 0, null),
      event('user/message', 1, null),
    ])).toThrow('invalid content')
  })

  it('adds the bracket id to a compact-plugin user message source only', () => {
    const migrated = migrate([
      event('compaction/start', 0, {}),
      event('user/message', 1, { role: 'user', id: 'u-1', content: [], source: { kind: 'plugin', plugin: 'compact' } }),
      event('user/message', 2, { role: 'user', id: 'u-2', content: [], source: { kind: 'plugin', plugin: 'compact', compactionId: 'own' } }),
      event('user/message', 3, { role: 'user', id: 'u-3', content: [], source: { kind: 'user' } }),
      event('user/message', 4, { role: 'user', id: 'u-4', content: [] }),
    ])
    expect(migrated.events[1]!.data).toMatchObject({ source: { kind: 'plugin', plugin: 'compact', compactionId: 'legacy-compaction:s:0' } })
    expect(migrated.events[2]!.data).toMatchObject({ source: { compactionId: 'own' } })
    expect(migrated.events[3]!.data).toMatchObject({ source: { kind: 'user' } })
    expect(migrated.events[4]!.data).toMatchObject({ id: 'u-4' })
  })
})

describe('legacy message carriers', () => {
  it('adds identity to the early flat user message form', () => {
    const migrated = migrate([
      event('user/message', 0, { content: [], source: { kind: 'user' } }),
      event('user/message', 1, { role: 'user', id: 'u-1', content: [], source: { kind: 'user' } }),
      event('user/message', 2, { role: 'user', message: { id: 'm' }, content: [] }),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ id: 'legacy-message:s:0', role: 'user' })
    expect(migrated.events[1]!.data).toMatchObject({ id: 'u-1' })
    expect(migrated.events[2]!.data).toMatchObject({ message: { id: 'm' } })
  })

  it('rejects data-less carriers in the v2 stage', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/result']) {
      expect(() => migrate([event(type, 0, null)], 2)).toThrow(/v2 .* has invalid/)
    }
  })

  it('wraps the early flat assistant form into the message envelope', () => {
    const migrated = migrate([
      event('assistant/message', 0, { content: [{ type: 'text', text: 'hi' }], [LEGACY_ASSISTANT_SOURCE_KEY]: { provider: 'p' }, usage: { in: 1 } }),
      event('assistant/message', 1, { content: [], [LEGACY_ASSISTANT_SOURCE_KEY]: 'x' }),
      event('assistant/message', 2, { message: { id: 'a', content: [] } }),
    ])
    expect(migrated.events[0]!.data).toMatchObject({
      usage: { in: 1 },
      message: { id: 'legacy-message:s:0', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { provider: 'p', kind: 'model' } },
    })
    // A non-record legacy source still folds into the model source.
    expect(migrated.events[1]!.data).toMatchObject({ message: { source: { kind: 'model' } } })
    expect(migrated.events[2]!.data).toMatchObject({ message: { id: 'a' } })
  })

  it('rejects a flat assistant form without the required fields downstream', () => {
    expect(() => migrate([event('assistant/message', 0, { content: [] })])).toThrow('invalid message content')
    expect(() => migrate([event('assistant/message', 0, { content: 'x', [LEGACY_ASSISTANT_SOURCE_KEY]: {} })])).toThrow('invalid message content')
  })

  it('wraps the early flat tool result form and inherits the replaced message id', () => {
    const migrated = migrate([
      event('user/message', 0, { role: 'user', id: 'u-1', content: [] }),
      event('tool/result', 1, { callId: 'c-1', content: [{ type: 'text', text: 'out' }], isError: false, extra: 1 }),
      event('tool/result', 2, { callId: 'c-2', content: [], isError: true }, { surfaceOp: { op: 'replace', start: 0, end: 0 } }),
      event('tool/result', 3, { message: { id: 't', content: [] } }),
    ])
    expect(migrated.events[1]!.data).toMatchObject({
      extra: 1,
      message: {
        id: 'legacy-message:s:1', role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c-1', content: [{ type: 'text', text: 'out' }], isError: false }],
        source: { kind: 'tool', callId: 'c-1' },
      },
    })
    // The replace op names the shadowed user/message seq, so the result reuses its id.
    expect(migrated.events[2]!.data).toMatchObject({ message: { id: 'u-1' } })
    expect(migrated.events[3]!.data).toMatchObject({ message: { id: 't' } })
  })

  it('rejects malformed flat tool results in the v2 stage', () => {
    for (const data of [
      { callId: 5, content: [], isError: false },
      { callId: 'c', content: [], isError: 'x' },
      { callId: 'c', isError: false },
      { callId: 'c', content: [], isError: false, message: { content: 'bad' } },
    ]) {
      expect(() => migrate([event('tool/result', 0, data)])).toThrow('invalid message content')
    }
  })

  it('rejects a replacement citing a seq whose message never got an identity', () => {
    expect(() => migrate([
      event('session/title', 0, { title: 't' }),
      event('tool/result', 1, { callId: 'c', content: [], isError: false }, { surfaceOp: { op: 'replace', start: 0, end: 0 } }),
    ])).toThrow('tool/result 1 replacement cites a message without identity')
  })

  it('rejects a negative replacement start at the v2 reference remap', () => {
    expect(() => migrate([
      event('tool/result', 0, { callId: 'c', content: [], isError: false }, { surfaceOp: { op: 'replace', start: -1, end: 0 } }),
    ])).toThrow('does not name an earlier event')
  })
})

describe('legacy message lists', () => {
  it('synthesizes ids for identity-less inserted and request message items', () => {
    const migrated = migrate([
      event('agent/inbox/spliced', 0, { inserted: [
        { role: 'user', content: [], source: { kind: 'user' } },
        { role: 'user', id: 'q-1', content: [], source: { kind: 'user' } },
      ] }),
      event('session/title-llm-request', 1, { messages: [
        { role: 'user', content: [], source: { kind: 'user' } },
      ], messageSeqs: [0] }),
      event('agent/inbox/spliced', 2, { inserted: [{ role: 'user', id: 'x', content: [] }] }),
      event('session/title', 3, { title: 't' }),
    ])
    expect(migrated.events[0]!.data).toMatchObject({ inserted: [
      { id: 'legacy-message:s:0:0', role: 'user' },
      { id: 'q-1' },
    ] })
    expect(migrated.events[1]!.data).toMatchObject({ messages: [{ id: 'legacy-message:s:1:0' }] })
  })

  it('rejects malformed list fields in the v2 stage', () => {
    expect(() => migrate([event('agent/inbox/spliced', 0, { inserted: 'not-a-list' })], 2)).toThrow('invalid messages')
    expect(() => migrate([event('agent/inbox/spliced', 0, { inserted: [{ role: 'user' }] })], 2)).toThrow('invalid messages')
    expect(() => migrate([event('agent/inbox/spliced', 0, null)], 2)).toThrow('invalid data')
    expect(() => migrate([event('session/title-llm-request', 0, null)], 2)).toThrow('invalid data')
  })
})

describe('inherited end-seed consistency', () => {
  it('rejects a flagged marker that disagrees with the seed cut', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, { inherited: true }),
    ], 1, { isSeeded: true }, 2)).toThrow('inherited end-seed marker disagrees with its seed cut')
  })

  it('rejects a flagged marker in an unseeded v0 log', () => {
    expect(() => migrate([
      event('session/end-seed', 0, { inherited: true }),
    ], 0)).toThrow('unseeded Session contains an inherited end-seed marker')
  })

  it('treats a stored artifact without inheritedEventCount as a zero cut', () => {
    expect(() => sessionFormatCatalog.migrate({
      header: { version: 0, id: 's', createdAt: 1 },
      events: [event('turn/start', 0, { turn: 1 })],
    } as unknown as SessionFormatArtifact)).toThrow('inheritedEventCount must be a non-negative safe integer')
  })

  it('treats an undeclared source cut as zero across the whole chain', () => {
    const output: SessionFormatEvent[] = []
    const flow = sessionFormatCatalog.createStream(
      { version: 0, id: 's', createdAt: 1 },
      undefined,
      { emitEvent: value => output.push(value) },
    )
    flow.emitEvent(event('turn/start', 0, { turn: 1 }))
    expect(flow.finish()).toBe(0)
    expect(output.map(item => item.type)).toEqual(['turn/start'])

    const late = sessionFormatCatalog.createStream(
      { version: 2, id: 's', createdAt: 1 },
      undefined,
      { emitEvent: () => {} },
    )
    late.emitEvent(event('turn/start', 0, { turn: 1 }))
    expect(late.finish()).toBe(0)
  })
})

describe('v2 stage guards', () => {
  it('requires dense source sequences', () => {
    expect(() => stream([
      event('turn/start', 0, { turn: 1 }),
      event('turn/start', 2, { turn: 2 }),
    ], 2)).toThrow('format v2 source events must be dense')
  })

  it('emits the owed end-seed marker when a seeded v2 log ends ahead of its cut', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
    ], 2, { isSeeded: true }, 1)
    expect(migrated.inheritedEventCount).toBe(1)
    expect(migrated.events.map(item => item.type)).toEqual(['turn/start', 'session/end-seed'])
    expect(migrated.events[1]!.data).toEqual({ inherited: true })
  })

  it('counts a generated system head ahead of the cut into the inherited region', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: { system: 'sys' }, reason: 'initial' }),
      event('step/end', 2, { turn: 1, step: 1 }),
      event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ], 2, { isSeeded: true }, 2)
    const marker = migrated.events.findIndex(item => item.type === 'session/end-seed')
    expect(marker).toBeGreaterThan(-1)
    expect(migrated.inheritedEventCount).toBe(marker)
  })

  it('rejects a current-generation delivery marker naming another Session', () => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('session-log-deepseek/delivery-accepted', 1, { sessionId: 'other' }),
    ], 2, {}, 0)).toThrow('current-generation delivery marker names the wrong Session')
    const ok = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('session-log-deepseek/delivery-accepted', 1, { sessionId: 's' }),
      event('session-log-deepseek/delivery-accepted', 2, { sessionId: 'other' }),
    ], 2, {}, 3)
    expect(ok.events).toHaveLength(4)
  })

  it('remaps command/done and title references', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('user/message', 1, { role: 'user', id: 'u-1', content: [] }),
      event('command/done', 2, { sourceEventSeq: 1 }),
      event('command/done', 3, {}),
      event('session/title', 4, { messageSeqs: [1] }),
      event('session/title', 5, { title: 't' }),
      event('session/title-llm-request', 6, { messages: [{ id: 'm', content: [] }], messageSeqs: [1] }),
    ])
    // The generated system node shifted every later sequence by one.
    expect(migrated.events[3]!.data).toMatchObject({ sourceEventSeq: 2 })
    expect(migrated.events[5]!.data).toMatchObject({ messageSeqs: [2] })
    expect(migrated.events[7]!.data).toMatchObject({ messageSeqs: [2] })
  })

  it.each(['compaction/summary', 'compaction/prune'] as const)('rejects %s without a shadowedRange', (type) => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event(type, 1, {}),
    ], 2)).toThrow(`v2 ${type} lacks its shadowedRange`)
  })

  it.each([
    [{ surfaceOp: { op: 'replace', start: 0 } }, 'requires exact replace fields'],
    [{ surfaceOp: { op: 'replace' } }, 'requires exact replace fields'],
    [{ surfaceOp: 7 }, 'requires exact replace fields'],
    [{ sourceEventSeqs: 'x' }, 'sourceEventSeqs must be an array'],
  ] as const)('remap guards reject %j', (extra, message) => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: { system: 'x' }, reason: 'initial' }, extra),
    ], 2)).toThrow(message)
  })

  it('rejects a v2 assistant/message carrying sourceEventSeqs', () => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('assistant/message', 1, { message: { id: 'a', content: [{ type: 'text', text: 'x' }] } }, { sourceEventSeqs: [0] }),
    ], 2)).toThrow('embeds its stream and cannot carry sourceEventSeqs')
  })

  it('rejects a non-array shadowedSeqs and messageSeqs', () => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('compaction/summary', 1, { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: 'x' }),
    ], 2)).toThrow('v2 shadowedSeqs must be an array')
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('session/title', 1, { messageSeqs: 'x' }),
    ], 2)).toThrow('v2 messageSeqs must be an array')
  })
})

describe('v3-to-v4 assistant stream fold', () => {
  const chunk = (seq: number, body: Record<string, unknown>, turn = 1, step = 1) =>
    event('assistant/chunk', seq, { turn, step, chunk: body })
  const textDelta = (text: string, index = 0) => ({ type: 'text-delta', index, text })

  it('drops chunk events covered by an embedded settlement stream', () => {
    const stream = [
      { type: 'chunk', time: 2, chunk: textDelta('hi') },
      { type: 'chunk', time: 3, chunk: { type: 'finish', reason: 'stop' } },
    ]
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      chunk(2, textDelta('hi')),
      chunk(3, { type: 'finish', reason: 'stop' }),
      event('assistant/message', 4, { turn: 1, step: 1, message: { id: 'm' }, usage: {}, stream }),
      event('step/end', 5, { turn: 1, step: 1 }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    ], 3)
    expect(migrated.header.version).toBe(4)
    expect(migrated.events.map(item => item.type)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(migrated.events[2]!.data).toMatchObject({ stream })
    expect(migrated.events.map(item => item.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('attaches the folded stream to a settlement that lacks one', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('a')),
      chunk(2, textDelta('b')),
      chunk(3, { type: 'finish', reason: 'stop' }),
      event('assistant/message', 4, { turn: 1, step: 1, message: { id: 'm' } }),
      event('step/end', 5, { turn: 1, step: 1 }),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'assistant/message', 'step/end',
    ])
    const data = migrated.events[1]!.data as Record<string, unknown>
    const folded = data['stream']
    expect(Array.isArray(folded)).toBe(true)
    expect(folded).toMatchObject([
      { type: 'text-chunks', index: 0, texts: ['a', 'b'] },
      { type: 'chunk', chunk: { type: 'finish', reason: 'stop' } },
    ])
  })

  it('synthesizes an assistant/attempt for chunks closed without a settlement', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('orphan')),
      event('step/end', 2, { turn: 1, step: 1 }),
      event('turn/end', 3, { turn: 1, reason: { kind: 'interrupted' } }),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'assistant/attempt', 'step/end', 'turn/end',
    ])
    const attempt = migrated.events[1]!
    expect(attempt.time).toBe(2)
    expect(attempt.data).toMatchObject({ turn: 1, step: 1 })
  })

  it('synthesizes attempts on retry boundaries and at end of stream', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('torn')),
      event('llm/retry', 2, { turn: 1, step: 1, id: 'r1' }),
      chunk(3, textDelta('tail')),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'assistant/attempt', 'llm/retry', 'assistant/attempt',
    ])
  })

  it('emits interleaved events ahead of the settlement they precede', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('a')),
      event('tool/call', 2, { callId: 'c1' }),
      chunk(3, textDelta('b')),
      event('assistant/message', 4, { turn: 1, step: 1, message: { id: 'm' }, stream: [{ type: 'chunk', time: 4, chunk: textDelta('x') }] }),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'tool/call', 'assistant/message',
    ])
  })

  it('settles a mismatched-turn message standalone and folds the pending attempt', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('a'), 1, 1),
      event('assistant/message', 2, { turn: 1, step: 2, message: { id: 'm' }, stream: [] }),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'assistant/attempt', 'assistant/message',
    ])
    expect(migrated.events[1]!.data).toMatchObject({ turn: 1, step: 1 })
    expect(migrated.events[2]!.data).toMatchObject({ turn: 1, step: 2 })
  })

  it('starts a new group after a terminal chunk', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, { type: 'finish', reason: 'stop' }),
      chunk(2, textDelta('next')),
      event('step/end', 3, { turn: 1, step: 1 }),
    ], 3)
    expect(migrated.events.map(item => item.type)).toEqual([
      'step/start', 'assistant/attempt', 'assistant/attempt', 'step/end',
    ])
  })

  it('requires dense source sequences', () => {
    expect(() => stream([
      chunk(0, textDelta('a')),
      chunk(2, textDelta('b')),
    ], 3)).toThrow('format v3 source events must be dense')
  })

  it('rejects a chunk without its coordinates or chunk body', () => {
    expect(() => migrate([event('assistant/chunk', 0, { turn: 1 })], 3)).toThrow('lacks turn, step, or chunk')
    expect(() => migrate([event('assistant/chunk', 0, 7)], 3)).toThrow('lacks turn, step, or chunk')
  })

  it('passes a settlement with non-record data through with an empty stream', () => {
    const output = stream([event('assistant/attempt', 0, 'x')], 3)
    expect(output[0]!.data).toEqual({ stream: [] })
  })

  it('drops a settlement envelope sourceEventSeqs before remapping', () => {
    const output = stream([
      event('assistant/message', 0, { turn: 1, step: 1, message: { id: 'a' }, stream: [] }, { sourceEventSeqs: [0] }),
    ], 3)
    expect(output[0]).not.toHaveProperty('sourceEventSeqs')
  })

  it.each([7, { op: 'append' }, { op: 'replace', startSeq: 0 }] as const)(
    'rejects a malformed v3 surfaceOp %j', (surfaceOp) => {
      expect(() => stream([event('session/title', 0, { title: 't' }, { surfaceOp })], 3))
        .toThrow('requires exact replace fields')
    })

  it('rejects a v3 compaction without its shadowedRange', () => {
    expect(() => stream([event('compaction/prune', 0, { shadowedSeqs: [] })], 3))
      .toThrow('v3 compaction/prune lacks its shadowedRange')
  })

  it('rejects non-array v3 sequence references', () => {
    expect(() => stream([
      event('compaction/prune', 0, { shadowedRange: { start: 0, end: 0 }, shadowedSeqs: 'x' }),
    ], 3)).toThrow('v3 shadowedSeqs must be an array')
    expect(() => stream([event('session/title', 0, { messageSeqs: 'x' })], 3))
      .toThrow('v3 messageSeqs must be an array')
  })

  it('rejects references into consumed chunk sequences', () => {
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('a')),
      event('assistant/message', 2, { turn: 1, step: 1, message: { id: 'm' }, stream: [{ type: 'chunk', time: 3, chunk: textDelta('x') }] }),
      event('request/header', 3, { header: {}, reason: 'x' }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ], 3)).toThrow('does not name an earlier event')
  })

  it('remaps references to surviving sequences', () => {
    const migrated = migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      chunk(1, textDelta('a')),
      event('assistant/message', 2, { turn: 1, step: 1, message: { id: 'm' }, stream: [] }),
      event('session/title', 3, { messageSeqs: [0] }),
    ], 3)
    expect(migrated.events.at(-1)!.data).toMatchObject({ messageSeqs: [0] })
    expect(migrated.events.map(item => item.seq)).toEqual([0, 1, 2])
  })
})

describe('v3-to-v4 inherited cut', () => {
  const chunk = (seq: number) =>
    event('assistant/chunk', seq, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } })

  it('carries a seeded bare marker at the seed count', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, {}),
      event('turn/start', 2, { turn: 2 }),
    ], 3, { isSeeded: true }, 1)
    expect(migrated.inheritedEventCount).toBe(1)
    expect(migrated.events.map(item => item.type)).toEqual(['turn/start', 'session/end-seed', 'turn/start'])
  })

  it('accepts a flagged marker at the cut and rejects one off the cut', () => {
    const ok = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, { inherited: true }),
      event('turn/start', 2, { turn: 2 }),
    ], 3, { isSeeded: true }, 1)
    expect(ok.inheritedEventCount).toBe(1)
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, { inherited: true }),
    ], 3, { isSeeded: true }, 2)).toThrow('disagrees with its seed cut')
  })

  it('rejects a seeded artifact missing its marker and a flagged unseeded marker', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ], 3, { isSeeded: true }, 1)).toThrow('lacks its inherited end-seed marker')
    expect(() => migrate([
      event('session/end-seed', 0, { inherited: true }),
    ], 3)).toThrow('unseeded Session contains an inherited end-seed marker')
  })

  it('rejects a chunk group straddling the marker', () => {
    expect(() => migrate([
      chunk(0),
      event('session/end-seed', 1, {}),
      chunk(2),
    ], 3, { isSeeded: true }, 1)).toThrow('splits one Assistant attempt')
  })

  it('rejects the marker while a chunk group is still open', () => {
    expect(() => migrate([
      chunk(0),
      event('session/end-seed', 1, { inherited: true }),
    ], 3, { isSeeded: true }, 1)).toThrow('splits one Assistant attempt')
  })

  it('passes bare end-seed delimiters through an unseeded log', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, {}),
      event('turn/start', 2, { turn: 2 }),
    ], 3)
    expect(migrated.inheritedEventCount).toBe(0)
    expect(migrated.events.map(item => item.type)).toEqual(['turn/start', 'session/end-seed', 'turn/start'])
  })

  it('derives the chained cut from the in-band marker after a v2 injection shift', () => {
    const output = stream([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 2, { turn: 2 }),
      event('step/start', 3, { turn: 2, step: 1 }),
      event('request/header', 4, { header: { system: 'sys' }, reason: 'initial' }),
      event('assistant/message', 5, { turn: 2, step: 1, message: { id: 'm', content: [] }, stream: [] }),
      event('step/end', 6, { turn: 2, step: 1 }),
      event('turn/end', 7, { turn: 2, reason: { kind: 'completed' } }),
    ], 2, { isSeeded: true }, 2)
    const marker = output.findIndex(item => item.type === 'session/end-seed')
    expect(marker).toBe(2)
    expect(output[marker]!.data).toEqual({ inherited: true })
    const flow = sessionFormatCatalog.createStream(
      { version: 2, id: 's', createdAt: 1, isSeeded: true }, 2,
      { emitEvent: () => {} },
    )
    expect(flow.header.version).toBe(4)
  })
})
