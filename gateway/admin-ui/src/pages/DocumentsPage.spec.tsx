import { cleanup, render, screen } from '@testing-library/react'
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
    listDocumentMetrics: vi.fn(),
    listProjects: vi.fn(),
    listUsers: vi.fn(),
    transferAdminDocumentOwnership: vi.fn(),
  }
})

describe('DocumentsPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
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

  it('renders document owner sources with localized labels', async () => {
    render(<DocumentsPage />)

    expect(await screen.findByText('上传')).toBeTruthy()
    expect(screen.queryByText('upload')).toBeNull()
  })
})
