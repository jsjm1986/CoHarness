import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, type SessionFormatEvent, type SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header, releasedV4SessionFormatCodec, releasedV5SessionFormatCodec, restoreReleasedV5Artifact, sessionFormatV4ToV5 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 4, id: 'draft-upgrade', createdAt: 1, isSeeded: false, delegationDepth: 0 }

it.each([undefined, false, true])('preserves already-written draft=%j while promoting only the version', (draft) => {
  const source = { ...header, ...draft === undefined ? {} : { draft } }
  const physical = releasedV4SessionFormatCodec.encodeHeader(source, 0)
  expect(physical).toEqual({ type: 'session', ...source })
  const target = sessionFormatV4ToV5.migrateHeader(releasedV4SessionFormatCodec.decodeHeader(physical))
  expect(target).toEqual({ ...source, version: 5 })
  const encoded = releasedV5SessionFormatCodec.encodeHeader(target, 0)
  expect(encoded).toEqual({ ...physical, version: 5 })
  expect(releasedV5SessionFormatCodec.decodeHeader(encoded)).toEqual(target)
  const decoder = releasedV5SessionFormatCodec.createDecoder(encoded, 'strict')
  const collector = new SessionFormatEventCollector()
  const row = { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }
  const event = releasedV5SessionFormatCodec.encodeEvent(row)
  decoder.decodeRow(event, collector)
  expect(collector.values).toEqual([row])
  expect(decoder.finish(collector)).toBe(0)
  expect(restoreReleasedV5Artifact({ header: target, events: [], inheritedEventCount: 0 }, new Set()).header).toBe(target)
})

describe('V4 identity body migration', () => {
  it.each([undefined, 0, 2])('preserves events and inherited cut %j without copying message payloads', (knownCut) => {
    const sourceHeader = { ...header, isSeeded: knownCut !== 0 }
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader, targetHeader: { ...sourceHeader, version: 5 }, sourceInheritedEventCount: knownCut, sourceKind: 'decoded' })
    const events: SessionFormatEvent[] = [
      { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 2, type: 'turn/end', data: { turn: 1, reason: 'done' } },
      ...knownCut === 0 ? [] : [{ seq: 2, time: 2, type: 'session/end-seed', data: { inherited: true } }],
    ]
    const collector = new SessionFormatEventCollector()
    stage.transformEvent(events[0]!, collector)
    stage.transformRun({ runType: 'fixture', firstSeq: 1, eventCount: events.length - 1, *expand() { yield* events.slice(1) } }, collector)
    expect(collector.values).toEqual(events)
    expect(collector.values[0]).toBe(events[0])
    expect(stage.finish(collector)).toBe(knownCut ?? 2)
  })

  it('refuses a seeded source without its inherited cut', () => {
    const sourceHeader = { ...header, isSeeded: true }
    const stage = sessionFormatV4ToV5.createStage({ sourceHeader, targetHeader: { ...sourceHeader, version: 5 }, sourceInheritedEventCount: undefined, sourceKind: 'decoded' })
    expect(() => stage.finish(new SessionFormatEventCollector())).toThrow('no inherited cut')
  })
})

it('rejects other versions and malformed draft fields instead of widening the historical codec', () => {
  expect(() => { assertReleasedV5Header(header) }).toThrow('expected format v5')
  expect(() => sessionFormatV4ToV5.migrateHeader({ ...header, version: 3 })).toThrow('expected format v4')
  for (const value of [null, { type: 'session', ...header }, { type: 'session', ...header, version: 6 }]) {
    expect(() => releasedV5SessionFormatCodec.decodeHeader(value)).toThrow('expected format v5 physical')
  }
  for (const draft of [null, 'true', 1]) {
    expect(() => releasedV5SessionFormatCodec.decodeHeader({ type: 'session', ...header, version: 5, draft })).toThrow('draft must be boolean')
    expect(() => { assertReleasedV5Header({ ...header, version: 5, draft }) }).toThrow('draft must be boolean')
  }
})
