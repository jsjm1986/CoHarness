import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DocumentsPage } from './DocumentsPage.tsx'

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>()
  return {
    ...actual,
    deleteAdminDocument: vi.fn(),
    getAdminDocument: vi.fn(),
    listAdminDocuments: vi.fn(),
    listAdminDocumentsPage: vi.fn(),
    listDocumentMetrics: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    listUsers: vi.fn(),
    transferAdminDocumentOwnership: vi.fn(),
  }
})

describe('DocumentsPage', () => {
  it('opens the mobile document detail with a named keyboard action', async () => {
    const document = (await api.listAdminDocuments())[0]!
    vi.mocked(api.getAdminDocument).mockResolvedValue({ document, history: [], copies: [] })
    render(<DocumentsPage />)
    const open = await screen.findByRole('button', { name: '查看详情 设计说明.md' })
    open.focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: '设计说明.md' })
    expect(api.getAdminDocument).toHaveBeenCalledExactlyOnceWith(document.catalogId)
  })

  it('does not describe an unread document catalog as empty', async () => {
    vi.mocked(api.listAdminDocuments).mockRejectedValueOnce(new Error('documents-unavailable'))
    render(<DocumentsPage />)
    expect((await screen.findByRole('alert')).textContent).toBe('documents-unavailable')
    expect(screen.queryByText('没有匹配的文档')).toBeNull()
    expect(screen.queryByText('0 条记录')).toBeNull()
  })
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listAdminDocumentsPage).mockImplementation(async () => ({ documents: await api.listAdminDocuments() }))
    vi.mocked(api.listUsers).mockResolvedValue([])
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.listAdminDocuments).mockResolvedValue([{
      catalogId: '11111111-1111-4111-8111-111111111111',
      scope: { kind: 'personal', label: '个人' },
      docId: 'doc-1',
      directoryId: 'dir-1',
      name: '设计说明.md',
      bytes: 1024,
      mediaType: 'text/markdown',
      modifiedAt: Date.parse('2026-08-25T00:00:00Z'),
      owner: null,
      ownerSource: 'upload',
      state: 'active',
      legacy: false,
      lineageRootId: null,
    }])
    vi.mocked(api.listDocumentMetrics).mockResolvedValue({
      total: 1,
      active: 1,
      deleted: 0,
      personal: 1,
      project: 0,
      bytes: 1024,
      operations24h: 0,
      failures24h: 0,
    })
  })

  it.each(['personal', 'project'] as const)('offers ownership transfer only for an active project document (%s)', async (kind) => {
    const row = (await api.listAdminDocuments())[0]!
    const document = { ...row, scope: kind === 'personal' ? row.scope : { kind: 'project' as const, id: 3, label: 'Shared' },
      owner: { id: 1, username: 'owner', displayName: 'Owner' } }
    vi.mocked(api.listAdminDocuments).mockResolvedValue([document])
    vi.mocked(api.getAdminDocument).mockResolvedValue({ document, history: [], copies: [] })
    vi.mocked(api.getProject).mockResolvedValue({ members: [{ userId: 1, username: 'owner', mode: 'rw' }, { userId: 2, username: 'member', mode: 'rw' }] } as Awaited<ReturnType<typeof api.getProject>>)
    vi.mocked(api.listUsers).mockResolvedValue([{ id: 1, displayName: 'Owner' }, { id: 2, displayName: 'Member' }, { id: 3, displayName: 'Outsider' }] as api.AdminUser[])
    render(<DocumentsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    const dialog = within(await screen.findByRole('dialog', { name: '设计说明.md' }))
    if (kind === 'personal') {
      expect(dialog.queryByRole('button', { name: '转移所有权' })).toBeNull()
      expect(dialog.getByText('所有者：Owner（个人文档归属其所在账号）')).toBeTruthy()
      expect(api.transferAdminDocumentOwnership).not.toHaveBeenCalled()
    } else {
      const selector = (await dialog.findByLabelText('所有者')) as HTMLSelectElement
      await waitFor(() => expect([...selector.options].map(option => option.text)).toContain('Member（#2）'))
      expect([...selector.options].map(option => option.text)).not.toContain('Outsider（#3）')
      fireEvent.change(selector, { target: { value: '2' } })
      fireEvent.click(dialog.getByRole('button', { name: '转移所有权' }))
      await waitFor(() => expect(api.transferAdminDocumentOwnership).toHaveBeenCalledWith(document.catalogId, 2))
    }
  })

  it.each(['trash', 'purged', 'missing'] as const)('hides ownership transfer for a project document in %s', async state => {
    const original = (await api.listAdminDocuments())[0]!
    const document: api.AdminDocument = { ...original, scope: { kind: 'project', id: 3, label: 'Shared' }, state }
    vi.mocked(api.listAdminDocuments).mockResolvedValue([document])
    vi.mocked(api.getAdminDocument).mockResolvedValue({ document, history: [], copies: [] })
    render(<DocumentsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    const dialog = within(await screen.findByRole('dialog', { name: '设计说明.md' }))
    expect(dialog.queryByRole('button', { name: '转移所有权' })).toBeNull()
    if (state === 'missing') expect(dialog.getByText('文件缺失')).toBeTruthy()
  })

  it('filters missing records without presenting them as permanently purged', async () => {
    const original = (await api.listAdminDocuments())[0]!
    vi.mocked(api.listAdminDocuments).mockResolvedValue([{ ...original, state: 'missing' }])
    render(<DocumentsPage />)
    await screen.findByRole('button', { name: '查看详情' })
    const state = screen.getByLabelText('状态')
    fireEvent.change(state, { target: { value: 'missing' } })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(api.listAdminDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'missing' })))
    const table = within(screen.getByRole('table'))
    expect(table.getByText('文件缺失')).toBeTruthy()
    expect(table.queryByText('已永久清理')).toBeNull()
  })

  it('renders document owner sources with localized labels', async () => {
    render(<DocumentsPage />)

    expect(await screen.findByText('上传')).toBeTruthy()
    expect(screen.queryByText('upload')).toBeNull()
  })
})
