// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import { DocumentsModal } from '../src/client/DocumentsModal.tsx'
import { zh, type DocumentsKey } from '../src/client/locales.ts'

const { createUserDocClient } = vi.hoisted(() => ({ createUserDocClient: vi.fn() }))
vi.mock('../src/client/documents-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/documents-client.ts')>()
  return {
    ...actual,
    createUserDocClient,
  }
})
import { UserDocServiceUnavailableError } from '../src/client/documents-client.ts'
import type { UserDocLimits } from '../src/client/documents-client.ts'

function t(key: DocumentsKey, params?: Record<string, string>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, v)
    }
  }
  return text
}

const limits = { maxFileBytes: 10 * 1024 * 1024, maxFilesPerMessage: 5, maxMessageBytes: 100, maxInlineTextBytes: 256 }

function doc(ref: Partial<{ docId: string; name: string; bytes: number; mediaType: string }> = {}) {
  return {
    docId: '2026-08-17/report.pdf',
    name: 'report.pdf',
    bytes: 2048,
    mediaType: 'application/pdf',
    ...ref,
  }
}

function makeClient() {
  const documents = [doc()]
  return {
    list: vi.fn(async () => ({ documents, limits })),
    upload: vi.fn(async (
      _file: File,
      _signal?: AbortSignal,
      _onProgress?: (loaded: number, total: number) => void,
    ) => doc()),
    remove: vi.fn(async () => undefined),
    contentUrl: vi.fn((id: string) => `/api/documents/content?id=${encodeURIComponent(id)}`),
  }
}

function renderModal() {
  return render(<DocumentsModal open onClose={() => {}} t={t} />)
}

function namedButton(action: 'preview' | 'delete', name: string) {
  const key = action === 'preview' ? 'action.previewNamed' : 'action.deleteNamed'
  return screen.getByRole('button', { name: t(key, { name }) })
}

describe('DocumentsModal', () => {
  afterEach(() => {
    cleanup()
    createUserDocClient.mockReset()
    vi.unstubAllGlobals()
  })

  it('renders a button with the document label, opens the modal on click, and closes on Escape', () => {
    createUserDocClient.mockReturnValue(makeClient())
    render(<DocumentsButton t={t as never} wide={false} useSessions={undefined as never} useWorkspaces={undefined as never} />)
    expect(screen.getByRole('button', { name: '文档' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '文档' }))
    expect(screen.getByRole('dialog', { name: '文档管理' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '文档管理' })).toBeNull()
  })

  it('shows the document label beside the icon when the sidebar is wide', () => {
    createUserDocClient.mockReturnValue(makeClient())
    render(<DocumentsButton t={t as never} wide={true} useSessions={undefined as never} useWorkspaces={undefined as never} />)
    expect(screen.getByRole('button', { name: '文档' }).textContent).toContain('文档')
  })

  it('loads and groups documents by date with limits and actions', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    expect(await screen.findByText('report.pdf')).toBeTruthy()
    expect(screen.getByText('2026-08-17')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText(t('modal.limits', { size: '10.0 MB', count: '5' }))).toBeTruthy()
    expect(namedButton('preview', 'report.pdf')).toBeTruthy()
    expect(namedButton('delete', 'report.pdf')).toBeTruthy()
    expect(screen.getByRole('link', { name: t('action.downloadNamed', { name: 'report.pdf' }) })).toBeTruthy()
  })

  it('filters documents by name query and shows a no-match empty state', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.change(screen.getByPlaceholderText(t('modal.search')), { target: { value: 'nope' } })
    expect(screen.queryByText('report.pdf')).toBeNull()
    expect(screen.getByText(t('modal.noResults'))).toBeTruthy()
  })

  it('shows the unavailable error when the service route is missing', async () => {
    const client = makeClient()
    client.list.mockRejectedValue(new UserDocServiceUnavailableError())
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.unavailable'))
  })

  it('ignores an aborted load after the modal unmounts', async () => {
    const client = makeClient()
    let rejectList: (error: Error) => void = () => {}
    client.list.mockImplementation(() => new Promise((_, reject) => { rejectList = reject }))
    createUserDocClient.mockReturnValue(client)
    const { unmount } = renderModal()
    unmount()
    rejectList(new Error('boom'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a generic list error for other failures', async () => {
    const client = makeClient()
    client.list.mockRejectedValue(new Error('boom'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })

  it('uploads a selected file, reports progress, and refreshes the list', async () => {
    const client = makeClient()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    client.upload.mockImplementation(async (
      _file: File,
      _signal?: AbortSignal,
      onProgress?: (loaded: number, total: number) => void,
    ) => {
      onProgress?.(10, 0)
      onProgress?.(40, 80)
      await held
      return doc()
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['x'], 'new.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    expect(await screen.findByText(t('modal.upload.progressCount', {
      current: '1', total: '1', percent: '50',
    }))).toBeTruthy()
    release()
    await waitFor(() => { expect(client.upload).toHaveBeenCalledWith(file, undefined, expect.any(Function)) })
  })

  it('reports an upload failure', async () => {
    const client = makeClient()
    client.upload.mockRejectedValue(new Error('up'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'new.txt')], configurable: true })
    fireEvent.change(input)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('modal.upload.error'))
  })

  it('uploads dropped files', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const panel = document.querySelector('[data-documents-panel]') as HTMLElement
    const file = new File(['x'], 'drop.txt', { type: 'text/plain' })
    fireEvent.dragEnter(panel)
    fireEvent.dragOver(panel)
    fireEvent.drop(panel, { dataTransfer: { files: [file] } })
    await waitFor(() => { expect(client.upload).toHaveBeenCalledWith(file, undefined, expect.any(Function)) })
  })

  it('clears the drop overlay when the pointer leaves', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    await screen.findByText('report.pdf')
    const panel = document.querySelector('[data-documents-panel]') as HTMLElement
    fireEvent.dragEnter(panel)
    fireEvent.dragEnter(panel)
    expect(panel.className).toContain('dropActive')
    fireEvent.dragLeave(panel)
    expect(panel.className).toContain('dropActive')
    fireEvent.dragLeave(panel)
    expect(panel.className).not.toContain('dropActive')
  })

  it('ignores an empty file selection', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    fireEvent.change(input)
    fireEvent.drop(document.querySelector('[data-documents-panel]') as HTMLElement, {
      dataTransfer: { files: [] },
    })
    expect(client.upload).not.toHaveBeenCalled()
  })

  it('titles the manager from a project account context and warns on delete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ scope: { kind: 'project', projectName: '支付重构' } }),
    })))
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    expect(await screen.findByRole('dialog', { name: t('modal.title.project', { name: '支付重构' }) })).toBeTruthy()
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    expect(confirm.textContent).toContain(t('delete.confirm.project.extra'))
  })

  it('deletes a document after confirmation and refreshes', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    await waitFor(() => { expect(client.remove).toHaveBeenCalledWith('2026-08-17/report.pdf') })
  })

  it('reports a delete failure', async () => {
    const client = makeClient()
    client.remove.mockRejectedValue(new Error('del'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('delete.error'))
  })

  it('opens a text preview through the modal', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/readme.md', name: 'readme.md', bytes: 10, mediaType: 'text/markdown' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo) => {
      const href = typeof url === 'string' ? url : url.url
      if (href.includes('/account/api/context')) {
        return { ok: false }
      }
      return { text: async () => '# hello' }
    }))
    renderModal()
    await screen.findByText('readme.md')
    fireEvent.click(namedButton('preview', 'readme.md'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'readme.md' }) })).toBeTruthy() })
    expect(await screen.findByText('# hello')).toBeTruthy()
  })

  it('previews an image document', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/photo.png', name: 'photo.png', mediaType: 'image/png' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('photo.png')
    fireEvent.click(namedButton('preview', 'photo.png'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'photo.png' }) })).toBeTruthy() })
    expect(screen.getByRole('img', { name: 'photo.png' })).toBeTruthy()
  })

  it('previews a PDF document', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc()],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('preview', 'report.pdf'))
    const preview = await screen.findByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })
    expect(within(preview).getByTitle('report.pdf')).toBeTruthy()
  })

  it('shows a too-large fallback for text previews exceeding the limit', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/big.txt', name: 'big.txt', bytes: 1024 * 1024, mediaType: 'text/plain' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('big.txt')
    fireEvent.click(namedButton('preview', 'big.txt'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'big.txt' }) })).toBeTruthy() })
    expect(screen.getByText(t('preview.too.large'))).toBeTruthy()
  })

  it('shows an unsupported fallback for unknown media types', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/data.bin', name: 'data.bin', mediaType: 'application/octet-stream' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('data.bin')
    fireEvent.click(namedButton('preview', 'data.bin'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'data.bin' }) })).toBeTruthy() })
    expect(screen.getByText(t('preview.not.supported'))).toBeTruthy()
  })

  it('handles a fetch error during text preview gracefully', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/broken.txt', name: 'broken.txt', bytes: 10, mediaType: 'text/plain' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo) => {
      const href = typeof url === 'string' ? url : url.url
      if (href.includes('/account/api/context')) return { ok: false }
      throw new Error('network')
    }))
    renderModal()
    await screen.findByText('broken.txt')
    fireEvent.click(namedButton('preview', 'broken.txt'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'broken.txt' }) })).toBeTruthy() })
    expect(screen.getByText(t('preview.not.supported'))).toBeTruthy()
  })

  it('groups multiple documents under the same date', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [
        doc({ docId: '2026-08-17/a.pdf', name: 'a.pdf' }),
        doc({ docId: '2026-08-17/b.pdf', name: 'b.pdf' }),
      ],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    expect(await screen.findByText('a.pdf')).toBeTruthy()
    expect(screen.getByText('b.pdf')).toBeTruthy()
    expect(screen.getAllByText('2026-08-17').length).toBe(1)
  })

  it('shows no limits text when limits are absent', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({ documents: [], limits: null as unknown as UserDocLimits }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText(t('modal.empty'))
    expect(screen.queryByText(/单文件上限|Max /)).toBeNull()
  })

  it('handles the delete guard when no target is set', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('modal.cancel') }))
    expect(screen.queryByRole('dialog', { name: t('delete.confirm.title') })).toBeNull()
  })

  it('triggers the file input change, refresh callbacks, and closes preview and delete modals', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('modal.upload') }))
    fireEvent.click(screen.getByRole('button', { name: t('modal.refresh') }))
    await waitFor(() => { expect(screen.getByText('report.pdf')).toBeTruthy() })
    fireEvent.click(namedButton('preview', 'report.pdf'))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeTruthy() })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeNull() })
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getAllByRole('button', { name: t('modal.close') }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: t('delete.confirm.title') })).toBeNull()
  })
})
