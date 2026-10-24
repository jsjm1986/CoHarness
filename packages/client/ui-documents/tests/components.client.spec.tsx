// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import { DocumentsOverlay } from '../src/client/DocumentsOverlay.tsx'
import buttonCss from '../src/client/DocumentsButton.module.css'
import { DocumentsModal } from '../src/client/DocumentsModal.tsx'
import modalCss from '../src/client/DocumentsModal.module.css'
import { zh, type DocumentsKey } from '../src/client/locales.ts'

const useNoCurrentSession = (select: (state: { current: undefined }) => unknown) => select({ current: undefined })

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
  UserDocDirectoryIdType, UserDocDirectoryRef, UserDocIdType, UserDocLimits, UserDocListQuery, UserDocScope, UserDocTrashRef,
  UserDocUploadPhase,
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
      _onProgress?: (loaded: number, total: number, phase?: UserDocUploadPhase) => void,
    ) => doc()),
    uploadToScope: vi.fn(async (
      _scope: { kind: 'personal' } | { kind: 'project'; projectId: number },
      _file: File,
      _directoryId?: string,
      _signal?: AbortSignal,
      _onProgress?: (loaded: number, total: number, phase?: UserDocUploadPhase) => void,
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
    browseScope: vi.fn(async (
      _scope: UserDocScope,
      directoryId: UserDocDirectoryIdType,
      _signal?: AbortSignal,
      _query?: UserDocListQuery,
    ) => ({
      version: 1,
      directoryId,
      directories: [] as UserDocDirectoryRef[],
      scope: { kind: 'project', label: 'Compiler' },
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

function renderPickerButton() {
  const runtime = {
    t: t as never, useSessions: useNoCurrentSession as never,
    useWorkspaces: undefined as never, usePanelInfo: undefined as never,
  }
  return render(<>
    <DocumentsButton {...runtime} wide={false} />
    <DocumentsOverlay {...runtime} />
  </>)
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
    vi.restoreAllMocks()
    createUserDocClient.mockReset()
    vi.unstubAllGlobals()
  })

  it('renders a button with the document label, opens the modal on click, and closes on Escape', () => {
    createUserDocClient.mockReturnValue(makeClient())
    renderPickerButton()
    expect(screen.getByRole('button', { name: '文档' }).className.split(/\s+/)).toContain(buttonCss.rail)
    fireEvent.click(screen.getByRole('button', { name: '文档' }))
    expect(screen.getByRole('dialog', { name: '文档管理' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '文档管理' })).toBeNull()
  })

  it('shows the document label beside the icon when the sidebar is wide', () => {
    createUserDocClient.mockReturnValue(makeClient())
    render(<DocumentsButton
      t={t as never} wide={true} useSessions={useNoCurrentSession as never}
      useWorkspaces={undefined as never} usePanelInfo={undefined as never}
    />)
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
    renderPickerButton()
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
    await waitFor(() => { expect(client.browseScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 })) })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: t('modal.title') })).toBe(manager)
    expect(screen.getByText(t('scope.viewing', { name: 'Compiler' }))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('modal.upload') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('action.previewNamed', { name: 'report.pdf' }) })).toBeTruthy()
  })

  it.each([
    { mode: 'manage', runtime: 'personal' },
    { mode: 'select', runtime: 'personal' },
    { mode: 'manage', runtime: 'project' },
    { mode: 'select', runtime: 'project' },
  ] as const)('browses the captured attachment scope independently from the $runtime runtime in $mode mode', async ({ mode, runtime }) => {
    const client = makeClient()
    const attachmentScope: UserDocScope = runtime === 'personal'
      ? { kind: 'project', projectId: 41 }
      : { kind: 'personal' }
    const targetLabel = runtime === 'personal' ? 'Compiler' : t('copy.target.personal')
    const runtimeLabel = runtime === 'personal' ? t('copy.target.personal') : 'Compiler'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: runtime === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    })))
    client.browseScope.mockImplementation(async (_scope, directoryId) => ({
      version: 1,
      directoryId,
      directories: [],
      scope: { kind: runtime === 'personal' ? 'project' : 'personal', label: targetLabel },
      documents: [doc({ docId: 'alternate.txt', name: 'alternate.txt' })],
    }))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} mode={mode} attachmentScope={attachmentScope} />)
    await screen.findByText('report.pdf')
    const initialReads = client.browse.mock.calls.length
    const manager = screen.getByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(targetLabel) }))
    await screen.findByText('alternate.txt')
    expect(client.browseScope).toHaveBeenCalledWith(attachmentScope, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 }))
    expect(client.browse).toHaveBeenCalledTimes(initialReads)
    expect(screen.getAllByText(t('scope.upload.target', { name: targetLabel })).length).toBeGreaterThan(0)
    expect(screen.getByRole('dialog')).toBe(manager)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(runtimeLabel) }))
    await screen.findByText('report.pdf')
    expect(screen.queryByText('alternate.txt')).toBeNull()
    expect(client.browseScope).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox', { name: 'report.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: t('selection.copy') }))
    const copyDialog = await screen.findByRole('dialog', { name: t('copy.title') })
    const choices = within(copyDialog).getByRole('combobox', { name: t('copy.target') })
    expect(within(choices).getAllByRole('option').map(option => option.getAttribute('value')))
      .toEqual([attachmentScope.kind === 'personal' ? 'personal' : 'project:41'])
    fireEvent.click(within(copyDialog).getByRole('button', { name: t('modal.cancel') }))
    expect(client.transfer).not.toHaveBeenCalled()
  })

  it('returns to the parent directory through an explicit navigation action', async () => {
    const client = makeClient()
    client.browse.mockImplementation(async (directoryId: UserDocDirectoryIdType = '' as UserDocDirectoryIdType) => ({
      directoryId,
      directories: directoryId === '' ? [directory('dsh-plugin')] : [],
      documents: [],
      limits,
    }))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByRole('dialog', { name: t('modal.title') })
    fireEvent.click(screen.getByRole('button', { name: t('folder.openNamed', { name: 'dsh-plugin' }) }))
    expect(await screen.findByRole('button', { name: t('breadcrumb.parent') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('breadcrumb.parent') }))
    await waitFor(() => { expect(client.browse).toHaveBeenLastCalledWith('', expect.any(AbortSignal), expect.anything()) })
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

  it('shows stale scope metadata while revalidating and discards expired entries', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
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

    now.mockReturnValue(31_001)
    fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
    await screen.findByText('compiler.txt')
    expect(document.querySelector(`.${modalCss.loadingState}`)).toBeNull()
    expect(screen.getByText(t('scope.switch.loading', { name: 'Compiler' }))).toBeTruthy()

    pending.shift()?.resolve({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: responses.get(41)!, limits })
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(3) })

    now.mockReturnValue(331_002)
    fireEvent.click(screen.getByRole('button', { name: /Payments/ }))
    await waitFor(() => { expect(browseScope).toHaveBeenCalledTimes(4) })
    expect(screen.getByText('compiler.txt')).toBeTruthy()
    expect(screen.queryByText('payments.txt')).toBeNull()
    pending.shift()?.resolve({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: responses.get(42)!, limits })
    await screen.findByText('payments.txt')
  })

  it('reuses the fresh current-scope listing when the manager is reopened', async () => {
    const client = makeClient()
    client.browse.mockImplementationOnce(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [doc({ docId: 'cached.txt', name: 'cached.txt', mediaType: 'text/plain' })],
      limits,
    }))
    const contextFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ scope: { kind: 'personal' }, projects: [] }),
    }))
    vi.stubGlobal('fetch', contextFetch)
    createUserDocClient.mockReturnValue(client)
    const view = render(<DocumentsModal open onClose={() => {}} t={t} />)
    await screen.findByText('cached.txt')
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })

    view.rerender(<DocumentsModal open={false} onClose={() => {}} t={t} />)
    view.rerender(<DocumentsModal open onClose={() => {}} t={t} />)
    await waitFor(() => { expect(contextFetch).toHaveBeenCalledTimes(2) })
    expect(client.browse).toHaveBeenCalledOnce()
    expect(screen.getByText('cached.txt')).toBeTruthy()
    expect(document.querySelector(`.${modalCss.loadingState}`)).toBeNull()
  })

  it('loads the new runtime when account context changes across manager opens', async () => {
    const client = makeClient()
    client.browse
      .mockResolvedValueOnce({
        directoryId: '' as UserDocDirectoryIdType,
        directories: [],
        documents: [doc({ docId: 'personal.txt', name: 'personal.txt', mediaType: 'text/plain' })],
        limits,
      })
      .mockResolvedValueOnce({
        directoryId: '' as UserDocDirectoryIdType,
        directories: [],
        documents: [doc({ docId: 'project.txt', name: 'project.txt', mediaType: 'text/plain' })],
        limits,
      })
    let contextCall = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      contextCall += 1
      const call = contextCall
      return {
        ok: true,
        json: async () => call === 1
          ? { scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }] }
          : {
            scope: { kind: 'project', projectName: 'Compiler', projectId: 41, mode: 'rw' },
            projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
          },
      }
    }))
    createUserDocClient.mockReturnValue(client)
    const view = render(<DocumentsModal open onClose={() => {}} t={t} />)
    await screen.findByText('personal.txt')

    view.rerender(<DocumentsModal open={false} onClose={() => {}} t={t} />)
    view.rerender(<DocumentsModal open onClose={() => {}} t={t} />)
    await screen.findByText('project.txt')
    expect(client.browse).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog', { name: t('modal.title.project', { name: 'Compiler' }) })).toBeTruthy()
  })

  it('caches a legacy runtime listing that arrives before project scope discovery', async () => {
    const client = makeClient()
    client.browse.mockImplementationOnce(async () => ({
      directoryId: '' as UserDocDirectoryIdType,
      directories: [],
      documents: [doc({ docId: 'project-cached.txt', name: 'project-cached.txt', mediaType: 'text/plain' })],
      limits,
    }))
    let resolveContext: (response: { ok: true; json: () => Promise<unknown> }) => void = () => {}
    const firstContext = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveContext = resolve
    })
    const contextResponse = {
      ok: true as const,
      json: async () => ({
        scope: { kind: 'project', projectName: 'Compiler', projectId: 41, mode: 'rw' },
        projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    }
    const contextFetch = vi.fn()
      .mockImplementationOnce(async () => firstContext)
      .mockImplementation(async () => contextResponse)
    vi.stubGlobal('fetch', contextFetch)
    createUserDocClient.mockReturnValue(client)
    const view = render(<DocumentsModal open onClose={() => {}} t={t} />)
    await screen.findByText('project-cached.txt')
    resolveContext(contextResponse)
    await screen.findByRole('dialog', { name: t('modal.title.project', { name: 'Compiler' }) })

    view.rerender(<DocumentsModal open={false} onClose={() => {}} t={t} />)
    view.rerender(<DocumentsModal open onClose={() => {}} t={t} />)
    await waitFor(() => { expect(contextFetch).toHaveBeenCalledTimes(2) })
    expect(client.browse).toHaveBeenCalledOnce()
    expect(screen.getByText('project-cached.txt')).toBeTruthy()
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
    await waitFor(() => { expect(client.browseScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 })) })
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
    await waitFor(() => { expect(client.browseScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 })) })
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
    await waitFor(() => { expect(client.browseScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 })) })
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

  it('localizes a document scope timeout as a retryable unavailable state', async () => {
    const client = makeClient()
    client.browse.mockRejectedValue(new UserDocHttpError(
      504, 'Document scope request timed out.', 'DOCUMENT_SCOPE_TIMEOUT', undefined,
    ))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.runtimeUnavailable'))
    expect(alert.textContent).not.toContain('Document scope request timed out.')
  })

  it('does not render an HTML proxy error body in the document panel', async () => {
    const client = makeClient()
    client.browse.mockRejectedValue(new UserDocHttpError(
      502, '<!DOCTYPE html><html><body>Bad Gateway</body></html>', undefined, undefined,
    ))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('error.runtimeUnavailable'))
    expect(alert.textContent).not.toContain('<!DOCTYPE html>')
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

  it('reports published upload batch files without claiming an empty folder', async () => {
    const client = makeClient()
    const committed: ReturnType<typeof doc>[] = []
    const release = Promise.withResolvers<undefined>()
    client.browse.mockImplementation(async () => ({
      directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [...committed], limits,
    }))
    client.upload.mockImplementation(async (file, _directory, _signal, report) => {
      if (file.name === 'b.txt') {
        report?.(1, 1, 'verifying')
        await release.promise
      }
      const stored = doc({ docId: file.name, name: file.name, mediaType: 'text/plain' })
      committed.push(stored)
      return stored
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText(t('modal.empty'))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    try {
      fireEvent.change(input, { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } })
      await waitFor(() => { expect(client.upload).toHaveBeenCalledTimes(2) })
      expect(screen.getByText('已上传 1 / 2 个文件')).toBeTruthy()
      expect(screen.queryByText(t('modal.empty'))).toBeNull()
      expect(screen.queryByText(t('modal.count', { count: '0' }))).toBeNull()
      expect(input.disabled).toBe(true)
      expect(client.browse).toHaveBeenCalledOnce()
      expect(screen.queryByText('已上传 2 / 2 个文件')).toBeNull()
    } finally {
      await act(async () => { release.resolve(undefined); await release.promise })
    }
    await screen.findByText('b.txt')
    expect(client.browse).toHaveBeenCalledTimes(2)
  })

  it('refreshes a published upload batch prefix and names failed and unstarted files', async () => {
    const client = makeClient()
    const committed: ReturnType<typeof doc>[] = []
    const listing = () => ({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [...committed], limits })
    const refresh = Promise.withResolvers<ReturnType<typeof listing>>()
    let refreshEntered = false
    client.browse.mockImplementation(async () => {
      if (committed.length > 0) { refreshEntered = true; return await refresh.promise }
      return listing()
    })
    client.upload.mockImplementation(async (file) => {
      if (file.name === 'b.txt') throw new Error('synthetic second file failure')
      const stored = doc({ docId: file.name, name: file.name, mediaType: 'text/plain' })
      committed.push(stored)
      return stored
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText(t('modal.empty'))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    try {
      fireEvent.change(input, { target: { files: ['a', 'b', 'c'].map(name => new File([name], `${name}.txt`)) } })
      await waitFor(() => { expect(refreshEntered).toBe(true) })
      expect(input.disabled).toBe(true)
      expect(screen.getByText('已上传 1 / 3 个文件')).toBeTruthy()
      expect(client.upload).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => { refresh.resolve(listing()); await refresh.promise })
    }
    await screen.findByText('a.txt')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('b.txt')
    expect(alert.textContent).toContain('1 个文件未开始')
    expect(screen.getByText('已上传 1 / 3 个文件')).toBeTruthy()
    expect(input.disabled).toBe(false)
    expect(client.browse).toHaveBeenCalledTimes(2)
    expect(client.remove).not.toHaveBeenCalled()
  })

  it('accepts one upload batch across same-tick drop and input events', async () => {
    const client = makeClient()
    const release = Promise.withResolvers<undefined>()
    client.upload.mockImplementation(async (file) => { await release.promise; return doc({ docId: file.name, name: file.name }) })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const panel = document.querySelector<HTMLElement>('[data-documents-panel]')!
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    try {
      act(() => {
        fireEvent.drop(panel, { dataTransfer: { files: [new File(['1'], 'first.txt')] } })
        fireEvent.drop(panel, { dataTransfer: { files: [new File(['2'], 'second.txt')] } })
        fireEvent.change(input, { target: { files: [new File(['3'], 'third.txt')] } })
      })
      expect(client.upload).toHaveBeenCalledTimes(1)
      expect(input.disabled).toBe(true)
    } finally {
      await act(async () => { release.resolve(undefined); await release.promise })
    }
    await waitFor(() => { expect(input.disabled).toBe(false) })
  })

  it('keeps a closed upload batch on its captured folder without republishing its old view', async () => {
    const client = makeClient()
    const releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    client.browse.mockImplementation(async (directoryId = '' as UserDocDirectoryIdType) => ({
      directoryId, directories: directoryId === '' ? [directory('reports')] : [],
      documents: [doc({ docId: `${directoryId || 'root'}/marker.txt`, name: directoryId === '' ? 'root-marker.txt' : 'folder-marker.txt' })],
      limits,
    }))
    client.upload.mockImplementation(async (file) => {
      await releases[file.name === 'a.txt' ? 0 : 1]!.promise
      return doc({ docId: `reports/${file.name}`, name: file.name })
    })
    createUserDocClient.mockReturnValue(client)
    const view = renderModal()
    fireEvent.click(await screen.findByRole('button', { name: t('folder.openNamed', { name: 'reports' }) }))
    await screen.findByText('folder-marker.txt')
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    try {
      fireEvent.change(input, { target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] } })
      await waitFor(() => { expect(client.upload).toHaveBeenCalledTimes(1) })
      view.rerender(<DocumentsModal open={false} onClose={() => {}} t={t} />)
      view.rerender(<DocumentsModal open onClose={() => {}} t={t} />)
      await screen.findByText('root-marker.txt')
      const readsAfterReopen = client.browse.mock.calls.length
      await act(async () => { releases[0]!.resolve(undefined); await releases[0]!.promise })
      await waitFor(() => { expect(client.upload).toHaveBeenCalledTimes(2) })
      expect(client.upload.mock.calls.map(call => call[1])).toEqual(['reports', 'reports'])
      expect(screen.queryByRole('progressbar')).toBeNull()
      expect(screen.getByRole('button', { name: t('modal.upload') }).hasAttribute('disabled')).toBe(true)
      await act(async () => { releases[1]!.resolve(undefined); await releases[1]!.promise })
      expect(screen.getByText('root-marker.txt')).toBeTruthy()
      expect(screen.queryByText('folder-marker.txt')).toBeNull()
      expect(client.browse).toHaveBeenCalledTimes(readsAfterReopen)
    } finally {
      await act(async () => {
        for (const release of releases) release.resolve(undefined)
        await Promise.all(releases.map(release => release.promise))
      })
    }
  })

  it.each(['ready', 'pending'] as const)(
    'keeps the reopened paged view navigable after an old upload batch completes with %s scope', async (scopeState) => {
      const client = makeClient()
      const releaseUpload = Promise.withResolvers<undefined>()
      const releaseScope = Promise.withResolvers<undefined>()
      const documents = Array.from({ length: 21 }, (_, index) => doc({
        docId: `root-${String(index + 1).padStart(2, '0')}.txt`,
        name: `root-${String(index + 1).padStart(2, '0')}.txt`, mediaType: 'text/plain',
      }))
      client.browse.mockImplementation(async (directoryId = '' as UserDocDirectoryIdType, _signal, query) => ({
        directoryId, directories: [], limits, totalDocuments: documents.length,
        documents: query?.cursor === 'next-page' ? documents.slice(20) : documents.slice(0, 20),
        ...(query?.cursor === undefined ? { nextCursor: 'next-page' } : {}),
      }))
      client.upload.mockImplementation(async (file) => {
        await releaseUpload.promise
        return doc({ docId: file.name, name: file.name })
      })
      let scopeReads = 0
      vi.stubGlobal('fetch', vi.fn(async () => {
        scopeReads += 1
        if (scopeState === 'pending') await releaseScope.promise
        return { ok: true, json: async () => ({
          scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
        }) }
      }))
      createUserDocClient.mockReturnValue(client)
      const view = renderModal()
      try {
        await screen.findByText('root-01.txt')
        if (scopeState === 'ready') await screen.findByRole('button', { name: /Compiler/ })
        const input = document.querySelector<HTMLInputElement>('input[type=file]')!
        fireEvent.change(input, { target: { files: [new File(['old'], 'old-upload.txt')] } })
        expect(client.upload).toHaveBeenCalledOnce()
        view.rerender(<DocumentsModal open={false} onClose={() => {}} t={t} />)
        view.rerender(<DocumentsModal open onClose={() => {}} t={t} />)
        await screen.findByText('root-01.txt')
        await waitFor(() => { expect(scopeReads).toBe(2) })
        const reopenedInput = document.querySelector<HTMLInputElement>('input[type=file]')!
        const readsAfterReopen = client.browse.mock.calls.length
        await act(async () => { releaseUpload.resolve(undefined); await releaseUpload.promise })
        await waitFor(() => { expect(reopenedInput.disabled).toBe(false) })
        await act(async () => { releaseScope.resolve(undefined); await releaseScope.promise })
        await screen.findByRole('button', { name: /Compiler/ })
        expect(screen.queryByText('old-upload.txt')).toBeNull()
        expect(screen.queryByRole('progressbar')).toBeNull()
        expect(client.browse).toHaveBeenCalledTimes(readsAfterReopen)
        fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
        expect(client.browse.mock.calls.slice(readsAfterReopen).map(call => call[2]?.cursor)).toEqual(['next-page'])
        await screen.findByText('root-21.txt')
        const readsAfterNext = client.browse.mock.calls.length
        fireEvent.click(screen.getByRole('button', { name: t('pager.prev') }))
        expect(client.browse.mock.calls.slice(readsAfterNext).map(call => call[2]?.cursor)).toEqual([undefined])
        await screen.findByText('root-01.txt')
        expect(scopeReads).toBe(2)
        expect(client.upload.mock.calls[0]?.[1]).toBe('')
      } finally {
        await act(async () => {
          releaseUpload.resolve(undefined)
          releaseScope.resolve(undefined)
          await Promise.all([releaseUpload.promise, releaseScope.promise])
        })
      }
    },
  )

  it('keeps a published upload batch summary when its authoritative listing fails', async () => {
    const client = makeClient()
    let published = false
    client.browse.mockImplementation(async () => {
      if (published) throw new Error('synthetic listing failure')
      return { directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [], limits }
    })
    client.upload.mockImplementation(async (file) => { published = true; return doc({ docId: file.name, name: file.name }) })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText(t('modal.empty'))
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.txt')] } })
    await screen.findByRole('alert')
    expect(screen.getByText('已上传 1 / 1 个文件')).toBeTruthy()
    expect(screen.queryByText(t('modal.empty'))).toBeNull()
    expect(screen.queryByText(t('modal.count', { count: '0' }))).toBeNull()
    expect(input.disabled).toBe(false)
    expect(client.browse).toHaveBeenCalledTimes(2)
  })

  it('ignores completed upload batch callbacks while the next batch owns progress', async () => {
    const client = makeClient()
    const releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const callbacks: Array<((loaded: number, total: number, phase?: UserDocUploadPhase) => void) | undefined> = []
    client.upload.mockImplementation(async (file, _directory, _signal, report) => {
      const index = callbacks.length
      callbacks.push(report)
      await releases[index]!.promise
      return doc({ docId: file.name, name: file.name })
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('report.pdf')
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    try {
      fireEvent.change(input, { target: { files: [new File(['a'], 'a.txt')] } })
      await waitFor(() => { expect(client.upload).toHaveBeenCalledTimes(1) })
      await act(async () => { releases[0]!.resolve(undefined); await releases[0]!.promise })
      await waitFor(() => { expect(input.disabled).toBe(false) })
      fireEvent.change(input, { target: { files: [new File(['b'], 'b.txt')] } })
      await waitFor(() => { expect(client.upload).toHaveBeenCalledTimes(2) })
      act(() => { callbacks[0]?.(90, 100) })
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
      expect(input.disabled).toBe(true)
    } finally {
      await act(async () => {
        for (const release of releases) release.resolve(undefined)
        await Promise.all(releases.map(release => release.promise))
      })
    }
  })

  it('reconciles an upload batch through the selected project without returning to personal', async () => {
    const client = makeClient()
    let published = false
    client.browseScope.mockImplementation(async (_scope, directoryId) => ({
      version: 1, scope: { kind: 'project' as const, label: 'Compiler' }, directoryId, directories: [],
      documents: published ? [doc({ docId: 'project/a.txt', name: 'a.txt' })] : [],
    }))
    client.uploadToScope.mockImplementation(async (_scope, file) => {
      if (file.name === 'b.txt') throw new Error('synthetic project failure')
      published = true
      return doc({ docId: `project/${file.name}`, name: file.name })
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
    }) })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: /Compiler/ }))
    await screen.findByText(t('scope.upload.target', { name: 'Compiler' }), { selector: 'strong' })
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    fireEvent.change(input, { target: { files: ['a', 'b', 'c'].map(name => new File([name], `${name}.txt`)) } })
    await screen.findByText('a.txt')
    expect(screen.getByRole('alert').textContent).toContain('b.txt')
    expect(client.upload).not.toHaveBeenCalled()
    expect(client.browse).toHaveBeenCalledOnce()
    expect(client.browseScope).toHaveBeenCalledTimes(2)
    expect(client.browseScope.mock.calls.every(call => call[0].kind === 'project' && call[0].projectId === 41)).toBe(true)
    expect(screen.getByText(t('scope.upload.target', { name: 'Compiler' }), { selector: 'strong' })).toBeTruthy()
  })

  it('keeps upload batch reconciliation on the filtered server page without inserting upload refs', async () => {
    const client = makeClient()
    const documents = Array.from({ length: 21 }, (_, index) => doc({
      docId: `keep-${String(index + 1).padStart(2, '0')}.txt`,
      name: `keep-${String(index + 1).padStart(2, '0')}.txt`, mediaType: 'text/plain',
    }))
    client.browse.mockImplementation(async (_directory, _signal, request) => ({
      directoryId: '' as UserDocDirectoryIdType, directories: [],
      documents: request?.cursor === 'next-page' ? documents.slice(20) : documents.slice(0, 20), limits,
      totalDocuments: 21, ...(request?.cursor === undefined ? { nextCursor: 'next-page' } : {}),
    }))
    client.upload.mockImplementation(async file => doc({ docId: file.name, name: file.name, mediaType: 'text/plain' }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ scope: { kind: 'personal' } }) })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText('keep-01.txt')
    fireEvent.change(screen.getByPlaceholderText(t('modal.search')), { target: { value: 'keep' } })
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.type') }), { target: { value: 'text' } })
    fireEvent.change(screen.getByRole('combobox', { name: t('modal.sort') }), { target: { value: 'name:asc' } })
    await waitFor(() => { expect(client.browse.mock.lastCall?.[2]).toMatchObject({ query: 'keep', type: 'text', sort: 'name-asc' }) })
    await waitFor(() => { expect(screen.queryByText(t('modal.refreshing'))).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: t('pager.next') }))
    await screen.findByText('keep-21.txt')
    const before = client.browse.mock.calls.length
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!
    fireEvent.change(input, { target: { files: [new File(['new'], 'outside-filter.txt')] } })
    await waitFor(() => { expect(client.browse.mock.calls.length).toBe(before + 2) })
    await waitFor(() => { expect(input.disabled).toBe(false) })
    expect(screen.getByText('keep-21.txt')).toBeTruthy()
    expect(screen.getByText(t('pager.status', { page: '2', pages: '2' }))).toBeTruthy()
    expect(screen.queryByText('outside-filter.txt')).toBeNull()
    expect(screen.getByPlaceholderText(t('modal.search')).getAttribute('value')).toBe('keep')
    expect(client.browse.mock.calls.slice(before).map(call => call[2])).toEqual([
      expect.objectContaining({ query: 'keep', type: 'text', sort: 'name-asc' }),
      expect.objectContaining({ query: 'keep', type: 'text', sort: 'name-asc', cursor: 'next-page' }),
    ])
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

  it.each([false, true])('copies into the captured project pane before attaching, and preserves ACL refusal (%s)', async (refused) => {
    const client = makeClient()
    const attach = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }] }),
    })))
    if (refused) client.transfer.mockRejectedValue(new UserDocHttpError(403, 'Project permission revoked'))
    createUserDocClient.mockReturnValue(client)
    render(<DocumentsModal open onClose={() => {}} t={t} mode="select"
      attachmentScope={{ kind: 'project', projectId: 41 }} onAttachDocument={attach} />)
    await screen.findByText('report.pdf')
    fireEvent.click(namedButton('attach', 'report.pdf'))
    await waitFor(() => { expect(client.transfer).toHaveBeenCalledOnce() })
    expect(client.transfer).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: 'personal' }, target: { kind: 'project', projectId: 41 },
    }))
    if (refused) {
      await screen.findByText('Project permission revoked')
      expect(attach).not.toHaveBeenCalled()
    } else {
      await waitFor(() => { expect(attach).toHaveBeenCalledWith(expect.objectContaining({ docId: 'report.pdf' })) })
      expect(attach).not.toHaveBeenCalledWith(expect.objectContaining({ docId: '2026-08-17/report.pdf' }))
    }
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
    await waitFor(() => { expect(client.browseScope).toHaveBeenCalledWith({ kind: 'project', projectId: 41 }, '', expect.any(AbortSignal), expect.objectContaining({ limit: 20 })) })
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
    await screen.findByText('report.pdf')
    expect(screen.queryByRole('button', { name: t('copy.source.current') })).toBeNull()
    expect(client.browse).toHaveBeenCalledOnce()
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

  it.each([
    { compact: false, target: 'personal' }, { compact: false, target: 'project' },
    { compact: true, target: 'personal' }, { compact: true, target: 'project' },
  ] as const)('returns from $target trash to its cached folder and restores focus (compact=$compact)', async ({ compact, target }) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 23, 12))
    if (compact) stubPhoneMedia()
    const client = makeClient()
    let restored = false
    const restoredDocument = doc({ docId: 'reports/restored.txt', name: 'restored.txt', mediaType: 'text/plain' })
    const listing = (directoryId: UserDocDirectoryIdType) => ({
      version: 1 as const,
      directoryId,
      directories: directoryId === '' ? [directory('reports')] : [],
      documents: directoryId === 'reports' && restored ? [restoredDocument] : [],
      limits,
      scope: { kind: 'project' as const, label: 'Compiler' },
    })
    const restoredListing = Promise.withResolvers<ReturnType<typeof listing>>()
    const restoredListingRequested = Promise.withResolvers<undefined>()
    const browse = async (id: UserDocDirectoryIdType) => {
      if (restored && id === 'reports') {
        restoredListingRequested.resolve(undefined)
        return await restoredListing.promise
      }
      return listing(id)
    }
    client.browse.mockImplementation(async (id = '' as UserDocDirectoryIdType) => await browse(id))
    client.browseScope.mockImplementation(async (_scope, id) => await browse(id))
    const trashDocument: UserDocTrashRef = {
      ...restoredDocument, docId: restoredDocument.docId as UserDocIdType,
      directoryId: 'reports' as UserDocDirectoryIdType,
      trashedAt: 1, purgeAfter: Date.now() + 86_400_000,
    }
    client.listTrash.mockResolvedValue({ version: 1, documents: [trashDocument] })
    client.listTrashInScope.mockResolvedValue({ version: 1, documents: [trashDocument] })
    client.restore.mockImplementation(async () => { restored = true; return restoredDocument })
    client.restoreInScope.mockImplementation(async () => { restored = true; return restoredDocument })
    const context = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        scope: { kind: 'personal' }, projects: [{ projectId: 41, name: 'Compiler', mode: 'rw' }],
      }),
    }))
    vi.stubGlobal('fetch', context)
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByRole('button', { name: t('folder.openNamed', { name: 'reports' }) })
    if (target === 'project') {
      if (compact) {
        fireEvent.click(screen.getByTestId('documents-scope-trigger'))
        const scopes = await screen.findByRole('dialog', { name: t('scope.switch.title') })
        fireEvent.click(within(scopes).getByRole('option', { name: /Compiler/ }))
      } else fireEvent.click(screen.getByRole('button', { name: /Compiler/ }))
      await waitFor(() => { expect(client.browseScope).toHaveBeenCalledTimes(1) })
      await screen.findAllByText(t('scope.upload.target', { name: 'Compiler' }))
    }
    fireEvent.click(screen.getByRole('button', { name: t('folder.openNamed', { name: 'reports' }) }))
    const navigation = screen.getByRole('navigation', { name: t('breadcrumb.label') })
    await waitFor(() => { expect(within(navigation).getByRole('button', { name: 'reports' }).hasAttribute('disabled')).toBe(true) })
    const before = { local: client.browse.mock.calls.length, remote: client.browseScope.mock.calls.length }
    const enterTrash = async () => {
      if (compact) {
        fireEvent.click(screen.getByRole('button', { name: t('action.more') }))
        const more = await screen.findByRole('dialog', { name: t('action.more') })
        fireEvent.click(within(more).getByRole('button', { name: t('trash.button') }))
      } else fireEvent.click(screen.getByRole('button', { name: t('trash.button') }))
      return await screen.findByRole('region', { name: t('trash.title') })
    }
    const firstTrash = await enterTrash()
    const back = within(firstTrash).getByRole('button', { name: t('trash.back') })
    back.focus()
    fireEvent.click(back)
    await waitFor(() => { expect(screen.queryByRole('region', { name: t('trash.title') })).toBeNull() })
    const returnTarget = screen.getByRole('button', { name: t(compact ? 'action.more' : 'trash.button') })
    expect(document.activeElement).toBe(returnTarget)
    expect(within(navigation).getByRole('button', { name: 'reports' }).hasAttribute('disabled')).toBe(true)
    expect(client.browse).toHaveBeenCalledTimes(before.local)
    expect(client.browseScope).toHaveBeenCalledTimes(before.remote)
    if (target === 'project') expect(screen.getAllByText(t('scope.upload.target', { name: 'Compiler' })).length).toBeGreaterThan(0)
    const secondTrash = await enterTrash()
    fireEvent.click(within(secondTrash).getByRole('button', { name: t('trash.restoreNamed', { name: 'restored.txt' }) }))
    await waitFor(() => { expect(within(secondTrash).queryByRole('button', { name: t('trash.restoreNamed', { name: 'restored.txt' }) })).toBeNull() })
    expect(client.browse).toHaveBeenCalledTimes(before.local)
    expect(client.browseScope).toHaveBeenCalledTimes(before.remote)
    fireEvent.click(within(secondTrash).getByRole('button', { name: t('trash.back') }))
    try {
      await restoredListingRequested.promise
      expect(screen.getAllByRole('status').filter(node => node.textContent === t('modal.loading'))).toHaveLength(1)
      expect(screen.queryByText(t('modal.empty'))).toBeNull()
      expect(screen.queryByText(t('modal.count', { count: '0' }))).toBeNull()
      expect(screen.queryByText(t('modal.refreshing'))).toBeNull()
      expect(within(navigation).getByRole('button', { name: 'reports' }).hasAttribute('disabled')).toBe(true)
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t(compact ? 'action.more' : 'trash.button') }))
    } finally { restoredListing.resolve(listing('reports' as UserDocDirectoryIdType)) }
    await screen.findByText('restored.txt')
    expect(client.browse).toHaveBeenCalledTimes(before.local + (target === 'personal' ? 1 : 0))
    expect(client.browseScope).toHaveBeenCalledTimes(before.remote + (target === 'project' ? 1 : 0))
    expect(context).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t(compact ? 'action.more' : 'trash.button') }))
  })

  it.each(['success', 'failure'] as const)('shows loading instead of an empty result until an empty-folder refresh settles: %s', async (outcome) => {
    const client = makeClient()
    const empty = { directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [], limits }
    const refresh = Promise.withResolvers<typeof empty>()
    const requested = Promise.withResolvers<undefined>()
    client.browse.mockResolvedValueOnce(empty).mockImplementationOnce(async () => {
      requested.resolve(undefined)
      return await refresh.promise
    })
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByText(t('modal.empty'))
    fireEvent.click(screen.getByRole('button', { name: t('modal.refresh') }))
    try {
      await requested.promise
      expect(screen.getAllByRole('status').filter(node => node.textContent === t('modal.loading'))).toHaveLength(1)
      expect(screen.queryByText(t('modal.empty'))).toBeNull()
      expect(screen.queryByText(t('modal.count', { count: '0' }))).toBeNull()
      expect(screen.queryByText(t('modal.refreshing'))).toBeNull()
    } finally {
      if (outcome === 'success') refresh.resolve(empty)
      else refresh.reject(new Error('metadata unavailable'))
    }
    await screen.findByText(t('modal.empty'))
    expect(screen.getByText(t('modal.count', { count: '0' }))).toBeTruthy()
    expect(screen.queryByText(t('modal.loading'))).toBeNull()
    expect(client.browse).toHaveBeenCalledTimes(2)
    if (outcome === 'failure') expect(screen.getByRole('alert').textContent).toContain('metadata unavailable')
  })

  it('keeps the cached folder after a failed restore and retains the trash document', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 23, 12))
    const client = makeClient()
    client.browse.mockResolvedValue({ directoryId: '' as UserDocDirectoryIdType, directories: [], documents: [], limits })
    client.listTrash.mockResolvedValue({
      version: 1,
      documents: [{
        ...doc(), docId: '2026-08-17/report.pdf' as UserDocIdType, directoryId: '' as UserDocDirectoryIdType,
        trashedAt: 1, purgeAfter: Date.now() + 86_400_000,
      }],
    })
    client.restore.mockRejectedValue(new Error('restore unavailable'))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ scope: { kind: 'personal' } }) })))
    createUserDocClient.mockReturnValue(client)
    renderModal()
    await screen.findByRole('button', { name: t('trash.button') })
    await waitFor(() => { expect(client.browse).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: t('trash.button') }))
    const trash = await screen.findByRole('region', { name: t('trash.title') })
    const restore = within(trash).getByRole('button', { name: t('trash.restoreNamed', { name: 'report.pdf' }) })
    fireEvent.click(restore)
    await screen.findByRole('alert')
    expect(within(trash).getByRole('button', { name: t('trash.restoreNamed', { name: 'report.pdf' }) })).toBe(restore)
    fireEvent.click(within(trash).getByRole('button', { name: t('trash.back') }))
    await waitFor(() => { expect(screen.queryByRole('region', { name: t('trash.title') })).toBeNull() })
    expect(client.browse).toHaveBeenCalledOnce()
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

it.each(['application/pdf', 'image/png'])('pins %s preview and download URLs to their account', async (mediaType) => {
  const client = makeClient()
  const name = mediaType === 'application/pdf' ? 'pinned.pdf' : 'pinned.png'
  client.browse.mockImplementation(async () => ({ directoryId: '' as UserDocDirectoryIdType,
    directories: [], documents: [doc({ docId: `2026-08-17/${name}`, name, mediaType })], limits }))
  createUserDocClient.mockReturnValue(client)
  const pin = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}dshPrincipal=7`
  render(<DocumentsModal open onClose={() => {}} t={t} privateResourceUrl={pin} />)
  await screen.findByText(name)
  expect(screen.getByRole('link', { name: t('action.downloadNamed', { name }) }).getAttribute('href')).toContain('dshPrincipal=7')
  fireEvent.click(namedButton('preview', name))
  const preview = await screen.findByRole('dialog', { name: t('preview.title', { name }) })
  const content = mediaType === 'application/pdf' ? within(preview).getByTitle(name) : within(preview).getByRole('img', { name })
  expect(content.getAttribute('src')).toContain('dshPrincipal=7')
})
