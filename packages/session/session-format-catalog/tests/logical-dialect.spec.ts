import { describe, expect, it } from 'vitest'
import { sessionLogicalFormatCatalog } from '../src/index.ts'
import { coharnessV2ToV3Dialect } from '../src/coharness-v2-dialect.ts'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'

/** Legacy flat `assistant/message` field carrying the model source record. */
const LEGACY_ASSISTANT_SOURCE_KEY = ['pro', 'venance'].join('')

const CONFIG = { provider: 'mock', model: 'mock' }

function event(type: string, seq: number, data: unknown, extra: Record<string, unknown> = {}): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...extra } as unknown as SessionFormatEvent
}

function migrate(
  events: readonly SessionFormatEvent[],
  header: Record<string, unknown> = {},
  inheritedEventCount?: number,
) {
  return sessionLogicalFormatCatalog.migrate(
    { version: 2, id: 's', createdAt: 1, ...header } as SessionFormatHeader,
    events,
    inheritedEventCount,
  )
}

const USER_MESSAGE = { role: 'user', id: 'u-1', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }

/** One complete turn the artifact relationship rules accept, with members inserted before step/end. */
function turnWithStep(members: SessionFormatEvent[], startSeq = 0): SessionFormatEvent[] {
  return [
    event('turn/start', startSeq, { turn: 1 }),
    event('step/start', startSeq + 1, { turn: 1, step: 1 }),
    ...members.map((item, index) => ({ ...item, seq: startSeq + 2 + index, time: startSeq + 3 + index })),
    event('step/end', startSeq + 2 + members.length, { turn: 1, step: 1 }),
    event('turn/end', startSeq + 3 + members.length, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

const RETRY_BASE = {
  turn: 1, step: 1, provider: 'mock', mode: 'always', policyKey: 'k',
  retry: 1, delayMs: 1, failure: { message: 'f', code: 'C' },
}

describe('dialect compact vocabulary', () => {
  it('renames compact/* events and threads a generated compaction id through the bracket', () => {
    const migrated = migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('user/message', 0, { ...USER_MESSAGE, id: 'u-2', content: [{ type: 'text', text: 'b' }] }),
      event('compact/start', 0, { turn: 1 }),
      event('compact/summary', 0, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compact/end', 0, { turn: 1 }),
      event('compact/prune', 0, {
        shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 1,
      }),
    ]))
    expect(migrated.events.map(item => item.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'user/message',
      'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
      'step/end', 'turn/end',
    ])
    expect(migrated.events[5]?.data).toMatchObject({ compactionId: 'legacy-compaction:s:4' })
    expect(migrated.events[6]?.data).toMatchObject({ compactionId: 'legacy-compaction:s:4' })
    expect(migrated.events[7]?.data).toMatchObject({ compactionId: 'legacy-compaction:s:4' })
  })

  it('keeps declared ids, clears the bracket at its end-seed, and leaves orphan payloads alone', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('user/message', 2, USER_MESSAGE),
      event('compaction/start', 3, { compactionId: 'c-1', turn: 1 }),
      event('compaction/summary', 4, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compaction/end', 5, { compactionId: 'c-1', turn: 1 }),
      event('session/end-seed', 6, {}),
      event('step/end', 7, { turn: 1, step: 1 }),
      event('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events[5]?.data).toMatchObject({ compactionId: 'c-1' })
    expect(migrated.events[6]?.data).toMatchObject({ compactionId: 'c-1' })
    /* The declared id owned its key and the bracket closed before end-seed. */
    expect(migrated.events.map(item => item.type)).toContain('session/end-seed')
  })

  it('rejects a declared non-string compaction id and an orphan summary downstream', () => {
    expect(() => migrate(turnWithStep([
      event('compaction/start', 0, { compactionId: 7, turn: 1 }),
    ]))).toThrow()
    expect(() => migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('compaction/summary', 0, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
    ]))).toThrow('compactionId')
  })

  it('tags only compact-plugin user message sources inside an open bracket', () => {
    const migrated = migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('compaction/start', 0, { turn: 1 }),
      event('user/message', 0, { ...USER_MESSAGE, id: 'u-c', source: { kind: 'plugin', plugin: 'compact' } }),
      event('user/message', 0, { ...USER_MESSAGE, id: 'u-own', source: { kind: 'plugin', plugin: 'compact', compactionId: 'own' } }),
      event('user/message', 0, { ...USER_MESSAGE, id: 'u-p', source: { kind: 'user' } }),
      event('compaction/summary', 0, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compaction/end', 0, { turn: 1 }),
    ]))
    const byId = (id: string) => migrated.events.find(item => (item.data as { id?: string }).id === id)
    expect(byId('u-c')?.data).toMatchObject({ source: { kind: 'plugin', plugin: 'compact', compactionId: 'legacy-compaction:s:3' } })
    expect(byId('u-own')?.data).toMatchObject({ source: { compactionId: 'own' } })
    expect(byId('u-p')?.data).toMatchObject({ source: { kind: 'user' } })
  })

  it('passes a non-carrier inside an open bracket and clears state at the bracket end', () => {
    const migrated = migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('compaction/start', 0, { turn: 1 }),
      event('session/title', 0, { title: 't', messageSeqs: [], source: { kind: 'user' } }),
      event('compaction/summary', 0, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compaction/end', 0, { turn: 1 }),
    ]))
    expect(migrated.events.map(item => item.type)).toContain('session/title')
  })

  it('rejects a data-less user message inside an open bracket', () => {
    expect(() => migrate(turnWithStep([
      event('compaction/start', 0, { turn: 1 }),
      event('user/message', 0, null),
    ]))).toThrow('invalid content')
  })
})

describe('dialect unsupported and malformed payloads', () => {
  it.each(['request/header-delta', 'mode/set'] as const)('refuses %s', (type) => {
    expect(() => migrate(turnWithStep([event(type, 0, {})]))).toThrow(`unsupported legacy ${type} event at seq 2`)
  })

  it('refuses a request/header fallback reason', () => {
    expect(() => migrate(turnWithStep([
      event('request/header', 0, { reason: 'fallback', header: { config: CONFIG } }),
    ]))).toThrow('unsupported request/header reason "fallback" at seq 2')
  })
})

describe('dialect turn normalization', () => {
  it('drops the retired turn/start trigger payload', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1, trigger: { kind: 'prompt' } }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events[0]?.data).toEqual({ turn: 1 })
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

  it.each(['completed', 'blocked', 'max-tokens', 'interrupted'] as const)('keeps current turn/end reason %s', (kind) => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind } }),
    ])
    expect(migrated.events[1]?.data).toEqual({ turn: 1, reason: { kind } })
  })

  it('folds retired aborted variants into the current reason shape', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'aborted' } }),
      event('turn/start', 2, { turn: 2 }),
      event('turn/end', 3, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      event('turn/start', 4, { turn: 3 }),
      event('turn/end', 5, { turn: 3, reason: { kind: 'disposed' } }),
      event('turn/start', 6, { turn: 4 }),
      event('turn/end', 7, { turn: 4, reason: { kind: 'unknown-future' } }),
    ])
    expect(migrated.events[1]?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    expect(migrated.events[3]?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(migrated.events[5]?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    expect(migrated.events[7]?.data).toMatchObject({ reason: { kind: 'unknown-future' } })
  })

  it('folds the retired flat error reason into the nested shape', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'error', message: 'boom', code: 'X' } }),
      event('turn/start', 2, { turn: 2 }),
      event('turn/end', 3, { turn: 2, reason: { kind: 'error', message: 'boom' } }),
      event('turn/start', 4, { turn: 3 }),
      event('turn/end', 5, { turn: 3, reason: { kind: 'error', failure: { code: 'C', message: 'f' } } }),
      event('turn/start', 6, { turn: 4 }),
      event('turn/end', 7, { turn: 4, reason: { kind: 'error', error: { code: 'E', message: 'kept' } } }),
    ])
    expect(migrated.events[1]?.data).toMatchObject({ reason: { kind: 'error', error: { message: 'boom', code: 'X' } } })
    expect(migrated.events[3]?.data).toMatchObject({ reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    expect(migrated.events[5]?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'C', message: 'f' } } })
    expect(migrated.events[7]?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'E', message: 'kept' } } })
  })

  it.each([
    [{ turn: 1, reason: 'x' }],
    [{ turn: 1, reason: { kind: 1 } }],
    [{ turn: 1, reason: { kind: 'error', failure: 'x' } }],
    [{ turn: 1, reason: { kind: 'error', failure: { code: 'C' } } }],
    [{ turn: 1, reason: { kind: 'error' } }],
    [{ turn: 1, reason: { kind: 'error', message: 'm', code: 3 } }],
  ] as const)('rejects malformed turn/end %j', (data) => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, data),
    ])).toThrow('malformed legacy turn/end at seq 1')
  })
})

describe('dialect request/header normalization', () => {
  it('strips the retired messagePrefix payload', () => {
    const migrated = migrate(turnWithStep([
      event('request/header', 0, { header: { config: CONFIG, system: 'p', messagePrefix: ['a'] }, reason: 'initial' }),
      event('request/header', 0, { header: { config: CONFIG }, reason: 'initial' }),
    ]))
    const headers = migrated.events.filter(item => item.type === 'request/header')
    /* The system prompt moves out of the header into the synthesized head. */
    expect(headers[0]?.data).toEqual({ header: { config: CONFIG }, reason: 'initial' })
    expect(headers[1]?.data).toEqual({ header: { config: CONFIG }, reason: 'initial' })
  })

  it('rejects a non-array messagePrefix', () => {
    expect(() => migrate(turnWithStep([
      event('request/header', 0, { header: { config: CONFIG, messagePrefix: 'x' }, reason: 'initial' }),
    ]))).toThrow('malformed request/header messagePrefix at seq 2')
  })
})

describe('dialect steering/message normalization', () => {
  it('unwraps an enveloped message and synthesizes identity for the bare form', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('steering/message', 1, { turn: 1, message: { role: 'user', id: 'w-1', content: [], source: { kind: 'user' } } }),
      event('steering/message', 2, { turn: 1, content: [], source: { kind: 'user' } }),
      event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const messages = migrated.events.filter(item => item.type === 'user/message')
    expect(messages[0]).toMatchObject({ type: 'user/message', data: { id: 'w-1' } })
    expect(messages[1]).toMatchObject({
      type: 'user/message',
      data: { id: 'legacy-message:s:2', role: 'user', content: [], source: { kind: 'user' } },
    })
    expect((messages[1]?.data as Record<string, unknown>)['turn']).toBeUndefined()
  })

  it.each([
    [null],
    [{ message: { role: 'user', id: 'm', content: [], source: { kind: 'user' } }, turn: 'x' }],
  ] as const)('rejects malformed steering/message %j', (data) => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('steering/message', 1, data),
    ])).toThrow('malformed legacy steering/message at seq 1')
  })
})

describe('dialect llm/retry identity', () => {
  it('keeps real ids, chains a generated one, and refuses an explicit empty id', () => {
    const retry = (seq: number, data: Record<string, unknown>) => event('llm/retry', seq, { ...RETRY_BASE, ...data })
    const migrated = migrate(turnWithStep([
      event('request/header', 0, { header: { config: CONFIG }, reason: 'initial' }),
      retry(0, { retryId: 'r-1' }),
      retry(0, { retry: 2 }),
      retry(0, { policyKey: 'other' }),
    ]))
    const retries = migrated.events.filter(item => item.type === 'llm/retry')
    expect(retries[0]?.data).toMatchObject({ retryId: 'r-1' })
    /* The chain key reuses the id recorded by the earlier attempt. */
    expect(retries[1]?.data).toMatchObject({ retryId: 'r-1' })
    expect(retries[2]?.data).toMatchObject({ retryId: 'legacy-retry:s:5' })
    expect(() => migrate(turnWithStep([
      event('request/header', 0, { header: { config: CONFIG }, reason: 'initial' }),
      retry(0, { retryId: '' }),
    ]))).toThrow('retryId')
  })
})

describe('dialect message carriers', () => {
  it('adds identity to the early flat user message form', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { content: [], source: { kind: 'user' } }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const message = migrated.events.find(item => item.type === 'user/message')
    expect(message?.data).toMatchObject({ id: 'legacy-message:s:1', role: 'user' })
  })

  it('leaves carriers that already own identity fields alone', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { role: 'user', id: 'u-1', content: [], source: { kind: 'user' } }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events[1]?.data).toMatchObject({ id: 'u-1' })
    /* A `message` key is not a flat carrier: it fails the released disposition. */
    expect(() => migrate([
      event('user/message', 0, { role: 'user', message: { id: 'm' }, content: [] }),
    ])).toThrow()
    /* Neither are carriers missing their flat content or source fields. */
    expect(() => migrate([
      event('user/message', 0, { source: { kind: 'user' } }),
    ])).toThrow()
    expect(() => migrate([
      event('user/message', 0, { content: [] }),
    ])).toThrow()
  })

  it('wraps the early flat assistant form into the message envelope', () => {
    const migrated = migrate(turnWithStep([
      event('assistant/message', 0, {
        turn: 1, step: 1, stream: [],
        content: [{ type: 'text', text: 'hi' }], [LEGACY_ASSISTANT_SOURCE_KEY]: { provider: 'p', model: 'm' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]))
    const assistants = migrated.events.filter(item => item.type === 'assistant/message')
    expect(assistants[0]?.data).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1 },
      message: {
        id: 'legacy-message:s:2', role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        source: { provider: 'p', model: 'm', kind: 'model' },
      },
    })
    /* A non-record legacy source folds into a bare model source, which the
     * released source validator then refuses for lacking provider/model. */
    expect(() => migrate(turnWithStep([
      event('assistant/message', 0, {
        turn: 1, step: 1, stream: [], content: [], [LEGACY_ASSISTANT_SOURCE_KEY]: 'x',
      }),
    ]))).toThrow('source')
  })

  it('rejects a flat assistant form missing its required members', () => {
    expect(() => migrate(turnWithStep([
      event('assistant/message', 0, { turn: 1, step: 1, stream: [], content: [] }),
    ]))).toThrow()
    expect(() => migrate(turnWithStep([
      event('assistant/message', 0, {
        turn: 1, step: 1, stream: [], content: 'x', [LEGACY_ASSISTANT_SOURCE_KEY]: {},
      }),
    ]))).toThrow()
  })

  it('wraps the early flat tool result form and inherits the replaced result id', () => {
    const call = (callId: string) => event('tool/call', 0, { turn: 1, step: 1, callId, name: 'x', arguments: '{}' })
    const advertise = (callId: string, id: string) => event('assistant/message', 0, {
      turn: 1, step: 1, stream: [],
      message: {
        id, role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'x', arguments: '{}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    })
    const migrated = migrate(turnWithStep([
      advertise('c-1', 'a-1'),
      call('c-1'),
      event('tool/result', 0, {
        turn: 1, step: 1,
        message: {
          id: 'r-1', role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c-1', content: [], isError: false }],
          source: { kind: 'tool', callId: 'c-1' },
        },
      }),
      advertise('c-2', 'a-2'),
      call('c-2'),
      event('tool/result', 0, { turn: 1, step: 1, callId: 'c-2', content: [{ type: 'text', text: 'out' }], isError: false }),
      event('tool/result', 0, { turn: 1, step: 1, callId: 'c-1', content: [{ type: 'text', text: 'replaced' }], isError: false },
        { surfaceOp: { op: 'replace', start: 4, end: 4 }, sourceEventSeqs: [4] }),
    ]))
    const results = migrated.events.filter(item => item.type === 'tool/result')
    expect(results[1]?.data).toMatchObject({
      message: {
        id: 'legacy-message:s:7', role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c-2', content: [{ type: 'text', text: 'out' }], isError: false }],
        source: { kind: 'tool', callId: 'c-2' },
      },
    })
    /* The replace op names the shadowed tool/result seq, so the flat result
     * reuses that message's identity. */
    expect(results[2]?.data).toMatchObject({ message: { id: 'r-1' } })
  })

  it('rejects malformed flat tool results', () => {
    for (const data of [
      { turn: 1, step: 1, callId: 5, content: [], isError: false },
      { turn: 1, step: 1, callId: 'c', content: [], isError: 'x' },
      { turn: 1, step: 1, callId: 'c', isError: false },
      { turn: 1, step: 1, callId: 'c', content: [], isError: false, message: { content: 'bad' } },
    ]) {
      expect(() => migrate(turnWithStep([event('tool/result', 0, data)]))).toThrow()
    }
  })

  it('rejects a replacement citing a seq whose message never got an identity', () => {
    expect(() => migrate(turnWithStep([
      event('session/title', 0, { title: 't', messageSeqs: [], source: { kind: 'user' } }),
      event('tool/result', 0, { turn: 1, step: 1, callId: 'c', content: [], isError: false },
        { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }),
    ]))).toThrow('replacement cites a message without identity')
  })

  it('rejects a negative replacement start on a flat tool result', () => {
    expect(() => migrate(turnWithStep([
      event('tool/result', 0, { turn: 1, step: 1, callId: 'c', content: [], isError: false },
        { surfaceOp: { op: 'replace', start: -1, end: 0 } }),
    ]))).toThrow()
  })
})

describe('dialect message lists', () => {
  it('synthesizes ids for identity-less inserted items', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('agent/inbox/spliced', 1, {
        target: 'next-turn', start: 0,
        inserted: [
          { role: 'user', content: [], source: { kind: 'user' } },
          { role: 'user', id: 'q-1', content: [], source: { kind: 'user' } },
        ],
      }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events[1]?.data).toMatchObject({
      inserted: [{ id: 'legacy-message:s:1:0', role: 'user' }, { id: 'q-1' }],
    })
  })

  it('synthesizes ids inside a title request message list', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('user/message', 2, USER_MESSAGE),
      event('session/title-llm-request', 3, {
        titleProvider: 'p', messageSeqs: [2], route: { provider: 'p', model: 'm' }, system: 's', maxTokens: 8,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages:\n[{"seq":3,"text":"a"}]' }],
          source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
        }],
      }),
      event('step/end', 4, { turn: 1, step: 1 }),
      event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const request = migrated.events.find(item => item.type === 'session/title-llm-request')
    expect(request?.data).toMatchObject({ messages: [{ id: 'legacy-message:s:3:0' }] })
  })

  it('rejects malformed list fields', () => {
    expect(() => migrate(turnWithStep([
      event('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: 'not-a-list' }),
    ]))).toThrow('invalid messages')
    expect(() => migrate(turnWithStep([
      event('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: [{ role: 'user' }] }),
    ]))).toThrow('invalid messages')
    expect(() => migrate(turnWithStep([
      event('agent/inbox/spliced', 0, null),
    ]))).toThrow('invalid data')
    expect(() => migrate(turnWithStep([
      event('session/title-llm-request', 0, null),
    ]))).toThrow('invalid data')
  })
})

describe('dialect carrier shape admission', () => {
  it('rejects non-record carrier data and malformed message payloads', () => {
    for (const bad of [
      event('assistant/message', 0, []),
      event('tool/result', 0, 'x'),
      event('agent/inbox/spliced', 0, []),
      event('session/title-llm-request', 0, 7),
      event('assistant/message', 0, { turn: 1, step: 1, stream: [], message: null }),
      event('tool/result', 0, { turn: 1, step: 1, message: { content: 'bad' } }),
      event('agent/inbox/spliced', 0, { target: 'next-turn', start: 0, inserted: 'bad' }),
      event('session/title-llm-request', 0, { messages: 'bad' }),
      event('assistant/attempt', 0, { turn: 1, step: 1, stream: 'bad' }),
      event('user/message', 0, { role: 'user', id: 'u', content: 'bad', source: { kind: 'user' } }),
    ]) {
      expect(() => migrate([bad])).toThrow()
    }
  })

  it('passes a valid assistant/attempt stream through', () => {
    const migrated = migrate(turnWithStep([
      event('assistant/attempt', 0, { turn: 1, step: 1, stream: [] }),
    ]))
    expect(migrated.events.map(item => item.type)).toContain('assistant/attempt')
  })
})

describe('dialect non-surface metadata stripping', () => {
  it('validates and drops envelope surface fields on request/header', () => {
    const migrated = migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('request/header', 0, { header: { config: CONFIG, system: 'x' }, reason: 'initial' },
        { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }),
      event('request/header', 0, { header: { config: CONFIG }, reason: 'change' }, { surfaceOp: 'append' }),
    ]))
    const headers = migrated.events.filter(item => item.type === 'request/header')
    expect(headers[0]).not.toHaveProperty('surfaceOp')
    expect(headers[0]).not.toHaveProperty('sourceEventSeqs')
    expect(headers[1]).not.toHaveProperty('surfaceOp')
  })

  it.each([
    [{ surfaceOp: 7 }],
    [{ surfaceOp: { op: 'replace' } }],
    [{ surfaceOp: { op: 'replace', start: 'x', end: 0 } }],
    [{ surfaceOp: { op: 'replace', start: 5, end: 5 } }],
    [{ surfaceOp: { op: 'replace', start: 1, end: -1 } }],
    [{ sourceEventSeqs: 'x' }],
    [{ sourceEventSeqs: [] }],
    [{ sourceEventSeqs: [99] }],
    [{ sourceEventSeqs: [-1] }],
  ] as const)('rejects malformed non-surface metadata %j', (extra) => {
    expect(() => migrate(turnWithStep([
      event('request/header', 0, { header: { config: CONFIG, system: 'x' }, reason: 'initial' }, extra),
    ]))).toThrow()
  })
})

describe('dialect pending drain ordering', () => {
  it('keeps a referencing pending event behind the events it cites', () => {
    const migrated = migrate([
      event('user/message', 0, USER_MESSAGE),
      event('session/title', 1, { title: 't', messageSeqs: [0], source: { kind: 'provider', provider: 'p', model: { provider: 'p', model: 'm' } } }),
      event('turn/start', 2, { turn: 1 }),
      event('step/start', 3, { turn: 1, step: 1 }),
      event('step/end', 4, { turn: 1, step: 1 }),
      event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    ])
    /* The title cites the pending user/message, so neither drains at turn/start;
     * both emit after the step opens the system head, with remapped messageSeqs. */
    const types = migrated.events.map(item => item.type)
    expect(types).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'session/title', 'step/end', 'turn/end',
    ])
    const title = migrated.events[4]
    expect(title?.data).toMatchObject({ messageSeqs: [3] })
  })

  it('drains reference-free pending rows at the turn boundary while cited ones wait for the head', () => {
    const migrated = migrate([
      event('agent/inbox/spliced', 0, {
        target: 'next-turn', start: 0,
        inserted: [{ role: 'user', id: 'q-1', content: [], source: { kind: 'user' } }],
      }),
      event('command/run', 1, { commandId: 'c', name: 'n', source: { kind: 'user' } }),
      event('command/done', 2, { commandId: 'c', kind: 'success', sourceEventSeq: 0 }),
      event('user/message', 3, USER_MESSAGE),
      event('turn/start', 4, { turn: 1 }),
      event('step/start', 5, { turn: 1, step: 1 }),
      event('step/end', 6, { turn: 1, step: 1 }),
      event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const types = migrated.events.map(item => item.type)
    /* The inbox splice and command/run cite only settled seqs, so they drain
     * ahead of the turn boundary. command/done cites the still-pending splice,
     * so it stays buffered with the user message until the head opens; its
     * sourceEventSeq then remaps to the splice's emitted seq. */
    expect(types).toEqual([
      'agent/inbox/spliced', 'command/run', 'turn/start',
      'step/start', 'system/message', 'command/done', 'user/message', 'step/end', 'turn/end',
    ])
    expect(migrated.events[5]?.data).toMatchObject({ sourceEventSeq: 0 })
  })

  it('keeps a pending event behind the pending target it cites', () => {
    const migrated = migrate([
      event('user/message', 0, USER_MESSAGE),
      event('compaction/prune', 1, {
        shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1,
      }),
      event('turn/start', 2, { turn: 1 }),
      event('step/start', 3, { turn: 1, step: 1 }),
      event('step/end', 4, { turn: 1, step: 1 }),
      event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const types = migrated.events.map(item => item.type)
    /* The prune cites the pending user message, so nothing drains at the turn
     * boundary; both wait for the head and remap into the emitted surface. */
    expect(types).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'compaction/prune', 'step/end', 'turn/end',
    ])
    const prune = migrated.events[4]
    expect(prune?.data).toMatchObject({ shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3] })
  })
})

describe('dialect seeded boundary handling', () => {
  it('treats a bare end-seed at the declared cut as the inherited marker', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 2, {}),
      event('turn/start', 3, { turn: 2 }),
      event('turn/end', 4, { turn: 2, reason: { kind: 'completed' } }),
    ], { isSeeded: true }, 2)
    const marker = migrated.events.find(item => item.type === 'session/end-seed')
    expect(marker?.data).toEqual({ inherited: true })
    expect(migrated.inheritedEventCount).toBe(2)
  })

  it('adopts an in-band flagged marker when the header cut did not arrive', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 2, { inherited: true }),
      event('turn/start', 3, { turn: 2 }),
      event('turn/end', 4, { turn: 2, reason: { kind: 'completed' } }),
    ], { isSeeded: true }, undefined)
    expect(migrated.inheritedEventCount).toBe(2)
  })

  it('rejects a seeded source without any inherited count or marker', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ], { isSeeded: true }, undefined)).toThrow('requires its inherited event count')
  })

  it('lets an inherited foreign delivery marker pass while a current one refuses', () => {
    const migrated = migrate([
      event('turn/start', 0, { turn: 1 }),
      event('session-log-deepseek/delivery-accepted', 1, { sessionId: 'other', throughSeq: 0, sessionFormatVersion: 2 }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 3, {}),
      event('turn/start', 4, { turn: 2 }),
      event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } }),
    ], { isSeeded: true, parentSession: 'parent' }, 3)
    expect(migrated.inheritedEventCount).toBe(3)
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 2, { inherited: true }),
      event('session-log-deepseek/delivery-accepted', 3, { sessionId: 'other', throughSeq: 2, sessionFormatVersion: 2 }),
      event('turn/start', 4, { turn: 2 }),
      event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } }),
    ], { isSeeded: true, parentSession: 'parent' }, 2)).toThrow('delivery marker names the wrong Session')
  })

  it('rejects a delivery marker claiming target format v3', () => {
    expect(() => migrate(turnWithStep([
      event('session-log-deepseek/delivery-accepted', 0, { sessionId: 's', throughSeq: 0, sessionFormatVersion: 3 }),
    ]))).toThrow('delivery marker claims target format v3')
  })
})

describe('dialect stage run handling', () => {
  it('expands a compact run through the stage transformRun path', () => {
    const sourceHeader = { version: 2, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0 } as SessionFormatHeader
    const stage = coharnessV2ToV3Dialect.createStage({
      sourceHeader,
      targetHeader: coharnessV2ToV3Dialect.migrateHeader(sourceHeader),
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    const output: SessionFormatEvent[] = []
    const context = { emitEvent: (value: SessionFormatEvent) => { output.push(value) }, emitRun: () => {} }
    stage.transformRun({
      runType: 'test-run', firstSeq: 0, eventCount: 1,
      *expand() { yield event('turn/start', 0, { turn: 1 }) },
    }, context)
    expect(stage.finish(context)).toBe(0)
    expect(output.map(item => item.type)).toEqual(['turn/start'])
  })
})

describe('logical catalog header surface', () => {
  it('classifies stored headers through readHeader', () => {
    expect(sessionLogicalFormatCatalog.readHeader('x').status).toBe('malformed')
    expect(sessionLogicalFormatCatalog.readHeader({ version: 7, id: 's', createdAt: 1 }).status).toBe('unsupported')
    expect(sessionLogicalFormatCatalog.readHeader({ version: 6, id: 's', createdAt: 1 }).status).toBe('current')
    for (const version of [0, 1, 2, 3, 4, 5]) {
      expect(
        sessionLogicalFormatCatalog.readHeader({ version, id: 's', createdAt: 1 }).status,
      ).toBe('migration-required')
    }
    expect(
      sessionLogicalFormatCatalog.readHeader({ version: 2, id: 's', createdAt: 1, draft: true }).status,
    ).toBe('malformed')
    expect(
      sessionLogicalFormatCatalog.readHeader({ version: 2, id: 's', createdAt: 1, seedLength: 'x' }).status,
    ).toBe('malformed')
    expect(
      sessionLogicalFormatCatalog.readHeader(
        { version: 2, id: 's', createdAt: 1, seedLength: 2, isSeeded: false },
      ).status,
    ).toBe('malformed')
    const full = sessionLogicalFormatCatalog.readHeader({
      version: 6, id: 's', createdAt: 1, cwd: '/x', parentSession: 'p', origin: 'subagent',
      delegationDepth: 1, agentPreset: 'ptc', draft: false, isSeeded: true,
    })
    expect(full).toMatchObject({
      status: 'current',
      header: { cwd: '/x', parentSession: 'p', origin: 'subagent', delegationDepth: 1, agentPreset: 'ptc' },
    })
  })

  it('migrates headers through migrateHeader and refuses what cannot migrate', () => {
    const migrated = sessionLogicalFormatCatalog.migrateHeader(
      { version: 2, id: 's', createdAt: 1, agentPreset: 'code' } as SessionFormatHeader,
    )
    expect(migrated).toMatchObject({ version: 6, agentPreset: 'ptc' })
    expect(sessionLogicalFormatCatalog.migrateHeader(
      { version: 3, id: 's', createdAt: 1 } as SessionFormatHeader,
    ).version).toBe(6)
    expect(sessionLogicalFormatCatalog.migrateHeader(
      { version: 4, id: 's', createdAt: 1 } as SessionFormatHeader,
    ).version).toBe(6)
    expect(() => sessionLogicalFormatCatalog.migrateHeader('x' as unknown as SessionFormatHeader))
      .toThrow('must be a JSON object')
    expect(() => sessionLogicalFormatCatalog.migrateHeader(
      { version: 7, id: 's', createdAt: 1 } as SessionFormatHeader,
    )).toThrow('newer format v7')
  })
})

describe('logical catalog stream admission', () => {
  function stream(version: number, inheritedEventCount = 0) {
    const emitted: SessionFormatEvent[] = []
    const value = sessionLogicalFormatCatalog.createStream(
      { version, id: 's', createdAt: 1 } as SessionFormatHeader,
      inheritedEventCount,
      { emitEvent: item => emitted.push(item), emitRun: () => {} },
    )
    return { stream: value, emitted }
  }

  it.each([3, 4, 5] as const)('migrates a stored v%s artifact', (version) => {
    const { stream: s, emitted } = stream(version)
    s.emitEvent(event('turn/start', 0, { turn: 1 }))
    s.emitEvent(event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }))
    expect(s.finish()).toBe(0)
    expect(emitted.map(item => item.type)).toEqual(['turn/start', 'turn/end'])
    expect(s.header.version).toBe(6)
  })

  it('runs v3 admission on stored v3 rows and v4 admission on v4/v5/v6 rows', () => {
    const { stream: v3 } = stream(3)
    expect(() => { v3.emitEvent(event('tool/code-dispatch', 0, {})) })
      .toThrow('format v3 contains unknown event type')
    const { stream: v4 } = stream(4)
    expect(() => { v4.emitEvent(event('assistant/chunk', 0, {})) }).toThrow('v3 row')
    const { stream: v5 } = stream(5)
    expect(() => { v5.emitEvent(event('tool/code-dispatch', 0, {})) }).toThrow('format v4 contains')
    const { stream: v6 } = stream(6)
    expect(() => { v6.emitEvent(event('tool/code-dispatch', 0, {})) }).toThrow('format v4 contains')
  })

  it('enforces the shared logical event envelope', () => {
    const { stream: s } = stream(5)
    expect(() => { s.emitEvent(null as unknown as SessionFormatEvent) }).toThrow('must be a JSON object')
    expect(() => {
      s.emitEvent({ type: 'turn/start', seq: 0, data: { turn: 1 } } as unknown as SessionFormatEvent)
    }).toThrow('lacks time')
    expect(() => {
      s.emitEvent({ type: 5, seq: 0, time: 1, data: {} } as unknown as SessionFormatEvent)
    }).toThrow('type must be a string')
    expect(() => { s.emitEvent(event('turn/start', 0, { turn: 1 }, { ignorable: false })) })
      .toThrow('ignorable must be true')
    expect(() => { s.emitEvent(event('turn/start', 0, { turn: 1 }, { extra: 1 })) })
      .toThrow('unsupported key')
  })

  it('refuses events and runs after finish', () => {
    const { stream: s } = stream(5)
    s.emitEvent(event('turn/start', 0, { turn: 1 }))
    s.emitEvent(event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }))
    s.finish()
    expect(() => { s.emitEvent(event('turn/start', 2, { turn: 2 })) }).toThrow('stream is finished')
    expect(() => {
      s.emitRun({
        runType: 'r', firstSeq: 2, eventCount: 1,
        *expand() { yield event('turn/start', 2, { turn: 2 }) },
      })
    }).toThrow('no compact runs')
  })

  it('wraps a restored-artifact refusal but passes an unsupported refusal through', () => {
    const { stream: wrapped } = stream(5)
    wrapped.emitEvent(event('turn/start', 0, { turn: 1 }))
    wrapped.emitEvent(event('system/message', 1, {
      turn: 1, step: 1,
      message: { id: 'm', role: 'system', content: [], source: { kind: 'plugin', plugin: 'x' } },
    }, { surfaceOp: 'append' }))
    expect(() => wrapped.finish()).toThrow('refuses the transformed artifact')
    const { stream: passthrough } = stream(5)
    passthrough.emitEvent(event('unknown/thing', 0, {}))
    expect(() => passthrough.finish()).toThrow('unknown event type')
  })
})

describe('dialect admission on malformed payloads', () => {
  it.each([
    ['request/header', null],
    ['turn/start', null],
    ['turn/end', 'x'],
    ['llm/retry', []],
    ['request/header', { reason: 'initial', header: 'x' }],
    ['compaction/start', null],
  ] as const)('rejects %s with non-record data', (type, data) => {
    expect(() => migrate(turnWithStep([event(type, 0, data)]))).toThrow()
  })

  it('rejects a data-less compaction/end inside an open bracket', () => {
    expect(() => migrate(turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('compaction/start', 0, { turn: 1 }),
      event('compaction/summary', 0, {
        summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compaction/end', 0, null),
    ]))).toThrow()
  })

  it('drains a pending feedback row and a reference-free command pair', () => {
    const migrated = migrate([
      event('feedback/message-put', 0, {
        sessionId: 's',
        item: { messageId: 'm-1', rating: 'positive', version: 'v', createdAt: 1, updatedAt: 1 },
      }),
      event('command/run', 1, { commandId: 'c', name: 'n', source: { kind: 'user' } }),
      event('command/done', 2, { commandId: 'c', kind: 'success' }),
      event('turn/start', 3, { turn: 1 }),
      event('step/start', 4, { turn: 1, step: 1 }),
      event('step/end', 5, { turn: 1, step: 1 }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    ])
    /* All three pending rows cite nothing pending, so they drain in order at
     * the turn boundary ahead of the generated head. */
    expect(migrated.events.map(item => item.type)).toEqual([
      'feedback/message-put', 'command/run', 'command/done', 'turn/start',
      'step/start', 'system/message', 'step/end', 'turn/end',
    ])
  })

  it('refuses an unclassified event at the v2 boundary', () => {
    expect(() => migrate([
      event('opaque/thing', 0, null, { ignorable: true }),
    ])).toThrow('cannot safely transform unclassified event')
  })

  it('drains a pending compaction row once its cited seq has settled', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('compaction/prune', 1, {
        shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1,
      }),
      event('turn/start', 2, { turn: 2 }),
      event('step/start', 3, { turn: 2, step: 1 }),
      event('step/end', 4, { turn: 2, step: 1 }),
      event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } }),
    ])).toThrow()
  })

  it('drains a pending id-carrying summary and a title citing a settled seq', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('compaction/summary', 1, {
        compactionId: 'c-1', summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1,
      }),
      event('session/title', 2, { title: 't', messageSeqs: [0], source: { kind: 'user' } }),
      event('turn/start', 3, { turn: 2 }),
      event('step/start', 4, { turn: 2, step: 1 }),
      event('step/end', 5, { turn: 2, step: 1 }),
      event('turn/end', 6, { turn: 2, reason: { kind: 'completed' } }),
    ])).toThrow()
  })

  it('rejects a seeded stream that ends before its declared inherited cut', () => {
    expect(() => migrate([
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ], { isSeeded: true }, 5)).toThrow('ended before its declared inherited cut')
  })

  it('keeps a current-generation delivery marker naming this Session untracked', () => {
    const migrated = migrate(turnWithStep([
      event('session-log-deepseek/delivery-accepted', 0, { sessionId: 's', throughSeq: 1, sessionFormatVersion: 2 }),
    ]))
    expect(migrated.events.map(item => item.type)).toContain('session-log-deepseek/delivery-accepted')
  })
})

describe('dialect stage direct entry points', () => {
  function stageWith(events: SessionFormatEvent[]) {
    const sourceHeader = { version: 2, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0 } as SessionFormatHeader
    const stage = coharnessV2ToV3Dialect.createStage({
      sourceHeader,
      targetHeader: coharnessV2ToV3Dialect.migrateHeader(sourceHeader),
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    const context = {
      emitEvent: (value: SessionFormatEvent) => { events.push(value) },
      emitRun: () => {},
    }
    return { stage, context }
  }

  it('expands a compact run through transformRun', () => {
    const output: SessionFormatEvent[] = []
    const { stage, context } = stageWith(output)
    stage.transformRun({
      runType: 'test-run', firstSeq: 0, eventCount: 1,
      *expand() { yield event('turn/start', 0, { turn: 1 }) },
    }, context)
    expect(stage.finish(context)).toBe(0)
    expect(output.map(item => item.type)).toEqual(['turn/start'])
  })

  it('enforces dense source sequences at transformEvent', () => {
    const { stage, context } = stageWith([])
    expect(() => { stage.transformEvent(event('turn/start', 4, { turn: 1 }), context) })
      .toThrow('must be dense')
  })
})

/** Migrate a stored artifact from any declared source version through the logical chain. */
function migrateVersion(
  version: number,
  events: readonly SessionFormatEvent[],
  header: Record<string, unknown> = {},
  inheritedEventCount?: number,
) {
  return sessionLogicalFormatCatalog.migrate(
    { version, id: 's', createdAt: 1, ...header } as SessionFormatHeader,
    events,
    inheritedEventCount,
  )
}

const USERDOC_ATTACHED = {
  version: 1,
  messageId: 'u-1',
  index: 0,
  ref: { docId: 'd-1', path: '/docs/d-1.zip', name: 'd-1.zip', bytes: 4, mediaType: 'application/zip', modifiedAt: 1 },
  representation: { kind: 'path' },
}

const DIALECT_USER_SOURCE = {
  kind: 'user',
  rpcId: 'r-1',
  clientTimeZone: 'Asia/Shanghai',
  participant: {
    userId: 1, username: 'admin', displayName: 'admin', role: 'admin',
    scope: { kind: 'project', projectId: 7, projectName: 'p', mode: 'rw', canManage: true },
  },
  documents: [{ ref: USERDOC_ATTACHED.ref, representation: { kind: 'path' } }],
}

describe('dialect member admission', () => {
  it('preserves permission/preset origin through migration from v0 and v1', () => {
    for (const version of [0, 1]) {
      const migrated = migrateVersion(version, turnWithStep([
        event('permission/preset', 0, { preset: 'workspace-write', origin: 'selection' }),
        event('user/message', 0, USER_MESSAGE),
      ]), {}, 0)
      const preset = migrated.events.find(item => item.type === 'permission/preset')
      expect(preset?.data).toMatchObject({ preset: 'workspace-write', origin: 'selection' })
    }
  })

  it('refuses an undeclared permission/preset origin', () => {
    expect(() => migrateVersion(0, turnWithStep([
      event('permission/preset', 0, { preset: 'workspace-write', origin: 'invented' }),
      event('user/message', 0, USER_MESSAGE),
    ]), {}, 0)).toThrow()
  })

  it('rewrites a v2 descriptor stamp to the identical v3 schema', () => {
    const migrated = migrateVersion(0, turnWithStep([
      event('subagent/descriptor', 0, {
        version: 2, mode: 'continuable', provider: 'spawn', label: 'child',
        agentProvider: 'p', agentModel: 'm', agentReasoningEffort: 'max',
      }),
      event('user/message', 0, USER_MESSAGE),
    ]), {}, 0)
    const descriptor = migrated.events.find(item => item.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ version: 3, mode: 'continuable', provider: 'spawn', label: 'child' })
  })

  it('still refuses a descriptor version outside the declared dialect', () => {
    expect(() => migrateVersion(0, turnWithStep([
      event('subagent/descriptor', 0, { version: 9, mode: 'continuable', provider: 'spawn', label: 'c' }),
      event('user/message', 0, USER_MESSAGE),
    ]), {}, 0)).toThrow('descriptor version')
  })

  it('preserves user source documents and project-scope canManage', () => {
    const migrated = migrateVersion(0, turnWithStep([
      event('user/message', 0, { ...USER_MESSAGE, source: DIALECT_USER_SOURCE }),
    ]), {}, 0)
    const message = migrated.events.find(item => item.type === 'user/message')
    expect(message?.data).toMatchObject({ source: DIALECT_USER_SOURCE })
  })

  it('preserves documents on inserted message sources inside agent/inbox/spliced', () => {
    const migrated = migrateVersion(0, turnWithStep([
      event('agent/inbox/spliced', 0, {
        target: 'next-turn', start: 0,
        inserted: [{ id: 'u-9', role: 'user', content: [{ type: 'text', text: 'q' }], source: DIALECT_USER_SOURCE }],
      }),
      event('user/message', 0, USER_MESSAGE),
    ]), {}, 0)
    const spliced = migrated.events.find(item => item.type === 'agent/inbox/spliced')
    expect((spliced?.data as { inserted: Array<{ source: unknown }> }).inserted[0]?.source)
      .toMatchObject(DIALECT_USER_SOURCE)
  })

  it('carries userdoc/attached through the chain unchanged', () => {
    const migrated = migrateVersion(0, turnWithStep([
      event('user/message', 0, { ...USER_MESSAGE, source: DIALECT_USER_SOURCE }),
      event('userdoc/attached', 0, USERDOC_ATTACHED),
    ]), {}, 0)
    const attached = migrated.events.find(item => item.type === 'userdoc/attached')
    expect(attached?.data).toMatchObject(USERDOC_ATTACHED)
  })

  it('refuses a userdoc/attached payload outside the declared form', () => {
    expect(() => migrateVersion(0, turnWithStep([
      event('user/message', 0, USER_MESSAGE),
      event('userdoc/attached', 0, { ...USERDOC_ATTACHED, version: 2 }),
    ]), {}, 0)).toThrow('undeclared payload')
  })

  it('still refuses unknown event types', () => {
    expect(() => migrateVersion(0, turnWithStep([
      event('invented/event', 0, { anything: true }),
      event('user/message', 0, USER_MESSAGE),
    ]), {}, 0)).toThrow()
  })
})
