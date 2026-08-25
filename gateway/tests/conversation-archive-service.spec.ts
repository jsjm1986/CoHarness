import { mkdtemp, mkdir, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationArchiveService } from '../src/postgres/conversation-archive-service.ts'

const context = {
  organizationId: 'org-1', organizationSlug: 'org', nodeId: 'node-1', nodeName: 'node',
  pool: undefined as unknown as Pool,
}

const archiveRow = {
  root_session_id: 'session-1', title: 'Archive', creator_public_id: '2', creator_display_name: 'Worker',
  project_public_id: null, project_name: null, runtime_kind: 'user', runtime_public_id: '2',
  workspace_path: '/tmp/workspace', workspace_title: 'Workspace', workspace_position: 0,
  state: 'archived', archived_at_ms: '1000', restored_at_ms: null, trashed_at_ms: null, purge_after_ms: null,
  sync_state: 'synced', child_count: '1', message_count: '4', updated_at_ms: '2000',
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ConversationArchiveService', () => {
  it('projects bounded administrator list rows', async () => {
    const query = vi.fn(async () => ({ rows: [archiveRow], rowCount: 1 }))
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    await expect(service.adminList({ query: 'Archive', limit: 10 })).resolves.toEqual([expect.objectContaining({
      rootSessionId: 'session-1', title: 'Archive', creator: { id: 2, displayName: 'Worker' },
      state: 'archived', childCount: 1, messageCount: 4,
    })])
    expect(query).toHaveBeenCalledTimes(1)
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(['org-1', '%Archive%', 10, 0])
  })

  it('returns a root detail with descendants and a bounded event page', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [archiveRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'session-1', parent_session_id: null, title: 'Archive' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ session_id: 'session-1', seq: '0', event_type: 'user/message', occurred_at_ms: '1000', event: { content: 'hello' } }], rowCount: 1 })
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    await expect(service.detail('session-1', 0, 10)).resolves.toMatchObject({
      record: { rootSessionId: 'session-1' }, descendants: [{ sessionId: 'session-1' }],
      events: [{ seq: 0, type: 'user/message', data: { content: 'hello' } }], hasMore: false,
    })
  })

  it('hydrates a personal detail from the owning runtime on demand', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [archiveRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    const reader = vi.fn(async () => ({
      title: '来自运行时',
      descendants: [{ sessionId: 'session-1', parentSessionId: null, title: '来自运行时' }],
      events: [{ sessionId: 'session-1', seq: 0, type: 'user/message', time: 1000, data: { content: 'runtime' } }],
      hasMore: false,
    }))
    service.setRuntimeReader(reader)
    await expect(service.detail('session-1')).resolves.toMatchObject({
      record: { title: '来自运行时' },
      events: [{ data: { content: 'runtime' } }],
    })
    expect(reader).toHaveBeenCalledWith({ kind: 'user', id: 2 }, 'session-1', 0, 200)
  })

  it('collapses archived child sessions into one root index row', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push([text, values])
        if (text.includes('SELECT id FROM harness.projects')) return { rows: [{ id: 'project-internal' }], rowCount: 1 }
        if (text.includes('SELECT state,sync_revision')) return { rows: [], rowCount: 0 }
        if (text.includes('SELECT c.id::text')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = {
      connect: vi.fn(async () => client),
      query: client.query,
    } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await service.syncRuntimeSnapshot({
      runtime: { kind: 'project', id: 4 }, revision: 3, archivedSessionIds: ['child'],
      sessions: [{ sessionId: 'child', rootSessionId: 'root', header: { parentSession: 'root' }, messageCount: 1 }],
      search: [{ sessionId: 'child', seq: 0, role: 'user', content: 'hello', occurredAt: 10 }],
    })
    const insert = calls.find(([text]) => text.includes('INSERT INTO harness.conversation_archive_records'))
    expect(insert?.[1]).toEqual(expect.arrayContaining(['root']))
  })

  it('does not recursively remove a directory recorded as a content path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archive-purge-'))
    temporaryRoots.push(root)
    const file = join(root, 'owned.bin')
    const directory = join(root, 'not-a-file')
    await writeFile(file, 'content')
    await mkdir(directory)
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('SELECT state,sync_revision')) return { rows: [{ state: 'archived', sync_revision: '0' }], rowCount: 1 }
        if (text.includes('SELECT DISTINCT f.local_path')) return { rows: [{ local_path: file }, { local_path: directory }], rowCount: 2 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: client.query } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await expect(service.purge('session-1')).resolves.toBe(true)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(directory)).resolves.toBeDefined()
  })
})
