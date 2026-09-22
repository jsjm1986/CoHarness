import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UsersPage } from './UsersPage.tsx'

vi.mock('../api.ts', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  patchUser: vi.fn(),
  resetPassword: vi.fn(),
  controlInstance: vi.fn(),
}))

const alice = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  role: 'user' as const,
  status: 'active' as const,
  homePath: '/home/alice',
  mustChangePassword: false,
  autoReviewEligible: false,
  port: 9101,
  instanceState: 'stopped',
}

describe('UsersPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.mocked(api.listUsers).mockResolvedValue([alice])
    vi.mocked(api.patchUser).mockResolvedValue(undefined)
    vi.mocked(api.deleteUser).mockResolvedValue(undefined)
    vi.mocked(api.createUser).mockResolvedValue(alice)
  })

  it('confirms account disabling in an accessible dialog before patching', async () => {
    render(<UsersPage />)
    expect(await screen.findAllByText('@alice · ID 1')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '禁用用户' }))
    expect(screen.getByRole('heading', { name: '禁用用户' })).toBeTruthy()
    expect(api.patchUser).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '确认禁用' }))
    expect(api.patchUser).toHaveBeenCalledWith(1, { status: 'disabled' })
  })

  it('creates a user through the dialog form', async () => {
    const user = userEvent.setup()
    render(<UsersPage />)
    await screen.findAllByText('@alice · ID 1')
    await user.click(screen.getByRole('button', { name: '新建用户' }))
    const dialog = within(screen.getByRole('dialog', { name: '新建用户' }))
    await user.type(dialog.getByLabelText(/^用户名/), 'bob')
    await user.type(dialog.getByLabelText('显示名'), 'Bob')
    await user.type(dialog.getByLabelText('初始密码'), 'secret-pass')
    await user.selectOptions(dialog.getByLabelText('角色'), 'admin')
    await user.click(dialog.getByRole('button', { name: '创建用户' }))
    expect(api.createUser).toHaveBeenCalledWith({
      username: 'bob',
      password: 'secret-pass',
      displayName: 'Bob',
      role: 'admin',
    })
  })

  it('localizes the ready instance state returned by the gateway', async () => {
    vi.mocked(api.listUsers).mockResolvedValue([{ ...alice, instanceState: 'ready' }])
    render(<UsersPage />)

    expect(await screen.findAllByText('运行中')).toHaveLength(2)
    expect(screen.queryAllByText('ready')).toHaveLength(0)
  })

  it('shows Auto eligibility in both layouts and edits it without selecting a preset', async () => {
    const user = userEvent.setup()
    vi.mocked(api.patchUser).mockImplementation(async (_id, patch) => {
      vi.mocked(api.listUsers).mockResolvedValue([{ ...alice, autoReviewEligible: patch.autoReviewEligible ?? false }])
    })
    render(<UsersPage />)
    expect(await screen.findAllByText('未授予')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '编辑用户' }))
    const dialog = within(screen.getByRole('dialog', { name: '编辑 alice' }))
    const eligibility = dialog.getByRole('checkbox', { name: '允许选择 Auto 审查' }) as HTMLInputElement
    expect(eligibility.checked).toBe(false)
    expect(dialog.getByText(/不会改变已有会话或新会话的默认权限/)).toBeTruthy()
    await user.click(eligibility)
    await user.click(dialog.getByRole('button', { name: '保存更改' }))
    expect(api.patchUser).toHaveBeenLastCalledWith(1, { autoReviewEligible: true })
    expect(await screen.findAllByText('已授予')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '编辑用户' }))
    const reopened = within(screen.getByRole('dialog', { name: '编辑 alice' }))
    expect((reopened.getByRole('checkbox', { name: '允许选择 Auto 审查' }) as HTMLInputElement).checked).toBe(true)
    await user.click(reopened.getByRole('checkbox', { name: '允许选择 Auto 审查' }))
    await user.click(reopened.getByRole('button', { name: '保存更改' }))
    expect(api.patchUser).toHaveBeenLastCalledWith(1, { autoReviewEligible: false })
    expect(await screen.findAllByText('未授予')).toHaveLength(2)
  })

  it('changes a name and role without rewriting an unchanged Auto grant', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUsers).mockResolvedValue([{ ...alice, autoReviewEligible: true }])
    render(<UsersPage />)
    await screen.findAllByText('已授予')
    await user.click(screen.getByRole('button', { name: '编辑用户' }))
    const dialog = within(screen.getByRole('dialog', { name: '编辑 alice' }))
    await user.clear(dialog.getByLabelText('显示名'))
    await user.type(dialog.getByLabelText('显示名'), 'Renamed')
    await user.selectOptions(dialog.getByLabelText('角色'), 'admin')
    await user.click(dialog.getByRole('button', { name: '保存更改' }))
    expect(api.patchUser).toHaveBeenCalledWith(1, { displayName: 'Renamed', role: 'admin' })
  })

  it('confirms user deletion and removes the account from the list', async () => {
    vi.mocked(api.deleteUser).mockImplementation(async () => {
      vi.mocked(api.listUsers).mockResolvedValue([])
    })
    render(<UsersPage />)
    expect(await screen.findAllByText('@alice · ID 1')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '删除用户' }))
    expect(screen.getByRole('heading', { name: '删除用户' })).toBeTruthy()
    expect(api.deleteUser).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(api.deleteUser).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryAllByText('@alice · ID 1')).toHaveLength(0))
  })
})
