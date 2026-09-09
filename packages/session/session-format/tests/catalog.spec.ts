import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

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
    expect(migrated.events.map(event => event.type)).toEqual(['step/start', 'system/message', 'request/header'])
    expect(migrated.events[1]?.data).toMatchObject({ message: { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] } })
    expect(migrated.events[2]?.data).toEqual({ header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
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
