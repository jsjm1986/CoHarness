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
import { UserDocHttpError, UserDocServiceUnavailableError } from '../src/client/documents-client.ts'
import type {
  UserDocDirectoryIdType, UserDocDirectoryRef, UserDocIdType, UserDocLimits, UserDocListQuery, UserDocTrashRef,
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

const upload = { protocol: 'resumable-v1' as const, chunkBytes: 8 * 1024 * 1024, sessionTtlMs: 86400000, resumable: true as const }
const limits: UserDocLimits = {
  maxFileBytes: 10 * 1024 * 1024, maxFilesPerMessage: 5, maxMessageBytes: 100, maxInlineTextBytes: 256, upload,
}
const unlimitedLimits: UserDocLimits = { maxFileBytes: null, maxFilesPerMessage: 5, maxMessageBytes: 100, maxInlineTextBytes: 256, upload }

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
    browse: vi.fn(async (
      directoryId: UserDocDirectoryIdType = '' as UserDocDirectoryIdType,
      _signal?: AbortSignal,
      _query?: UserDocListQuery,
    ) => ({
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
    uploadToScope: vi.fn(async (
      _scope: { kind: 'personal' } | { kind: 'project'; projectId: number },
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
    listTrash: vi.fn(async (): Promise<{ version: 1; documents: UserDocTrashRef[] }> => ({ version: 1, documents: [] })),
    trash: vi.fn(async (docId: string) => ({ docId, directoryId: '', name: 'report.pdf', trashedAt: 1, purgeAfter: Date.now() + 86_400_000, bytes: 2048, mediaType: 'application/pdf', modifiedAt: 1 })),
    restore: vi.fn(async () => doc()),
    purge: vi.fn(async () => undefined),
    listTrashInScope: vi.fn(async (): Promise<{ version: 1; documents: UserDocTrashRef[] }> => ({ version: 1, documents: [] })),
    trashInScope: vi.fn(async (scope: unknown, docId: string) => ({ scope, docId, directoryId: '', name: 'report.pdf', trashedAt: 1, purgeAfter: Date.now() + 86_400_000, bytes: 2048, mediaType: 'application/pdf', modifiedAt: 1 })),
    restoreInScope: vi.fn(async () => doc()),
    purgeInScope: vi.fn(async () => undefined),
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
    scopedContentUrl: vi.fn((scope: unknown, id: string, inline?: boolean) => `/api/documents/scope/content?scope=${encodeURIComponent(JSON.stringify(scope))}&id=${encodeURIComponent(id)}${inline ? '&inline=1' : ''}`),
  }
}

function renderModal() {
  return render(<DocumentsModal open onClose={() => {}} t={t} />)
}

function stubPhoneMedia(): void {
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
    dispatchEvent: () => true,
    media: '(max-width: 767px)',
    onchange: null,
  }) as unknown as MediaQueryList))
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

  it('refreshes the active project scope when the mounted manager is reopened', async () => {
    const client = makeClient()
    let projectName = 'Compiler'
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (href.includes('/account/api/context')) {
        return {
          ok: true,
          json: async () => ({
            scope: { kind: 'project', projectName, projectId: 41, mode: 'rw' },
            projects: [{ projectId: 41, name: projectName, mode: 'rw' }],
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    }))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsButton t={t as never} wide={false} useSessions={undefined as never} useWorkspaces={undefined as never} />)
    fireEvent.click(screen.getByRole('button', { name: '文档' }))
    expect(await screen.findByRole('dialog', { name: t('modal.title.project', { name: 'Compiler' }) })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    projectName = 'Payments'
    fireEvent.click(screen.getByRole('button', { name: '文档' }))
    expect(await screen.findByRole('dialog', { name: t('modal.title.project', { name: 'Payments' }) })).toBeTruthy()
  })

  it('switches scopes inside the existing manager dialog with full read actions', async () => {
    const client = makeClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'ro' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const manager = await screen.findByRole('dialog', { name: t('modal.title') })
    const project = screen.getByRole('button', { name: /Compiler/ })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(project)
    await waitFor(() => { expect(client.listScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }) })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: t('modal.title') })).toBe(manager)
    expect(screen.getByText(t('scope.viewing', { name: 'Compiler' }))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('modal.upload') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('action.previewNamed', { name: 'report.pdf' }) })).toBeTruthy()
  })

  it('keeps the current list visible and cancels a superseded scope request', async () => {
    type ScopeResponse = {
      directoryId: UserDocDirectoryIdType
      directories: UserDocDirectoryRef[]
      documents: ReturnType<typeof doc>[]
      limits: UserDocLimits
    }
    const pending: Array<{ signal: AbortSignal | undefined; resolve: (response: ScopeResponse) => void }> = []
    const browseScope = vi.fn((_scope: unknown, _directoryId: UserDocDirectoryIdType, signal?: AbortSignal) => (
      new Promise<ScopeResponse>((resolve) => { pending.push({ signal, resolve }) })
    ))
    const client = Object.assign(makeClient(), { browseScope })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [
          { projectId: 41, name: 'Compiler', mode: 'ro' },
          { projectId: 42, name: 'Payments', mode: 'rw' },
        ],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')

    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(1) })
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(document.querySelector(`.${modalCss.loadingState}`)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Payments/ }))
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(2) })
    expect(pending[0]?.signal?.aborted).toBe(true)
    expect(screen.getByText('report.pdf')).toBeTruthy()

    pending[1]?.resolve({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [doc({ docId: 'payments.txt', name: 'payments.txt', mediaType: 'text/plain' })],
      limits,
    })
    await screen.findByText('payments.txt')
    pending[0]?.resolve({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [doc({ docId: 'compiler.txt', name: 'compiler.txt', mediaType: 'text/plain' })],
      limits,
    })
    expect(screen.getByText('payments.txt')).toBeTruthy()
  })

  it('keeps the previous list when a scope request fails', async () => {
    let rejectScope: (error: Error) => void = () => {}
    const browseScope = vi.fn(() => new Promise<never>((_, reject) => { rejectScope = reject }))
    const client = Object.assign(makeClient(), { browseScope })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'ro' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(1) })
    rejectScope(new Error('scope unavailable'))
    expect((await screen.findByRole('alert')).textContent).toContain('scope unavailable')
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(document.querySelector(`.${modalCss.loadingState}`)).toBeNull()
  })

  it('shows a previously visited scope from cache while revalidating it', async () => {
    const responses = new Map<number, ReturnType<typeof doc>[]>([
      [41, [doc({ docId: 'compiler.txt', name: 'compiler.txt', mediaType: 'text/plain' })]],
      [42, [doc({ docId: 'payments.txt', name: 'payments.txt', mediaType: 'text/plain' })]],
    ])
    type ScopedResponse = {
      directoryId: UserDocDirectoryIdType
      directories: UserDocDirectoryRef[]
      documents: ReturnType<typeof doc>[]
      limits: UserDocLimits
    }
    const pending: Array<{ projectId: number; resolve: (response: ScopedResponse) => void }> = []
    const browseScope = vi.fn((target: { projectId: number }, _directoryId: UserDocDirectoryIdType, _signal?: AbortSignal) => (
      new Promise<{
        directoryId: UserDocDirectoryIdType
        directories: UserDocDirectoryRef[]
        documents: ReturnType<typeof doc>[]
        limits: UserDocLimits
      }>((resolve) => { pending.push({ projectId: target.projectId, resolve }) })
    ))
    const client = Object.assign(makeClient(), { browseScope })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [
          { projectId: 41, name: 'Compiler', mode: 'ro' },
          { projectId: 42, name: 'Payments', mode: 'rw' },
        ],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')

    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await waitFor(() => { expect(pending).toHaveLength(1) })
    pending.shift()?.resolve({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: responses.get(41)!, limits })
    await screen.findByText('compiler.txt')

    fireEvent.click(screen.getByRole('button', { name: /Payments/ }))
    await waitFor(() => { expect(pending).toHaveLength(1) })
    pending.shift()?.resolve({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: responses.get(42)!, limits })
    await screen.findByText('payments.txt')

    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await screen.findByText('compiler.txt')
    expect(document.querySelector(`.${modalCss.loadingState}`)).toBeNull()
    expect(screen.getByText(t('scope.switch.loading', { name: 'Compiler' }))).toBeTruthy()

    pending.shift()?.resolve({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: responses.get(41)!, limits })
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(3) })
  })

  it('uploads directly to a writable selected scope without using the current runtime upload', async () => {
    const client = makeClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await waitFor(() => { expect(client.listScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }) })
    const input = document.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('document upload input missing')
    fireEvent.change(input, { target: { files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })] } })
    await waitFor(() => {
      expect(client.uploadToScope).toHaveBeenCalledWith(
        { kind: 'project', projectId: 41 },
        expect.any(File),
        '',
        undefined,
        expect.any(Function),
      )
    })
    expect(client.upload).not.toHaveBeenCalled()
  })

  it('uses a compact scope sheet and keeps scope search local', async () => {
    stubPhoneMedia()
    const client = makeClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [
          { projectId: 41, name: 'Compiler', mode: 'rw' },
          { projectId: 42, name: 'Payments', mode: 'ro' },
        ],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const upload = screen.getByRole('button', { name: t('modal.upload') })
    expect(upload.textContent).toContain(t('modal.upload.compact'))
    expect(screen.getByRole('button', { name: t('action.more') }).textContent).toContain(t('action.more.compact'))
    fireEvent.click(screen.getByTestId('documents-scope-trigger'))
    const sheet = await screen.findByRole('dialog', { name: t('scope.switch.title') })
    const search = within(sheet).getByPlaceholderText(t('scope.switch.search'))
    expect(within(sheet).getByRole('option', { name: /Compiler/ }).textContent).toContain(t('scope.project.mode.editable'))
    fireEvent.change(search, { target: { value: 'Compiler' } })
    expect(within(sheet).getByRole('option', { name: /Compiler/ })).toBeTruthy()
    expect(within(sheet).queryByRole('option', { name: /Payments/ })).toBeNull()
    fireEvent.click(within(sheet).getByRole('option', { name: /Compiler/ }))
    await waitFor(() => { expect(client.listScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }) })
    expect(screen.queryByRole('dialog', { name: t('scope.switch.title') })).toBeNull()
  })

  it('refreshes mobile upload-scope options after project context loads', async () => {
    stubPhoneMedia()
    const client = Object.assign(makeClient(), {
      overview: vi.fn(async () => ({
        version: 1 as const,
        documents: [],
        metrics: {
          total: 0, active: 0, deleted: 0, personal: 0, project: 0, bytes: 0,
          operations24h: 0, failures24h: 0,
        },
      })),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByTestId('documents-scope-trigger'))
    const scopeSheet = await screen.findByRole('dialog', { name: t('scope.switch.title') })
    fireEvent.click(within(scopeSheet).getByRole('option', { name: /全部可访问文档/ }))
    await screen.findByRole('heading', { name: t('scope.all') })
    fireEvent.click(screen.getByRole('button', { name: t('scope.upload.choose') }))
    const uploadSheet = await screen.findByRole('dialog', { name: t('scope.upload.choose') })
    expect(within(uploadSheet).getByRole('option', { name: /Compiler/ })).toBeTruthy()
  })

  it('adds a current-scope document directly from the all-scope picker', async () => {
    const client = Object.assign(makeClient(), {
      overview: vi.fn(async () => ({
        version: 1 as const,
        documents: [{
          catalogId: 'catalog-personal',
          scope: { kind: 'personal' as const, id: 7, label: '个人文档' },
          docId: 'report.pdf',
          directoryId: '',
          name: 'report.pdf',
          bytes: 4,
          mediaType: 'application/pdf',
          modifiedAt: 1,
          owner: null,
          ownerSource: 'upload' as const,
          state: 'active' as const,
          legacy: false,
          lineageRootId: null,
        }],
        metrics: {
          total: 1, active: 1, deleted: 0, personal: 1, project: 0, bytes: 4,
          operations24h: 0, failures24h: 0,
        },
      })),
    })
    const attach = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ scope: { kind: 'personal' } }) })))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} mode="select" onAttachDocument={attach} />)
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: /全部可访问文档/ }))
    expect(await screen.findByRole('button', { name: t('action.attach') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('action.attach') }))
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ docId: 'report.pdf', path: '' }))
  })

  it('keeps add-to-conversation and preview actions directly reachable on phones', async () => {
    stubPhoneMedia()
    const client = makeClient()
    const attach = vi.fn(() => true)
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} onAttachDocument={attach} />)
    await screen.findByText('report.pdf')
    expect(screen.getByRole('button', { name: t('action.attachNamed', { name: 'report.pdf' }) })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('action.previewNamed', { name: 'report.pdf' }) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('action.attachNamed', { name: 'report.pdf' }) }))
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ docId: '2026-08-17/report.pdf' }))
  })

  it('opens the compact alternate-source sheet from More without a second manager dialog', async () => {
    stubPhoneMedia()
    const client = makeClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'ro' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('action.more') }))
    const more = await screen.findByRole('dialog', { name: t('action.more') })
    fireEvent.click(within(more).getByRole('button', { name: t('copy.source') }))
    const source = await screen.findByRole('dialog', { name: t('copy.source.title') })
    fireEvent.click(within(source).getByRole('option', { name: /Compiler/ }))
    await waitFor(() => { expect(client.listScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }) })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('filters compact lists locally without issuing another browse request', async () => {
    stubPhoneMedia()
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const browseCalls = client.browse.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: t('action.more') }))
    const more = await screen.findByRole('dialog', { name: t('action.more') })
    fireEvent.change(within(more).getByLabelText(t('modal.type')), { target: { value: 'pdf' } })
    fireEvent.change(within(more).getByLabelText(t('modal.sort')), { target: { value: 'name:asc' } })
    expect(client.browse).toHaveBeenCalledTimes(browseCalls)
  })

  it('routes compact row actions through one sheet and preserves the existing preview modal', async () => {
    stubPhoneMedia()
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('action.moreNamed', { name: 'report.pdf' }) }))
    const sheet = await screen.findByRole('dialog', { name: t('action.more') })
    fireEvent.click(within(sheet).getByRole('button', { name: t('action.preview') }))
    expect(await screen.findByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: t('preview.title', { name: 'report.pdf' }) })).toBeNull()
  })

  it('keeps the compact batch bar separate from the scrolling list', async () => {
    stubPhoneMedia()
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: 'report.pdf' }))
    const batch = screen.getByTestId('documents-batch-bar')
    expect(batch.textContent).toContain(t('selection.selected', { count: '1' }))
    fireEvent.click(within(batch).getByRole('button', { name: t('selection.actions') }))
    const sheet = await screen.findByRole('dialog', { name: t('selection.actions') })
    expect(within(sheet).getByRole('button', { name: t('selection.copy') })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: t('selection.actions') })).toBeNull()
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

  it('shows a retryable runtime message instead of the generic operation error', async () => {
    const client = makeClient()
    client.browse.mockRejectedValue(new UserDocHttpError(
      503, 'The document runtime is starting. Retry shortly.', 'INSTANCE_STARTING', 0,
    ))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.runtimeStarting'))
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

  it('copies selected personal documents to a writable project without attaching a foreign-scope id', async () => {
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
    expect(attach).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(t('copy.success', { target: 'Compiler' }))
    })
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
    expect(sourceDialog.querySelectorAll('select')).toHaveLength(0)
    expect(within(sourceDialog).getByRole('option', { name: /Compiler/ })).toBeTruthy()
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

  it('returns to the active runtime after browsing an alternate scope', async () => {
    const client = makeClient()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'ro' }],
      }),
    })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('copy.source') }))
    const sourceDialog = await screen.findByRole('dialog', { name: t('copy.source.title') })
    fireEvent.click(within(sourceDialog).getByRole('button', { name: t('copy.source.open') }))
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('copy.source.current') }))
    await waitFor(() => { expect(client.browse).toHaveBeenCalledTimes(2) })
  })

  it('deletes a document after confirmation and refreshes', async () => {
    const client = makeClient()
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('delete', 'report.pdf'))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    await waitFor(() => { expect(client.trash).toHaveBeenCalledWith('2026-08-17/report.pdf') })
  })

  it('opens the scope trash and restores a document', async () => {
    const client = makeClient()
    client.listTrash.mockResolvedValue({
      version: 1,
      documents: [{
        docId: '2026-08-17/report.pdf' as UserDocIdType, directoryId: '' as UserDocDirectoryIdType, name: 'report.pdf', trashedAt: 1,
        purgeAfter: Date.now() + 86_400_000, bytes: 2048, mediaType: 'application/pdf', modifiedAt: 1,
      }],
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    fireEvent.click(screen.getByRole('button', { name: t('trash.button') }))
    expect(await screen.findByText(t('trash.title'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('trash.restoreNamed', { name: 'report.pdf' }) }))
    await waitFor(() => { expect(client.restore).toHaveBeenCalledWith('2026-08-17/report.pdf') })
  })

  it('reports a delete failure', async () => {
    const client = makeClient()
    client.trash.mockRejectedValue(new Error('del'))
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
      return { ok: true, text: async () => '# hello' }
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
    expect(within(moveDialog).getByRole('option', { name: 'archive' })).toBeTruthy()
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

  it('uses the server cursor when a paged listing is advertised', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => doc({
      docId: `server/${String(i + 1).padStart(2, '0')}.txt`,
      name: `server-${String(i + 1).padStart(2, '0')}.txt`,
      mediaType: 'text/plain',
    }))
    const last = doc({ docId: 'server/21.txt', name: 'server-21.txt', mediaType: 'text/plain' })
    const client = makeClient()
    client.browse.mockImplementation(async (_directory, _signal, request) => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: request?.cursor === 'next-page' ? [last] : firstPage,
      limits,
      totalDocuments: 21,
      ...(request?.cursor === undefined ? { nextCursor: 'next-page' } : {}),
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    expect(await screen.findByText('server-01.txt')).toBeTruthy()
    expect(screen.queryByText('server-21.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    expect(await screen.findByText('server-21.txt')).toBeTruthy()
    expect(client.browse).toHaveBeenLastCalledWith(
      '',
      expect.any(AbortSignal),
      { limit: 20, query: '', type: 'all', sort: 'date-desc', cursor: 'next-page' },
    )
  })

  it('keeps the initial cursor chain while runtime scope discovery is pending', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => doc({
      docId: `pending/${String(i + 1).padStart(2, '0')}.txt`,
      name: `pending-${String(i + 1).padStart(2, '0')}.txt`,
      mediaType: 'text/plain',
    }))
    const last = doc({ docId: 'pending/21.txt', name: 'pending-21.txt', mediaType: 'text/plain' })
    let resolveContext: (response: unknown) => void = () => {}
    const context = new Promise<unknown>((resolve) => { resolveContext = resolve })
    const client = makeClient()
    client.browse.mockImplementation(async (_directory, _signal, request) => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: request?.cursor === 'next-page' ? [last] : firstPage,
      limits,
      totalDocuments: 21,
      ...(request?.cursor === undefined ? { nextCursor: 'next-page' } : {}),
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (href.includes('/account/api/context')) return context
      return { ok: true, json: async () => ({}) }
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    expect(await screen.findByText('pending-01.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    expect(await screen.findByText('pending-21.txt')).toBeTruthy()
    expect(client.browse).toHaveBeenCalledTimes(2)
    expect(client.browse).toHaveBeenLastCalledWith(
      '',
      expect.any(AbortSignal),
      { limit: 20, query: '', type: 'all', sort: 'date-desc', cursor: 'next-page' },
    )
    resolveContext({
      ok: true,
      json: async () => ({ scope: { kind: 'personal' }, projects: [] }),
    })
  })

  it('keeps selected document metadata across server pages for batch actions', async () => {
    const first = doc({ docId: 'server/first.txt', name: 'first.txt', mediaType: 'text/plain' })
    const second = doc({ docId: 'server/second.txt', name: 'second.txt', mediaType: 'text/plain' })
    const firstPage = [first, ...Array.from({ length: 19 }, (_, index) => doc({
      docId: `server/filler-${String(index)}.txt`, name: `filler-${String(index)}.txt`, mediaType: 'text/plain',
    }))]
    const client = makeClient()
    client.browse.mockImplementation(async (_directory, _signal, request) => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: request?.cursor === 'next-page' ? [second] : firstPage,
      limits,
      totalDocuments: 21,
      ...(request?.cursor === undefined ? { nextCursor: 'next-page' } : {}),
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('first.txt')
    fireEvent.click(screen.getByRole('checkbox', { name: 'first.txt' }))
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    await screen.findByText('second.txt')
    fireEvent.click(screen.getByRole('checkbox', { name: 'second.txt' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.delete') }))
    const confirm = screen.getByRole('dialog', { name: t('delete.confirm.title') })
    fireEvent.click(within(confirm).getByRole('button', { name: t('delete.confirm.button') }))
    await waitFor(() => { expect(client.trash).toHaveBeenCalledTimes(2) })
    expect(client.trash).toHaveBeenCalledWith('server/first.txt')
    expect(client.trash).toHaveBeenCalledWith('server/second.txt')
  })

  it('clamps to page one after the only document on page two is deleted', async () => {
    let documents = Array.from({ length: 21 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      return doc({ docId: `2026-08-${day}/f-${day}.txt`, name: `f-${day}.txt` })
    })
    const client = makeClient()
    client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents, limits }))
    client.trash.mockImplementation(async (id?: string) => {
      documents = documents.filter(item => item.docId !== id)
      return {
        docId: id ?? '', directoryId: '', name: 'document', trashedAt: 1,
        purgeAfter: Date.now() + 86_400_000, bytes: 1, mediaType: 'text/plain', modifiedAt: 1,
      }
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
    await waitFor(() => { expect(client.trash).toHaveBeenCalledTimes(2) })
    expect(client.trash).toHaveBeenCalledWith('2026-08-17/a.pdf')
    expect(client.trash).toHaveBeenCalledWith('2026-08-17/b.pdf')
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
