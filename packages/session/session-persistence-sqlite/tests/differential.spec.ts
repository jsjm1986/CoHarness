import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { freezeMessage, MessageId, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../session-persistence/tests/legacy-contract.ts'
import { testSql } from './test-sql.ts'

type BackendName = 'jsonl-zstd' | 'sqlite'

interface MountedBackend {
  readonly persistence: SessionPersistence
  dispose(): Promise<void>
}

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function mount(name: BackendName, root: string): Promise<MountedBackend> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  switch (name) {
    case 'jsonl-zstd': {
      const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: join(root, 'jsonl') })
      return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
    }
    case 'sqlite': {
      const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: join(root, 'sessions.db') })
      return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
    }
  }
}

function closedAttemptLog(
  entries: readonly { readonly chunk: StreamChunk; readonly time: number; readonly ignorable?: true }[],
): SessionEvent[] {
  const attempts = entries.map(({ chunk, time, ignorable }, index): SessionEvent => ({
    type: 'assistant/attempt',
    seq: SessionSeq(index + 2),
    time,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', time, chunk }] },
    ...ignorable === true ? { ignorable } : {},
  }))
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    ...attempts,
    { type: 'step/end', seq: SessionSeq(attempts.length + 2), time: 3, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end',
      seq: SessionSeq(attempts.length + 3),
      time: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
}

function streamMatrixLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    // An abandoned attempt retaining every packed stream-record kind.
    { type: 'assistant/attempt', seq: SessionSeq(2), time: 3, data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'text-chunks', time0: 1_000, index: 0, dt: [1, 1, 1], texts: ['text-0', 'text-1', 'text-2', 'text-3'] },
        { type: 'reasoning-chunks', time0: 990, index: 1, dt: [-1, -1], texts: ['reason-0', 'reason-1', 'reason-2'] },
        { type: 'tool-call-chunks', time0: 2_000, index: 2, dt: [1, 1], id: ToolCallId('named-call'), name: 'write', args: ['{0', '{1', '{2'] },
        { type: 'tool-call-chunks', time0: 3_000, index: 3, dt: [1], id: ToolCallId('unnamed-call'), args: ['0}', '1}'] },
        { type: 'chunk', time: 4_000, chunk: { type: 'block-start', index: 4, blockType: 'text' } },
        { type: 'text-chunks', time0: 4_001, index: 4, dt: [1], texts: ['short-a', 'short-b'] },
        { type: 'chunk', time: 4_004, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'failed' } } } },
      ],
    } },
    {
      type: 'assistant/message',
      seq: SessionSeq(3),
      time: 5,
      data: {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId('matrix-assistant'),
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
        stream: [
          { type: 'text-chunks', time0: 4, index: 0, dt: [], texts: ['done'] },
          { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      },
      surfaceOp: 'append',
    },
    // An ignorable foreign event riding the same scalar row path.
    {
      type: 'future/event',
      seq: SessionSeq(4),
      time: 6,
      data: { scalar: true },
      ignorable: true,
    } as unknown as SessionEvent,
    { type: 'step/end', seq: SessionSeq(5), time: 7, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(6), time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function storageTagCollisionLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ...['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].map((type, index) => ({
      type,
      seq: SessionSeq(index + 1),
      time: index + 2,
      data: { future: true },
      ignorable: true as const,
    }) as unknown as SessionEvent),
    { type: 'turn/end', seq: SessionSeq(4), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function batches(events: readonly SessionEvent[], sizes: readonly number[]): SessionEvent[][] {
  const result: SessionEvent[][] = []
  let offset = 0
  let index = 0
  while (offset < events.length) {
    const size = sizes[index % sizes.length] as number
    result.push(events.slice(offset, offset + size))
    offset += size
    index += 1
  }
  return result
}

async function verifyBackend(
  name: BackendName,
  root: string,
  events: readonly SessionEvent[],
  sizes: readonly number[],
): Promise<void> {
  const header = { ...meta('differential', '/work'), delegationDepth: 0 }
  let mounted = await mount(name, root)
  try {
    await mounted.persistence.create(header)
    for (const batch of batches(events, sizes)) {
      await mounted.persistence.append(header.id, batch)
    }
    expect(await mounted.persistence.inspect(header.id), name)
      .toEqual({ meta: header, inheritedEventCount: SessionLogOffset(0), events })
    expect(await mounted.persistence.listHeaders(), name).toEqual([header])
    const revision = (await mounted.persistence.listSnapshots())[0]?.revision
    for (let fromSeq = 0; fromSeq <= events.length + 1; fromSeq += 1) {
      expect((await mounted.persistence.readFrom(header.id, SessionLogOffset(fromSeq))).events, `${name} seq ${fromSeq}`)
        .toEqual(events.slice(fromSeq))
    }
    expect((await mounted.persistence.listSnapshots())[0]?.revision, name).toBe(revision)
  } finally {
    await mounted.dispose()
  }

  mounted = await mount(name, root)
  try {
    expect(await mounted.persistence.inspect(header.id), `${name} reopen`)
      .toEqual({ meta: header, inheritedEventCount: SessionLogOffset(0), events })
  } finally {
    await mounted.dispose()
  }
}

const streamChunkArbitrary: fc.Arbitrary<StreamChunk> = fc.oneof(
  fc.record({ type: fc.constant<'text-delta'>('text-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({ type: fc.constant<'reasoning-delta'>('reasoning-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(ToolCallId('call-1'), ToolCallId('call-2')),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(ToolCallId('call-1'), ToolCallId('call-2')),
    name: fc.constantFrom('read', 'write'),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'block-start'>('block-start'),
    index: fc.nat(2),
    blockType: fc.constant<'text'>('text'),
  }),
  fc.record({ type: fc.constant<'finish'>('finish'), reason: fc.constant({ kind: 'stop' as const }) }),
)

const randomWorkload = fc.record({
  entries: fc.array(fc.record({
    chunk: streamChunkArbitrary,
    time: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
    ),
    ignorable: fc.option(fc.constant<true>(true), { nil: undefined }),
  }), { maxLength: 30 }),
  batchSizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 }),
}).map(({ entries, batchSizes }) => ({
  events: JSON.parse(JSON.stringify(closedAttemptLog(entries.map(({ chunk, time, ignorable }) => ({
    chunk,
    time,
    ...ignorable === true ? { ignorable } : {},
  }))))) as SessionEvent[],
  batchSizes,
}))

describe('SQLite cross-backend differential behavior', () => {
  it('preserves ignorable logical events whose names match physical storage tags', async () => {
    const events = storageTagCollisionLog()
    const directory = await freshDirectory('dsh-sqlite-storage-tag-collision-')
    const root = join(directory, 'sqlite')
    await verifyBackend('sqlite', root, events, [2, 1])
    const db = new DatabaseSync(join(root, 'sessions.db'), { readOnly: true })
    try {
      expect(db.prepare(testSql('count-physical-types')).all()).toEqual([])
      expect(db.prepare(testSql('count-ignorable-events')).get()).toEqual({ count: 3 })
    } finally {
      db.close()
    }
  })

  it('matches JSONL/Zstandard for every stream record kind, ignorable events, partitions, and reopen', async () => {
    const events = streamMatrixLog()
    for (const [partitionIndex, sizes] of [[events.length], [1], [2, 1, 5, 3]].entries()) {
      const directory = await freshDirectory(`dsh-sqlite-matrix-${partitionIndex}-`)
      for (const name of ['jsonl-zstd', 'sqlite'] as const) {
        const root = join(directory, name)
        await verifyBackend(name, root, events, sizes)
        if (name === 'sqlite') {
          const db = new DatabaseSync(join(root, 'sessions.db'), { readOnly: true })
          try {
            // Scalar rows only: no packed physical rows exist at schema 21.
            expect(db.prepare(testSql('count-physical-types')).all()).toEqual([])
            expect(db.prepare(testSql('count-events')).get())
              .toEqual({ count: events.length })
            expect(db.prepare(testSql('count-ignorable-events')).get())
              .toEqual({ count: 1 })
          } finally {
            db.close()
          }
        }
      }
    }
  }, 30_000)

  it('matches JSONL/Zstandard across randomized logical logs and append partitions', async () => {
    await fc.assert(fc.asyncProperty(randomWorkload, async ({ events, batchSizes }) => {
      const directory = await freshDirectory('dsh-sqlite-property-')
      for (const name of ['jsonl-zstd', 'sqlite'] as const) {
        await verifyBackend(name, join(directory, name), events, batchSizes)
      }
    }), { numRuns: 100, seed: 0x5A17E })
    // 100 seeded runs, each churning temp directories and reopening both
    // backends. That costs ~7s on Linux but 35-60s+ on the Windows runners,
    // where temp-file and SQLite I/O is several times slower. The budget is
    // sized for the slower platform so a busy runner cannot turn a passing
    // workload into a timeout; it does not change what the test asserts.
  }, 120_000)

})
