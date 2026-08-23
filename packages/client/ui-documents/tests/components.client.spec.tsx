// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import buttonCss from '../src/client/DocumentsButton.module.css'
import { DocumentsModal } from '../src/client/DocumentsModal.tsx'
import modalCss from '../src/client/DocumentsModal.module.css'
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
import type {
  UserDocDirectoryIdType, UserDocDirectoryRef, UserDocLimits,
} from '../src/client/documents-client.ts'

function t(key: DocumentsKey, params?: Record<string, string>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, v)
    }
  }
  return text
}

const limits: UserDocLimits = { maxFileBytes: 10 * 1024 * 1024, maxFilesPerMessage: 5, maxMessageBytes: 100, maxInlineTextBytes: 256 }
const unlimitedLimits: UserDocLimits = { maxFileBytes: null, maxFilesPerMessage: 5, maxMessageBytes: 100, maxInlineTextBytes: 256 }

function doc(ref: Partial<{ docId: string; name: string; bytes: number; mediaType: string; modifiedAt: number }> = {}) {
  const docId = ref.docId ?? '2026-08-17/report.pdf'
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:\/|$)/.exec(docId)
  return {
    docId,
    path: `/documents/${docId}`,
    name: 'report.pdf',
    bytes: 2048,
    mediaType: 'application/pdf',
    modifiedAt: date === null
      ? Date.UTC(2026, 7, 17)
      : Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])),
    ...ref,
  }
}

function directory(directoryId: string, name = directoryId.split('/').at(-1) ?? directoryId): UserDocDirectoryRef {
  return {
    directoryId: directoryId as UserDocDirectoryIdType,
    name,
    path: `/documents/${directoryId}`,
    modifiedAt: 1,
  }
}

function makeClient() {
  const documents = [doc()]
  return {
    list: vi.fn(async () => ({ documents, limits })),
    browse: vi.fn(async (directoryId: UserDocDirectoryIdType = '' as UserDocDirectoryIdType) => ({
      directoryId,
      directories: [] as UserDocDirectoryRef[],
      documents,
      limits,
    })),
    listDirectories: vi.fn(async () => ({ directories: [] as UserDocDirectoryRef[] })),
    upload: vi.fn(async (
      _file: File,
      _directoryId?: string,
      _signal?: AbortSignal,
      _onProgress?: (loaded: number, total: number) => void,
    ) => doc()),
    createDirectory: vi.fn(async (_parentDirectoryId?: string, name: string = '') => ({
      directoryId: name,
      name,
      path: `/documents/${name}`,
      modifiedAt: 1,
    })),
    renameDirectory: vi.fn(async (_directoryId?: string, name: string = '') => ({
      directoryId: name,
      name,
      path: `/documents/${name}`,
      modifiedAt: 1,
    })),
    removeDirectory: vi.fn(async (_directoryId?: string) => undefined),
    move: vi.fn(async (_docId?: string, _directoryId?: string) => doc()),
    remove: vi.fn(async (_docId?: string) => undefined),
    transfer: vi.fn(async () => ({
      version: 1,
      transferId: 'transfer-1',
      source: { kind: 'personal', label: 'Personal documents' },
      target: { kind: 'project', label: 'Compiler' },
      items: [{
        status: 'copied' as const,
        source: { name: 'report.pdf', bytes: 2048, mediaType: 'application/pdf' },
        target: {
          docId: 'report.pdf', name: 'report.pdf', bytes: 2048,
          mediaType: 'application/pdf', modifiedAt: 1,
        },
      }],
    })),
    capabilities: vi.fn(async () => ({
      version: 1,
      current: { kind: 'personal' as const, label: 'Personal documents' },
      targets: [],
    })),
    listScope: vi.fn(async () => ({
      version: 1,
      scope: { kind: 'project' as const, label: 'Compiler' },
      documents: [{
        docId: 'project/report.pdf', name: 'report.pdf', bytes: 2048,
        mediaType: 'application/pdf', modifiedAt: 1,
      }],
    })),
    contentUrl: vi.fn((id: string) => `/api/documents/content?id=${encodeURIComponent(id)}`),
  }
}

function renderModal() {
  return render(<DocumentsModal open onClose={() => {}} t={t} />)
}

function namedButton(action: 'attach' | 'preview' | 'move' | 'delete', name: string) {
  const key = action === 'preview'
    ? 'action.previewNamed'
    : action === 'attach'
      ? 'action.attachNamed'
      : action === 'move' ? 'action.moveNamed' : 'action.deleteNamed'
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
    expect(screen.getByRole('button', { name: '文档' }).className.split(/\s+/)).toContain(buttonCss.rail)
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
    expect(namedButton('attach', 'report.pdf')).toBeTruthy()
    expect(namedButton('preview', 'report.pdf')).toBeTruthy()
    expect(namedButton('delete', 'report.pdf')).toBeTruthy()
    expect(screen.getByRole('link', { name: t('action.downloadNamed', { name: 'report.pdf' }) })).toBeTruthy()
    expect(screen.getByRole('group', { name: t('modal.filters') })).toBeTruthy()
    expect(screen.getByRole('group', { name: t('modal.actions') })).toBeTruthy()
  })

  it('adds an existing document to the conversation and closes the manager', async () => {
    const client = makeClient()
    const attachDocument = vi.fn(() => true)
    const onClose = vi.fn()
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={onClose} t={t} onAttachDocument={attachDocument} />)
    await screen.findByText('report.pdf')

    fireEvent.click(namedButton('attach', 'report.pdf'))

    expect(attachDocument).toHaveBeenCalledWith(expect.objectContaining({ docId: '2026-08-17/report.pdf' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows an error when an existing document cannot be attached', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} onAttachDocument={() => false} />)
    await screen.findByText('report.pdf')

    fireEvent.click(namedButton('attach', 'report.pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain(t('action.attach.error'))
  })

  it('contains an attachment callback failure in the manager', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} onAttachDocument={() => { throw new Error('gone') }} />)
    await screen.findByText('report.pdf')

    fireEvent.click(namedButton('attach', 'report.pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain(t('action.attach.error'))
  })

  it('shows that the default document size is unlimited', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [doc()],
      limits: unlimitedLimits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()

    await screen.findByText('report.pdf')
    expect(screen.getByText(t('modal.limits.unlimited', { count: '5' }))).toBeTruthy()
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
    client.browse.mockRejectedValue(new UserDocServiceUnavailableError())
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.unavailable'))
  })

  it('ignores an aborted load after the modal unmounts', async () => {
    const client = makeClient()
    let rejectList: (error: Error) => void = () => {}
    client.browse.mockImplementation(() => new Promise((_, reject) => { rejectList = reject }))
    createUserDocClient.mockReturnValue(client)
    const { unmount } = renderModal()
    unmount()
    rejectList(new Error('boom'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a generic list error for other failures', async () => {
    const client = makeClient()
    client.browse.mockRejectedValue(new Error('boom'))
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
      _directoryId?: string,
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
    await waitFor(() => { expect(client.upload).toHaveBeenCalledWith(file, '', undefined, expect.any(Function)) })
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
    await waitFor(() => { expect(client.upload).toHaveBeenCalledWith(file, '', undefined, expect.any(Function)) })
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

  it('copies selected personal documents to a writable project and offers attach-to-composer', async () => {
    const client = makeClient()
    const attach = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} onAttachDocument={attach} />)
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: 'report.pdf' }))
    expect(screen.getByRole('button', { name: t('selection.delete') }).className.split(/\s+/))
      .toContain(modalCss.selectionDelete)
    fireEvent.click(screen.getByRole('button', { name: t('selection.copy') }))
    const copyDialog = await screen.findByRole('dialog', { name: t('copy.title') })
    fireEvent.click(within(copyDialog).getByRole('button', { name: t('copy.confirm') }))
    await waitFor(() => { expect(client.transfer).toHaveBeenCalledOnce() })
    expect(client.transfer).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'personal' },
      target: { kind: 'project', projectId: 41 },
      documents: [{ docId: '2026-08-17/report.pdf' }],
    }))
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ docId: 'report.pdf' }))
  })

  it('browses a project source from a personal composer and copies it back to personal documents', async () => {
    const client = makeClient()
    const attach = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'ro' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} onAttachDocument={attach} />)
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('copy.source') }))
    const sourceDialog = await screen.findByRole('dialog', { name: t('copy.source.title') })
    fireEvent.click(within(sourceDialog).getByRole('button', { name: t('copy.source.open') }))
    await waitFor(() => { expect(client.listScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }) })
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: 'report.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.copy') }))
    const copyDialog = await screen.findByRole('dialog', { name: t('copy.title') })
    fireEvent.click(within(copyDialog).getByRole('button', { name: t('copy.confirm') }))
    await waitFor(() => { expect(client.transfer).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'project', projectId: 41 },
      target: { kind: 'personal' },
    })) })
    expect(attach).toHaveBeenCalled()
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
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
    client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [], limits: null as unknown as UserDocLimits }))
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

  it('shows personal visibility and a filtered count', async () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderModal()
    await screen.findByText('report.pdf')
    expect(screen.getByText(t('modal.visibility.personal'))).toBeTruthy()
    expect(screen.getByText(t('modal.count', { count: '1' }))).toBeTruthy()
  })

  it('navigates folders with breadcrumbs and uploads into the current folder', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async (directoryId: UserDocDirectoryIdType = '' as UserDocDirectoryIdType) => directoryId === ''
      ? { directoryId: '' as UserDocDirectoryIdType, directories: [directory('reports')], documents: [], limits }
      : {
        directoryId: 'reports' as UserDocDirectoryIdType,
        parentDirectoryId: '' as UserDocDirectoryIdType,
        directories: [],
        documents: [doc({ docId: 'reports/summary.txt', name: 'summary.txt', mediaType: 'text/plain' })],
        limits,
      })
    createUserDocClient.mockReturnValue(client)
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: t('folder.openNamed', { name: 'reports' }) }))
    expect(await screen.findByText('summary.txt')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: t('breadcrumb.label') }).textContent).toContain('reports')

    const input = document.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['x'], 'inside.txt')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    await waitFor(() => { expect(client.upload).toHaveBeenCalledWith(file, 'reports', undefined, expect.any(Function)) })

    fireEvent.click(screen.getByRole('button', { name: t('breadcrumb.root') }))
    expect(await screen.findByRole('button', { name: t('folder.openNamed', { name: 'reports' }) })).toBeTruthy()
  })

  it('creates, renames, and deletes an empty folder', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType, directories: [directory('reports')], documents: [], limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByRole('button', { name: t('folder.openNamed', { name: 'reports' }) })

    fireEvent.click(screen.getByRole('button', { name: t('folder.create') }))
    const createDialog = screen.getByRole('dialog', { name: t('folder.create.title') })
    fireEvent.change(within(createDialog).getByLabelText(t('folder.name')), { target: { value: 'drafts' } })
    fireEvent.click(within(createDialog).getByRole('button', { name: t('folder.create.confirm') }))
    await waitFor(() => { expect(client.createDirectory).toHaveBeenCalledWith('', 'drafts') })

    fireEvent.click(screen.getByRole('button', { name: t('folder.renameNamed', { name: 'reports' }) }))
    const renameDialog = screen.getByRole('dialog', { name: t('folder.rename.title') })
    fireEvent.change(within(renameDialog).getByLabelText(t('folder.name')), { target: { value: 'archive' } })
    fireEvent.click(within(renameDialog).getByRole('button', { name: t('folder.rename.confirm') }))
    await waitFor(() => { expect(client.renameDirectory).toHaveBeenCalledWith('reports', 'archive') })

    fireEvent.click(screen.getByRole('button', { name: t('folder.deleteNamed', { name: 'reports' }) }))
    const deleteDialog = screen.getByRole('dialog', { name: t('folder.delete.title') })
    fireEvent.click(within(deleteDialog).getByRole('button', { name: t('folder.delete.confirm') }))
    await waitFor(() => { expect(client.removeDirectory).toHaveBeenCalledWith('reports') })
  })

  it('moves one document to a selected folder', async () => {
    const client = makeClient()
    client.listDirectories.mockResolvedValue({ directories: [directory('reports'), directory('archive')] })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')

    fireEvent.click(namedButton('move', 'report.pdf'))
    const moveDialog = await screen.findByRole('dialog', { name: t('move.title') })
    await waitFor(() => { expect(within(moveDialog).getByLabelText(t('move.destination'))).toBeTruthy() })
    fireEvent.change(within(moveDialog).getByLabelText(t('move.destination')), { target: { value: 'archive' } })
    fireEvent.click(within(moveDialog).getByRole('button', { name: t('move.confirm') }))
    await waitFor(() => { expect(client.move).toHaveBeenCalledWith('2026-08-17/report.pdf', 'archive') })
  })

  it('keeps only unfinished documents in the move dialog after a partial failure', async () => {
    const documents = [
      doc({ docId: '2026-08-17/a.pdf', name: 'a.pdf' }),
      doc({ docId: '2026-08-17/b.pdf', name: 'b.pdf' }),
    ]
    const client = makeClient()
    client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents, limits }))
    client.listDirectories.mockResolvedValue({ directories: [directory('reports')] })
    client.move
      .mockResolvedValueOnce(doc({ docId: 'reports/a.pdf', name: 'a.pdf' }))
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce(doc({ docId: 'reports/b.pdf', name: 'b.pdf' }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('a.pdf')

    fireEvent.click(screen.getByRole('checkbox', { name: 'a.pdf' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'b.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.move') }))
    const moveDialog = await screen.findByRole('dialog', { name: t('move.title') })
    fireEvent.click(within(moveDialog).getByRole('button', { name: t('move.confirm') }))

    expect(await within(moveDialog).findByText(t('move.error'))).toBeTruthy()
    expect(within(moveDialog).getByText(t('move.message', { count: '1' }))).toBeTruthy()
    fireEvent.click(within(moveDialog).getByRole('button', { name: t('move.confirm') }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: t('move.title') })).toBeNull() })
    expect(client.move).toHaveBeenNthCalledWith(3, '2026-08-17/b.pdf', 'reports')
  })

  it('pages 21 documents and keeps the last file on page two', async () => {
    const documents = Array.from({ length: 21 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      return doc({ docId: `2026-08-${day}/f-${day}.txt`, name: `f-${day}.txt` })
    })
    const client = makeClient()
    client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents, limits }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    expect(await screen.findByText('f-21.txt')).toBeTruthy()
    expect(screen.queryByText('f-01.txt')).toBeNull()
    expect(screen.getByText(t('pager.status', { page: '1', pages: '2' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    expect(await screen.findByText('f-01.txt')).toBeTruthy()
    expect(screen.queryByText('f-21.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('pager.prev') }))
    expect(await screen.findByText('f-21.txt')).toBeTruthy()
  })

  it('clamps to page one after the only document on page two is deleted', async () => {
    let documents = Array.from({ length: 21 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      return doc({ docId: `2026-08-${day}/f-${day}.txt`, name: `f-${day}.txt` })
    })
    const client = makeClient()
    client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents, limits }))
    client.remove.mockImplementation(async (id?: string) => {
      documents = documents.filter(item => item.docId !== id)
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('f-21.txt')
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    expect(await screen.findByText('f-01.txt')).toBeTruthy()
    fireEvent.click(namedButton('delete', 'f-01.txt'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    await waitFor(() => { expect(screen.getByText('f-21.txt')).toBeTruthy() })
    expect(screen.queryByRole('button', { name: t('pager.next') })).toBeNull()
  })

  it('filters by type and sorts by name without date groups', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [
        doc({ docId: '2026-08-17/zeta.pdf', name: 'zeta.pdf', mediaType: 'application/pdf' }),
        doc({ docId: '2026-08-18/alpha.png', name: 'alpha.png', mediaType: 'image/png' }),
        doc({ docId: '2026-08-19/beta.txt', name: 'beta.txt', mediaType: 'text/plain' }),
      ],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('alpha.png')
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.type') }), { target: { value: 'image' } })
    expect(screen.getByText('alpha.png')).toBeTruthy()
    expect(screen.queryByText('beta.txt')).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.type') }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.sort') }), { target: { value: 'name:asc' } })
    expect(screen.queryByRole('group', { name: `${t('listing.date')} 2026-08-18` })).toBeNull()
    const names = screen.getAllByRole('listitem').map(row => row.textContent ?? '')
    expect(names[0]).toContain('alpha.png')
    expect(names[1]).toContain('beta.txt')
    expect(names[2]).toContain('zeta.pdf')
  })

  it('selects the current page from the header checkbox and batch-deletes the selection', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [
        doc({ docId: '2026-08-17/a.pdf', name: 'a.pdf' }),
        doc({ docId: '2026-08-17/b.pdf', name: 'b.pdf' }),
      ],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('a.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: 'a.pdf' }))
    expect(screen.getByText(t('selection.selected', { count: '1' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: t('selection.selectPage') }))
    expect(screen.getByText(t('selection.selected', { count: '2' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: t('selection.selectPage') }))
    expect(screen.queryByText(t('selection.selected', { count: '2' }))).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: t('selection.selectPage') }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    expect(confirm.textContent).toContain(t('delete.confirm.message.many', { count: '2', projectExtra: '' }))
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    await waitFor(() => { expect(client.remove).toHaveBeenCalledTimes(2) })
    expect(client.remove).toHaveBeenCalledWith('2026-08-17/a.pdf')
    expect(client.remove).toHaveBeenCalledWith('2026-08-17/b.pdf')
  })

  it('warns that a project batch delete affects every member', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ scope: { kind: 'project', projectName: '支付重构' } }),
    })))
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [
        doc({ docId: '2026-08-17/a.pdf', name: 'a.pdf' }),
        doc({ docId: '2026-08-17/b.pdf', name: 'b.pdf' }),
      ],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    expect(await screen.findByText(t('modal.visibility.project'))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'a.pdf' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'b.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    expect(confirm.textContent).toContain(t('delete.confirm.project.extra'))
  })

  it('clears a page selection and prunes it when the type filter hides those rows', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [
        doc({ docId: '2026-08-17/pic.png', name: 'pic.png', mediaType: 'image/png' }),
        doc({ docId: '2026-08-17/note.txt', name: 'note.txt', mediaType: 'text/plain' }),
      ],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('pic.png')
    fireEvent.click(screen.getByRole('checkbox', { name: 'pic.png' }))
    expect(screen.getByText(t('selection.selected', { count: '1' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'pic.png' }))
    expect(screen.queryByText(t('selection.selected', { count: '1' }))).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'pic.png' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.clear') }))
    expect(screen.queryByText(t('selection.selected', { count: '1' }))).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'pic.png' }))
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.type') }), { target: { value: 'text' } })
    await waitFor(() => {
      expect(screen.queryByText(t('selection.selected', { count: '1' }))).toBeNull()
    })
  })
})
