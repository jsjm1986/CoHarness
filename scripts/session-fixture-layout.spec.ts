import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { canonicalSessionFixture, inspectSessionFixtureLayouts, isPhysicalSessionFixture } from './session-fixture-layout.ts'

const LEGACY_HEADER = '  {"type":"session","version":0,"id":"fixture","createdAt":1,"delegationDepth":0}  '
const CURRENT_HEADER = '{"type":"session","version":4,"id":"fixture","createdAt":1,"delegationDepth":0}'
const VERSIONLESS_HEADER = '{"type":"session","id":"fixture","createdAt":1,"delegationDepth":0}'

function legacyChunkRows(): string[] {
  return Array.from({ length: 4 }, (_, index) => JSON.stringify({
    type: 'assistant/chunk',
    seq: index,
    time: 10 + index,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `part-${index}` } },
  }))
}

function legacyFixture(): string {
  return [LEGACY_HEADER, ...legacyChunkRows(), ''].join('\n')
}

function packedRow(): string {
  return JSON.stringify({
    type: 'text-chunks',
    seq0: 0,
    time0: 10,
    data: { turn: 1, step: 1, index: 0, dt: [1, 1, 1], texts: ['a', 'b', 'c', 'd'] },
  })
}

function currentEvents(): string[] {
  return [
    JSON.stringify({ type: 'turn/start', data: { turn: 1 }, seq: 0, time: 10 }),
    JSON.stringify({
      type: 'user/message',
      data: {
        id: 'u1', role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      },
      seq: 1,
      time: 11,
      surfaceOp: 'append',
    }),
    JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 2, time: 12 }),
  ]
}

function currentFixture(header: string = CURRENT_HEADER): string {
  return [header, ...currentEvents(), ''].join('\n')
}

describe('canonicalSessionFixture', () => {
  it('returns a released-generation fixture byte-identically after validating its rows', () => {
    const fixture = legacyFixture()
    expect(canonicalSessionFixture(fixture, 'fixture.jsonl')).toBe(fixture)
  })

  it('validates released packed rows without rewriting them', () => {
    const fixture = [LEGACY_HEADER, packedRow(), ''].join('\n')
    expect(canonicalSessionFixture(fixture, 'fixture.jsonl')).toBe(fixture)
  })

  it('ignores JSONL whose first record is not a session header', () => {
    expect(canonicalSessionFixture('{"type":"session_event"}\n{"value":1}\n')).toBeUndefined()
  })

  it('rejects packed rows in a current-generation fixture', () => {
    expect(() => canonicalSessionFixture([CURRENT_HEADER, packedRow(), ''].join('\n'), 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2: current projected fixtures cannot contain legacy packed rows/)
  })

  it('rejects packed rows in a versionless fixture', () => {
    expect(() => canonicalSessionFixture([VERSIONLESS_HEADER, packedRow(), ''].join('\n')))
      .toThrow(/current projected fixtures cannot contain legacy packed rows/)
  })

  it('re-encodes a current fixture one projected event per row', () => {
    const canonical = canonicalSessionFixture(currentFixture(), 'fixture.jsonl')
    expect(canonical).toBeDefined()
    expect(canonical?.split('\n')[0]).toBe(CURRENT_HEADER)
    const bodyLines = canonical?.split('\n').slice(1).filter(line => line.length > 0) ?? []
    expect(bodyLines).toHaveLength(3)
    for (const line of bodyLines) {
      expect(JSON.parse(line)).not.toHaveProperty('seq')
      expect(JSON.parse(line)).not.toHaveProperty('time')
    }
    const source = parseSessionLog(currentFixture())
    const rewritten = parseSessionLog(canonical ?? '')
    const project = (events: typeof source) => events.map(({ seq: _seq, time: _time, ...event }) => event)
    expect(project(rewritten)).toStrictEqual(project(source))
  })

  it('is idempotent for an already canonical current fixture', () => {
    const canonical = canonicalSessionFixture(currentFixture())
    expect(canonical).toBeDefined()
    expect(canonicalSessionFixture(canonical ?? '')).toBe(canonical)
  })

  it('fails loud on malformed records after a session header', () => {
    expect(() => canonicalSessionFixture(`${LEGACY_HEADER}\n{not-json}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2 contains invalid JSON/)
  })

  it('labels malformed packed rows with the fixture path and line', () => {
    expect(() => canonicalSessionFixture(`${LEGACY_HEADER}\n{"type":"text-chunks"}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2: malformed text-chunks storage row/)
  })
})

describe('isPhysicalSessionFixture', () => {
  it('recognizes installed-runtime physical snapshots', () => {
    expect(isPhysicalSessionFixture('scripts/snapshots/python-sdk-single-exe/advanced/session.jsonl')).toBe(true)
    expect(isPhysicalSessionFixture('scripts/snapshots/python-sdk-single-exe/advanced/requests.jsonl')).toBe(false)
    expect(isPhysicalSessionFixture('apps/web/tests/snapshots/example/session.jsonl')).toBe(false)
  })
})

it('keeps projected session fixtures in canonical layout', () => {
  const root = resolve(import.meta.dirname, '..')
  const nonCanonical = inspectSessionFixtureLayouts(root)
    .filter(fixture => fixture.source !== fixture.canonical)
    .map(fixture => fixture.path)
  expect(nonCanonical).toEqual([])
})
