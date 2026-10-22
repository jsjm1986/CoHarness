/** Page-local project lists feed each resource-grant picker without a second request. */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { PluginsPage } from './PluginsPage.tsx'
import { SshPage } from './SshPage.tsx'
import { TerminalsPage } from './TerminalsPage.tsx'
import { TerminalPermissions } from '../components/TerminalPermissions.tsx'

vi.mock('../api.ts', () => ({
  listUsers: vi.fn(), listProjects: vi.fn(), listSshTargets: vi.fn(), pluginManagementOverview: vi.fn(),
  getPluginPolicy: vi.fn(), getTerminalPolicy: vi.fn(), getSshPolicy: vi.fn(),
  setPluginPolicy: vi.fn(), setTerminalPolicy: vi.fn(), setSshPolicy: vi.fn(),
}))
vi.mock('../plugins/transport.ts', () => ({ pluginManagementRemote: vi.fn() }))

afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.listUsers).mockResolvedValue([])
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 7, name: 'Shared' } as api.Project])
  vi.mocked(api.listSshTargets).mockResolvedValue({ targets: [] })
  vi.mocked(api.pluginManagementOverview).mockResolvedValue([])
  for (const read of [api.getPluginPolicy, api.getTerminalPolicy, api.getSshPolicy]) {
    vi.mocked(read).mockImplementation(async (kind, id) => ({ kind, id, enabled: false, revision: '0' }))
  }
})

describe.each([
  { name: '插件管理', Component: PluginsPage, read: 'getPluginPolicy' },
  { name: '终端', Component: TerminalsPage, read: 'getTerminalPolicy' },
  { name: 'SSH', Component: SshPage, read: 'getSshPolicy' },
] as const)('$name project owners', ({ name, Component, read }) => {
  it('uses one project request for the page and permission picker', async () => {
    render(<Component />)
    const picker = await screen.findByLabelText(`${name}授权对象`)
    await within(picker).findByRole('option', { name: '项目 · Shared' })
    expect(api.listProjects).toHaveBeenCalledTimes(1)
  })

  it('shows project grant subjects before the unrelated page directory settles', async () => {
    const directory = Promise.withResolvers<void>()
    if (name === 'SSH') vi.mocked(api.listSshTargets).mockImplementation(async () => {
      await directory.promise
      return { targets: [] }
    })
    else vi.mocked(api.listUsers).mockImplementation(async () => { await directory.promise; return [] })
    render(<Component />)
    try {
      const picker = await screen.findByLabelText(`${name}授权对象`)
      await within(picker).findByRole('option', { name: '项目 · Shared' })
      expect(api.listProjects).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { directory.resolve(); await directory.promise })
    }
  })

  it('retries the page-owned project read after a failure without a picker request', async () => {
    vi.mocked(api.listProjects).mockRejectedValueOnce(new Error('project directory unavailable'))
    const user = userEvent.setup()
    render(<Component />)
    expect((await screen.findAllByText(/project directory unavailable/)).length).toBeGreaterThan(0)
    expect(api.listProjects).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '重新加载授权对象' }))
    const picker = await screen.findByLabelText(`${name}授权对象`)
    await within(picker).findByRole('option', { name: '项目 · Shared' })
    expect(api.listProjects).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/project directory unavailable/)).toBeNull()
  })

  it('reloads an empty project list through the page owner', async () => {
    vi.mocked(api.listProjects).mockResolvedValueOnce([])
    const user = userEvent.setup()
    render(<Component />)
    await user.click(await screen.findByRole('button', { name: '重新加载授权对象' }))
    const picker = await screen.findByLabelText(`${name}授权对象`)
    await within(picker).findByRole('option', { name: '项目 · Shared' })
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })

  it('starts a new list on navigation and ignores the unmounted page reply', async () => {
    const old = Promise.withResolvers<api.Project[]>()
    vi.mocked(api.listProjects).mockReturnValueOnce(old.promise)
      .mockResolvedValue([{ id: 8, name: 'Next page' } as api.Project])
    const page = render(<Component />)
    await screen.findByText('正在加载授权对象')
    expect(api.listProjects).toHaveBeenCalledTimes(1)
    page.unmount()
    const NextPage = name === 'SSH' ? PluginsPage : SshPage
    const nextName = name === 'SSH' ? '插件管理' : 'SSH'
    render(<NextPage />)
    const picker = await screen.findByLabelText(`${nextName}授权对象`)
    await within(picker).findByRole('option', { name: '项目 · Next page' })
    await act(async () => { old.resolve([{ id: 7, name: 'Old page' } as api.Project]); await old.promise })
    expect(within(picker).queryByRole('option', { name: '项目 · Old page' })).toBeNull()
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })

  it('aborts the selected policy read on unmount and drops its late result', async () => {
    const old = Promise.withResolvers<api.AdminResourcePolicy>()
    vi.mocked(api[read]).mockReturnValue(old.promise)
    const user = userEvent.setup()
    const page = render(<Component />)
    await user.selectOptions(await screen.findByLabelText(`${name}授权对象`), 'project:7')
    await waitFor(() => expect(api[read]).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(api[read]).mock.calls[0]![2]!
    page.unmount()
    expect(signal.aborted).toBe(true)
    render(<Component />)
    await screen.findByLabelText(`${name}授权对象`)
    await act(async () => { old.resolve({ kind: 'project', id: 7, enabled: true, revision: '99' }); await old.promise })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(api.listProjects).toHaveBeenCalledTimes(2)
  })
})

it('invalidates a selected grant during a shared refresh and rereads the retained project', async () => {
  const old = Promise.withResolvers<api.AdminResourcePolicy>()
  vi.mocked(api.getTerminalPolicy).mockReturnValueOnce(old.promise)
    .mockResolvedValue({ kind: 'project', id: 7, enabled: false, revision: '2' })
  const user = userEvent.setup(), retry = vi.fn()
  const items = [{ id: 7, name: 'Shared' }]
  const page = render(<TerminalPermissions projects={{ items, loading: false, error: '', reload: retry }} />)
  await user.selectOptions(await screen.findByLabelText('终端授权对象'), 'project:7')
  await waitFor(() => expect(api.getTerminalPolicy).toHaveBeenCalledTimes(1))
  const signal = vi.mocked(api.getTerminalPolicy).mock.calls[0]![2]!
  page.rerender(<TerminalPermissions projects={{ items, loading: true, error: '', reload: retry }} />)
  expect(signal.aborted).toBe(true)
  await act(async () => { old.resolve({ kind: 'project', id: 7, enabled: true, revision: '99' }); await old.promise })
  expect(screen.queryByRole('checkbox')).toBeNull()
  page.rerender(<TerminalPermissions projects={{ items: [...items], loading: false, error: '', reload: retry }} />)
  expect(await screen.findByText(/版本 2/)).toBeTruthy()
  expect(api.getTerminalPolicy).toHaveBeenCalledTimes(2)
  expect(api.listProjects).not.toHaveBeenCalled()
})

it('clears a removed project and exposes a shared-list retry without saving a stale grant', async () => {
  const user = userEvent.setup(), retry = vi.fn()
  const items = [{ id: 7, name: 'Shared' }]
  const page = render(<TerminalPermissions projects={{ items, loading: false, error: '', reload: retry }} />)
  await user.selectOptions(await screen.findByLabelText('终端授权对象'), 'project:7')
  await screen.findByRole('checkbox')
  page.rerender(<TerminalPermissions projects={{ items, loading: false, error: 'directory unavailable', reload: retry }} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  await user.click(screen.getByRole('button', { name: '重新加载授权对象' }))
  expect(retry).toHaveBeenCalledTimes(1)
  page.rerender(<TerminalPermissions projects={{ items: [{ id: 8, name: 'Next' }], loading: false, error: '', reload: retry }} />)
  expect(screen.getByLabelText('终端授权对象')).toHaveProperty('value', '')
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(api.setTerminalPolicy).not.toHaveBeenCalled()
  expect(api.listProjects).not.toHaveBeenCalled()
})
