import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UsagePage } from './UsagePage.tsx'

vi.mock('../api.ts', () => ({
  getRoleQuota: vi.fn(),
  getUsageHealth: vi.fn(),
  getUserQuota: vi.fn(),
  listUsageOverview: vi.fn(),
  listUsers: vi.fn(),
  setQuota: vi.fn(),
}))

const pricing = { status: 'priced' as const, pricedCalls: 2, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 }
const emptyPricing = { status: 'none' as const, pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 }
const personal = (calls: number, totalTokens: number) => ({
  month: '2026-08', inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  totalTokens, estimatedCostMicros: 0, companyCostMicros: 0, calls, missingUsageCalls: 0,
  tokenLimit: null, companyCostMicrosLimit: null, alerts: [], pricing: calls === 0 ? emptyPricing : pricing,
})
const measure = (calls: number, totalTokens: number) => ({
  inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens,
  estimatedCostMicros: 0, companyCostMicros: 0, calls, missingUsageCalls: 0,
  pricing: calls === 0 ? emptyPricing : pricing,
})

describe('UsagePage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getUsageHealth).mockResolvedValue({
      month: '2026-08', timeZone: 'Asia/Shanghai', missingUsageCalls: 0,
      unattributedProjectCalls: 1, unattributedProjectTokens: 200, unpricedCalls: 0,
      historicalUnknownCalls: 0, maxIntakeLagMs: 120,
    })
    vi.mocked(api.listUsers).mockResolvedValue([])
    vi.mocked(api.setQuota).mockResolvedValue(undefined)
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: null, companyCostMicrosLimit: null })
    vi.mocked(api.getUserQuota).mockResolvedValue({
      tokenMode: 'inherit', tokenLimit: null, companyCostMode: 'inherit', companyCostMicrosLimit: null,
    })
    vi.mocked(api.listUsageOverview).mockResolvedValue({
      month: '2026-08', timeZone: 'Asia/Shanghai',
      personal: measure(2, 100), projects: measure(4, 900), unattributedProjects: measure(1, 200),
      users: [
        { userId: 1, username: 'alice', archived: false, personal: personal(2, 100), projectContribution: measure(3, 700) },
        { userId: 2, username: 'bob', archived: false, personal: personal(0, 0), projectContribution: measure(0, 0) },
      ],
    })
  })

  it('separates personal billing from shared-project contribution activity', async () => {
    render(<UsagePage />)
    expect(await screen.findByText('项目 Token')).toBeTruthy()
    expect(screen.getByText('900')).toBeTruthy()
    const table = screen.getByRole('table')
    expect(within(table).getByText('alice')).toBeTruthy()
    expect(within(table).getByText('700')).toBeTruthy()
    expect(within(table).getAllByText(/不计入个人额度/)).toHaveLength(2)
    expect(within(table).getByText('bob')).toBeTruthy()
  })
  it('renders metering health as one aligned metric group', async () => {
    render(<UsagePage />)
    const group = await screen.findByLabelText('计量健康指标')
    const metrics = within(group)
    expect(group.className).toBe('usageHealthMetrics')
    expect(group.querySelectorAll('.metric')).toHaveLength(6)
    expect(metrics.getByText('缺失计量')).toBeTruthy()
    expect(metrics.getByText('未归属项目调用')).toBeTruthy()
    expect(metrics.getByText('200')).toBeTruthy()
    expect(metrics.getByText('最大上报延迟')).toBeTruthy()
    expect(metrics.getByText('0.1 秒')).toBeTruthy()
  })

  it('loads the stored role quota, saves through real values, and reads back on reopen', async () => {
    vi.mocked(api.getRoleQuota)
      .mockResolvedValueOnce({ tokenLimit: 42_000, companyCostMicrosLimit: 9_250_000 })
      .mockResolvedValueOnce({ tokenLimit: 42_000, companyCostMicrosLimit: 9_250_000 })
    render(<UsagePage />)
    await userEvent.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = await screen.findByRole('dialog', { name: '配置月度额度' })
    expect(api.getRoleQuota).toHaveBeenCalledWith('user')
    expect(await within(dialog).findByDisplayValue('42000')).toBeTruthy()
    expect(await within(dialog).findByDisplayValue('9.25')).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: '保存额度' }))
    expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'role', subjectId: 'user', tokenLimit: 42_000, companyCostMicrosLimit: 9_250_000,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: '配置额度' }))
    const reopened = await screen.findByRole('dialog', { name: '配置月度额度' })
    expect(await within(reopened).findByDisplayValue('42000')).toBeTruthy()
    expect(await within(reopened).findByDisplayValue('9.25')).toBeTruthy()
  })

  it('disables save until the current subject loads and never posts for a missing user', async () => {
    let resolveRole!: (value: { tokenLimit: null; companyCostMicrosLimit: null }) => void
    vi.mocked(api.getRoleQuota).mockImplementationOnce(() => new Promise(resolve => { resolveRole = resolve }))
    render(<UsagePage />)
    await userEvent.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = await screen.findByRole('dialog', { name: '配置月度额度' })
    const save = within(dialog).getByRole('button', { name: '保存额度' })
    expect(save.hasAttribute('disabled')).toBe(true)
    resolveRole({ tokenLimit: null, companyCostMicrosLimit: null })
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
    // With no users the user subject stays unsaveable without issuing a read.
    await userEvent.selectOptions(within(dialog).getByLabelText('配置对象'), 'user')
    expect(api.getUserQuota).not.toHaveBeenCalled()
    expect(save.hasAttribute('disabled')).toBe(true)
    expect(api.setQuota).not.toHaveBeenCalled()
  })

  it('keeps a failed subject read retryable inside the dialog', async () => {
    vi.mocked(api.getRoleQuota)
      .mockRejectedValueOnce(new Error('role quota read failed'))
      .mockResolvedValueOnce({ tokenLimit: 10, companyCostMicrosLimit: null })
    render(<UsagePage />)
    await userEvent.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = await screen.findByRole('dialog', { name: '配置月度额度' })
    expect(await within(dialog).findByText('role quota read failed')).toBeTruthy()
    const save = within(dialog).getByRole('button', { name: '保存额度' })
    expect(save.hasAttribute('disabled')).toBe(true)
    await userEvent.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByDisplayValue('10')).toBeTruthy()
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false))
  })

  it('ignores an older month response that lands after a newer selection', async () => {
    let resolveOld!: (value: api.UsageOverview) => void
    const stale = {
      month: '2026-07', timeZone: 'Asia/Shanghai',
      personal: measure(9, 999), projects: measure(0, 0), unattributedProjects: measure(0, 0),
      users: [{ userId: 9, username: 'stale', archived: false, personal: personal(9, 999), projectContribution: measure(0, 0) }],
    }
    const fresh = {
      month: '2026-08', timeZone: 'Asia/Shanghai',
      personal: measure(2, 100), projects: measure(4, 900), unattributedProjects: measure(1, 200),
      users: [{ userId: 1, username: 'alice', archived: false, personal: personal(2, 100), projectContribution: measure(3, 700) }],
    }
    vi.mocked(api.listUsageOverview)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue(fresh)
    render(<UsagePage />)
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-08' } })
    const table = await screen.findByRole('table')
    expect(within(table).getAllByText('alice')).not.toHaveLength(0)
    await act(async () => { resolveOld(stale) })
    expect(api.listUsageOverview).toHaveBeenCalledTimes(2)
    expect(within(table).queryByText('stale')).toBeNull()
    expect(within(table).getAllByText('alice')).not.toHaveLength(0)
  })

  it('keeps an edited role draft through a background users refresh without a second quota read', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 42_000, companyCostMicrosLimit: null })
    vi.mocked(api.listUsers).mockResolvedValue([
      { id: 5, username: 'carol', displayName: 'Carol', role: 'user', status: 'active', homePath: '/h/c', mustChangePassword: false, autoReviewEligible: false, port: 9105, instanceState: 'stopped' },
    ])
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    const tokenInput = (await dialog.findByDisplayValue('42000')) as HTMLInputElement
    await user.clear(tokenInput)
    await user.type(tokenInput, '999')
    // A month change refreshes overview + users; it is not a quota reload trigger.
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    await waitFor(() => expect(api.listUsageOverview).toHaveBeenLastCalledWith('2026-07'))
    expect(api.getRoleQuota).toHaveBeenCalledTimes(1)
    expect(api.getUserQuota).not.toHaveBeenCalled()
    expect(tokenInput.value).toBe('999')
    expect((dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps subject B loaded when the previously selected read settles late', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUsers).mockResolvedValue([
      { id: 5, username: 'carol', displayName: 'Carol', role: 'user', status: 'active', homePath: '/h/c', mustChangePassword: false, autoReviewEligible: false, port: 9105, instanceState: 'stopped' },
    ])
    let resolveRole!: (value: api.RoleQuotaView) => void
    vi.mocked(api.getRoleQuota).mockImplementation(() => new Promise(resolve => { resolveRole = resolve }))
    vi.mocked(api.getUserQuota).mockResolvedValue({
      tokenMode: 'custom', tokenLimit: 777, companyCostMode: 'unlimited', companyCostMicrosLimit: null,
    })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await user.selectOptions(dialog.getByLabelText('配置对象'), 'user')
    expect(await dialog.findByDisplayValue('777')).toBeTruthy()
    await act(async () => { resolveRole({ tokenLimit: 1, companyCostMicrosLimit: 8_000_000 }) })
    expect(api.getRoleQuota).toHaveBeenCalledTimes(1)
    expect((dialog.getByLabelText('每月 Token') as HTMLInputElement).value).toBe('777')
    expect((dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('ignores a late failure of the previously selected subject', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listUsers).mockResolvedValue([
      { id: 5, username: 'carol', displayName: 'Carol', role: 'user', status: 'active', homePath: '/h/c', mustChangePassword: false, autoReviewEligible: false, port: 9105, instanceState: 'stopped' },
    ])
    let rejectRole!: (cause: unknown) => void
    vi.mocked(api.getRoleQuota).mockImplementation(() => new Promise((_ok, reject) => { rejectRole = reject }))
    vi.mocked(api.getUserQuota).mockResolvedValue({
      tokenMode: 'custom', tokenLimit: 777, companyCostMode: 'unlimited', companyCostMicrosLimit: null,
    })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await user.selectOptions(dialog.getByLabelText('配置对象'), 'user')
    expect(await dialog.findByDisplayValue('777')).toBeTruthy()
    await act(async () => { rejectRole(new Error('late role failure')) })
    expect(api.getRoleQuota).toHaveBeenCalledTimes(1)
    expect(dialog.queryByText('late role failure')).toBeNull()
    expect((dialog.getByLabelText('每月 Token') as HTMLInputElement).value).toBe('777')
    expect((dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('blocks form submission while a subject read is pending, failed, or impossible, and a retry re-enables editing', async () => {
    const user = userEvent.setup()
    let resolveRole!: (value: api.RoleQuotaView) => void
    vi.mocked(api.getRoleQuota)
      .mockImplementationOnce(() => new Promise(resolve => { resolveRole = resolve }))
      .mockRejectedValueOnce(new Error('role quota read failed'))
      .mockResolvedValueOnce({ tokenLimit: 10, companyCostMicrosLimit: null })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    const form = document.getElementById('quota-form') as HTMLFormElement
    const save = dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.submit(form)
    expect(api.setQuota).not.toHaveBeenCalled()
    resolveRole({ tokenLimit: 42_000, companyCostMicrosLimit: null })
    await waitFor(() => expect(save.disabled).toBe(false))
    // A user subject with no users cannot issue a read or submit.
    await user.selectOptions(dialog.getByLabelText('配置对象'), 'user')
    expect(api.getUserQuota).not.toHaveBeenCalled()
    expect(save.disabled).toBe(true)
    fireEvent.submit(form)
    expect(api.setQuota).not.toHaveBeenCalled()
    // A failed read cannot submit either; retry restores editing.
    await user.selectOptions(dialog.getByLabelText('配置对象'), 'role')
    expect(await dialog.findByText('role quota read failed')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.submit(form)
    expect(api.setQuota).not.toHaveBeenCalled()
    await user.click(dialog.getByRole('button', { name: '重试' }))
    expect(await dialog.findByDisplayValue('10')).toBeTruthy()
    await waitFor(() => expect(save.disabled).toBe(false))
  })

  it('disables both subject selectors while a write is pending and keeps a refusal inside the dialog', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 42_000, companyCostMicrosLimit: null })
    let resolveWrite!: () => void
    vi.mocked(api.setQuota)
      .mockImplementationOnce(() => new Promise(resolve => { resolveWrite = resolve }))
      .mockRejectedValueOnce(new Error('quota write refused'))
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await dialog.findByDisplayValue('42000')
    const subject = dialog.getByLabelText('配置对象') as HTMLSelectElement
    const roleSelect = dialog.getByLabelText('角色') as HTMLSelectElement
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => {
      expect(subject.disabled).toBe(true)
      expect(roleSelect.disabled).toBe(true)
    })
    await act(async () => { resolveWrite() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // A refused write surfaces inside the still-open dialog and stays editable.
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const again = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await again.findByDisplayValue('42000')
    await user.click(again.getByRole('button', { name: '保存额度' }))
    expect(await again.findByText('quota write refused')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '配置月度额度' })).toBeTruthy()
  })

  it('rejects an empty custom limit and an out-of-range cost without posting a fallback write', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 42_000, companyCostMicrosLimit: 9_250_001 })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    const form = document.getElementById('quota-form') as HTMLFormElement
    const tokenInput = (await dialog.findByDisplayValue('42000')) as HTMLInputElement
    await user.clear(tokenInput)
    fireEvent.submit(form)
    expect(await dialog.findByText('Token 额度必须是非负整数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    const costInput = dialog.getByLabelText('每月人民币元') as HTMLInputElement
    await user.type(tokenInput, '12')
    await user.clear(costInput)
    fireEvent.submit(form)
    expect(await dialog.findByText('成本额度必须是有效的非负数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    await user.type(costInput, '-1')
    fireEvent.submit(form)
    expect(await dialog.findByText('成本额度必须是有效的非负数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    // Editing tokens alone preserves the stored micro-precision cost.
    await user.clear(costInput)
    await user.type(costInput, '9.250001')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'role', subjectId: 'user', tokenLimit: 12, companyCostMicrosLimit: 9_250_001,
    }))
  })

  it.each([
    { tokenMode: 'inherit' as const, tokenLimit: null, costMode: 'custom' as const, costValue: 2_500_000, writes: { tokenLimit: 'inherit', companyCostMicrosLimit: 2_500_000 } },
    { tokenMode: 'custom' as const, tokenLimit: 0, costMode: 'unlimited' as const, costValue: null, writes: { tokenLimit: 0, companyCostMicrosLimit: null } },
    { tokenMode: 'unlimited' as const, tokenLimit: null, costMode: 'unlimited' as const, costValue: null, writes: { tokenLimit: null, companyCostMicrosLimit: null } },
  ])('writes a user quota mixture $tokenMode/$costMode', async ({ tokenMode, tokenLimit, costMode, costValue, writes }) => {
    const user = userEvent.setup()
    vi.mocked(api.listUsers).mockResolvedValue([
      { id: 5, username: 'carol', displayName: 'Carol', role: 'user', status: 'active', homePath: '/h/c', mustChangePassword: false, autoReviewEligible: false, port: 9105, instanceState: 'stopped' },
    ])
    vi.mocked(api.getUserQuota).mockResolvedValue({
      tokenMode, tokenLimit, companyCostMode: costMode, companyCostMicrosLimit: costValue,
    })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await user.selectOptions(dialog.getByLabelText('配置对象'), 'user')
    const save = dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await user.click(save)
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'user', subjectId: '5', ...writes,
    }))
  })

  it.each(['user', 'admin'] as const)('reads and writes the %s role quota', async role => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: null, companyCostMicrosLimit: null })
    render(<UsagePage />)
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await user.selectOptions(dialog.getByLabelText('角色'), role)
    await waitFor(() => expect(api.getRoleQuota).toHaveBeenCalledWith(role))
    const save = dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    await user.click(save)
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'role', subjectId: role, tokenLimit: null, companyCostMicrosLimit: null,
    }))
  })

  it('saves using the committed month after a month switch', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 5, companyCostMicrosLimit: null })
    render(<UsagePage />)
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    await waitFor(() => expect(api.listUsageOverview).toHaveBeenCalledWith('2026-07'))
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await dialog.findByDisplayValue('5')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalled())
    // The post-write reload re-reads the month committed before the save.
    await waitFor(() => expect(api.listUsageOverview).toHaveBeenLastCalledWith('2026-07'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('ends the spinner when a quiet reload supersedes a delayed loading read', async () => {
    const user = userEvent.setup()
    let resolveOld!: (value: api.UsageOverview) => void
    vi.mocked(api.listUsageOverview)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue({
        month: '2026-08', timeZone: 'Asia/Shanghai',
        personal: measure(1, 10), projects: measure(0, 0), unattributedProjects: measure(0, 0),
        users: [{ userId: 1, username: 'alice', archived: false, personal: personal(1, 10), projectContribution: measure(0, 0) }],
      })
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 5, companyCostMicrosLimit: null })
    render(<UsagePage />)
    expect(await screen.findByText('正在加载用量')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await dialog.findByDisplayValue('5')
    // The save's quiet reload is the newest read and ends the initial spinner.
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByText('正在加载用量')).toBeNull())
    await act(async () => {
      resolveOld({
        month: '2026-08', timeZone: 'Asia/Shanghai',
        personal: measure(9, 999), projects: measure(0, 0), unattributedProjects: measure(0, 0),
        users: [{ userId: 9, username: 'stale', archived: false, personal: personal(9, 999), projectContribution: measure(0, 0) }],
      })
    })
    expect(api.listUsageOverview).toHaveBeenCalledTimes(3)
    const table = await screen.findByRole('table')
    expect(within(table).queryByText('stale')).toBeNull()
    expect(within(table).getAllByText('alice')).not.toHaveLength(0)
    expect(screen.queryByText('正在加载用量')).toBeNull()
  })

  it('settles reads, a valid write, and the post-write reload under StrictMode', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getRoleQuota).mockResolvedValue({ tokenLimit: 42_000, companyCostMicrosLimit: null })
    render(<StrictMode><UsagePage /></StrictMode>)
    expect(await screen.findByRole('table')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置月度额度' }))
    await dialog.findByDisplayValue('42000')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'role', subjectId: 'user', tokenLimit: 42_000, companyCostMicrosLimit: null,
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(vi.mocked(api.listUsageOverview).mock.calls.length).toBeGreaterThanOrEqual(2))
  })
})
