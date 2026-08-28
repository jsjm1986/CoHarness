import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'

const headerRow = {
  id: 'session-1',
  organization_id: 'organization-1',
  creator_user_id: 'user-1',
  project_id: null,
  parent_session_id: null,
  root_session_id: 'session-1',
  visibility: 'personal',
  session_format_version: 0,
  created_at_ms: '1000',
  cwd: null,
  seed_length: null,
  origin: null,
  delegation_depth: null,
  agent_preset: null,
  draft: false,
  title: null,
  version: '7',
  next_seq: '1',
  has_visible_content: true,
  visible_content_seq: '0',
  last_prompt_at_ms: '1000',
}

describe('ConversationRepository load', () => {
  it('reads the header revision and events in one repeatable-read transaction', async () => {
    const calls: string[] = []
    const event = { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } }
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.startsWith('SELECT id,organization_id')) return { rows: [headerRow], rowCount: 1 }
        if (text.startsWith('SELECT event FROM')) return { rows: [{ event }], rowCount: 1 }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(new ConversationRepository(pool).load('session-1')).resolves.toMatchObject({
      header: { id: 'session-1', createdAt: 1000 },
      events: [event],
      revision: '7:1',
    })
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringMatching(/^SELECT id,organization_id/),
      'SELECT event FROM harness.conversation_events WHERE session_id=$1 AND seq >= $2 ORDER BY seq',
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('commits an empty repeatable-read snapshot without querying events', async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [], rowCount: text === 'BEGIN' || text === 'COMMIT' ? null : 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(new ConversationRepository(pool).load('missing')).resolves.toBeUndefined()
    expect(calls.filter(text => text.startsWith('SELECT event FROM'))).toHaveLength(0)
    expect(calls.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
})
