import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('Session format catalog', () => {
  it('classifies headers without reading events and migrates each adjacent generation', () => {
    const result = sessionFormatCatalog.readHeader({ version: 0, id: 'old', createdAt: 1 })
    expect(result).toMatchObject({ status: 'migration-required', storedVersion: 0, targetVersion: 2 })
    if (result.status !== 'migration-required') throw new Error('expected migration-required header')
    expect(result.header).toEqual({ version: 2, id: 'old', createdAt: 1 })
  })

  it('refuses newer generations before body decoding', () => {
    expect(sessionFormatCatalog.readHeader({ version: 3, id: 'newer', createdAt: 1 })).toMatchObject({
      status: 'unsupported',
      storedVersion: 3,
      targetVersion: 2,
    })
  })

  it('keeps source artifacts detached and upgrades the header only', () => {
    const source = {
      header: { version: 1, id: 'artifact', createdAt: 2 },
      inheritedEventCount: 0,
      events: [{ type: 'turn/start', seq: 0, time: 3, data: { turn: 1 } }],
    } as const
    const migrated = sessionFormatCatalog.migrate(source)
    expect(migrated.header.version).toBe(2)
    expect(migrated.events).toEqual(source.events)
    expect(migrated).not.toBe(source)
  })
})
