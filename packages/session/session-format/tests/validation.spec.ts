import { describe, expect, it } from 'vitest'
import {
  createSessionFormatCatalog, createSessionFormatChain, defineSessionFormatMigration,
  inspectSessionFormatVersion, sessionFormatCatalog, sessionFormatCount,
  snapshotSessionFormatArtifact, snapshotSessionFormatHeader, snapshotSessionFormatJson,
} from '../src/index.ts'
import type { SessionFormatArtifact, SessionFormatChainOptions, SessionFormatEvent, SessionFormatHeader, SessionFormatMigration } from '../src/index.ts'

const header = (version = 0): SessionFormatHeader => ({ id: 'session', version, createdAt: 1 })
const artifact = (version = 0): SessionFormatArtifact => ({
  header: header(version), inheritedEventCount: 0,
  events: [{ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }],
})
const migration = (overrides: Partial<SessionFormatMigration> = {}): SessionFormatMigration => ({
  name: 'v0-to-v1', fromVersion: 0, toVersion: 1,
  migrateHeader: value => ({ ...value, version: 1 }),
  migrate: value => ({ ...value, header: { ...value.header, version: 1 } }),
  validateTargetHeader: () => {}, validateTarget: () => {}, ...overrides,
})
const options = (overrides: Partial<SessionFormatChainOptions> = {}): SessionFormatChainOptions => ({
  currentVersion: 1, migrations: [migration()],
  restoreCurrentHeader: value => value, restoreCurrent: value => value, ...overrides,
})

describe('Session format input validation', () => {
  it.each([undefined, null, [], 1, 'header', true])('classifies a non-object header as malformed (%j)', (value) => {
    expect(sessionFormatCatalog.readHeader(value)).toMatchObject({ status: 'malformed', targetVersion: 2 })
    expect(() => inspectSessionFormatVersion(value)).toThrow('must be a JSON object')
  })

  it.each([-1, -0, 0.5, Infinity, NaN, '1', null])('rejects an invalid coordinate (%s)', (value) => {
    expect(() => sessionFormatCount(value, 'offset')).toThrow('offset must be a non-negative safe integer')
    expect(sessionFormatCatalog.readHeader({ ...header(), version: value })).toMatchObject({ status: 'malformed' })
  })

  it('keeps the admitted version in malformed diagnostics without rereading input getters', () => {
    expect(sessionFormatCatalog.readHeader({ version: 1, id: '', createdAt: 1 })).toMatchObject({
      status: 'malformed', storedVersion: 1, reason: 'Session header id must be a non-empty string',
    })
    const throwing = { get version(): number { throw new Error('unreadable header') } }
    expect(sessionFormatCatalog.readHeader(throwing)).toMatchObject({ status: 'malformed', reason: 'Error: unreadable header' })
    expect(sessionFormatCatalog.readHeader(header(2))).toMatchObject({ status: 'current', storedVersion: 2 })
  })

  it('snapshots lossless JSON and rejects values JSON would discard', () => {
    expect(snapshotSessionFormatJson({ nested: [1, null] })).toEqual({ nested: [1, null] })
    expect(() => snapshotSessionFormatJson({ value: undefined })).toThrow('not lossless JSON')
    expect(() => snapshotSessionFormatJson(Infinity, 'header')).toThrow('header is not lossless JSON')
  })

  it.each([null, [], 1, true])('rejects a non-object durable header (%j)', (value) => {
    expect(() => snapshotSessionFormatHeader(value as unknown as SessionFormatHeader)).toThrow('must be a JSON object')
  })

  it.each([{}, { ...header(), id: 1 }, { ...header(), id: '' }, { ...header(), createdAt: -1 }])('rejects incomplete header coordinates (%j)', (value) => {
    expect(() => snapshotSessionFormatHeader(value as SessionFormatHeader)).toThrow()
  })

  it.each([null, [], 1, true])('rejects a non-object durable artifact (%j)', (value) => {
    expect(() => snapshotSessionFormatArtifact(value as unknown as SessionFormatArtifact)).toThrow('must be an object')
  })

  it.each([null, [], 1])('requires an artifact header object (%j)', (value) => {
    expect(() => snapshotSessionFormatArtifact({ ...artifact(), header: value } as unknown as SessionFormatArtifact)).toThrow('header must be an object')
  })

  it.each([
    { inheritedEventCount: -1 }, { inheritedEventCount: 2 }, { events: 'events' },
    { events: [null] }, { events: [[]] }, { events: [1] },
    { events: [{ seq: 1, type: 'event', time: 1, data: {} }] },
    { events: [{ seq: 0, type: '', time: 1, data: {} }] },
    { events: [{ seq: 0, type: 1, time: 1, data: {} }] },
    { events: [{ seq: 0, type: 'event', time: -1, data: {} }] },
    { events: [{ seq: 0, type: 'event', time: 1 }] },
  ])('rejects malformed artifact coordinates and event envelopes (%j)', (fields) => {
    expect(() => snapshotSessionFormatArtifact({ ...artifact(), ...fields } as unknown as SessionFormatArtifact)).toThrow()
  })
})

describe('adjacent migration declarations and output validation', () => {
  it.each([{ name: '' }, { fromVersion: -1 }, { fromVersion: 0.5 }, { toVersion: 2 }])('rejects an invalid declaration (%j)', (fields) => {
    expect(() => defineSessionFormatMigration(migration(fields))).toThrow()
  })

  it('rejects duplicate or missing migration edges', () => {
    expect(() => createSessionFormatChain(options({ migrations: [migration(), migration()] }))).toThrow('duplicate')
    expect(() => createSessionFormatChain(options({ migrations: [] }))).toThrow('missing Session migration')
  })

  it('refuses invalid starting versions and returns immutable complete plans', () => {
    const chain = createSessionFormatChain(options())
    expect(() => chain.plan(-1)).toThrow('stored Session version must be non-negative')
    expect(() => chain.plan(2)).toThrow('newer format')
    expect(chain.plan(0).map(step => step.name)).toEqual(['v0-to-v1'])
    expect(chain.plan(1)).toEqual([])
    expect(Object.isFrozen(chain.plan(0))).toBe(true)
  })

  it('rejects a migration that returns the wrong header or artifact version', () => {
    const chain = createSessionFormatChain(options({ migrations: [migration({
      migrateHeader: value => value, migrate: value => value,
    })] }))
    expect(() => chain.migrateHeader(header())).toThrow('invalid header version')
    expect(() => chain.migrate(artifact())).toThrow('invalid artifact version')
  })

  it('rejects a restorer that returns an old artifact and preserves caller-owned input', () => {
    const chain = createSessionFormatChain(options({ restoreCurrent: () => artifact(0) }))
    expect(() => chain.migrate(artifact())).toThrow('restorer returned an invalid version')
    const source = artifact()
    const restored = createSessionFormatChain(options()).migrate(source)
    expect(restored.header.version).toBe(1)
    expect(source.header.version).toBe(0)
    expect(Object.isFrozen(restored.events)).toBe(true)
  })

  it('delegates direct catalog header migration to the declared chain', () => {
    const catalog = createSessionFormatCatalog(options())
    expect(catalog.migrateHeader(header())).toEqual(header(1))
    expect(catalog.migrate(artifact()).header).toEqual(header(1))
  })
})

describe('streaming migration stages', () => {
  it('emits events incrementally and flushes each adjacent stage', () => {
    const calls: string[] = []
    const chain = createSessionFormatChain(options({
      migrations: [migration({
        createStage: ({ targetHeader }) => ({
          transformEvent: (event, context) => { calls.push(`event:${targetHeader.version}:${event.seq}`); context.emitEvent({ ...event, type: 'migrated' }) },
          finish: () => { calls.push(`finish:${targetHeader.version}`) },
        }),
      })],
    }))
    const output: SessionFormatEvent[] = []
    const stream = chain.createStream(header(), 0, { emitEvent: event => output.push(event) })
    stream.emitEvent(artifact().events[0] as SessionFormatEvent)
    expect(output).toEqual([{ type: 'migrated', seq: 0, time: 2, data: { turn: 1 } }])
    stream.finish()
    expect(calls).toEqual(['event:1:0', 'finish:1'])
    expect(stream.header.version).toBe(1)
  })

  it('fails when an adjacent migration has no streaming stage', () => {
    const noStage = migration()
    expect(() => createSessionFormatChain(options({ migrations: [noStage] })).createStream(header(), 0, { emitEvent: () => {} })).toThrow('does not provide a streaming stage')
  })
})
