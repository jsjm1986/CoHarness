import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import * as api from '../api.ts'
import { UserDetailPage } from './UserDetailPage.tsx'

vi.mock('../api.ts', () => ({
  AdminRequestError: class AdminRequestError extends Error {
    constructor(readonly status: number, message: string) { super(message); this.name = 'AdminRequestError' }
  },
  getUser: vi.fn(),
  patchUser: vi.fn(),
  resetPassword: vi.fn(),
  deleteUser: vi.fn(),
  controlInstance: vi.fn(),
  getSshPolicy: vi.fn(),
  setSshPolicy: vi.fn(),
  getTerminalPolicy: vi.fn(),
  setTerminalPolicy: vi.fn(),
  getDesktopPolicy: vi.fn(),
  setDesktopPolicy: vi.fn(),
  getPluginPolicy: vi.fn(),
  setPluginPolicy: vi.fn(),
  listModels: vi.fn(),
  getModelAccess: vi.fn(),
  setModelAccess: vi.fn(),
  listUserMemberships: vi.fn(),
  listProjects: vi.fn(),
  setMember: vi.fn(),
  removeMember: vi.fn(),
  getUserQuota: vi.fn(),
  setQuota: vi.fn(),
}))

const alice: api.AdminUser = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
  status: 'active',
  homePath: '/home/alice',
  mustChangePassword: false,
  autoReviewEligible: false,
  port: 9101,
  instanceState: 'running',
}

const model: api.ModelGovernanceRow = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  displayName: 'DeepSeek Chat',
  enabled: true,
  adminAllowed: true,
  userAllowed: false,
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
} as api.ModelGovernanceRow

const quota: api.UserQuotaView = {
  tokenMode: 'inherit',
  tokenLimit: null,
  companyCostMode: 'inherit',
  companyCostMicrosLimit: null,
}

function renderPage(path = '/users/1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/users/:id" element={<UserDetailPage />} />
        <Route path="/" element={<div>用户列表</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('UserDetailPage', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getUser).mockResolvedValue(alice)
    vi.mocked(api.getSshPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: true, revision: '3' })
    vi.mocked(api.getTerminalPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: false, revision: '0' })
    vi.mocked(api.getDesktopPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: false, revision: '0' })
    vi.mocked(api.getPluginPolicy).mockResolvedValue({ kind: 'user', id: 1, enabled: false, revision: '0' })
    vi.mocked(api.listModels).mockResolvedValue([model])
    vi.mocked(api.getModelAccess).mockResolvedValue({ effective: { version: 1, defaultAllowed: false, models: [{ provider: model.provider, model: model.model, allowed: false }] }, overrides: [] })
    vi.mocked(api.listUserMemberships).mockResolvedValue({ memberships: [{ projectId: 7, name: 'Shared', path: '/srv/shared', mode: 'ro' }] })
    vi.mocked(api.listProjects).mockResolvedValue([{ id: 7, name: 'Shared' } as api.Project, { id: 8, name: 'Second' } as api.Project])
    vi.mocked(api.getUserQuota).mockResolvedValue(quota)
  })

  it('renders account, qualification, model, membership, and quota sections for the user', async () => {
    renderPage()
    expect(await screen.findByText('用户 · Alice')).toBeTruthy()
    expect(screen.getByText('能力准入')).toBeTruthy()
    await screen.findByRole('checkbox', { name: '授予此用户SSH资格' })
    expect(screen.getAllByText('已授予').length).toBeGreaterThan(0)
    expect(api.getSshPolicy).toHaveBeenCalledWith('user', 1, expect.any(AbortSignal))
    expect(api.getTerminalPolicy).toHaveBeenCalledWith('user', 1, expect.any(AbortSignal))
    expect(api.getDesktopPolicy).toHaveBeenCalledWith('user', 1, expect.any(AbortSignal))
    expect((await screen.findAllByText('Shared')).length).toBeGreaterThan(0)
    expect(screen.getByRole('group', { name: 'Token 额度' })).toBeTruthy()
  })

  it.each([
    { name: 'administrator role default', role: 'admin' as const, enabled: true, override: null, allowed: true },
    { name: 'disabled model with an allow override', role: 'user' as const, enabled: false, override: true, allowed: false },
    { name: 'disabled provider with an allow override', role: 'user' as const, enabled: true, override: true, allowed: false },
  ])('displays server effective access for $name on desktop and mobile', async ({ role, enabled, override, allowed }) => {
    vi.mocked(api.getUser).mockResolvedValue({ ...alice, role })
    vi.mocked(api.listModels).mockResolvedValue([{ ...model, enabled }])
    vi.mocked(api.getModelAccess).mockResolvedValue({
      effective: { version: 1, defaultAllowed: false, models: [{ provider: model.provider, model: model.model, allowed }] },
      overrides: override === null ? [] : [{ provider: model.provider, model: model.model, allowed: override }],
    })
    renderPage()
    await screen.findAllByText('DeepSeek Chat')
    const table = screen.getAllByRole('table').find(table => within(table).queryByText('此用户例外') !== null)!
    const cells = within(within(table).getAllByRole('row')[1]!).getAllByRole('cell')
    expect(cells[1]!.textContent).toBe(role === 'admin' ? '允许' : '拒绝')
    expect(cells[3]!.textContent).toBe(allowed ? '可用' : '拒绝')
    const mobile = screen.getAllByRole('article').find(item => within(item).queryByText('DeepSeek Chat') !== null)!
    expect(mobile.querySelector('.mobileItemHeader')?.textContent).toContain(allowed ? '可用' : '拒绝')
  })

  it('saves a model override for this user', async () => {
    const user = userEvent.setup()
    renderPage()
    const selects = await screen.findAllByLabelText('此用户例外')
    vi.mocked(api.setModelAccess).mockResolvedValue(undefined)
    vi.mocked(api.getModelAccess).mockResolvedValue({ effective: { version: 2, defaultAllowed: false, models: [{ provider: model.provider, model: model.model, allowed: true }] }, overrides: [{ provider: 'deepseek', model: 'deepseek-chat', allowed: true }] })
    await user.selectOptions(selects[0]!, 'allow')
    expect(api.setModelAccess).toHaveBeenCalledWith(1, 'deepseek', 'deepseek-chat', true)
    await waitFor(() => expect(api.getModelAccess).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByText('可用')).toHaveLength(2))
  })

  it('reloads effective model permissions after the account role changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findAllByText('DeepSeek Chat')
    expect(screen.queryByText('可用')).toBeNull()
    await user.click(screen.getByRole('button', { name: '编辑账号' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑 alice' })
    await user.selectOptions(within(dialog).getByLabelText('角色'), 'admin')
    vi.mocked(api.patchUser).mockResolvedValue(undefined)
    vi.mocked(api.getUser).mockResolvedValue({ ...alice, role: 'admin' })
    vi.mocked(api.getModelAccess).mockResolvedValue({
      effective: { version: 2, defaultAllowed: false, models: [{ provider: model.provider, model: model.model, allowed: true }] },
      overrides: [],
    })
    await user.click(within(dialog).getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(screen.getAllByText('可用')).toHaveLength(2))
    expect(api.patchUser).toHaveBeenCalledWith(1, { role: 'admin' })
    expect(api.getModelAccess).toHaveBeenCalledTimes(2)
  })

  it('changes a membership mode and removes a member', async () => {
    const user = userEvent.setup()
    renderPage()
    const select = (await screen.findAllByLabelText('Shared 目录权限'))[0]!
    vi.mocked(api.setMember).mockResolvedValue(undefined)
    await user.selectOptions(select, 'rw')
    expect(api.setMember).toHaveBeenCalledWith(7, 1, 'rw')
    vi.mocked(api.removeMember).mockResolvedValue(undefined)
    await user.click(screen.getAllByRole('button', { name: '移出 Shared' })[0]!)
    await user.click(await screen.findByRole('button', { name: '确认移出' }))
    expect(api.removeMember).toHaveBeenCalledWith(7, 1)
  })

  it('saves a custom user quota', async () => {
    const user = userEvent.setup()
    renderPage()
    const fieldset = await screen.findByRole('group', { name: 'Token 额度' })
    await user.selectOptions(within(fieldset as HTMLElement).getByLabelText('额度模式'), 'custom')
    await user.type(within(fieldset as HTMLElement).getByLabelText('每月 Token'), '5000')
    vi.mocked(api.setQuota).mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: '保存配额' }))
    expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'user',
      subjectId: '1',
      tokenLimit: 5000,
      companyCostMicrosLimit: 'inherit',
    })
  })

  it('confirms disabling before patching the account', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('用户 · Alice')
    await user.click(screen.getByRole('button', { name: '禁用' }))
    vi.mocked(api.patchUser).mockResolvedValue(undefined)
    await user.click(await screen.findByRole('button', { name: '确认禁用' }))
    expect(api.patchUser).toHaveBeenCalledWith(1, { status: 'disabled' })
  })

  it('shows a not-found state for a deleted user', async () => {
    vi.mocked(api.getUser).mockRejectedValue(new api.AdminRequestError(404, 'user not found'))
    renderPage('/users/99')
    expect(await screen.findByText('用户不存在')).toBeTruthy()
  })
})
