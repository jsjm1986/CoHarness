import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ProjectDirectoryBrowser } from './ProjectDirectoryBrowser.tsx'

vi.mock('../api.ts', () => ({ listProjectDirectories: vi.fn() }))

describe('ProjectDirectoryBrowser', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.mocked(api.listProjectDirectories).mockReset()
  })

  it('hides dot directories by default and selects the current directory', async () => {
    vi.mocked(api.listProjectDirectories).mockResolvedValue(listing())
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<ProjectDirectoryBrowser onSelect={onSelect} />)

    await screen.findByRole('button', { name: '打开目录 visible' })
    expect(screen.queryByRole('button', { name: '打开目录 .hidden' })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: '显示隐藏目录 (1)' }))
    expect(screen.getByRole('button', { name: '打开目录 .hidden' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '使用当前目录' }))
    expect(onSelect).toHaveBeenCalledWith('/workspace')
  })

  it('shows a stable read error and retries the same path', async () => {
    vi.mocked(api.listProjectDirectories)
      .mockRejectedValueOnce(new Error('project-directory-path-inaccessible'))
      .mockResolvedValueOnce(listing())
    const user = userEvent.setup()
    render(<ProjectDirectoryBrowser onSelect={vi.fn()} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Gateway 无权读取该目录')
    expect((screen.getByRole('button', { name: '使用当前目录' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '已选择当前目录' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('button', { name: '打开目录 visible' })
    expect(api.listProjectDirectories).toHaveBeenNthCalledWith(1, undefined)
    expect(api.listProjectDirectories).toHaveBeenNthCalledWith(2, undefined)
  })

  it('keeps the last successful breadcrumbs and returns after a child-directory failure', async () => {
    vi.mocked(api.listProjectDirectories)
      .mockResolvedValueOnce(listing())
      .mockRejectedValueOnce(new Error('project-directory-path-not-found'))
      .mockResolvedValueOnce(listing())
    const user = userEvent.setup()
    render(<ProjectDirectoryBrowser onSelect={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '打开目录 visible' }))
    expect((await screen.findByRole('alert')).textContent).toContain('目录不存在')
    expect(screen.getByRole('navigation', { name: '目录路径' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回当前目录' }))

    await screen.findByRole('button', { name: '打开目录 visible' })
    expect(api.listProjectDirectories).toHaveBeenNthCalledWith(2, '/workspace/visible')
    expect(api.listProjectDirectories).toHaveBeenNthCalledWith(3, '/workspace')
  })
})

function listing(): api.ProjectDirectoryListing {
  return {
    path: '/workspace',
    scope: 'filesystem',
    crumbs: [
      { name: '/', path: '/' },
      { name: 'workspace', path: '/workspace' },
    ],
    entries: [
      { name: '.hidden', path: '/workspace/.hidden', hidden: true },
      { name: 'visible', path: '/workspace/visible', hidden: false },
    ],
    selectable: true,
    truncated: false,
  }
}
