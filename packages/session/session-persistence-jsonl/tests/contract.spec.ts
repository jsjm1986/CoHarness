/**
 * Upstream handle contract against the coordinator-adapted JSONL backend:
 * `create`/`open`/`stat`/`list`/`flush` plus `SessionHandle` reads, writes,
 * ownership, lazy materialization, and torn-tail repair.
 */

import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../src/format.ts'
import { runPersistenceContract } from '../../session-persistence/tests/contract.ts'

runPersistenceContract('jsonl-none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-contract-'))
  const instance = async (): Promise<{ persistence: SessionPersistence; dispose: () => Promise<void> }> => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
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
      await rm(dir, { recursive: true, force: true })
    },
    reopen: instance,
    // A half-written record with no trailing newline: the scanner treats it
    // as an uncommitted crash fragment, so the write path repairs a torn tail.
    corruptTail: async (id, cwd) => {
      await appendFile(logPath(dir, cwd, id, 'none'), '{"type":"turn/start","seq":8,"ti')
    },
  }
})
