import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ArchivesPage } from './ArchivesPage.tsx'

vi.mock('../api.ts', () => ({
  applyArchiveAction: vi.fn(),
  exportArchive: vi.fn((id: string) => `/admin/api/archives/${id}/export`),
  getArchive: vi.fn(),
  listArchives: vi.fn(),
}))

const row: api.ConversationArchiveRow = {
  rootSessionId: 'session-1', title: '产品讨论',
  creator: { id: 1, displayName: '管理员' }, project: { id: 2, name: '产品' },
  runtime: { kind: 'project', id: 2 }, workspace: { path: '/project', title: '产品', position: 0 },
  state: 'archived', archivedAt: Date.UTC(2026, 7, 25), restoredAt: null, trashedAt: null, purgeAfter: null,
  syncState: 'synced', childCount: 1, messageCount: 4, updatedAt: Date.UTC(2026, 7, 25),
}

describe('ArchivesPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listArchives).mockResolvedValue([row])
    vi.mocked(api.getArchive).mockResolvedValue({
      record: row,
      descendants: [{ sessionId: 'session-1', parentSessionId: null, title: '产品讨论' }],
      events: [{ sessionId: 'session-1', seq: 0, type: 'user/message', time: row.archivedAt, data: { content: [{ type: 'text', text: '你好' }] } }],
      hasMore: false,
    })
    vi.mocked(api.applyArchiveAction).mockResolvedValue({ action: 'restore', results: [{ rootSessionId: row.rootSessionId, ok: true }] })
  })

  it('lists archived roots, opens the reader, and restores one record', async () => {
    render(<ArchivesPage />)
    expect((await screen.findAllByText('产品讨论')).length).toBeGreaterThan(0)
    const table = screen.getByRole('table')
    expect(within(table).getByText('管理员')).toBeTruthy()
    await userEvent.click(within(table).getByRole('button', { name: '查看 产品讨论' }))
    expect(await screen.findByText('user/message')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '恢复', exact: true }))
    await userEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', { name: '恢复', exact: true }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('restore', ['session-1'])
  })

  it('supports selecting rows for a batch action', async () => {
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 产品讨论' }))
    expect(screen.getByText('已选择 1 条')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '移入回收站', exact: true }))
    await userEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', { name: '移入回收站', exact: true }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('trash', ['session-1'])
  })
})
