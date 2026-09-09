import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sessionFormatCatalog } from '../src/index.ts'
import type { SessionFormatEvent } from '../src/types.ts'

function event(type: string, seq: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionFormatEvent {
  return { type, seq, time: seq + 1, data, ...extra } as unknown as SessionFormatEvent
}

describe('Session format catalog', () => {
  it('classifies headers without reading events and migrates each adjacent generation', () => {
    const result = sessionFormatCatalog.readHeader({ version: 0, id: 'old', createdAt: 1 })
    expect(result).toMatchObject({ status: 'migration-required', storedVersion: 0, targetVersion: 3 })
    if (result.status !== 'migration-required') throw new Error('expected migration-required header')
    expect(result.header).toEqual({ version: 3, id: 'old', createdAt: 1 })
  })

  it('refuses newer generations before body decoding', () => {
    expect(sessionFormatCatalog.readHeader({ version: 4, id: 'newer', createdAt: 1 })).toMatchObject({
      status: 'unsupported',
      storedVersion: 4,
      targetVersion: 3,
    })
  })

  it('keeps source artifacts detached and upgrades the header only', () => {
    const source = {
      header: { version: 1, id: 'artifact', createdAt: 2 },
      inheritedEventCount: 0,
      events: [{ type: 'turn/start', seq: 0, time: 3, data: { turn: 1 } }],
    } as const
    const migrated = sessionFormatCatalog.migrate(source)
    expect(migrated.header.version).toBe(3)
    expect(migrated.events).toEqual(source.events)
    expect(migrated).not.toBe(source)
  })

  it('promotes a v2 request system prompt into a durable v3 surface node', () => {
    const source = {
      header: { version: 2, id: 'prompt', createdAt: 2 },
      inheritedEventCount: 0,
      events: [
        { type: 'step/start', seq: 0, time: 3, data: { turn: 1, step: 1 } },
        { type: 'request/header', seq: 1, time: 4, data: { header: { config: { provider: 'mock', model: 'mock' }, system: 'Be concise.' }, reason: 'initial' } },
      ],
    } as const
    const migrated = sessionFormatCatalog.migrate(source)
    expect(migrated.header.version).toBe(3)
    expect(migrated.events.map(event => event.type)).toEqual(['step/start', 'system/message', 'system/message', 'request/header'])
    expect(migrated.events[2]?.data).toMatchObject({ message: { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] } })
    expect(migrated.events[3]?.data).toEqual({ header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
  })

  it('migrates empty prompts, remaps replacements, and carries inherited cuts', () => {
    const source = {
      header: { version: 2, id: 'remap', createdAt: 1, agentPreset: 'code' },
      inheritedEventCount: 2,
      events: [
        event('step/start', 0, { turn: 1, step: 1 }),
        event('user/message', 1, { role: 'user', id: 'u-1', content: [], source: { kind: 'plugin', plugin: 'tools-code-mode' } }),
        event('request/header', 2, { header: { config: {}, system: '' }, reason: 'initial' }, { surfaceOp: 'append' }),
        event('request/header', 3, { header: { config: {}, system: 'next' }, reason: 'change' }, {
          surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1],
        }),
        event('assistant/message', 4, { message: { role: 'assistant', id: 'a-1', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } }),
        event('tool/result', 5, { message: { role: 'user', id: 't-1', content: [{ type: 'tool-result', toolCallId: 'c', content: [] }], source: { kind: 'tool', callId: 'c' } } }),
        event('agent/inbox/spliced', 6, { inserted: [{ role: 'user', id: 'q-1', content: [], source: { kind: 'user' } }] }),
        event('session/title-llm-request', 7, { messages: [{ role: 'user', id: 'title-1', content: [], source: { kind: 'user' } }] }),
        event('step/end', 8, { turn: 1, step: 1 }),
      ],
    } as const
    const migrated = sessionFormatCatalog.migrate(source)
    expect(migrated.header).toMatchObject({ version: 3, agentPreset: 'code' })
    expect(migrated.inheritedEventCount).toBeGreaterThan(0)
    expect(migrated.events.map(item => item.type)).toContain('system/message')
    const replacement = migrated.events.find(item => item.type === 'request/header'
      && (item.data as { reason?: unknown }).reason === 'change')
    expect(replacement).toMatchObject({ surfaceOp: { op: 'replace' }, sourceEventSeqs: [2] })
    const empty = migrated.events.find(item => item.type === 'system/message')
    expect(empty?.data).toMatchObject({ message: { content: [] } })
  })

  it('rejects malformed v2 step state, references, and generated ids', () => {
    const migrate = (events: readonly SessionFormatEvent[]) => sessionFormatCatalog.migrate({
      header: { version: 2, id: 'bad', createdAt: 1 }, inheritedEventCount: 0, events,
    })
    expect(() => migrate([event('request/header', 0, { header: {}, reason: 'initial' })])).toThrow('outside an open step')
    expect(() => migrate([event('step/start', 0, { turn: 1 })])).toThrow('lacks turn or step')
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: {}, reason: 'initial' }, { sourceEventSeqs: [99] }),
    ])).toThrow('does not name an earlier event')
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: {}, reason: 'initial' }, { surfaceOp: { op: 'replace', start: 99, end: 99 } }),
    ])).toThrow('does not name an earlier event')
    expect(() => migrate([
      event('user/message', 0, { role: 'user', id: `v2-to-v3-system-${createHash('sha256').update(JSON.stringify(['session-format-v2-to-v3', 'bad', 2, 'request/header'])).digest('hex')}`, content: [], source: { kind: 'user' } }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { system: 'x' }, reason: 'initial' }),
    ])).toThrow('collides with a source message')
    expect(() => migrate([
      event('step/start', 0, { turn: 1, step: 1 }),
      event('request/header', 1, { header: { system: 'x' }, reason: 'initial' }),
      event('user/message', 2, { role: 'user', id: `v2-to-v3-system-${createHash('sha256').update(JSON.stringify(['session-format-v2-to-v3', 'bad', 1, 'request/header'])).digest('hex')}`, content: [], source: { kind: 'user' } }),
    ])).toThrow('collides with a generated system message')
    for (const bad of [
      event('user/message', 0, { content: 'bad' }),
      event('assistant/message', 0, { message: null }),
      event('tool/result', 0, { message: { content: 'bad' } }),
      event('agent/inbox/spliced', 0, { inserted: 'bad' }),
      event('session/title-llm-request', 0, { messages: 'bad' }),
      event('assistant/attempt', 0, { stream: 'bad' }),
    ]) expect(() => migrate([bad])).toThrow(/invalid (?:content|message content|messages|stream)/)
    const missingHeader = sessionFormatCatalog.migrate({
      header: { version: 2, id: 'missing-header', createdAt: 1 }, inheritedEventCount: 0,
      events: [event('step/start', 0, { turn: 1, step: 1 }), event('request/header', 1, { reason: 'initial' })],
    })
    expect(missingHeader.events.at(-1)?.type).toBe('request/header')
  })

})

it('streams both default legacy generations without changing event identity', () => {
  const event = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
  const output: unknown[] = []
  const stream = sessionFormatCatalog.createStream({ version: 0, id: 'stream', createdAt: 1 }, 0, { emitEvent: (value) => { output.push(value) } })
  stream.emitEvent(event)
  stream.finish()
  expect(stream.header.version).toBe(3)
  expect(output).toEqual([event])
})

it('streams a v2 request-header migration with mapped surface references', () => {
  const output: SessionFormatEvent[] = []
  const stream = sessionFormatCatalog.createStream({ version: 2, id: 'stream-v2', createdAt: 1 }, 1, {
    emitEvent: value => output.push(value),
  })
  stream.emitEvent(event('step/start', 0, { turn: 1, step: 1 }))
  stream.emitEvent(event('request/header', 1, { header: { system: 'streamed' }, reason: 'initial' }))
  expect(stream.finish()).toBe(2)
  expect(output.map(item => item.type)).toEqual(['step/start', 'system/message', 'system/message', 'request/header'])
})
