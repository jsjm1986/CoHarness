import { describe, expect, it } from 'vitest'
import {
  SESSION_SURFACE_EVENT_TYPES,
  isSessionSurfaceEventType,
  isSessionSurfaceOp,
} from '../src/surface.ts'

describe('Session surface wire vocabulary', () => {
  it('enumerates exactly the message-producing event types', () => {
    expect([...SESSION_SURFACE_EVENT_TYPES].sort()).toEqual([
      'assistant/message',
      'system/message',
      'tool/result',
      'user/message',
    ])
  })

  it.each([
    ['system/message', true],
    ['user/message', true],
    ['assistant/message', true],
    ['tool/result', true],
    ['turn/start', false],
    ['assistant/attempt', false],
  ])('isSessionSurfaceEventType(%j) → %s', (type, expected) => {
    expect(isSessionSurfaceEventType(type)).toBe(expected)
  })

  it.each([
    ['append marker', 'append', true],
    ['canonical replace', { op: 'replace', startSeq: 0, endSeq: 1 }, true],
    ['legacy replace', { op: 'replace', start: 0, end: 1 }, true],
    ['replace with extra key', { op: 'replace', startSeq: 0, endSeq: 1, extra: true }, false],
    ['replace missing a bound', { op: 'replace', startSeq: 0 }, false],
    ['mixed canonical and legacy bounds', { op: 'replace', startSeq: 0, end: 1 }, false],
    ['non-replace op', { op: 'remove', startSeq: 0, endSeq: 1 }, false],
    ['fractional bound', { op: 'replace', startSeq: 0.5, endSeq: 1 }, false],
    ['negative bound', { op: 'replace', startSeq: -1, endSeq: 1 }, false],
    ['negative zero bound', { op: 'replace', startSeq: -0, endSeq: 1 }, false],
    ['array', ['append'], false],
    ['null', null, false],
    ['unknown string', 'replace', false],
    ['number', 1, false],
  ])('isSessionSurfaceOp accepts/rejects %s', (_label, value, expected) => {
    expect(isSessionSurfaceOp(value)).toBe(expected)
  })
})
