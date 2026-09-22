/**
 * Upstream handle contract against the coordinator-adapted SQLite backend:
 * `create`/`open`/`stat`/`list`/`flush` plus `SessionHandle` reads, writes,
 * ownership, lazy materialization, and reopen visibility.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { testSql } from './test-sql.ts'
import { runPersistenceContract } from '../../session-persistence/tests/contract.ts'

runPersistenceContract('sqlite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-contract-'))
  const path = join(directory, 'sessions.db')
  const instance = async (): Promise<{ persistence: SessionPersistence; dispose: () => Promise<void> }> => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    return {
      persistence: ctx.sessionPersistence,
      dispose: async () => { await fiber.dispose() },
    }
  }
  const primary = await instance()
  return {
    persistence: primary.persistence,
    dispose: async () => {
      await primary.dispose()
      await rm(directory, { recursive: true, force: true })
    },
    reopen: instance,
    // An undecodable event row past the committed tail: the recovery path
    // reads it as a torn tail and drops it before the next append.
    corruptTail: async (id) => {
      const db = new DatabaseSync(path)
      db.prepare(testSql('insert-corrupt-event'))
        .run(id, 99, 'assistant/attempt', 99, '{not valid json', null)
      db.close()
    },
  }
})
