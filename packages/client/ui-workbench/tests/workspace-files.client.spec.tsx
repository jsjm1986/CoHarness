// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileBrowser } from '../src/client/components/WorkspaceFileBrowser.tsx'
import type { WorkspaceBrowserOwner } from '../src/client/stores.ts'
import type { WorkspaceFileEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'

afterEach(cleanup)
const sessionId = 's-1' as SessionId
const labels = {
  close: 'Close', title: 'Workspace files', root: 'Workspace root', up: 'Up', loading: 'Loading',
  empty: 'Empty', directory: 'Directory ', truncated: 'Truncated', error: 'Error', reload: 'Reload',
}
const entry = (path: string, type: 'file' | 'directory'): WorkspaceFileEntry => ({ name: path.split('/').pop()!, path, type, version: 'v1', ...(type === 'file' ? { bytes: 3 } : {}) })

describe('WorkspaceFileBrowser', () => {
  it('loads the root, navigates directories, and opens a file with its explicit target', async () => {
    const list = vi.fn(async (_owner: WorkspaceBrowserOwner, path: string) => ({ entries: path === '.' ? [entry('src', 'directory')] : path === 'src' ? [entry('src/nested', 'directory'), entry('src/index.ts', 'file')] : [entry('src/nested/file.ts', 'file')], truncated: false }))
    const open = vi.fn<(request: WorkspaceResourceOpenRequest) => void>()
    const { getByRole, getByText } = render(<WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'project', projectId: 4 }} list={list} open={open} close={() => {}} labels={labels} />)
    await waitFor(() => { expect(getByRole('treeitem', { name: 'Directory src' })).toBeTruthy() })
    fireEvent.click(getByRole('treeitem', { name: 'Directory src' }))
    await waitFor(() => { expect(getByText('index.ts')).toBeTruthy() })
    fireEvent.click(getByRole('treeitem', { name: 'Directory nested' }))
    await waitFor(() => { expect(getByText('file.ts')).toBeTruthy() })
    expect(getByRole('button', { name: 'src' })).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'src' }))
    await waitFor(() => { expect(getByText('index.ts')).toBeTruthy() })
    fireEvent.click(getByRole('treeitem', { name: 'index.ts' }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ sessionId, path: 'src/index.ts', runtimeTarget: { kind: 'project', projectId: 4 }, address: 'dsh-resource://file/session/s-1/src/index.ts' }))
    expect(list).toHaveBeenCalledWith({ sessionId, runtimeTarget: { kind: 'project', projectId: 4 } }, 'src', expect.any(AbortSignal))
  })

  it('returns to the root and reports bounded directory results and failures', async () => {
    const list = vi.fn(async (_owner: WorkspaceBrowserOwner, path: string) => {
      if (path === '.') return { entries: [entry('src', 'directory')], truncated: true }
      throw new Error('directory unavailable')
    })
    const view = render(
      <WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }}
        list={list} open={() => {}} close={() => {}} labels={labels} />,
    )
    await waitFor(() => { expect(view.getByText('Truncated')).toBeTruthy() })
    expect(list).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    fireEvent.click(view.getByRole('treeitem', { name: 'Directory src' }))
    await waitFor(() => { const alert = view.getByRole('alert'); expect(alert.textContent).toBe('directory unavailable') })
    fireEvent.click(view.getByRole('button', { name: 'Up' }))
    await waitFor(() => { expect(within(view.getByRole('tree')).getByRole('treeitem', { name: 'Directory src' })).toBeTruthy() })
  })
})

describe('WorkspaceFileBrowser edge paths', () => {
  it('renders an empty directory, handles non-Error failures, and closes', async () => {
    const list = vi.fn(async () => ({ entries: [] as readonly WorkspaceFileEntry[], truncated: false }))
    const view = render(<WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }} list={list} open={() => {}} close={vi.fn()} labels={labels} />)
    await waitFor(() => { expect(view.getByText('Empty')).toBeTruthy() })
    expect(view.queryByRole('treeitem')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
  })

  it('omits the footer when no reload label is provided', async () => {
    const list = vi.fn(async () => ({ entries: [entry('a.txt', 'file')], truncated: false }))
    const { reload: _reload, ...noReload } = labels
    const view = render(<WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }} list={list} open={() => {}} close={() => {}} labels={noReload} />)
    await waitFor(() => { expect(view.getByText('a.txt')).toBeTruthy() })
    expect(view.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('uses the fallback error copy for a non-Error directory failure', async () => {
    const list = vi.fn(async () => { throw 'bad directory response' })
    const view = render(
      <WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }}
        list={list} open={() => {}} close={() => {}} labels={labels} />,
    )
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Error') })
  })

  it('orders same-type entries by name and marks only the active breadcrumb current', async () => {
    const list = vi.fn(async (_owner: WorkspaceBrowserOwner, path: string) => ({
      entries: path === '.'
        ? [entry('z.txt', 'file'), entry('a10.txt', 'file'), entry('a2.txt', 'file'), entry('dir', 'directory')]
        : [entry('dir/x.txt', 'file')],
      truncated: false,
    }))
    const view = render(<WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }} list={list} open={() => {}} close={() => {}} labels={labels} />)
    await waitFor(() => { expect(view.getAllByRole('treeitem')).toHaveLength(4) })
    const names = view.getAllByRole('treeitem').map(item => item.textContent ?? '')
    expect(names[0]).toContain('dir')
    expect(names[1]).toContain('a2.txt')
    expect(names[2]).toContain('a10.txt')
    expect(names[3]).toContain('z.txt')
    const root = view.getByRole('button', { name: 'Workspace root' })
    expect(root.getAttribute('aria-current')).toBe('page')
    fireEvent.click(view.getByRole('treeitem', { name: 'Directory dir' }))
    await waitFor(() => { expect(view.getByText('x.txt')).toBeTruthy() })
    expect(root.getAttribute('aria-current')).toBeNull()
    fireEvent.click(root)
    await waitFor(() => { expect(view.getByText('z.txt')).toBeTruthy() })
    expect(root.getAttribute('aria-current')).toBe('page')
  })
})



describe('WorkspaceFileBrowser cancellation', () => {
  it('ignores a resolved directory promise after unmount', async () => {
    let resolve!: (value: { entries: readonly WorkspaceFileEntry[]; truncated: boolean }) => void
    const list = vi.fn(() => new Promise<{ entries: readonly WorkspaceFileEntry[]; truncated: boolean }>((yes) => { resolve = yes }))
    const view = render(<WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }} list={list} open={() => {}} close={() => {}} labels={labels} />)
    await waitFor(() => { expect(list).toHaveBeenCalled() })
    view.unmount()
    resolve({ entries: [entry('late', 'file')], truncated: false })
    await Promise.resolve()
  })

  it('ignores a rejected directory promise after unmount', async () => {
    let reject!: (error: unknown) => void
    const list = vi.fn(() => new Promise<{ entries: readonly WorkspaceFileEntry[]; truncated: boolean }>(
      (_resolve, yes) => { reject = yes },
    ))
    const view = render(
      <WorkspaceFileBrowser sessionId={sessionId} runtimeTarget={{ kind: 'base' }}
        list={list} open={() => {}} close={() => {}} labels={labels} />,
    )
    await waitFor(() => { expect(list).toHaveBeenCalled() })
    view.unmount()
    reject(new Error('late failure'))
    await Promise.resolve()
  })
})
