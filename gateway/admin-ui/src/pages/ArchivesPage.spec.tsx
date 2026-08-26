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
  previewEmptyDrafts: vi.fn(),
  trashEmptyDrafts: vi.fn(),
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
      events: [
        { sessionId: 'session-1', seq: 0, type: 'user/message', time: row.archivedAt, data: { content: [{ type: 'text', text: '你好' }] } },
        { sessionId: 'session-1', seq: 1, type: 'assistant/message', time: row.archivedAt + 1, data: { message: { content: [{ type: 'text', text: '你好，我可以帮你整理产品讨论。' }] } } },
        { sessionId: 'session-1', seq: 2, type: 'tool/call', time: row.archivedAt + 2, data: { callId: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' } },
        { sessionId: 'session-1', seq: 3, type: 'tool/result', time: row.archivedAt + 3, data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容' }] }] } } },
      ],
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
    expect(await screen.findByRole('heading', { name: '对话记录' })).toBeTruthy()
    expect(screen.getByText('你好，我可以帮你整理产品讨论。')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('文件内容')).toBeTruthy()
    const rawDetails = screen.getByText('查看技术详情').closest('details')
    expect(rawDetails?.open).toBe(false)
    await userEvent.click(screen.getByText('查看技术详情'))
    expect(screen.getByText('seq 0')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^恢复$/ }))
    await userEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', { name: /^恢复$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('restore', ['session-1'])
  })

  it('summarizes configuration-only archives and keeps raw events collapsed', async () => {
    vi.mocked(api.getArchive).mockResolvedValueOnce({
      record: row,
      descendants: [{ sessionId: 'session-1', parentSessionId: null, title: '产品讨论' }],
      events: [
        { sessionId: 'session-1', seq: 0, type: 'permission/preset', time: row.archivedAt, data: { preset: 'workspace-write' } },
        { sessionId: 'session-1', seq: 1, type: 'sandbox/mode', time: row.archivedAt + 1, data: { mode: 'read-only' } },
        { sessionId: 'session-1', seq: 2, type: 'approval/policy', time: row.archivedAt + 2, data: { policy: 'ask' } },
      ],
      hasMore: false,
    })
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '查看 产品讨论' }))
    expect((await screen.findAllByText('权限设置')).length).toBeGreaterThan(0)
    expect(screen.getByText('预设：工作区可写')).toBeTruthy()
    expect(screen.getByText('只读')).toBeTruthy()
    expect(screen.getByText('需要确认')).toBeTruthy()
    expect(screen.getByText('未发现用户或助手消息，以上内容是会话运行状态摘要。')).toBeTruthy()
    expect(screen.queryByText('user/message')).toBeNull()
    expect(screen.getByText('查看技术详情').closest('details')?.open).toBe(false)
  })

  it('supports selecting rows for a batch action', async () => {
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 产品讨论' }))
    expect(screen.getByText('已选择 1 条')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^移入回收站$/ }))
    await userEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', { name: /^移入回收站$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('trash', ['session-1'])
  })
})
