import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'

const context = {
  organizationId: 'org-1', organizationSlug: 'org', nodeId: 'node-1', nodeName: 'node',
  pool: undefined as unknown as Pool,
}

describe('PostgresCollaborationService conversation titles', () => {
  it('derives the list title from the first human-authored search row', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const service = new PostgresCollaborationService({ ...context, pool: { query } as unknown as Pool })
    await service.listAccountConversations(2)
    const text = (query.mock.calls[0] as unknown as [string])[0]
    expect(text).toContain('COALESCE(harness.human_session_title(r.title)')
    expect(text).toContain(`search.role='user'`)
    expect(text).toContain('harness.human_session_title(search.content) IS NOT NULL')
    expect(text).toContain('ORDER BY search.occurred_at,search.event_seq LIMIT 1')
    expect(text).not.toContain('ORDER BY search.occurred_at DESC')
  })
})
