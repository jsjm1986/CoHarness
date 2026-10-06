// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { WorkspaceResourceError, WorkspaceResourceRegistry, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFileTab } from '../src/client/components/WorkspaceFileTab.tsx'
import { previewRequest } from './workspace-preview-resource.fixture.tsx'

vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: ({ data }: { data: Uint8Array }) => <pre data-testid="pdf">{new TextDecoder().decode(data)}</pre> }))
vi.mock('../src/client/excel/LazyExcelBody.tsx', () => ({ LazyExcelBody: ({ path }: { path: string }) => <pre data-testid="excel">{path}</pre> }))

afterEach(cleanup)
const sessionId = 'files-owner' as SessionId

function harness(path = 'a.txt') {
  const resources = new WorkspaceResourceRegistry()
  resources.register({ kind: 'project', projectId: 8 }, {
    stat: async () => ({ sessionId, path, type: 'file', version: 'v1', changed: false }),
  }, 5)
  const close = vi.fn()
  const runtimeTarget = () => ({ kind: 'project' as const, projectId: 8 })
  // The test twin of the renderer's keyedHooks binding: an address-keyed source
  // with a memoized selector, so an identical snapshot never reselects.
  const useWorkspaceResource = (
    address: string, selector?: (state: unknown) => unknown, equal?: (a: unknown, b: unknown) => boolean,
  ): unknown => {
    const select = selector ?? ((value: unknown) => value)
    const source = useMemo(() => (
      address === '' ? undefined : resources.source(previewRequest(address, sessionId, runtimeTarget()))
    ), [address])
    const cache = useRef<{ snap: unknown; selected: unknown } | undefined>(undefined)
    const getSnapshot = useCallback(() => {
      if (source === undefined) return select(undefined)
      const snap = source.getSnapshot()
      if (cache.current !== undefined && Object.is(cache.current.snap, snap)) return cache.current.selected
      const selected = select(snap)
      cache.current = {
        snap,
        selected: cache.current !== undefined && equal !== undefined && equal(cache.current.selected, selected)
          ? cache.current.selected
          : selected,
      }
      return cache.current.selected
    }, [source, select, equal])
    return useSyncExternalStore(source?.subscribe ?? (() => () => {}), getSnapshot)
  }
  const readPreview = vi.fn(async () => ({ path, offset: 1, limit: 20, text: 'project content', version: 'v1', eof: true }))
  const readBytesPreview = vi.fn()
  const readFileBytes = vi.fn(async () => ({ bytes: '', version: 'v1' }))
  const readDocument = vi.fn(async () => ({ bytes: btoa('PDF v1'), version: 'v1', missingFonts: [] as string[] }))
  const props = (visible: boolean, line?: number, revision = 0) => ({
    sessionId, runtimeTarget, useWorkspaceResource, readPreview, readBytesPreview, readFileBytes, readDocument,
    reloadResource: (request: WorkspaceResourceOpenRequest) => resources.source(request).reload(),
    revokeResource: (request: WorkspaceResourceOpenRequest, message: string) => {
      resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', message))
    },
    renderHtml: vi.fn(async () => '<html></html>'),
    markdownT: (key: string) => key, htmlT: (key: string) => key, pdfT: (key: string) => key, officeT: (key: string) => key,
    excelT: (key: string) => key, excelLimits: { maxBytes: 1024, maxCells: 1000, timeoutMs: 5000 },
    t: (key: string) => key,
    useTabInfo: () => ({
      tab: {
        visible, actions: { close },
        navigation: { address: workspaceResourceAddress(sessionId, path), revision, params: line === undefined ? undefined : { line } },
      },
    }),
  }) as unknown as Parameters<typeof WorkspaceFileTab>[0]
  return { props, close, readPreview, readFileBytes, readDocument }
}

describe('workspace file tab', () => {
  it('reads only visible content from the owning runtime and closes its own occurrence', async () => {
    const h = harness()
    const view = render(<WorkspaceFileTab {...h.props(false)} />)
    expect(h.readPreview).not.toHaveBeenCalled()
    view.rerender(<WorkspaceFileTab {...h.props(true)} />)
    await waitFor(() => { expect(view.getByText('project content')).toBeTruthy() })
    expect(h.readPreview).toHaveBeenCalledWith({
      resource: { runtimeTarget: { kind: 'project', projectId: 8 }, sessionId, path: 'a.txt', address: workspaceResourceAddress(sessionId, 'a.txt') },
      offset: 1, version: 'v1',
    }, expect.any(AbortSignal))
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'previewClose' }))
    expect(h.close).toHaveBeenCalledOnce()
    const signal = (h.readPreview.mock.calls[0] as unknown as [unknown, AbortSignal])[1]
    view.rerender(<WorkspaceFileTab {...h.props(false)} />)
    expect(signal.aborted).toBe(true)
    expect(view.queryByText('project content')).toBeNull()
  })

  it('opens a requested line and moves an existing file tab to a new line without a second resource owner', async () => {
    const h = harness()
    const view = render(<WorkspaceFileTab {...h.props(true, 24, 1)} />)
    await waitFor(() => { expect(h.readPreview).toHaveBeenCalledWith(expect.objectContaining({ offset: 24 }), expect.any(AbortSignal)) })
    const firstSignal = (h.readPreview.mock.calls[0] as unknown as [unknown, AbortSignal])[1]
    view.rerender(<WorkspaceFileTab {...h.props(true, 3, 2)} />)
    await waitFor(() => { expect(h.readPreview).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 3 }), expect.any(AbortSignal)) })
    expect(firstSignal.aborted).toBe(true)
    expect(view.getAllByRole('region')).toHaveLength(1)
  })

  it('routes Markdown to the accumulated renderer and HTML to the byte reader on the same resource service', async () => {
    const markdown = harness('guide.md')
    const markdownView = render(<WorkspaceFileTab {...markdown.props(true)} />)
    await waitFor(() => { expect(markdown.readPreview).toHaveBeenCalled() })
    expect(markdownView.container.querySelector('[data-workspace-markdown]')).not.toBeNull()
    expect(markdown.readFileBytes).not.toHaveBeenCalled()
    fireEvent.click(markdownView.getByRole('button', { name: 'previewClose' }))
    expect(markdown.close).toHaveBeenCalledOnce()
    markdownView.unmount()

    const html = harness('page.html')
    const htmlView = render(<WorkspaceFileTab {...html.props(true)} />)
    await waitFor(() => { expect(html.readFileBytes).toHaveBeenCalled() })
    expect(html.readPreview).not.toHaveBeenCalled()
    fireEvent.click(htmlView.getByRole('button', { name: 'previewClose' }))
    expect(html.close).toHaveBeenCalledOnce()
    htmlView.unmount()
  })

  it('routes a document suffix to the document preview and closes from its toolbar', async () => {
    const h = harness('report.pdf')
    const view = render(<WorkspaceFileTab {...h.props(true)} />)
    await waitFor(() => { expect(view.getByTestId('pdf')).toBeTruthy() })
    expect(h.readDocument).toHaveBeenCalled()
    expect(h.readPreview).not.toHaveBeenCalled()
    expect(h.readFileBytes).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'previewClose' }))
    expect(h.close).toHaveBeenCalledOnce()
  })

  it.each(['book.xlsx', 'legacy.xls', 'table.csv'])('routes the %s suffix to the browser spreadsheet body, never office-to-pdf', async (path) => {
    const h = harness(path)
    const view = render(<WorkspaceFileTab {...h.props(true)} />)
    await waitFor(() => { expect(view.getByTestId('excel')).toBeTruthy() })
    expect(h.readFileBytes).toHaveBeenCalled()
    expect(h.readDocument).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'previewClose' }))
    expect(h.close).toHaveBeenCalledOnce()
  })

  it.each(['notes.docx', 'slides.ppt'])('keeps %s on the Office conversion reader', async (path) => {
    const h = harness(path)
    const view = render(<WorkspaceFileTab {...h.props(true)} />)
    await waitFor(() => { expect(view.getByTestId('pdf')).toBeTruthy() })
    expect(h.readDocument).toHaveBeenCalled()
    expect(view.queryByTestId('excel')).toBeNull()
  })

  it('rejects a tab address belonging to another Session before reading', () => {
    const h = harness()
    const props = { ...h.props(true), sessionId: 'different' as SessionId }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<WorkspaceFileTab {...props} />)).toThrow('does not belong to this Session')
      expect(h.readPreview).not.toHaveBeenCalled()
    } finally { consoleError.mockRestore() }
  })
})
