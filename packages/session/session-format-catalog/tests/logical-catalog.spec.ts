import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sessionLogicalFormatCatalog } from '../src/index.ts'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'

function event(type: string, seq: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...extra } as unknown as SessionFormatEvent
}

function migrate(header: Record<string, unknown>, events: readonly SessionFormatEvent[], inheritedEventCount = 0) {
  return sessionLogicalFormatCatalog.migrate(header as SessionFormatHeader, events, inheritedEventCount)
}

const CONFIG = { provider: 'mock', model: 'mock' }

describe('logical Session format catalog', () => {
  it('classifies headers without reading events and migrates each adjacent generation', () => {
    const result = sessionLogicalFormatCatalog.readHeader({ version: 0, id: 'old', createdAt: 1 })
    expect(result).toMatchObject({ status: 'migration-required', storedVersion: 0, targetVersion: 6 })
    if (result.status !== 'migration-required') throw new Error('expected migration-required header')
    expect(result.header).toMatchObject({ version: 6, id: 'old', createdAt: 1 })
  })

  it('refuses newer generations before body decoding', () => {
    expect(sessionLogicalFormatCatalog.readHeader({ version: 7, id: 'newer', createdAt: 1 })).toMatchObject({
      status: 'unsupported',
      storedVersion: 7,
      targetVersion: 6,
    })
  })

  it('rejects unknown logical header keys and contradictory seed metadata', () => {
    expect(sessionLogicalFormatCatalog.readHeader({ version: 5, id: 'x', createdAt: 1, extra: 1 }))
      .toMatchObject({ status: 'malformed' })
    expect(sessionLogicalFormatCatalog.readHeader({
      version: 5, id: 'x', createdAt: 1, isSeeded: false, seedLength: 2,
    })).toMatchObject({ status: 'malformed' })
    /* seedLength is the stored spelling of the seeded declaration. */
    const seeded = sessionLogicalFormatCatalog.readHeader({
      version: 6, id: 'x', createdAt: 1, seedLength: 2,
    })
    expect(seeded).toMatchObject({ status: 'current' })
    if (seeded.status !== 'current') throw new Error('expected current header')
    expect(seeded.header.isSeeded).toBe(true)
    /* draft predates its admission generation on purpose. */
    expect(sessionLogicalFormatCatalog.readHeader({ version: 2, id: 'x', createdAt: 1, draft: true }))
      .toMatchObject({ status: 'malformed' })
  })

  it('carries an sshTarget binding through the logical header read', () => {
    const result = sessionLogicalFormatCatalog.readHeader({
      version: 6, id: 'ssh', createdAt: 1, isSeeded: false, delegationDepth: 0, sshTarget: 42,
    })
    expect(result).toMatchObject({ status: 'current', storedVersion: 6, targetVersion: 6 })
    if (result.status !== 'current') throw new Error('expected current header')
    expect(result.header.sshTarget).toBe(42)
  })

  it('keeps source artifacts detached and upgrades the header only', () => {
    const events: SessionFormatEvent[] = [{ type: 'turn/start', seq: 0, time: 3, data: { turn: 1 } }]
    const migrated = migrate({ version: 1, id: 'artifact', createdAt: 2 }, events)
    expect(migrated.header.version).toBe(6)
    expect(migrated.events).toEqual(events)
  })

  it('promotes a v2 request system prompt into a durable v3 surface node', () => {
    const migrated = migrate({ version: 2, id: 'prompt', createdAt: 2 }, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: 4, data: { header: { config: CONFIG, system: 'Be concise.' }, reason: 'initial' } },
    ] as SessionFormatEvent[])
    expect(migrated.header.version).toBe(6)
    expect(migrated.events.map(item => item.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'system/message', 'request/header',
    ])
    expect(migrated.events[3]?.data).toMatchObject({ message: { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] } })
    expect(migrated.events[4]?.data).toEqual({ header: { config: CONFIG }, reason: 'initial' })
  })

  it('migrates empty prompts, remaps replacements, and carries inherited cuts', () => {
    const migrated = migrate({ version: 2, id: 'remap', createdAt: 1, agentPreset: 'code', isSeeded: true }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('user/message', 2, { role: 'user', id: 'u-1', content: [], source: { kind: 'user' } }),
      event('request/header', 3, { header: { config: CONFIG, system: '' }, reason: 'initial' }),
      event('request/header', 4, { header: { config: CONFIG, system: 'next' }, reason: 'change' }),
      event('assistant/message', 5, { turn: 1, step: 1, message: { role: 'assistant', id: 'a-1', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }),
      event('agent/inbox/spliced', 6, { target: 'next-turn', start: 0, inserted: [{ role: 'user', id: 'q-1', content: [], source: { kind: 'user' } }] }),
      event('session/title', 7, {
        title: 't', source: { kind: 'provider', provider: 'p', model: { provider: 'p', model: 'm' } }, messageSeqs: [2],
      }),
      event('step/end', 8, { turn: 1, step: 1 }),
      event('turn/end', 9, { turn: 1, reason: { kind: 'completed' } }),
    ], 2)
    /* The released v2→v3 header edge retires the code preset vocabulary. */
    expect(migrated.header).toMatchObject({ version: 6, agentPreset: 'ptc' })
    expect(migrated.inheritedEventCount).toBeGreaterThan(0)
    expect(migrated.events.map(item => item.type)).toContain('system/message')
    /* request/header is not a surface type: the generated system node
     * expresses the replacement instead. */
    const replaced = migrated.events.find(item => item.type === 'system/message'
      && (item.data as { message?: { content?: unknown[] } }).message?.content?.length === 1)
    expect(replaced).toMatchObject({ surfaceOp: { op: 'replace' } })
    expect(Array.isArray(replaced?.sourceEventSeqs)).toBe(true)
    const empty = migrated.events.find(item => item.type === 'system/message')
    expect(empty?.data).toMatchObject({ message: { content: [] } })
  })

  it('rejects malformed v2 step state, references, and generated ids', () => {
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('request/header', 1, { header: { config: CONFIG }, reason: 'initial' }),
    ])).toThrow('outside an open step')
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1 }),
    ])).toThrow()
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { config: CONFIG }, reason: 'initial' }, { sourceEventSeqs: [99] }),
    ])).toThrow('sourceEventSeqs must name earlier events')
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { config: CONFIG }, reason: 'initial' }, { surfaceOp: { op: 'replace', start: 99, end: 99 } }),
    ])).toThrow('surfaceOp must name an earlier replace range')
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { role: 'user', id: `v2-to-v3-system-${createHash('sha256').update(JSON.stringify(['session-format-v2-to-v3', 'bad', 3, 'request/header'])).digest('hex')}`, content: [], source: { kind: 'user' } }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('request/header', 3, { header: { config: CONFIG, system: 'x' }, reason: 'initial' }),
    ])).toThrow('collides with an existing message id')
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { config: CONFIG, system: 'x' }, reason: 'initial' }),
      event('user/message', 3, { role: 'user', id: `v2-to-v3-system-${createHash('sha256').update(JSON.stringify(['session-format-v2-to-v3', 'bad', 2, 'request/header'])).digest('hex')}`, content: [], source: { kind: 'user' } }),
    ])).toThrow('collides with a generated system message')
    for (const bad of [
      event('user/message', 0, { content: 'bad' }),
      event('assistant/message', 0, { message: null }),
      event('tool/result', 0, { message: { content: 'bad' } }),
      event('agent/inbox/spliced', 0, { inserted: 'bad' }),
      event('session/title-llm-request', 0, { messages: 'bad' }),
      event('assistant/attempt', 0, { stream: 'bad' }),
    ]) {
      expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [bad])).toThrow()
    }
    /* A request/header without its required header field is malformed. */
    expect(() => migrate({ version: 2, id: 'bad', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { reason: 'initial' }),
    ])).toThrow()
  })

  it('buffers turn-scope pre-step events and emits them after the generated head', () => {
    const migrated = migrate({ version: 2, id: 'pre-step', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('user/message', 1, { role: 'user', id: 'u-0', content: [], source: { kind: 'user' } }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('step/end', 3, { turn: 1, step: 1 }),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ])
    /* The turn-scope message surfaces only after the head the step opened. */
    expect(migrated.events.map(item => item.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end',
    ])
  })

  it('drains emittable pending events in place at a turn boundary', () => {
    const migrated = migrate({ version: 2, id: 'turn-drain', createdAt: 1 }, [
      event('session/title', 0, { title: 't', messageSeqs: [], source: { kind: 'user' } }),
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('step/end', 3, { turn: 1, step: 1 }),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events.map(item => item.type)).toEqual([
      'session/title', 'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
    ])
  })

  it('passes bare mid-log end-seed lifecycle markers through an unseeded v0 log', () => {
    const migrated = migrate({ version: 0, id: 'resume-marks', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 2, {}),
      event('turn/start', 3, { turn: 2 }),
      event('turn/end', 4, { turn: 2, reason: { kind: 'completed' } }),
      event('session/end-seed', 5, {}),
    ])
    expect(migrated.header.version).toBe(6)
    expect(migrated.inheritedEventCount).toBe(0)
    expect(migrated.events.filter(item => item.type === 'session/end-seed')).toHaveLength(2)
  })

  it('accepts a seeded v0 log whose bare end-seed marker sits at the inherited cut', () => {
    const migrated = migrate({ version: 0, id: 'seeded', createdAt: 1, isSeeded: true }, [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      event('session/end-seed', 2, {}),
      event('turn/start', 3, { turn: 2 }),
    ], 2)
    expect(migrated.header.version).toBe(6)
    expect(migrated.inheritedEventCount).toBe(2)
  })

  it('rejects a flagged inherited end-seed marker in an unseeded log', () => {
    expect(() => migrate({ version: 2, id: 'unseeded-flag', createdAt: 1 }, [
      event('session/end-seed', 0, { inherited: true }),
    ])).toThrow('unseeded Session contains an inherited end-seed marker')
  })

  it('rejects a flagged inherited end-seed marker off the inherited cut', () => {
    expect(() => migrate({ version: 2, id: 'off-cut-flag', createdAt: 1, isSeeded: true }, [
      event('turn/start', 0, { turn: 1 }),
      event('session/end-seed', 1, { inherited: true }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 3, { turn: 2 }),
    ], 3)).toThrow('inherited end-seed marker')
  })

  it('synthesizes the owed end-seed marker when a seeded v2 log ends at its cut', () => {
    const migrated = migrate({ version: 2, id: 'owed-marker', createdAt: 1, isSeeded: true }, [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ], 2)
    const markers = migrated.events.filter(item => item.type === 'session/end-seed')
    expect(markers).toHaveLength(1)
    expect(markers[0]?.data).toEqual({ inherited: true })
  })

  it('refuses a seeded v2 log that ends before its declared inherited cut', () => {
    expect(() => migrate({ version: 2, id: 'short', createdAt: 1, isSeeded: true }, [
      event('turn/start', 0, { turn: 1 }),
    ], 5)).toThrow('ended before its declared inherited cut')
  })

  it('rejects a current-generation delivery marker naming another Session', () => {
    expect(() => migrate({ version: 2, id: 'deliver', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('session-log-deepseek/delivery-accepted', 1, { sessionId: 'other', throughSeq: 0, sessionFormatVersion: 2 }),
    ])).toThrow('delivery marker names the wrong Session')
  })

  it('renames the retired compact vocabulary through the v2 dialect', () => {
    const migrated = migrate({ version: 2, id: 'compact', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('user/message', 2, { role: 'user', id: 'u-1', content: [], source: { kind: 'user' } }),
      event('compact/start', 3, { turn: 1, compactionId: 'c-1' }),
      event('compact/summary', 4, {
        compactionId: 'c-1', summary: [{ type: 'text', text: 's' }], provider: 'p', model: 'm',
        shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 1,
      }),
      event('compact/end', 5, { turn: 1, compactionId: 'c-1' }),
      event('step/end', 6, { turn: 1, step: 1 }),
      event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(migrated.events.map(item => item.type)).toContain('compaction/start')
    expect(migrated.events.map(item => item.type)).toContain('compaction/summary')
    expect(migrated.events.map(item => item.type)).toContain('compaction/end')
    expect(migrated.events.map(item => item.type)).not.toContain('compact/start')
  })

  it('unwraps a steering message into a user message with the append placement', () => {
    const migrated = migrate({ version: 2, id: 'steer', createdAt: 1 }, [
      event('turn/start', 0, { turn: 1 }),
      event('steering/message', 1, { turn: 1, message: { role: 'user', id: 's-1', content: [], source: { kind: 'user' } } }),
      event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const steered = migrated.events.find(item => item.type === 'user/message')
    expect(steered).toMatchObject({ surfaceOp: 'append' })
  })

  it('requires dense logical sequences and refuses compact runs', () => {
    expect(() => migrate({ version: 2, id: 'gap', createdAt: 1 }, [
      event('turn/start', 1, { turn: 1 }),
    ])).toThrow('dense')
    const stream = sessionLogicalFormatCatalog.createStream(
      { version: 2, id: 'run', createdAt: 1 } as SessionFormatHeader,
      0,
      { emitEvent: () => {}, emitRun: () => {} },
    )
    expect(() => { stream.emitRun({} as never) }).toThrow('compact runs')
  })

  it('rejects malformed probes the physical path refuses', () => {
    /* The decoded-row admission mirrors the released codec: foreign envelope
     * keys are refused before migration. */
    expect(() => migrate({ version: 2, id: 'probe', createdAt: 1 }, [
      { turn: 1, unexpected: 1 } as unknown as SessionFormatEvent,
    ])).toThrow('lacks type')
  })

  it('streams a v2 request-header migration with the synthesized seed marker', () => {
    const output: SessionFormatEvent[] = []
    const stream = sessionLogicalFormatCatalog.createStream(
      { version: 2, id: 'stream-v2', createdAt: 1, isSeeded: true } as SessionFormatHeader,
      1,
      { emitEvent: value => output.push(value), emitRun: () => {} },
    )
    stream.emitEvent(event('turn/start', 0, { turn: 1 }))
    stream.emitEvent(event('step/start', 1, { turn: 1, step: 1 }))
    stream.emitEvent(event('request/header', 2, { header: { config: CONFIG, system: 'streamed' }, reason: 'initial' }))
    stream.emitEvent(event('step/end', 3, { turn: 1, step: 1 }))
    stream.emitEvent(event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }))
    expect(stream.finish()).toBe(1)
    expect(output.map(item => item.type)).toEqual([
      'turn/start', 'session/end-seed', 'step/start', 'system/message', 'system/message', 'request/header', 'step/end', 'turn/end',
    ])
    expect(stream.header.version).toBe(6)
  })
})
