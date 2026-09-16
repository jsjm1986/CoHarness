// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFileTextPage, WorkspaceFileByteWindow } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import {
  WorkspaceResourceError, WorkspaceResourceRegistry, workspaceResourceAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceFilePreview } from '../src/client/components/WorkspaceFilePreview.tsx'

afterEach(cleanup)
const sessionId = 'preview-session' as SessionId
const request: WorkspaceResourceOpenRequest = {
  runtimeTarget: { kind: 'base' }, sessionId, path: 'notes.txt', address: workspaceResourceAddress(sessionId, 'notes.txt'),
}
const imageRequest: WorkspaceResourceOpenRequest = {
  ...request, path: 'assets/screenshot.png', address: workspaceResourceAddress(sessionId, 'assets/screenshot.png'),
}
const extensionlessRequest: WorkspaceResourceOpenRequest = {
  ...request, path: 'README', address: workspaceResourceAddress(sessionId, 'README'),
}
const labels = {
  close: 'Close', reload: 'Reload', previous: 'Previous', next: 'Next', loading: 'Loading',
  changed: 'Changed; reload', binary: 'Binary (Base64)',
}
function harness(value: { version: string; bytes: number } = { version: 'v1', bytes: 10 }) {
  const resources = new WorkspaceResourceRegistry()
  let current = value
  resources.register({ kind: 'base' }, {
    stat: async () => ({ sessionId, path: request.path, type: 'file', ...current, changed: false }),
  }, 5)
  return { resources, setVersion: (version: string) => { current = { ...current, version } } }
}
function renderPreview(
  read: (
    request: { resource: WorkspaceResourceOpenRequest; offset: number; version: string }, signal: AbortSignal,
  ) => Promise<WorkspaceFileTextPage>,
  options: {
    readBytes?: (
      request: { resource: WorkspaceResourceOpenRequest; offset: number; length: number; version: string },
      signal: AbortSignal,
    ) => Promise<WorkspaceFileByteWindow>
  } = {},
) {
  const h = harness()
  return {
    ...h,
    ...render(<WorkspaceFilePreview request={request} read={read} readBytes={options.readBytes}
      resources={h.resources} close={vi.fn()} labels={labels} />),
  }
}

describe('WorkspaceFilePreview', () => {
  it('loads versioned text, pages forward and back, and reloads metadata', async () => {
    const read = vi.fn(async ({ offset, version }: { offset: number; version: string }) => ({ path: request.path, offset, limit: 2, text: `${version}:${offset}`, eof: offset > 1, version }))
    const view = renderPreview(read)
    await waitFor(() => { expect(view.getByText('v1:1')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Next' }))
    await waitFor(() => { expect(view.getByText('v1:3')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Previous' }))
    await waitFor(() => { expect(view.getByText('v1:1')).toBeTruthy() })
    view.setVersion('v2')
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(view.getByText('v2:1')).toBeTruthy() })
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ offset: 1, version: 'v2' }), expect.any(AbortSignal))
  })

  it('marks an observation stale without replacing visible text', async () => {
    const read = vi.fn(async ({ version }: { version: string }) => ({
      path: request.path, offset: 1, limit: 2, text: version, eof: true, version,
    }))
    const view = renderPreview(read)
    await waitFor(() => { expect(view.getByText('v1')).toBeTruthy() })
    view.resources.handleChange({ kind: 'base' }, { sessionId, path: request.path, version: 'v2' })
    await waitFor(() => { expect(view.getByText('Changed; reload')).toBeTruthy() })
    expect(view.getByText('v1')).toBeTruthy()
  })

  it('falls back to a bounded Base64 window for a binary file', async () => {
    const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    const readBytes = vi.fn(async () => ({ path: request.path, offset: 0, bytes: 'AAEC', eof: true, version: 'v1' }))
    const view = renderPreview(read, { readBytes })
    await waitFor(() => { expect(view.getByText(/Binary \(Base64\)/)).toBeTruthy() })
    expect(view.getByText(/AAEC/)).toBeTruthy()
    expect(readBytes).toHaveBeenCalledWith(expect.objectContaining({ length: 10, version: 'v1' }), expect.any(AbortSignal))
  })

  it('hides content when the target loses access and reports an ordinary failure', async () => {
    const read = vi.fn(async () => ({ path: request.path, offset: 1, limit: 2, text: 'visible', eof: true, version: 'v1' }))
    const view = renderPreview(read)
    await waitFor(() => { expect(view.getByText('visible')).toBeTruthy() })
    view.resources.disconnect({ kind: 'base' }, new WorkspaceResourceError('access-revoked', 'revoked'))
    await waitFor(() => { expect(view.queryByText('visible')).toBeNull() })
    expect(view.getByRole('alert').textContent).toBe('revoked')
  })
})

it('renders a fixed image MIME type from the bounded byte window', async () => {
  const resources = new WorkspaceResourceRegistry()
  resources.register({ kind: 'base' }, {
    stat: async () => ({ sessionId, path: imageRequest.path, type: 'file', bytes: 3, version: 'v1', changed: false }),
  }, 5)
  const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
  const readBytes = vi.fn(async () => ({ path: imageRequest.path, offset: 0, bytes: 'AAEC', eof: true, version: 'v1' }))
  render(<WorkspaceFilePreview request={imageRequest} read={read} readBytes={readBytes}
    resources={resources} close={vi.fn()} labels={labels} />)
  await waitFor(() => { expect(document.querySelector('[data-workspace-file-image]')).toBeTruthy() })
  expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAEC')
})

it('keeps unknown binary types in the Base64 fallback', async () => {
  const resources = new WorkspaceResourceRegistry()
  resources.register({ kind: 'base' }, {
    stat: async () => ({ sessionId, path: extensionlessRequest.path, type: 'file', bytes: 2, version: 'v1', changed: false }),
  }, 5)
  const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
  const readBytes = vi.fn(async () => ({ path: extensionlessRequest.path, offset: 0, bytes: 'AAE=', eof: true, version: 'v1' }))
  render(<WorkspaceFilePreview request={extensionlessRequest} read={read} readBytes={readBytes}
    resources={resources} close={vi.fn()} labels={labels} />)
  await waitFor(() => { expect(document.querySelector('[data-workspace-file-bytes]')).toBeTruthy() })
})

describe('WorkspaceFilePreview failure paths', () => {
  it('waits for a provider and keeps an unmounted request from publishing', async () => {
    const registry = new WorkspaceResourceRegistry()
    const read = vi.fn(() => new Promise<WorkspaceFileTextPage>(() => {}))
    const view = render(<WorkspaceFilePreview request={request} read={read} resources={registry} close={vi.fn()} labels={labels} />)
    expect(view.queryByRole('status')).toBeNull()
    view.unmount()
  })

  it('retains a plain read failure and handles a failed byte fallback', async () => {
    const read = vi.fn(async () => { throw 'plain provider failure' })
    const readBytes = vi.fn(async () => { throw new Error('byte window failed') })
    const view = renderPreview(read, { readBytes })
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('plain provider failure') })
    view.unmount()

    const binary = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    const bytes = vi.fn(async () => { throw 'plain byte failure' })
    const failed = renderPreview(binary, { readBytes: bytes })
    await waitFor(() => { expect(failed.getByRole('alert').textContent).toBe('plain byte failure') })
  })

  it('contains a failed binary access fallback and retains the error', async () => {
    const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    const readBytes = vi.fn(async () => { throw new WorkspaceResourceError('collaboration-forbidden', 'denied') })
    const view = renderPreview(read, { readBytes })
    await waitFor(() => { expect(view.resources.source(request).get()).toMatchObject({ status: 'failed', error: { code: 'access-revoked' } }) })
    expect(view.getByRole('alert').textContent).toBe('denied')
  })

  it('ignores a binary fallback rejection after unmount', async () => {
    const read = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    let reject!: (error: unknown) => void
    const readBytes = vi.fn(() => new Promise<WorkspaceFileByteWindow>((_resolve, yes) => { reject = yes }))
    const view = renderPreview(read, { readBytes })
    await waitFor(() => { expect(readBytes).toHaveBeenCalled() })
    view.unmount()
    reject(new Error('late bytes'))
    await Promise.resolve()
  })


  it('cancels a text request and a binary fallback on unmount', async () => {
    let resolveText!: (value: WorkspaceFileTextPage) => void
    const text = new Promise<WorkspaceFileTextPage>((resolve) => { resolveText = resolve })
    const read = vi.fn(() => text)
    const view = renderPreview(read)
    await waitFor(() => { expect(read).toHaveBeenCalled() })
    view.unmount()
    resolveText({ path: request.path, offset: 1, limit: 2, text: 'late', eof: true, version: 'v1' })
    await Promise.resolve()

    let rejectText!: (error: unknown) => void
    const rejectedText = new Promise<WorkspaceFileTextPage>((_resolve, reject) => { rejectText = reject })
    const rejectedView = renderPreview(vi.fn(() => rejectedText))
    await waitFor(() => { expect(rejectedView.getByRole('status')).toBeTruthy() })
    rejectedView.unmount()
    rejectText(new Error('late text'))
    await Promise.resolve()

    const binary = vi.fn(async () => { throw new WorkspaceResourceError('workspace-file/not-text', 'binary') })
    let resolveBytes!: (value: WorkspaceFileByteWindow) => void
    const bytes = new Promise<WorkspaceFileByteWindow>((resolve) => { resolveBytes = resolve })
    const fallback = renderPreview(binary, { readBytes: vi.fn(() => bytes) })
    await waitFor(() => { expect(fallback.getByRole('status')).toBeTruthy() })

    const byteError = renderPreview(binary, { readBytes: vi.fn(async () => { throw new Error('byte error') }) })
    await waitFor(() => { expect(byteError.getByRole('alert').textContent).toBe('byte error') })
    byteError.unmount()
    fallback.unmount()
    resolveBytes({ path: request.path, offset: 0, bytes: 'AAEC', eof: true, version: 'v1' })
    await Promise.resolve()
  })

  it('disconnects the target when a text read itself loses access', async () => {
    const read = vi.fn(async () => { throw new WorkspaceResourceError('collaboration-forbidden', 'denied') })
    const view = renderPreview(read)
    await waitFor(() => { expect(view.resources.source(request).get()).toMatchObject({ status: 'failed', error: { code: 'access-revoked' } }) })
    expect(view.getByRole('alert').textContent).toBe('denied')
    expect(view.container.querySelector('[data-workspace-file-preview]')).toBeNull()
  })

})
