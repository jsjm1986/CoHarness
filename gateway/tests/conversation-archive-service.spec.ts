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
      .mockResolvedValueOnce({ rows: [
        { session_id: 'session-1', seq: '0', event_type: 'user/message', occurred_at_ms: '1000', event: { content: 'hello' } },
        { session_id: 'session-1', seq: '1', event_type: 'assistant/message', occurred_at_ms: '1001', event: { content: 'world' } },
      ], rowCount: 2 })
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    await expect(service.detail('session-1', 0, 1)).resolves.toMatchObject({
      record: { rootSessionId: 'session-1' }, descendants: [{ sessionId: 'session-1' }],
      events: [{ seq: 0, type: 'user/message', data: { content: 'hello' } }], hasMore: true,
    })
  })

  it('rejects an archive tree that exceeds the descendant budget', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [archiveRow], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 10_001 }, (_, index) => ({
          id: `session-${String(index)}`, parent_session_id: null, title: null,
        })),
        rowCount: 10_001,
      })
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    await expect(service.detail('session-1')).rejects.toMatchObject({
      code: 'ARCHIVE_TOO_LARGE', status: 413,
    })
    expect(query).toHaveBeenCalledTimes(2)
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

  it('keeps the indexed detail when a runtime returns an oversized page', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [archiveRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const service = new ConversationArchiveService({ ...context, pool: { query } as unknown as Pool })
    service.setRuntimeReader(async () => ({
      title: 'untrusted',
      descendants: [],
      events: Array.from({ length: 201 }, (_, seq) => ({
        sessionId: 'session-1', seq, type: 'user/message', time: seq, data: {},
      })),
      hasMore: true,
    }))
    await expect(service.detail('session-1')).resolves.toMatchObject({
      record: { title: 'Archive', syncState: 'unavailable' },
      events: [],
    })
  })

  it('collapses archived child sessions into one root index row', async () => {
    const calls: Array<[string, unknown[] | undefined]> = []
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push([text, values])
        if (text.includes('SELECT id FROM harness.projects')) return { rows: [{ id: 'project-internal' }], rowCount: 1 }
        if (text.includes('SELECT s.id')) return {
          rows: [{ id: 'child', root_session_id: 'root' }, { id: 'root', root_session_id: 'root' }], rowCount: 2,
        }
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
      sessions: [{
        sessionId: 'child', rootSessionId: 'root', header: { parentSession: 'middle' },
        messageCount: 1, rootMessageCount: 7,
      }],
      search: [{ sessionId: 'child', seq: 0, role: 'user', content: 'hello', occurredAt: 10 }],
    }, { kind: 'project', id: 4 })
    const ownership = calls.find(([text]) => text.includes('SELECT s.id'))
    expect(ownership?.[1]?.[1]).toEqual(['child', 'root'])
    const insert = calls.find(([text]) => text.includes('INSERT INTO harness.conversation_archive_records'))
    expect(insert?.[1]).toEqual(expect.arrayContaining(['root', 7]))
    const searchInsert = calls.find(([text]) => text.includes('INSERT INTO harness.conversation_archive_search'))
    expect(searchInsert?.[0]).toContain('FROM unnest(')
    expect(searchInsert?.[1]).toEqual(expect.arrayContaining([['child'], [0], ['user'], ['hello'], [10]]))
    const pending = calls.find(([text]) => text.includes('SELECT c.id::text'))
    expect(pending?.[0]).toContain('LIMIT $4')
    expect(pending?.[1]?.at(-1)).toBe(1_000)
  })

  it('rejects unsafe runtime revisions and refuses to wrap a stored revision', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('SELECT id FROM harness.users')) return { rows: [{ id: 'user-internal' }], rowCount: 1 }
        if (text.includes('SELECT state,runtime_kind')) {
          return {
            rows: [{
              state: 'archived', runtime_kind: 'user', runtime_public_id: '2',
              sync_revision: String(Number.MAX_SAFE_INTEGER),
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: client.query } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await expect(service.syncSnapshot({
      rootSessionId: 'session-1', runtime: { kind: 'user', id: 2 },
      syncRevision: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow(/invalid runtime archive revision/)
    expect(pool.connect).not.toHaveBeenCalled()

    await expect(service.setState('session-1', 'trash', 2)).rejects.toThrow(/revision.*exhausted/)
    expect(client.query.mock.calls.some(([text]) => String(text).startsWith('UPDATE harness.conversation_archive_records')))
      .toBe(false)
  })

  it('rejects an explicit lineage root that disagrees with PostgreSQL', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('SELECT id FROM harness.projects')) return { rows: [{ id: 'project-internal' }], rowCount: 1 }
      if (text.includes('SELECT s.id')) return {
        rows: [{ id: 'child', root_session_id: 'actual-root' }, { id: 'root', root_session_id: 'actual-root' }],
        rowCount: 2,
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = { query, connect: vi.fn() } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await expect(service.syncRuntimeSnapshot({
      runtime: { kind: 'project', id: 4 }, revision: 1, archivedSessionIds: ['child'],
      sessions: [{ sessionId: 'child', rootSessionId: 'root', header: { parentSession: 'root' } }],
    }, { kind: 'project', id: 4 })).rejects.toThrow(/incorrect lineage root/)
    expect(pool.connect).not.toHaveBeenCalled()
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

  it('does not unlink a path that another content record still references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archive-shared-'))
    temporaryRoots.push(root)
    const file = join(root, 'shared.bin')
    await writeFile(file, 'content')
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('SELECT state,sync_revision')) return { rows: [{ state: 'archived', sync_revision: '0' }], rowCount: 1 }
        if (text.includes('SELECT DISTINCT f.local_path')) return { rows: [{ local_path: file }], rowCount: 1 }
        if (text.includes('SELECT local_path')) return { rows: [{ local_path: file }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: client.query } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await expect(service.purge('session-1')).resolves.toBe(true)
    await expect(stat(file)).resolves.toBeDefined()
  })

  it('keeps a failed cleanup task leased for retry instead of deleting an unsafe directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archive-retry-'))
    temporaryRoots.push(root)
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes('SELECT id::text,root_session_id,local_path,attempts')) {
          return { rows: [{ id: '00000000-0000-4000-8000-000000000001', root_session_id: 'session-1', local_path: root, attempts: 0 }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client), query: client.query } as unknown as Pool
    const service = new ConversationArchiveService({ ...context, pool })
    await expect(service.cleanupDue()).resolves.toBe(0)
    expect(client.query.mock.calls.some(([text]) => String(text).includes('SET lease_until=NULL,last_error'))).toBe(true)
    await expect(stat(root)).resolves.toBeDefined()
  })
})
