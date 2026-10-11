/** Maintenance-space management page: overview rendering and grant lifecycle. */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { MemoryRouter } from 'react-router-dom'
import { StewardPage } from './StewardPage.tsx'

vi.mock('../api.ts', () => ({
  getStewardOverview: vi.fn(),
  setStewardPolicy: vi.fn(),
}))

const admin = {
  userId: 1, username: 'root', displayName: 'Root', role: 'admin' as const,
  userStatus: 'active', membershipStatus: 'active',
  grantable: true, qualified: true, effective: true, revision: '3',
}
const plainAdmin = {
  userId: 2, username: 'ops', displayName: 'Ops', role: 'admin' as const,
  userStatus: 'active', membershipStatus: 'active',
  grantable: true, qualified: false, effective: false, revision: '0',
}
const staleMember = {
  userId: 3, username: 'wujie', displayName: 'Wujie', role: 'member' as const,
  userStatus: 'active', membershipStatus: 'active',
  grantable: false, qualified: true, effective: false, revision: '2',
}
const member = {
  userId: 4, username: 'longge', displayName: 'Longge', role: 'member' as const,
  userStatus: 'active', membershipStatus: 'active',
  grantable: false, qualified: false, effective: false, revision: '0',
}

const overview: api.StewardOverview = {
  enabled: true,
  space: { id: 26, name: '维护中枢', path: '/srv/harness-steward/workspace', runtime: 'ready' },
  members: [admin, plainAdmin, staleMember, member],
}

describe('StewardPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.mocked(api.getStewardOverview).mockResolvedValue(overview)
    vi.mocked(api.setStewardPolicy).mockResolvedValue({ kind: 'user', id: 2, enabled: true, revision: '1' })
  })

  it('renders the space state and every member qualification tier', async () => {
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    expect(await screen.findByText('维护中枢')).toBeTruthy()
    expect(screen.getByText('/srv/harness-steward/workspace')).toBeTruthy()
    expect(screen.getByText('就绪')).toBeTruthy()
    expect(screen.getByText('必须是活跃组织管理员——管理员身份单独不足以进入')).toBeTruthy()
    expect(screen.getByText('4 名成员 · 1 名当前可进入')).toBeTruthy()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('可进入')).toBeTruthy()
    expect(table.getByText('授权失效')).toBeTruthy()
    expect(table.getAllByText('未授权')).toHaveLength(2)
    expect(table.getByText('需先提升为管理员')).toBeTruthy()
    expect(table.getByRole('button', { name: '清除失效授权' })).toBeTruthy()
  })

  it('grants an eligible administrator after confirmation', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    await screen.findByText('4 名成员 · 1 名当前可进入')
    const checkbox = within(screen.getByRole('table')).getByRole('checkbox', { name: '授予 Ops' })
    await user.click(checkbox)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/授予 Ops 进入常驻维护空间的权限/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: '授予' }))
    expect(api.setStewardPolicy).toHaveBeenCalledWith({ kind: 'user', id: 2, enabled: true, revision: '0' })
    expect(await screen.findByText('已授予 ops 维护空间准入。')).toBeTruthy()
  })

  it('clears a stale member grant through the revoke dialog', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    await screen.findByText('4 名成员 · 1 名当前可进入')
    await user.click(within(screen.getByRole('table')).getByRole('button', { name: '清除失效授权' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '撤销' }))
    expect(api.setStewardPolicy).toHaveBeenCalledWith({ kind: 'user', id: 3, enabled: false, revision: '2' })
  })

  it('shows the rejected reason when the write fails', async () => {
    vi.mocked(api.setStewardPolicy).mockRejectedValue(new Error('steward qualification requires an active organization administrator'))
    const user = userEvent.setup()
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    await screen.findByText('4 名成员 · 1 名当前可进入')
    await user.click(within(screen.getByRole('table')).getByRole('checkbox', { name: '授予 Ops' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '授予' }))
    expect(await screen.findByText(/steward qualification requires an active organization administrator/)).toBeTruthy()
  })

  it('reports a disabled space without a member-table crash', async () => {
    vi.mocked(api.getStewardOverview).mockResolvedValue({ enabled: false, space: null, members: [] })
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    expect(await screen.findByText(/维护空间未启用/)).toBeTruthy()
    expect(screen.getByText('未启用')).toBeTruthy()
    expect(screen.getByText('暂无成员')).toBeTruthy()
  })

  it('surfaces an overview load failure', async () => {
    vi.mocked(api.getStewardOverview).mockRejectedValue(new Error('network unreachable'))
    render(<MemoryRouter><StewardPage /></MemoryRouter>)
    expect(await screen.findByText('network unreachable')).toBeTruthy()
  })
})
