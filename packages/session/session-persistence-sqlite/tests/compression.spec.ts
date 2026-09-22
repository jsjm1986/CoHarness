import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  bindRecord,
  decodeRow,
  scanRows,
  ZSTD_DATA_THRESHOLD_BYTES,
} from '../src/compression.ts'
import type { EventRow } from '../src/schema.ts'

function attempt(seq: number, text = `token-${seq}`): SessionEvent {
  return {
    type: 'assistant/attempt',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', time: 1_000 + seq, chunk: { type: 'text-delta', index: 0, text } },
      ],
    },
  }
}

function row(record: SessionEvent): EventRow {
  const bound = bindRecord(record)
  return {
    seq: bound.seq,
    type: bound.type,
    time: bound.time,
    data: bound.data,
    source_event_seqs: bound.sourceEventSeqs,
    surface_op: bound.surfaceOp,
    is_packed: bound.isPacked,
    ignorable: bound.ignorable,
  }
}

describe('SQLite compression', () => {
  it('round-trips every scalar event one row per logical event', () => {
    const events = Array.from({ length: 100 }, (_, index) => attempt(index))
    expect(scanRows(events.map(row)).preserved).toEqual(events)
  })

  it('rejects a physical row whose packed discriminator is set', () => {
    const packed = { ...row(attempt(0)), is_packed: 1 }
    expect(() => decodeRow(packed)).toThrow(/packed rows retired at schema 21/)
  })

  it.each(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])(
    'preserves an ignorable logical event named %s as a scalar row',
    (type) => {
      const logical = {
        type,
        seq: SessionSeq(0),
        time: 1,
        data: { future: true },
        ignorable: true,
      } as unknown as SessionEvent
      const physical = row(logical)
      expect(physical.is_packed).toBe(0)
      expect(physical.ignorable).toBe(1)
      expect(decodeRow(physical)).toEqual([logical])
    },
  )

  it('compresses large data and delta-encodes complete source-event arrays', () => {
    const sources = Array.from({ length: 2_000 }, (_, index) => index + 10)
    const event = {
      type: 'assistant/message',
      seq: sources.at(-1)! + 1,
      time: 1,
      data: { text: 'x'.repeat(ZSTD_DATA_THRESHOLD_BYTES * 2) },
      sourceEventSeqs: sources,
      surfaceOp: 'append',
    } as unknown as SessionEvent
    const bound = bindRecord(event)
    expect(bound.data).toBeInstanceOf(Uint8Array)
    expect(bound.sourceEventSeqs).toBeInstanceOf(Uint8Array)
    expect(bound.sourceEventSeqs?.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(sources)))
    expect(decodeRow(row(event))).toEqual([event])

    const small = bindRecord({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } })
    expect(typeof small.data).toBe('string')
  })

  it('round-trips empty, descending, and maximum-safe source-event deltas', () => {
    for (const sources of [
      [],
      [Number.MAX_SAFE_INTEGER - 1, 0, Number.MAX_SAFE_INTEGER - 2],
    ]) {
      const event = {
        type: 'assistant/message',
        seq: Number.MAX_SAFE_INTEGER,
        time: 1,
        data: {},
        sourceEventSeqs: sources,
        surfaceOp: 'append',
      } as unknown as SessionEvent
      expect(decodeRow(row(event))).toEqual([event])
    }
  })

  it('run-encodes ascending source events with gaps and round-trips every run', () => {
    const sources = [
      ...Array.from({ length: 400 }, (_, index) => index + 10),
      ...Array.from({ length: 300 }, (_, index) => index + 600),
    ]
    const event = {
      type: 'assistant/message',
      seq: 1_000,
      time: 1,
      data: {},
      sourceEventSeqs: sources,
      surfaceOp: 'append',
    } as unknown as SessionEvent
    const bound = bindRecord(event)
    // Two runs: five varints, far below one delta per source.
    expect(bound.sourceEventSeqs?.byteLength).toBeLessThan(16)
    expect(decodeRow(row(event))).toEqual([event])
  })

  it.each([
    ['a zero-length run', [1, 5, 0], /invalid ascending range/],
    ['a run starting inside the previous one', [1, 0, 3, 1, 2], /invalid ascending range/],
    ['a run longer than the event sequence allows', [1, 0, 100], /run exceeds its event sequence/],
  ])('rejects %s in a stored source-event run stream', (_label, bytes, pattern) => {
    const base = row({
      type: 'assistant/message', seq: 10, time: 1, data: {}, sourceEventSeqs: [0], surfaceOp: 'append',
    } as unknown as SessionEvent)
    expect(() => decodeRow({ ...base, source_event_seqs: Uint8Array.from(bytes) })).toThrow(pattern)
  })

  it.each([-1, 0.5])('rejects invalid source-event sequence %s before encoding', (sourceSeq) => {
    const event = {
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: 1,
      data: {},
      sourceEventSeqs: [sourceSeq],
      surfaceOp: 'append',
    } as unknown as SessionEvent
    expect(() => bindRecord(event)).toThrow(/non-negative safe integers/)
  })

  it('rejects malformed compressed and delta-encoded values', () => {
    const scalar = row({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } })
    expect(() => decodeRow({ ...scalar, data: Buffer.from('not zstd') })).toThrow()
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.from([0x80]) }))
      .toThrow(/truncated varint/)
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.from([0x80, 0x00]) }))
      .toThrow(/non-canonical varint/)
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.from([0x00, 0x01]) }))
      .toThrow(/decoded seq is out of range/)
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x02,
    ]) })).toThrow(/decoded seq is out of range/)
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.from([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10,
    ]) })).toThrow(/varint is out of range/)
    expect(() => decodeRow({ ...scalar, source_event_seqs: Buffer.alloc(9, 0x80) }))
      .toThrow(/varint is out of range/)
  })

  it('distinguishes removable and committed physical corruption', () => {
    const start = row({ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } })
    const skipped = row({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } })
    expect(scanRows([start, skipped])).toEqual({ preserved: [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ], tornFrom: 2 })

    const end = row({
      type: 'turn/end',
      seq: SessionSeq(3),
      time: 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(() => scanRows([start, skipped, end])).toThrow(/invalid committed physical row at seq 2/)

    const malformed = { ...row(attempt(0)), data: '{not json' }
    const committedEnd = row({
      type: 'turn/end',
      seq: SessionSeq(1),
      time: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(() => scanRows([malformed, committedEnd]))
      .toThrow(/invalid committed physical row at seq 0/)
  })

  it('treats a malformed scalar tail as one removable physical row', () => {
    const malformed: EventRow = {
      seq: SessionSeq(0),
      type: 'assistant/attempt',
      time: 1,
      data: '{not json',
      source_event_seqs: null,
      surface_op: null,
      is_packed: 0,
      ignorable: 0,
    }
    expect(scanRows([malformed])).toEqual({ preserved: [], tornFrom: 0 })
  })
})
