import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../api.ts'
import { ProjectListPage } from './ProjectListPage.tsx'

vi.mock('../api.ts', () => ({
  listProjects: vi.fn(),
  getOwnerProjectDisplays: vi.fn(),
  listProjectDirectories: vi.fn(),
  createProject: vi.fn(),
}))

describe('ProjectListPage', () => {
  it('keeps a failed initial request distinct from an empty project list', async () => {
    vi.mocked(api.listProjects).mockRejectedValueOnce(new Error('projects-unavailable'))
    render(<ProjectListPage />)
    expect((await screen.findByRole('alert')).textContent).toBe('projects-unavailable')
    expect(screen.queryByText('还没有项目')).toBeNull()
    expect(api.listProjects).toHaveBeenCalledOnce()
  })
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.mocked(api.listProjects).mockReset().mockResolvedValue([])
    vi.mocked(api.getOwnerProjectDisplays).mockReset()
    vi.mocked(api.listProjectDirectories).mockReset()
    vi.mocked(api.createProject).mockReset()
  })

  it('reads 32 visible project displays on this Admin computer and requests the rest only after More', async () => {
    const rows = Array.from({ length: 33 }, (_, i): api.Project => ({
      id: i + 1, name: `#${i + 1}`, path: '', memberCount: 1, metadataOnNode: true,
      nodeId: '20000000-0000-4000-8000-000000000001' as NonNullable<api.Project['nodeId']>,
      runtimeId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` as NonNullable<api.Project['runtimeId']>,
    }))
    vi.mocked(api.listProjects).mockResolvedValue(rows)
    vi.mocked(api.getOwnerProjectDisplays).mockImplementation(async page => new Map(page.map(row => [row.id, { name: `Ubuntu ${row.id}`, path: `/srv/${row.id}` }])))
    const user = userEvent.setup()
    render(<MemoryRouter><ProjectListPage /></MemoryRouter>)
    expect((await screen.findAllByText('Ubuntu 32')).length).toBeGreaterThan(0)
    expect([...screen.queryAllByText('Ubuntu 33')]).toHaveLength(0)
    expect(vi.mocked(api.getOwnerProjectDisplays).mock.calls.map(([page]) => page.map(row => row.id))).toEqual([rows.slice(0, 32).map(row => row.id)])
    await user.click(screen.getByRole('button', { name: '更多项目' }))
    expect((await screen.findAllByText('Ubuntu 33')).length).toBeGreaterThan(0)
    expect(vi.mocked(api.getOwnerProjectDisplays).mock.calls[1]?.[0].map(row => row.id)).toEqual([33])
  })

  it('creates a project from its name without asking for a host path', async () => {
    vi.mocked(api.createProject).mockResolvedValue({
      id: 1,
      name: 'People',
      path: '/srv/harness/projects/People',
      memberCount: 0,
    })
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.type(dialog.getByLabelText(/^项目名称/), '  People  ')
    await user.click(dialog.getByRole('button', { name: '创建项目' }))

    expect(api.createProject).toHaveBeenCalledWith({ name: 'People' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull())
  })

  it('keeps an invalid project name error inside the create dialog', async () => {
    vi.mocked(api.createProject).mockRejectedValue(new Error('project-name-invalid'))
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.type(dialog.getByLabelText(/^项目名称/), '../People')
    await user.click(dialog.getByRole('button', { name: '创建项目' }))

    expect(api.createProject).toHaveBeenCalledWith({ name: '../People' })
    expect((await dialog.findByRole('alert')).textContent).toContain('不能包含路径分隔符')
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeTruthy()
    expect((dialog.getByLabelText(/^项目名称/) as HTMLInputElement).value).toBe('../People')
  })

  it('imports a selected Gateway host directory and preserves an entered display name', async () => {
    vi.mocked(api.listProjectDirectories).mockImplementation(async (path) => {
      if (path === undefined) return directoryListing('/', false, [
        { name: 'Users', path: '/Users', hidden: false },
      ])
      if (path === '/Users') return directoryListing('/Users', true, [
        { name: 'existing-app', path: '/Users/existing-app', hidden: false },
      ], [
        { name: '/', path: '/' },
        { name: 'Users', path: '/Users' },
      ])
      return directoryListing('/Users/existing-app', true, [], [
        { name: '/', path: '/' },
        { name: 'Users', path: '/Users' },
        { name: 'existing-app', path: '/Users/existing-app' },
      ])
    })
    vi.mocked(api.createProject).mockResolvedValue({
      id: 2,
      name: 'Imported app',
      path: '/Users/existing-app',
      memberCount: 0,
    })
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.type(dialog.getByLabelText(/^项目名称/), '  Imported app  ')
    await user.click(dialog.getByRole('button', { name: '现有目录' }))
    expect((dialog.getByRole('button', { name: '创建项目' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(await dialog.findByRole('button', { name: '打开目录 Users' }))
    await user.click(await dialog.findByRole('button', { name: '打开目录 existing-app' }))
    await user.click(await dialog.findByRole('button', { name: '使用当前目录' }))
    expect(dialog.getAllByText('/Users/existing-app').length).toBeGreaterThan(0)
    await user.click(dialog.getByRole('button', { name: '创建项目' }))

    expect(api.createProject).toHaveBeenCalledWith({
      name: 'Imported app',
      path: '/Users/existing-app',
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull())
  })

  it('suggests the selected directory name when the project name is blank', async () => {
    vi.mocked(api.listProjectDirectories).mockResolvedValue(directoryListing('/Volumes/Projects/客服工具', true))
    vi.mocked(api.createProject).mockResolvedValue({
      id: 3,
      name: '客服工具',
      path: '/Volumes/Projects/客服工具',
      memberCount: 0,
    })
    const user = userEvent.setup()
    render(<ProjectListPage />)
    await screen.findByText('还没有项目')
    await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '新建项目' }))
    await user.click(dialog.getByRole('button', { name: '现有目录' }))
    await user.click(await dialog.findByRole('button', { name: '使用当前目录' }))

    expect((dialog.getByLabelText(/^项目名称/) as HTMLInputElement).value).toBe('客服工具')
  })
})

function directoryListing(
  path: string,
  selectable: boolean,
  entries: api.ProjectDirectoryListing['entries'] = [],
  crumbs: api.ProjectDirectoryListing['crumbs'] = [{ name: path, path }],
): api.ProjectDirectoryListing {
  return {
    path,
    scope: 'filesystem',
    crumbs,
    entries,
    selectable,
    truncated: false,
  }
}
