// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react'
import { WorkspaceResourceRegistry, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFileTab } from '../src/client/components/WorkspaceFileTab.tsx'
import { FontNotice } from '../src/client/office/FontNotice.tsx'

afterEach(cleanup)
const sessionId = 'files-owner' as SessionId

function harness(path = 'a.txt') {
  const resources = new WorkspaceResourceRegistry()
  resources.register({ kind: 'project', projectId: 8 }, {
    stat: async () => ({ sessionId, path, type: 'file', version: 'v1', changed: false }),
  }, 5)
  const close = vi.fn()
  const runtimeTarget = () => ({ kind: 'project' as const, projectId: 8 })
  const readPreview = vi.fn(async () => ({ path, offset: 1, limit: 20, text: 'project content', version: 'v1', eof: true }))
  const readBytesPreview = vi.fn()
  const readFileBytes = vi.fn(async () => ({ data: new Uint8Array(), version: 'v1' }))
  const readDocument = vi.fn()
  const props = (visible: boolean, line?: number, revision = 0) => ({
    sessionId, resources, runtimeTarget, readPreview, readBytesPreview, readFileBytes, readDocument,
    renderHtml: vi.fn(async () => '<html></html>'), fontNotice: FontNotice,
    markdownT: (key: string) => key, htmlT: (key: string) => key, pdfT: (key: string) => key, officeT: (key: string) => key,
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
    markdownView.unmount()

    const html = harness('page.html')
    const htmlView = render(<WorkspaceFileTab {...html.props(true)} />)
    await waitFor(() => { expect(html.readFileBytes).toHaveBeenCalled() })
    expect(html.readPreview).not.toHaveBeenCalled()
    htmlView.unmount()
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
