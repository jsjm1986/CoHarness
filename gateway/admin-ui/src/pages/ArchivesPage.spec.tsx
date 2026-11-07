import { parseConversationSessionIdentity } from '../../../src/session-identity.ts'
import { parseConversationArchiveId } from '../../../src/archive-identity.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ArchivesPage } from './ArchivesPage.tsx'

vi.mock('../api.ts', () => ({
  applyArchiveAction: vi.fn(),
  exportArchive: vi.fn((id: string) => `/admin/api/archives/records/${id}/export`),
  getArchive: vi.fn(),
  getArchiveStatus: vi.fn(),
  listArchives: vi.fn(),
  previewEmptyDrafts: vi.fn(),
  trashEmptyDrafts: vi.fn(),
}))

const row: api.ConversationArchiveRow = {
  archiveId: parseConversationArchiveId('22000000-0000-4000-8000-000000000022')!,
  rootSessionId: 'session-1', title: '产品讨论', contentPreview: '请整理产品需求和下一步计划',
  creator: { id: 1, displayName: '管理员' }, project: { id: 2, name: '产品' },
  runtime: { kind: 'project', id: 2 }, workspace: { path: '/project', title: '产品', position: 0 },
  state: 'archived', archivedAt: Date.UTC(2026, 7, 25), restoredAt: null, trashedAt: null, purgeAfter: null,
  syncState: 'synced', childCount: 1, messageCount: 4, updatedAt: Date.UTC(2026, 7, 25),
}

const draftRuntimeA = parseConversationSessionIdentity({ rootSessionId: 'fixture', runtimeId: '33000000-0000-4000-8000-000000000033' })!.runtimeId
const draftRuntimeB = parseConversationSessionIdentity({ rootSessionId: 'fixture', runtimeId: '44000000-0000-4000-8000-000000000044' })!.runtimeId
const emptyCandidates: api.EmptyDraftCandidate[] = [
  { rootSessionId: 'draft-project', runtime: { kind: 'project', id: 2, runtimeId: draftRuntimeA }, creator: { id: 1, displayName: '管理员' }, project: { id: 2, name: '产品' }, createdAt: Date.UTC(2026, 7, 24), updatedAt: Date.UTC(2026, 7, 25), eventCount: 0 },
  { rootSessionId: 'draft-personal', runtime: { kind: 'user', id: 1, runtimeId: draftRuntimeB }, creator: null, project: null, createdAt: Date.UTC(2026, 7, 24), updatedAt: Date.UTC(2026, 7, 25), eventCount: 0 },
]

describe('ArchivesPage', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

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
    vi.mocked(api.getArchiveStatus).mockResolvedValue(row)
    vi.mocked(api.applyArchiveAction).mockResolvedValue({ action: 'restore', results: [{ archiveId: row.archiveId, ok: true }] })
    vi.mocked(api.previewEmptyDrafts).mockResolvedValue({ cutoff: Date.now() - 3_600_000, candidates: [] })
    vi.mocked(api.trashEmptyDrafts).mockResolvedValue({ trashed: [] })
  })

  it('opens the empty-draft tool, scans on open, and shows project or personal ownership without exposing paths', async () => {
    vi.mocked(api.previewEmptyDrafts).mockResolvedValue({ cutoff: Date.now() - 3_600_000, candidates: emptyCandidates })
    render(<ArchivesPage />)
    expect(screen.queryByRole('dialog', { name: '清理空白草稿' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '清理空白草稿' }))
    expect((await screen.findAllByText('draft-project')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('产品').length).toBeGreaterThan(0)
    expect(screen.getAllByText('项目 #2').length).toBeGreaterThan(0)
    expect(screen.getAllByText('个人会话').length).toBeGreaterThan(0)
    expect(screen.getAllByText('个人运行时 #1').length).toBeGreaterThan(0)
    expect(screen.queryByText('/project')).toBeNull()
    const emptyTable = screen.getByRole('table', { name: '空白草稿列表' })
    expect(emptyTable).toBeTruthy()
    expect(within(emptyTable).getByRole('columnheader', { name: '归属' })).toBeTruthy()
  })

  it('disables cleanup until selected, submits the preview cutoff, and reports a partial skip', async () => {
    vi.mocked(api.previewEmptyDrafts)
      .mockResolvedValueOnce({ cutoff: 1, candidates: emptyCandidates })
      .mockResolvedValueOnce({ cutoff: 2, candidates: [] })
    vi.mocked(api.trashEmptyDrafts).mockResolvedValue({ trashed: [{ rootSessionId: 'draft-project', runtimeId: draftRuntimeA }] })
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '清理空白草稿' }))
    await screen.findAllByText('draft-project')
    expect(screen.queryByRole('button', { name: /删除选中/ })).toBeNull()
    await userEvent.click(screen.getAllByRole('checkbox', { name: `选择 draft-project (${draftRuntimeA})` })[0]!)
    await userEvent.click(screen.getAllByRole('checkbox', { name: `选择 draft-personal (${draftRuntimeB})` })[0]!)
    await userEvent.click(screen.getByRole('button', { name: '删除选中 2 项' }))
    const confirm = screen.getByRole('dialog', { name: '删除所选空白草稿？' })
    expect(within(confirm).getByText(/选中的 2 个空白草稿/)).toBeTruthy()
    expect(api.trashEmptyDrafts).not.toHaveBeenCalled()
    await userEvent.click(within(confirm).getByRole('button', { name: '删除' }))
    expect(api.trashEmptyDrafts).toHaveBeenCalledWith([{ rootSessionId: 'draft-project', runtimeId: draftRuntimeA }, { rootSessionId: 'draft-personal', runtimeId: draftRuntimeB }], 1)
    await waitFor(() => expect(api.previewEmptyDrafts).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('已移入回收站 1 个草稿；1 个草稿已不符合清理条件。')).toBeTruthy()
    expect(await screen.findByText('当前没有符合条件的空白草稿')).toBeTruthy()
  })

  it('selects only the reviewed Runtime when two drafts share a Host Session id', async () => {
    const original = emptyCandidates[0]!
    const copies = [original, { ...original, runtime: { ...original.runtime, runtimeId: draftRuntimeB } }]
    vi.mocked(api.previewEmptyDrafts).mockResolvedValueOnce({ cutoff: 1, candidates: copies }).mockResolvedValueOnce({ cutoff: 2, candidates: [] })
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '清理空白草稿' }))
    const table = await screen.findByRole('table', { name: '空白草稿列表' })
    const first = within(table).getByRole('checkbox', { name: `选择 draft-project (${draftRuntimeA})` }) as HTMLInputElement
    const second = within(table).getByRole('checkbox', { name: `选择 draft-project (${draftRuntimeB})` }) as HTMLInputElement
    await userEvent.click(second)
    expect(first.checked).toBe(false)
    expect(second.checked).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: '删除选中 1 项' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: '删除所选空白草稿？' })).getByRole('button', { name: '删除' }))
    expect(api.trashEmptyDrafts).toHaveBeenCalledWith([{ rootSessionId: 'draft-project', runtimeId: draftRuntimeB }], 1)
  })

  it('cancels the empty-draft confirmation without posting', async () => {
    vi.mocked(api.previewEmptyDrafts).mockResolvedValue({ cutoff: 1, candidates: emptyCandidates })
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '清理空白草稿' }))
    await screen.findAllByText('draft-project')
    await userEvent.click(screen.getAllByRole('checkbox', { name: `选择 draft-project (${draftRuntimeA})` })[0]!)
    await userEvent.click(screen.getByRole('button', { name: '删除选中 1 项' }))
    const confirm = screen.getByRole('dialog', { name: '删除所选空白草稿？' })
    await userEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(api.trashEmptyDrafts).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除所选空白草稿？' })).toBeNull()
  })

  it('shows scan and cleanup errors', async () => {
    vi.mocked(api.previewEmptyDrafts).mockResolvedValue({ cutoff: 1, candidates: [] })
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '清理空白草稿' }))
    await screen.findByText('当前没有符合条件的空白草稿')
    vi.mocked(api.previewEmptyDrafts).mockRejectedValue(new Error('扫描失败'))
    await userEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('扫描失败')).toBeTruthy()
    vi.mocked(api.previewEmptyDrafts).mockResolvedValue({ cutoff: 1, candidates: emptyCandidates })
    await userEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await screen.findAllByText('draft-project')
    await userEvent.click(screen.getAllByRole('checkbox', { name: `选择 draft-project (${draftRuntimeA})` })[0]!)
    vi.mocked(api.trashEmptyDrafts).mockRejectedValueOnce(new Error('清理失败'))
    await userEvent.click(screen.getByRole('button', { name: '删除选中 1 项' }))
    const confirm = screen.getByRole('dialog', { name: '删除所选空白草稿？' })
    await userEvent.click(within(confirm).getByRole('button', { name: '删除' }))
    expect(await screen.findByText('清理失败')).toBeTruthy()
  })

  it('lists archived roots, opens the reader, and restores one record', async () => {
    render(<ArchivesPage />)
    expect((await screen.findAllByText('产品讨论')).length).toBeGreaterThan(0)
    const table = screen.getByRole('table')
    expect(within(table).getByText('管理员')).toBeTruthy()
    expect(within(table).getByText('请整理产品需求和下一步计划')).toBeTruthy()
    expect(within(table).getByText('session-1')).toBeTruthy()
    const selectAll = within(table).getByRole('checkbox', { name: '全选本页' })
    await userEvent.click(selectAll)
    expect(screen.getByText('已选择 1 条')).toBeTruthy()
    await userEvent.click(within(table).getByRole('button', { name: '查看 产品讨论' }))
    expect(await screen.findByRole('heading', { name: '对话记录' })).toBeTruthy()
    expect(screen.getByText('你好，我可以帮你整理产品讨论。')).toBeTruthy()
    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('文件内容')).toBeTruthy()
    const rawDetails = screen.getByText('查看技术详情').closest('details')
    expect(rawDetails?.open).toBe(false)
    await userEvent.click(screen.getByText('查看技术详情'))
    expect(screen.getByText('seq 0')).toBeTruthy()
    await userEvent.click(within(screen.getByRole('dialog', { name: '产品讨论' })).getByRole('button', { name: /^恢复$/ }))
    await userEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByRole('button', { name: /^恢复$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('restore', [row.archiveId])
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

  it('supports selecting rows for a batch delete that lands in the trash', async () => {
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 产品讨论' }))
    expect(screen.getByText('已选择 1 条')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '删除所选' }))
    const confirm = screen.getByRole('dialog', { name: '删除所选对话？' })
    expect(within(confirm).getByText(/移入回收站/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: /^删除$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('trash', [row.archiveId])
  })

  it('runs the row-level delete without opening the detail dialog', async () => {
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '删除' }))
    const confirm = screen.getByRole('dialog', { name: '删除所选对话？' })
    await userEvent.click(within(confirm).getByRole('button', { name: /^删除$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('trash', [row.archiveId])
    expect(api.getArchive).not.toHaveBeenCalled()
  })

  it('offers permanent deletion only inside the trash tab', async () => {
    vi.mocked(api.listArchives).mockResolvedValue([{ ...row, state: 'trash' }])
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(api.listArchives).toHaveBeenCalledWith(expect.objectContaining({ state: 'trash' }))
    await screen.findAllByText('产品讨论')
    await userEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '彻底删除' }))
    const confirm = screen.getByRole('dialog', { name: '彻底删除所选对话？' })
    expect(within(confirm).getByText(/不能恢复/)).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '彻底删除' }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('purge', [row.archiveId])
  })

  it('settles a stale pending row from its inline action', async () => {
    vi.mocked(api.listArchives).mockResolvedValue([{ ...row, syncState: 'pending', updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1_000 }])
    render(<ArchivesPage />)
    await screen.findAllByText('产品讨论')
    expect(screen.getAllByText('实例长时间未响应').length).toBeGreaterThan(0)
    await userEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '结束等待' }))
    const confirm = screen.getByRole('dialog', { name: '结束等待并强制收尾？' })
    await userEvent.click(within(confirm).getByRole('button', { name: '结束等待' }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('settle', [row.archiveId])
  })

  it('settles a pending archive request from the detail dialog', async () => {
    vi.mocked(api.getArchive).mockResolvedValue({ record: { ...row, syncState: 'pending' }, descendants: [], events: [], hasMore: false })
    vi.mocked(api.getArchiveStatus).mockResolvedValue({ ...row, syncState: 'pending' })
    vi.mocked(api.applyArchiveAction).mockResolvedValue({ action: 'settle', results: [{ archiveId: row.archiveId, ok: true }] })
    render(<ArchivesPage />)
    await userEvent.click(within(await screen.findByRole('table')).getByRole('button', { name: '查看 产品讨论' }))
    expect(await screen.findByText('该操作正在等待实例确认。实例长时间不可达时，可以结束等待、在服务端直接收尾。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '结束等待' }))
    const confirm = screen.getAllByRole('dialog').at(-1)!
    expect(within(confirm).getByText('结束等待并强制收尾？')).toBeTruthy()
    await userEvent.click(within(confirm).getByRole('button', { name: '结束等待' }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('settle', [row.archiveId])
  })

  it('shows empty-draft records returned by the records query with a badge', async () => {
    const draftRow: api.ConversationArchiveRow = {
      ...row, rootSessionId: 'draft-1', title: '未命名对话', state: 'trash', recordKind: 'empty-draft', messageCount: 0, contentPreview: null,
    }
    vi.mocked(api.listArchives).mockResolvedValue([draftRow])
    render(<ArchivesPage />)
    await screen.findAllByText('未命名对话')
    expect(api.listArchives).toHaveBeenCalledWith(expect.objectContaining({ recordKind: 'all' }))
    expect(screen.getAllByText('空白草稿').length).toBeGreaterThan(0)
  })

  it('shows pending confirmation in the open dialog and then the recorded refusal without reloading history', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getArchive).mockResolvedValue({ record: { ...row, syncState: 'pending' }, descendants: [], events: [], hasMore: false })
    vi.mocked(api.getArchiveStatus).mockResolvedValue({ ...row, syncState: 'conflict', lastSyncError: '请先停止仍在运行的终端' })
    await act(async () => { render(<ArchivesPage />) })
    await act(async () => { fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '查看 产品讨论' })) })
    expect(within(screen.getByRole('dialog')).getByText('处理中·等待实例')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(within(screen.getByRole('dialog')).getByText('请先停止仍在运行的终端')).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByText('操作未完成')).toBeTruthy()
    expect(api.getArchive).toHaveBeenCalledOnce()
    expect(api.getArchiveStatus).toHaveBeenCalledWith(row.archiveId)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.getArchiveStatus).toHaveBeenCalledOnce()
  })

  it('preserves selection while a pending archive row refreshes in the background', async () => {
    vi.useFakeTimers()
    vi.mocked(api.listArchives).mockResolvedValue([{ ...row, syncState: 'pending' }])
    await act(async () => { render(<ArchivesPage />) })
    const checkbox = within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 产品讨论' }) as HTMLInputElement
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.listArchives).toHaveBeenCalledOnce()
    expect(api.getArchiveStatus).toHaveBeenCalledWith(row.archiveId)
    expect((within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 产品讨论' }) as HTMLInputElement).checked).toBe(true)
  })

  it('keeps the selected tab when an older request completes late', async () => {
    const first = Promise.withResolvers<api.ConversationArchiveRow[]>()
    vi.mocked(api.listArchives).mockReturnValueOnce(first.promise).mockResolvedValue([{ ...row, title: '回收站记录', state: 'trash' }])
    render(<ArchivesPage />)
    await userEvent.click(screen.getByRole('button', { name: '回收站' }))
    await screen.findAllByText('回收站记录')
    await act(async () => { first.resolve([row]) })
    expect(screen.queryByText('产品讨论')).toBeNull()
    expect(screen.getAllByText('回收站记录').length).toBeGreaterThan(0)
  })

  it('selects and deletes only one of two records sharing a Host Session ID', async () => {
    const other = { ...row, archiveId: parseConversationArchiveId('22000000-0000-4000-8000-000000000023')!, title: '另一台电脑' }
    vi.mocked(api.listArchives).mockResolvedValue([row, other])
    vi.mocked(api.applyArchiveAction).mockResolvedValue({ action: 'trash', results: [{ archiveId: other.archiveId, ok: true }] })
    render(<ArchivesPage />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByText(row.rootSessionId)).toHaveLength(2)
    await userEvent.click(within(table).getByRole('checkbox', { name: '选择 另一台电脑' }))
    expect(screen.getByText('已选择 1 条')).toBeTruthy()
    expect((within(table).getByRole('checkbox', { name: '选择 产品讨论' }) as HTMLInputElement).checked).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '删除所选' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: '删除所选对话？' })).getByRole('button', { name: /^删除$/ }))
    expect(api.applyArchiveAction).toHaveBeenCalledWith('trash', [other.archiveId])
  })

  it('polls both same-named records independently and preserves just the selected archive', async () => {
    vi.useFakeTimers()
    const first = { ...row, syncState: 'pending' as const }
    const other = { ...row, archiveId: parseConversationArchiveId('22000000-0000-4000-8000-000000000023')!, title: '另一台电脑', syncState: 'pending' as const }
    vi.mocked(api.listArchives).mockResolvedValue([first, other])
    vi.mocked(api.getArchiveStatus).mockImplementation(async id => id === row.archiveId ? { ...row, title: '电脑 A 完成' } : { ...other, syncState: 'conflict', lastSyncError: '电脑 B 拒绝' })
    await act(async () => { render(<ArchivesPage />) })
    fireEvent.click(within(screen.getByRole('table')).getByRole('checkbox', { name: '选择 另一台电脑' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const table = screen.getByRole('table')
    expect(api.getArchiveStatus).toHaveBeenCalledWith(first.archiveId)
    expect(api.getArchiveStatus).toHaveBeenCalledWith(other.archiveId)
    expect(within(table).getByText('电脑 A 完成')).toBeTruthy()
    expect(within(table).getByText('另一台电脑')).toBeTruthy()
    expect((within(table).getByRole('checkbox', { name: '选择 另一台电脑' }) as HTMLInputElement).checked).toBe(true)
    expect((within(table).getByRole('checkbox', { name: '选择 电脑 A 完成' }) as HTMLInputElement).checked).toBe(false)
  })

  it('keeps a late detail response out of a different archive with the same Host ID', async () => {
    const first = Promise.withResolvers<api.ConversationArchiveDetail>()
    const other = { ...row, archiveId: parseConversationArchiveId('22000000-0000-4000-8000-000000000023')!, title: '另一台电脑' }
    vi.mocked(api.listArchives).mockResolvedValue([row, other])
    vi.mocked(api.getArchive).mockReturnValueOnce(first.promise).mockResolvedValue({ record: other, descendants: [], events: [], hasMore: false })
    render(<ArchivesPage />)
    const table = await screen.findByRole('table')
    fireEvent.click(within(table).getByRole('button', { name: '查看 产品讨论' }))
    fireEvent.click(within(table).getByRole('button', { name: '查看 另一台电脑' }))
    expect(await screen.findByRole('dialog', { name: '另一台电脑' })).toBeTruthy()
    await act(async () => { first.resolve({ record: row, descendants: [], events: [], hasMore: false }) })
    expect(screen.getByRole('dialog', { name: '另一台电脑' })).toBeTruthy()
    expect(api.getArchive).toHaveBeenNthCalledWith(1, row.archiveId)
    expect(api.getArchive).toHaveBeenNthCalledWith(2, other.archiveId)
    expect(api.exportArchive).toHaveBeenLastCalledWith(other.archiveId)
  })

})
