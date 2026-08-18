// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import { DocumentsModal } from '../src/client/DocumentsModal.tsx'
import { zh, type DocumentsKey } from '../src/client/locales.ts'

const createUserDocClient = vi.fn()
vi.mock('../src/client/documents-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/documents-client.ts')>()
  return {
    createUserDocClient: (...args: unknown[]) => createUserDocClient(...args),
    UserDocServiceUnavailableError: actual.UserDocServiceUnavailableError,
    UserDocHttpError: actual.UserDocHttpError,
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
    upload: vi.fn(async () => doc()),
    remove: vi.fn(async () => undefined),
    contentUrl: vi.fn((id: string) => `/api/documents/content?id=${encodeURIComponent(id)}`),
  }
}

function renderModal() {
  return render(<DocumentsModal open onClose={() => {}} t={t} />)
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

  it('loads and groups documents by date with limits and actions', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    expect(await screen.findByText('report.pdf')).toBeTruthy()
    expect(screen.getByText('2026-08-17')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText(t('modal.limits', { size: '10.0 MB', count: '5' }))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('action.preview') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('action.delete') })).toBeTruthy()
  })

  it('filters documents by name query', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.change(screen.getByPlaceholderText(t('modal.search')), { target: { value: 'nope' } })
    expect(screen.queryByText('report.pdf')).toBeNull()
  })

  it('shows the unavailable error when the service route is missing', async () => {
    const client = makeClient()
    client.list.mockRejectedValue(new UserDocServiceUnavailableError())
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.unavailable'))
  })

  it('shows a generic list error for other failures', async () => {
    const client = makeClient()
    client.list.mockRejectedValue(new Error('boom'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })

  it('uploads a selected file and refreshes the list', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['x'], 'new.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(client.upload).toHaveBeenCalledWith(file))
  })

  it('reports an upload failure', async () => {
    const client = makeClient()
    client.upload.mockRejectedValue(new Error('up'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'new.txt')], configurable: true })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('modal.upload.error'))
  })

  it('deletes a document after confirmation and refreshes', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('action.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getAllByRole('button', { name: t('delete.confirm.button') }).at(-1)!)
    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('2026-08-17/report.pdf'))
  })

  it('reports a delete failure', async () => {
    const client = makeClient()
    client.remove.mockRejectedValue(new Error('del'))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('action.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getAllByRole('button', { name: t('delete.confirm.button') }).at(-1)!)
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => '# hello' })))
    renderModal()
    await screen.findByText('readme.md')
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'readme.md' }) })).toBeTruthy())
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
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'photo.png' }) })).toBeTruthy())
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
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
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
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'big.txt' }) })).toBeTruthy())
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
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'data.bin' }) })).toBeTruthy())
    expect(screen.getByText(t('preview.not.supported'))).toBeTruthy()
  })

  it('handles a fetch error during text preview gracefully', async () => {
    const client = makeClient()
    client.list.mockImplementation(async () => ({
      documents: [doc({ docId: '2026-08-17/broken.txt', name: 'broken.txt', bytes: 10, mediaType: 'text/plain' })],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    renderModal()
    await screen.findByText('broken.txt')
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'broken.txt' }) })).toBeTruthy())
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
    // Trigger handleDelete via the confirm button in the delete dialog
    fireEvent.click(screen.getByRole('button', { name: t('action.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    // Close the confirm dialog without deleting (cancel)
    fireEvent.click(within(confirm).getByRole('button', { name: t('button.label') }))
    // The delete target should be cleared now
    expect(screen.queryByRole('dialog', { name: t('delete.confirm.title') })).toBeNull()
  })

  it('triggers the file input change, refresh callbacks, and closes preview and delete modals', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    // Trigger file input onChange (the hidden input's change handler)
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'dummy.txt')] } })
    // Click the upload button (triggers file input onClick)
    fireEvent.click(screen.getByRole('button', { name: t('modal.upload') }))
    // Click the refresh button (triggers load)
    fireEvent.click(screen.getByRole('button', { name: t('modal.refresh') }))
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    // Open preview and close it via the close button
    fireEvent.click(screen.getByRole('button', { name: t('action.preview') }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeNull())
    // Open delete confirmation and cancel it
    fireEvent.click(screen.getByRole('button', { name: t('action.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getAllByRole('button', { name: t('button.label') }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: t('delete.confirm.title') })).toBeNull()
  })
})
