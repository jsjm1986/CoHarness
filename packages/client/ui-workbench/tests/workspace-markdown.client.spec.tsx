// @vitest-environment jsdom
/** Markdown accumulation and rendering follow the existing resource's access lifetime. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceResourceRegistry, WorkspaceResourceError, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceFileTextPage } from '@deepseek-ai/dsh-api-remotes/client'
import { WorkspaceMarkdownPreview, isWorkspaceMarkdown } from '../src/client/components/WorkspaceMarkdownPreview.tsx'
import type { ReadWorkspacePreview } from '../src/client/components/WorkspaceFilePreview.tsx'
import { en } from '../src/client/markdown/locales.ts'

afterEach(cleanup)
const id = 'markdown-session' as SessionId
const request: WorkspaceResourceOpenRequest = {
  sessionId: id, runtimeTarget: { kind: 'base' }, path: 'notes.md', address: workspaceResourceAddress(id, 'notes.md'),
}
const page = (offset: number, text: string, eof: boolean, version = 'v1'): WorkspaceFileTextPage => ({
  path: request.path, offset, limit: 5, text, eof, version,
})
function harness(read: ReadWorkspacePreview) {
  const resources = new WorkspaceResourceRegistry()
  let version = 'v1'
  resources.register(request.runtimeTarget, {
    stat: async () => ({ sessionId: id, path: request.path, type: 'file', version, bytes: 10, changed: false }),
  }, 5)
  const close = vi.fn()
  const view = render(<WorkspaceMarkdownPreview request={request} resources={resources} read={read}
    markdownT={makeTranslate(en)} close={close}
    labels={{ close: 'Close', reload: 'Reload', loading: 'Reading', changed: 'File changed' }} />)
  return { ...view, resources, close, change() {
    version = 'v2'
    resources.handleChange(request.runtimeTarget, { sessionId: id, path: request.path, version })
  } }
}

describe('WorkspaceMarkdownPreview', () => {
  it('accumulates paged reads into one rendered document with localized chrome', async () => {
    const read = vi.fn<ReadWorkspacePreview>(async ({ offset, version: v }) => (
      offset === 1 ? page(1, '# Title\n\nfirst\n', false, v) : page(6, 'second **bold**\n', true, v)
    ))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('heading', { name: 'Title' })).toBeTruthy() })
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.map(call => [call[0].offset, call[0].version])).toEqual([[1, 'v1'], [6, 'v1']])
    expect(view.container.querySelector('strong')?.textContent).toBe('bold')
    expect(view.container.querySelector('[data-workspace-markdown]')).not.toBeNull()
  })

  it('retains the displayed revision until explicit reload, then clears it immediately on revocation', async () => {
    const read = vi.fn<ReadWorkspacePreview>(async ({ version: v }) => page(1, `# ${v}`, true, v))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('heading', { name: 'v1' })).toBeTruthy() })
    act(() => { view.change() })
    expect(view.getByText('File changed')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(view.getByRole('heading', { name: 'v2' })).toBeTruthy() })
    act(() => { view.resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', 'Access revoked')) })
    expect(view.container.querySelector('[data-workspace-markdown]')).toBeNull()
    expect(read.mock.calls.at(-1)![1].aborted).toBe(true)
    expect(view.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(view.close).toHaveBeenCalledOnce()
  })

  it('aborts a pending accumulation on unmount without publishing', async () => {
    const pending = Promise.withResolvers<WorkspaceFileTextPage>()
    const read = vi.fn<ReadWorkspacePreview>().mockReturnValueOnce(pending.promise)
    const view = harness(read)
    await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    view.unmount()
    expect(read.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => { pending.resolve(page(1, '# late', true)) })
    expect(view.container.childElementCount).toBe(0)
  })

  it('ignores a read failure arriving after disposal', async () => {
    const pending = Promise.withResolvers<WorkspaceFileTextPage>()
    const read = vi.fn<ReadWorkspacePreview>().mockReturnValueOnce(pending.promise)
    const view = harness(read)
    await waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => { pending.reject(new Error('transport closed')) })
    expect(view.container.childElementCount).toBe(0)
  })

  it('reports a read rejection and permits retry', async () => {
    const read = vi.fn<ReadWorkspacePreview>()
      .mockRejectedValueOnce('read interrupted')
      .mockResolvedValueOnce(page(1, '# ok', true))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('read interrupted') })
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(view.getByRole('heading', { name: 'ok' })).toBeTruthy() })
  })

  it('propagates a denied read to every resource on the owning runtime', async () => {
    const read = vi.fn<ReadWorkspacePreview>().mockRejectedValue(new WorkspaceResourceError('access-revoked', 'Permission removed'))
    const view = harness(read)
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Permission removed') })
    expect(view.resources.source(request).get().error?.message).toBe('Permission removed')
    expect(view.container.querySelector('[data-workspace-markdown]')).toBeNull()
    expect(view.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.calls[0]![1].aborted).toBe(true)
  })

  it('recognizes Markdown suffixes only', () => {
    expect(isWorkspaceMarkdown('notes.md')).toBe(true)
    expect(isWorkspaceMarkdown('README.MARKDOWN')).toBe(true)
    expect(isWorkspaceMarkdown('notes.mdx')).toBe(false)
    expect(isWorkspaceMarkdown('notes.txt')).toBe(false)
  })
})
