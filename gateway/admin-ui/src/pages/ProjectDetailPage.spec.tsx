import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { ProjectDetailPage } from './ProjectDetailPage.tsx'

vi.mock('../api.ts', () => ({
  controlProjectInstance: vi.fn(),
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
  mustChangePassword: false, autoReviewEligible: false,
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

  it('remounts per route id: a settling old read cannot overwrite the new target', async () => {
    const other = { ...project, id: 8, name: 'Second' }
    let resolveA!: (value: typeof project) => void
    vi.mocked(api.getProject).mockImplementation(async id => (
      id === 8 ? other : new Promise<typeof project>(resolve => { resolveA = resolve })
    ))
    render(
      <MemoryRouter initialEntries={['/projects/7']}>
        <Link to="/projects/8">next-project</Link>
        <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('link', { name: 'next-project' }))
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeTruthy()
    resolveA(project)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'People' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy()
  })

  it('closes the first target’s rename dialog when the route id changes', async () => {
    const other = { ...project, id: 8, name: 'Second' }
    vi.mocked(api.getProject).mockImplementation(async id => id === 8 ? other : project)
    render(
      <MemoryRouter initialEntries={['/projects/7']}>
        <Link to="/projects/8">next-project</Link>
        <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(screen.getByRole('dialog', { name: '重命名项目' })).toBeTruthy()
    await userEvent.click(screen.getByRole('link', { name: 'next-project' }))
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

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

  it('keeps rename failures and the submitted name in the dialog, then permits correction', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameProject).mockRejectedValueOnce(new Error('项目名称已存在')).mockResolvedValueOnce(undefined)
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '重命名' }))
    const dialog = within(screen.getByRole('dialog', { name: '重命名项目' }))
    const name = dialog.getByLabelText('项目名称') as HTMLInputElement
    await user.clear(name); await user.type(name, 'Duplicate')
    await user.click(dialog.getByRole('button', { name: '保存名称' }))
    expect((await dialog.findByRole('alert')).textContent).toContain('项目名称已存在')
    expect(name.value).toBe('Duplicate')
    await user.clear(name); await user.type(name, 'Available')
    await user.click(dialog.getByRole('button', { name: '保存名称' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名项目' })).toBeNull())
    expect(api.renameProject).toHaveBeenLastCalledWith(7, 'Available')
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

  it.each([
    { tokenLimit: 12_345, companyCostMicrosLimit: 8_500_000, costText: '8.5' },
    { tokenLimit: 0, companyCostMicrosLimit: 0, costText: '0' },
  ])('preserves stored project limits when saving without edits: $tokenLimit', async ({ tokenLimit, companyCostMicrosLimit, costText }) => {
    vi.mocked(api.getProject).mockResolvedValue({
      ...project, quota: { source: 'independent', tokenLimit, companyCostMicrosLimit },
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    expect((dialog.getByLabelText('每月 Token') as HTMLInputElement).value).toBe(String(tokenLimit))
    expect((dialog.getByLabelText('每月人民币元') as HTMLInputElement).value).toBe(costText)
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project', subjectId: '7', tokenLimit, companyCostMicrosLimit,
    }))
  })

  it('keeps inherited limits inherited when saving without edits', async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      ...project, quota: { source: 'inherit', tokenLimit: 8_000, companyCostMicrosLimit: null },
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    expect((dialog.getByLabelText(/继承普通成员额度/) as HTMLInputElement).checked).toBe(true)
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project', subjectId: '7', tokenLimit: 'inherit', companyCostMicrosLimit: 'inherit',
    }))
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

  it('ignores usage and contributor reads that settle after a newer month loaded', async () => {
    const oldUsage = { ...usage, month: '2026-08', totalTokens: 1 }
    const newUsage = { ...usage, month: '2026-07', totalTokens: 222 }
    const oldContributors = { ...contributors, month: '2026-08' }
    const newContributors = { ...contributors, month: '2026-07' }
    let resolveOldUsage!: (value: typeof usage) => void
    let resolveOldContributors!: (value: typeof contributors) => void
    vi.mocked(api.getProjectUsage)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldUsage = resolve }))
      .mockResolvedValue(newUsage)
    vi.mocked(api.listUsageContributors)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOldContributors = resolve }))
      .mockResolvedValue(newContributors)
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    const summary = within(await screen.findByLabelText('项目用量汇总'))
    await summary.findByText('222')
    await act(async () => {
      resolveOldUsage(oldUsage)
      resolveOldContributors(oldContributors)
    })
    expect(api.getProjectUsage).toHaveBeenCalledTimes(2)
    expect(summary.getByText('222')).toBeTruthy()
    expect(summary.queryByText('1')).toBeNull()
    expect(screen.queryByText('正在加载项目用量')).toBeNull()
  })

  it('keeps the newest month read when an earlier usage read fails late', async () => {
    let rejectOldUsage!: (cause: unknown) => void
    let rejectOldContributors!: (cause: unknown) => void
    vi.mocked(api.getProjectUsage)
      .mockImplementationOnce(() => new Promise((_ok, reject) => { rejectOldUsage = reject }))
      .mockResolvedValue(usage)
    vi.mocked(api.listUsageContributors)
      .mockImplementationOnce(() => new Promise((_ok, reject) => { rejectOldContributors = reject }))
      .mockResolvedValue(contributors)
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-07' } })
    const summary = within(await screen.findByLabelText('项目用量汇总'))
    await summary.findByText('1070')
    await act(async () => {
      rejectOldUsage(new Error('stale usage failure'))
      rejectOldContributors(new Error('stale contributor failure'))
    })
    expect(api.getProjectUsage).toHaveBeenCalledTimes(2)
    expect(summary.getByText('1070')).toBeTruthy()
    expect(screen.queryByText('stale usage failure')).toBeNull()
    expect(screen.queryByText('正在加载项目用量')).toBeNull()
  })

  it('does not navigate when a pending delete resolves after the route changed', async () => {
    const other = { ...project, id: 8, name: 'Second' }
    let resolveDelete!: () => void
    vi.mocked(api.deleteProject).mockImplementation(() => new Promise(resolve => { resolveDelete = () => resolve(undefined) }))
    vi.mocked(api.getProject).mockImplementation(async id => id === 8 ? other : project)
    render(
      <MemoryRouter initialEntries={['/projects/7']}>
        <Link to="/projects/8">next-project</Link>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects" element={<div>projects home</div>} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'People' })
    await userEvent.click(screen.getByRole('button', { name: '删除项目' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
    await userEvent.click(screen.getByRole('link', { name: 'next-project' }))
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeTruthy()
    const projectReads = vi.mocked(api.getProject).mock.calls.filter(([id]) => id === 7).length
    await act(async () => { resolveDelete() })
    expect(api.deleteProject).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.getProject).mock.calls.filter(([id]) => id === 7).length).toBe(projectReads)
    await waitFor(() => expect(screen.queryByText('projects home')).toBeNull())
    expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy()
  })

  it('rejects empty and unsafe cost inputs without posting a fallback write', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProject).mockResolvedValue({
      ...project, quota: { source: 'independent', tokenLimit: 12_345, companyCostMicrosLimit: 9_250_001 },
    })
    renderPage()
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    const costInput = dialog.getByLabelText('每月人民币元') as HTMLInputElement
    // Stored micro-precision cost renders exactly and survives a tokens-only edit.
    expect(costInput.value).toBe('9.250001')
    const tokenInput = dialog.getByLabelText('每月 Token') as HTMLInputElement
    await user.clear(tokenInput)
    await user.type(tokenInput, '777')
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project', subjectId: '7', tokenLimit: 777, companyCostMicrosLimit: 9_250_001,
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置项目额度' })).toBeNull())
    vi.mocked(api.setQuota).mockClear()
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const again = within(screen.getByRole('dialog', { name: '配置项目额度' }))
    const form = document.getElementById('project-quota-form') as HTMLFormElement
    await user.clear(again.getByLabelText('每月 Token'))
    fireEvent.submit(form)
    expect(await again.findByText('Token 额度必须是非负整数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    await user.type(again.getByLabelText('每月 Token'), '777')
    await user.clear(again.getByLabelText('每月人民币元'))
    fireEvent.submit(form)
    expect(await again.findByText('成本额度必须是有效的非负数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    await user.type(again.getByLabelText('每月人民币元'), '-1')
    fireEvent.submit(form)
    expect(await again.findByText('成本额度必须是有效的非负数')).toBeTruthy()
    expect(api.setQuota).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '配置项目额度' })).toBeTruthy()
  })

  it('settles reads, a valid write, and the post-write reload under StrictMode', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProject).mockResolvedValue({
      ...project, quota: { source: 'independent', tokenLimit: 12_345, companyCostMicrosLimit: 8_500_000 },
    })
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/projects/7']}>
          <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
        </MemoryRouter>
      </StrictMode>,
    )
    await screen.findByRole('heading', { name: 'People' })
    // StrictMode replay already satisfies these counts; only increments after
    // the settled baseline prove the post-write reload ran.
    const projectReads = vi.mocked(api.getProject).mock.calls.length
    const usageReads = vi.mocked(api.getProjectUsage).mock.calls.length
    const contributorReads = vi.mocked(api.listUsageContributors).mock.calls.length
    await user.click(screen.getByRole('button', { name: '配置额度' }))
    const dialog = within(await screen.findByRole('dialog', { name: '配置项目额度' }))
    await user.click(dialog.getByRole('button', { name: '保存额度' }))
    await waitFor(() => expect(api.setQuota).toHaveBeenCalledWith({
      subjectType: 'project', subjectId: '7', tokenLimit: 12_345, companyCostMicrosLimit: 8_500_000,
    }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置项目额度' })).toBeNull())
    await waitFor(() => expect(vi.mocked(api.getProject).mock.calls.length).toBeGreaterThan(projectReads))
    await waitFor(() => expect(vi.mocked(api.getProjectUsage).mock.calls.length).toBeGreaterThan(usageReads))
    await waitFor(() => expect(vi.mocked(api.listUsageContributors).mock.calls.length).toBeGreaterThan(contributorReads))
    await screen.findByRole('heading', { name: 'People' })
    await waitFor(() => expect(screen.queryByText('正在加载成员贡献')).toBeNull())
    expect(await screen.findByRole('heading', { name: '成员贡献' })).toBeTruthy()
    expect(screen.queryByText('正在加载项目用量')).toBeNull()
  })
})
