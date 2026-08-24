import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ProjectDetailPage } from './ProjectDetailPage.tsx'

vi.mock('../api.ts', () => ({
  deleteProject: vi.fn(),
  getProjectModelAccess: vi.fn(),
  getProject: vi.fn(),
  getProjectUsage: vi.fn(),
  listUsageContributors: vi.fn(),
  listModelProviders: vi.fn(),
  listModels: vi.fn(),
  listUsers: vi.fn(),
  removeMember: vi.fn(),
  renameProject: vi.fn(),
  setMember: vi.fn(),
  setProjectModelAccess: vi.fn(),
  setAllProjectModelAccess: vi.fn(),
  setQuota: vi.fn(),
}))

const project = {
  id: 7,
  name: 'People',
  path: '/srv/people',
  memberCount: 1,
  members: [{ userId: 1, username: 'alice', mode: 'rw' as const }],
}

const alice = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  role: 'user' as const,
  status: 'active' as const,
  homePath: '/home/alice',
  mustChangePassword: false,
  port: 9101,
  instanceState: 'running',
}

const usage = {
  month: '2026-08',
  inputTokens: 700,
  outputTokens: 300,
  cacheReadTokens: 50,
  cacheWriteTokens: 20,
  totalTokens: 1_070,
  estimatedCostMicros: 2_000_000,
  companyCostMicros: 1_500_000,
  calls: 4,
  missingUsageCalls: 0,
  tokenLimit: 10_000,
  companyCostMicrosLimit: 5_000_000,
  alerts: [],
  pricing: { status: 'priced' as const, pricedCalls: 4, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
}

const contributors = {
  month: '2026-08',
  timeZone: 'Asia/Shanghai',
  projectId: 7,
  rows: [{
    userId: 1,
    username: 'alice',
    archived: false,
    projectCount: 1,
    inputTokens: 700,
    outputTokens: 300,
    cacheReadTokens: 50,
    cacheWriteTokens: 20,
    totalTokens: 1_070,
    estimatedCostMicros: 2_000_000,
    companyCostMicros: 1_500_000,
    calls: 4,
    missingUsageCalls: 0,
    pricing: { status: 'priced' as const, pricedCalls: 4, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
  }],
  unattributed: {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    estimatedCostMicros: 0, companyCostMicros: 0, calls: 0, missingUsageCalls: 0,
    pricing: { status: 'none' as const, pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 },
  },
}

const modelProviders: api.ModelProviderRow[] = [{
  provider: 'org-primary',
  displayName: 'Primary',
  driver: 'pi-ai',
  protocol: 'openai-completions',
  baseURL: 'https://api.example.com/v1',
  authMode: 'api-key',
  status: 'enabled',
  credentialRef: 'organization-model/org-primary/api-key',
  credentialConfigured: true,
  source: 'managed',
  revision: 1,
  modelCount: 2,
}]

const models: api.ModelGovernanceRow[] = [
  {
    provider: 'org-primary',
    model: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    enabled: true,
    adminAllowed: true,
    userAllowed: true,
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 0,
  },
  {
    provider: 'org-primary',
    model: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    enabled: true,
    adminAllowed: true,
    userAllowed: false,
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 0,
  },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7']}>
      <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('ProjectDetailPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getProject).mockResolvedValue(project)
    vi.mocked(api.listUsers).mockResolvedValue([alice])
    vi.mocked(api.getProjectUsage).mockResolvedValue(usage)
    vi.mocked(api.listUsageContributors).mockResolvedValue(contributors)
    vi.mocked(api.listModelProviders).mockResolvedValue(modelProviders)
    vi.mocked(api.listModels).mockResolvedValue(models)
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: false,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: false },
      ] },
      overrides: [{ provider: 'org-primary', model: 'deepseek-chat', allowed: true }],
    })
    vi.mocked(api.setProjectModelAccess).mockResolvedValue(undefined)
    vi.mocked(api.setAllProjectModelAccess).mockResolvedValue(undefined)
    vi.mocked(api.setQuota).mockResolvedValue(undefined)
  })

  it('shows project usage and reloads it for the selected month', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy()
    expect(within(await screen.findByLabelText('项目用量汇总')).getByText('1070')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    await waitFor(() => expect(api.getProjectUsage).toHaveBeenLastCalledWith(7, '2026-07'))
  })

  it('shows stored quota source and a readable project configuration summary', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      ...project,
      origin: 'admin',
      owner: { id: 1, username: 'alice', displayName: 'Alice' },
      createdBy: { id: 2, username: 'boss', displayName: 'Boss' },
      quota: { source: 'independent', tokenLimit: 10_000, companyCostMicrosLimit: 5_000_000 },
    })
    renderPage()
    const config = within(await screen.findByLabelText('项目配置'))
    expect(within(screen.getByLabelText('生效额度')).getByText('项目独立额度')).toBeTruthy()
    expect(config.getByText('项目独立额度')).toBeTruthy()
    expect(config.getByText('10,000')).toBeTruthy()
    expect(config.getByText('¥5.00')).toBeTruthy()
    expect(config.getByText('/srv/people')).toBeTruthy()
    expect(config.getByText('管理员发起')).toBeTruthy()
    expect(config.getByText('Alice')).toBeTruthy()
    expect(config.getByText('Boss')).toBeTruthy()
    expect(config.getByText('1 位')).toBeTruthy()
    expect(config.getByText('1 / 2')).toBeTruthy()
    expect(config.getByText('DeepSeek Chat')).toBeTruthy()
    expect(config.queryByText('DeepSeek Reasoner')).toBeNull()
  })

  it('labels inherited project quotas in the usage and configuration panels', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      ...project,
      quota: { source: 'inherit', tokenLimit: 8_000, companyCostMicrosLimit: null },
    })
    renderPage()
    const config = within(await screen.findByLabelText('项目配置'))
    expect(within(screen.getByLabelText('生效额度')).getByText('继承普通成员额度')).toBeTruthy()
    expect(config.getByText('继承普通成员额度')).toBeTruthy()
    expect(config.getByText('8,000')).toBeTruthy()
    expect(config.getByText('不限')).toBeTruthy()
  })

  it('defaults to independent unlimited quotas', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    expect((dialog.getByLabelText(/项目独立额度/) as HTMLInputElement).checked).toBe(true)
    expect((dialog.getByRole('button', { name: '保存额度' }) as HTMLButtonElement).disabled).toBe(false)
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project',
      subjectId: '7',
      tokenLimit: null,
      companyCostMicrosLimit: null,
    }))
  })

  it('can restore inherited project quotas', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    await user.click(dialog.getByLabelText(/继承普通成员额度/))
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project',
      subjectId: '7',
      tokenLimit: 'inherit',
      companyCostMicrosLimit: 'inherit',
    }))
  })

  it('saves independent Token and company-cost limits together', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    const modeSelects = dialog.getAllByLabelText('额度模式')
    await user.selectOptions(modeSelects[0]!, 'custom')
    await user.selectOptions(modeSelects[1]!, 'custom')
    await user.type(dialog.getByLabelText('每月 Token'), '12000')
    await user.type(dialog.getByLabelText('每月人民币元'), '8.5')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project',
      subjectId: '7',
      tokenLimit: 12_000,
      companyCostMicrosLimit: 8_500_000,
    }))
  })

  it('assigns and removes project models without role or user inheritance', async () => {
    const user = userEvent.setup()
    renderPage()
    const table = await screen.findByRole('table', { name: '项目模型权限' })
    const chatRow = within(table).getByRole('row', { name: /DeepSeek Chat/ })
    const reasonerRow = within(table).getByRole('row', { name: /DeepSeek Reasoner/ })
    expect((within(chatRow).getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect((within(reasonerRow).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByText('继承角色')).toBeNull()

    await user.click(within(reasonerRow).getByRole('checkbox'))
    await waitFor(() => expect(api.setProjectModelAccess).toHaveBeenCalledWith(
      7, 'org-primary', 'deepseek-reasoner', true,
    ))
    await user.click(within(chatRow).getByRole('checkbox'))
    await waitFor(() => expect(api.setProjectModelAccess).toHaveBeenCalledWith(
      7, 'org-primary', 'deepseek-chat', null,
    ))
  })

  it('assigns every project model in one write', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: false,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: false },
      ] },
      overrides: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-archived', model: 'legacy', allowed: true },
      ],
    })
    renderPage()
    const enableAll = await screen.findByRole('button', { name: '全部开启' }) as HTMLButtonElement
    expect(screen.getByText('1 / 2 个模型已授权 · 按项目单独授权 · 所有成员共享')).toBeTruthy()
    expect(enableAll.disabled).toBe(false)
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: false,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: true },
      ] },
      overrides: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: true },
        { provider: 'org-archived', model: 'legacy', allowed: true },
      ],
    })
    await user.click(enableAll)
    await waitFor(() => expect(api.setAllProjectModelAccess).toHaveBeenCalledWith(7, true))
    await waitFor(() => expect(enableAll.disabled).toBe(true))
  })

  it('clears every project model in one write', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: true,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: true },
      ] },
      overrides: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: true },
      ],
    })
    renderPage()
    const disableAll = await screen.findByRole('button', { name: '全部关闭' }) as HTMLButtonElement
    expect((screen.getByRole('button', { name: '全部开启' }) as HTMLButtonElement).disabled).toBe(true)
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: false,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: false },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: false },
      ] },
      overrides: [],
    })
    await user.click(disableAll)
    await waitFor(() => expect(api.setAllProjectModelAccess).toHaveBeenCalledWith(7, null))
    await waitFor(() => expect(disableAll.disabled).toBe(true))
  })

  it('shows default catalog authorization and records a denial exception', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProjectModelAccess).mockResolvedValue({
      projectDefaultAllowed: true,
      effective: { version: 1, defaultAllowed: false, models: [
        { provider: 'org-primary', model: 'deepseek-chat', allowed: true },
        { provider: 'org-primary', model: 'deepseek-reasoner', allowed: true },
      ] },
      overrides: [],
    })
    renderPage()
    const chatRow = within(await screen.findByRole('table', { name: '项目模型权限' }))
      .getByRole('row', { name: /DeepSeek Chat/ })
    expect(screen.getByText('2 / 2 个模型已授权 · 新增组织模型自动授权 · 所有成员共享')).toBeTruthy()
    await user.click(within(chatRow).getByRole('checkbox'))
    await waitFor(() => expect(api.setProjectModelAccess).toHaveBeenCalledWith(
      7, 'org-primary', 'deepseek-chat', false,
    ))
  })
})
