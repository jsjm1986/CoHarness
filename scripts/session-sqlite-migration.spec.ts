import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId, type SessionEvent, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '../packages/session/session-persistence-sqlite/src/index.ts'
import { SqliteStore } from '../packages/session/session-persistence-sqlite/src/store.ts'
import {
  migrateV18ToV20,
  migrateV20ToV18,
  readV18,
  readV20,
} from './session-sqlite-migration.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-migration-'))
  roots.push(root)
  return { root, path: join(root, 'sessions.db') }
}

function events(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: { text: 'future' },
      sourceEventSeqs: [0],
      surfaceOp: 'append',
      ignorable: true,
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('offline Session SQLite migrations', () => {
  it('round-trips a draft, provenance, ignorable event, and store identity both ways', async () => {
    const { root, path } = await fixture()
    const store = new SqliteStore({ path, journalMode: 'delete', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = { id: SessionId('migration-session'), version: 0, createdAt: 1, cwd: '/work', isSeeded: false, draft: true }
    await store.appendBatch({ meta: header, inheritedEventCount: SessionLogOffset(0) }, events(), false)
    await store.close()

    const v18 = join(root, 'v18.db')
    await migrateV20ToV18({ input: path, output: v18 })
    const v20 = join(root, 'v20-roundtrip.db')
    await migrateV18ToV20({ input: v18, output: v20 })
    const original = readV20(path)
    expect(readV20(v20)).toEqual(original)
    expect(readV18(v18)).toEqual(original)
    const oldDb = new DatabaseSync(v18, { readOnly: true })
    const newDb = new DatabaseSync(v20, { readOnly: true })
    try {
      expect(oldDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: 18 })
      expect(newDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 })
    } finally {
      oldDb.close()
      newDb.close()
    }
  })

  it('migrates an empty store using its singleton identity', async () => {
    const { root, path } = await fixture()
    const empty = new SqliteStore({ path, journalMode: 'delete', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    await empty.open()
    await empty.close()
    const v18 = join(root, 'empty-v18.db')
    await migrateV20ToV18({ input: path, output: v18 })
    const v20 = join(root, 'empty-v20.db')
    await migrateV18ToV20({ input: v18, output: v20 })
    expect(readV20(v20)).toEqual([])
  })

  it('supports verify-only and rejects unsafe output choices without touching input', async () => {
    const { path } = await fixture()
    const store = new SqliteStore({ path, journalMode: 'delete', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    await store.open()
    await store.close()
    await expect(migrateV20ToV18({ input: path, verifyOnly: true })).resolves.toBeUndefined()
    await expect(migrateV20ToV18({ input: path, output: path })).rejects.toThrow(/must differ/)
    await expect(stat(path)).resolves.toBeTruthy()
  })
})
