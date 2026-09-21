import { describe, expect, it } from 'vitest'
import { decodeChunkRow, decodeStorageRecord, isChunkRow } from '../src/index.ts'
import type { SessionEvent } from '../src/index.ts'

const textRow = {
  type: 'text-chunks', seq0: 4, time0: 104,
  data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['he', 'l', 'lo'] },
}

const toolRow = {
  type: 'tool-call-chunks', seq0: 7, time0: 20,
  data: { turn: 1, step: 1, index: 0, id: 'call-1', name: 'tool', dt: [5], args: ['{', '}'] },
}

describe('chunk row decoding', () => {
  it('recognizes only the three packed row tags on records', () => {
    expect(isChunkRow('text-chunks')).toBe(false)
    expect(isChunkRow(null)).toBe(false)
    expect(isChunkRow({ type: 'assistant/chunk' })).toBe(false)
    expect(isChunkRow(textRow)).toBe(true)
    expect(isChunkRow({ ...textRow, type: 'reasoning-chunks' })).toBe(true)
    expect(isChunkRow(toolRow)).toBe(true)
  })

  it('expands text, reasoning, and tool-call rows into ordered v3 events', () => {
    const text = decodeChunkRow(textRow)
    expect(text.map(item => item.seq)).toEqual([4, 5, 6])
    expect(text.map(item => item.time)).toEqual([104, 105, 106])
    expect(text[0]!.data).toMatchObject({ turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } })

    const reasoning = decodeChunkRow({ ...textRow, type: 'reasoning-chunks' })
    expect((reasoning[0]!.data as { chunk: { type: string } }).chunk.type).toBe('reasoning-delta')

    const tool = decodeChunkRow(toolRow)
    expect(tool.map(item => item.seq)).toEqual([7, 8])
    expect(tool[0]!.data).toMatchObject({
      chunk: { type: 'tool-call-delta', id: 'call-1', name: 'tool', argumentsDelta: '{' },
    })

    const anonymous = decodeChunkRow({
      ...toolRow,
      data: { turn: 1, step: 1, index: 0, id: 'call-1', dt: [5], args: ['{', '}'] },
    })
    expect((anonymous[0]!.data as { chunk: Record<string, unknown> }).chunk).not.toHaveProperty('name')
  })

  it('refuses a value that is not a packed chunk row', () => {
    expect(() => decodeChunkRow({ type: 'assistant/chunk' })).toThrow('value is not a packed chunk row')
    expect(() => decodeChunkRow(7)).toThrow('value is not a packed chunk row')
  })

  it.each([
    [{ type: 'text-chunks' }, 'envelope must be exactly'],
    [{ ...textRow, extra: 1 }, 'envelope must be exactly'],
    [{ ...textRow, seq0: -1 }, 'seq0 must be a non-negative safe integer'],
    [{ ...textRow, seq0: 1.5 }, 'seq0 must be a non-negative safe integer'],
    [{ ...textRow, seq0: -0 }, 'seq0 must be a non-negative safe integer'],
    [{ ...textRow, time0: 1.5 }, 'time0 must be a safe integer'],
    [{ ...textRow, data: 'x' }, 'data must be an object'],
  ] as const)('rejects a malformed envelope %#', (row, why) => {
    expect(() => decodeChunkRow(row)).toThrow(`malformed text-chunks storage row: ${why}`)
  })

  it.each([
    [{ turn: 'x', step: 1, index: 0, dt: [1], texts: ['a', 'b'] }, 'turn/step/index must be numbers'],
    [{ turn: 1, step: 1, index: 0, dt: [1], texts: [] }, 'texts must be a non-empty string array'],
    [{ turn: 1, step: 1, index: 0, dt: [1], texts: ['a', 7] }, 'texts must be a non-empty string array'],
    [{ turn: 1, step: 1, index: 0, dt: 'x', texts: ['a', 'b'] }, 'dt must be an array of safe integers'],
    [{ turn: 1, step: 1, index: 0, dt: [1.5], texts: ['a', 'b'] }, 'dt must be an array of safe integers'],
    [{ turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] }, 'dt length 0 does not match 2 members'],
    [{ turn: 1, step: 1, index: 0, dt: [1] }, 'data must be exactly'],
  ] as const)('rejects malformed run data %#', (data, why) => {
    expect(() => decodeChunkRow({ ...textRow, data })).toThrow(`malformed text-chunks storage row: ${why}`)
  })

  it.each([
    [{ turn: 1, step: 1, index: 0, dt: [5], args: ['{', '}'] }, 'data must be exactly {turn, step, index, id, name?, dt, args}'],
    [{ turn: 1, step: 1, index: 0, id: 7, name: 'tool', dt: [5], args: ['{', '}'] }, 'id (and name when present) must be strings'],
    [{ turn: 1, step: 1, index: 0, id: 'call-1', name: 7, dt: [5], args: ['{', '}'] }, 'id (and name when present) must be strings'],
    [{ turn: 1, step: 1, index: 0, id: 'call-1', name: 'tool', dt: [5], args: ['{', 7] }, 'args must be a non-empty string array'],
  ] as const)('rejects malformed tool-call data %#', (data, why) => {
    expect(() => decodeChunkRow({ ...toolRow, data })).toThrow(`malformed tool-call-chunks storage row: ${why}`)
  })

  it('rejects reconstructions that leave the safe-integer range', () => {
    expect(() => decodeChunkRow({
      ...textRow,
      seq0: Number.MAX_SAFE_INTEGER,
      data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] },
    })).toThrow('member seqs must stay safe integers')
    expect(() => decodeChunkRow({
      ...textRow,
      time0: Number.MAX_SAFE_INTEGER,
      data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['a', 'b'] },
    })).toThrow('member times must stay safe integers')
  })
})

describe('storage record decoding', () => {
  it('expands chunk rows and passes other rows through with seq admission', () => {
    expect(decodeStorageRecord(textRow)).toHaveLength(3)

    const event = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as SessionEvent
    expect(decodeStorageRecord(event)).toEqual([event])
    expect(decodeStorageRecord('x')).toEqual(['x'])
    expect(decodeStorageRecord({ type: 'custom' })).toEqual([{ type: 'custom' }])
    expect(() => decodeStorageRecord({ type: 'custom', seq: -1 })).toThrow()
  })
})
