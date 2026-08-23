import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORGANIZATION_MODEL_SETTINGS_SCHEMA } from '../../../src/organization-model-settings-schema.ts'
import * as api from '../api.ts'
import { ModelsPage } from './ModelsPage.tsx'

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>()
  return {
    ...actual,
    describeOrganizationCredentials: vi.fn(),
    describeOrganizationModelSettings: vi.fn(),
    discoverOrganizationModels: vi.fn(),
    getModelAccess: vi.fn(),
    listModelProviders: vi.fn(),
    listModelRegistrations: vi.fn(),
    listModels: vi.fn(),
    listUsers: vi.fn(),
    mutateOrganizationModelSettings: vi.fn(),
    saveModel: vi.fn(),
    setModelAccess: vi.fn(),
    setOrganizationCredential: vi.fn(),
    unsetOrganizationCredential: vi.fn(),
  }
})

const profile = {
  displayName: '组织主连接',
  apiKeyEnv: 'DSH_ORG_PRIMARY_API_KEY',
  api: 'openai-responses',
  baseURL: 'https://api.example.com/v1',
  models: [{
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    contextWindow: 128_000,
    maxTokens: 8_192,
  }],
  headers: { 'x-team': 'core' },
  reasoning: 'high',
}

function settingsView(revision = 3): api.OrganizationModelSettingsView {
  const providers = { 'org-primary': profile }
  return {
    writable: true,
    hasDocument: false,
    namespaces: [{
      ns: 'llm-pi-ai',
      schema: ORGANIZATION_MODEL_SETTINGS_SCHEMA,
      value: { providers },
      base: { providers: {} },
      user: { providers },
      applies: 'live',
      secrets: [{ path: ['providers', 'org-primary', 'apiKeyEnv'], set: true }],
      revision,
    }],
  }
}

const providers: api.ModelProviderRow[] = [{
  provider: 'org-primary',
  displayName: '组织主连接',
  driver: 'pi-ai',
  protocol: 'openai-responses',
  baseURL: 'https://api.example.com/v1',
  authMode: 'api-key',
  status: 'enabled',
  credentialRef: 'DSH_ORG_PRIMARY_API_KEY',
  credentialConfigured: true,
  source: 'managed',
  revision: 3,
  modelCount: 1,
  profile,
}]

const models: api.ModelGovernanceRow[] = [{
  provider: 'org-primary',
  model: 'deepseek-chat',
  displayName: 'DeepSeek Chat',
  enabled: true,
  adminAllowed: true,
  userAllowed: false,
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
  cacheReadMicrosPerMillion: 100_000,
  cacheWriteMicrosPerMillion: 200_000,
}]

const users: api.AdminUser[] = [{
  id: 7,
  username: 'alice',
  displayName: 'Alice',
  role: 'user',
  status: 'active',
  homePath: '/home/alice',
  mustChangePassword: false,
  port: 9107,
  instanceState: 'running',
}]

describe('ModelsPage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.describeOrganizationModelSettings).mockResolvedValue(settingsView())
    vi.mocked(api.mutateOrganizationModelSettings).mockResolvedValue(settingsView(4))
    vi.mocked(api.describeOrganizationCredentials).mockImplementation(async refs => ({
      credentials: Object.fromEntries(refs.map(ref => [ref, {
        configured: ref === 'DSH_ORG_PRIMARY_API_KEY',
        source: 'organization' as const,
        writable: true as const,
      }])),
    }))
    vi.mocked(api.setOrganizationCredential).mockResolvedValue(undefined)
    vi.mocked(api.unsetOrganizationCredential).mockResolvedValue(undefined)
    vi.mocked(api.discoverOrganizationModels).mockResolvedValue({ models: [] })
    vi.mocked(api.listModelProviders).mockResolvedValue(providers)
    vi.mocked(api.listModelRegistrations).mockResolvedValue({
      summary: { providerCount: 1, modelCount: 1, eventCount: 2, createdCount: 2, modifiedCount: 0, deletedCount: 0 },
      rows: [{
        eventId: 'registration-1', userId: 7, occurredAt: Date.parse('2026-08-24T00:00:00Z'),
        receivedAt: Date.parse('2026-08-24T00:00:00Z'), provider: 'custom', model: 'chat',
        action: 'model-created', scope: 'personal',
      }],
    })
    vi.mocked(api.listModels).mockResolvedValue(models)
    vi.mocked(api.listUsers).mockResolvedValue(users)
    vi.mocked(api.getModelAccess).mockResolvedValue({
      effective: { version: 1, defaultAllowed: false, models: [] },
      overrides: [],
    })
    vi.mocked(api.saveModel).mockResolvedValue(undefined)
    vi.mocked(api.setModelAccess).mockResolvedValue(undefined)
  })

  it('mounts the shared full Provider and model editor for organization settings', async () => {
    const user = userEvent.setup()
    render(<ModelsPage />)

    expect(await screen.findByText('组织主连接')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '添加提供方' })).toBeNull()
    expect(screen.getByRole('button', { name: '添加组织 Provider' })).toBeTruthy()
    expect(screen.queryByText('自定义')).toBeNull()
    expect(screen.getByText('组织')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '编辑 组织主连接 (org-primary)' }))
    await user.click(screen.getByText('自定义设置'))

    expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe(profile.baseURL)
    expect((screen.getByLabelText('API 协议') as HTMLSelectElement).value).toBe(profile.api)
    expect((screen.getByLabelText('模型 ID 1') as HTMLInputElement).value).toBe('deepseek-chat')
    expect((screen.getByLabelText('显示名称 1') as HTMLInputElement).value).toBe('DeepSeek Chat')
    expect(screen.getByRole('button', { name: '获取可用模型' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复默认模型' })).toBeNull()
    expect(screen.queryByRole('button', { name: '登记模型' })).toBeNull()
  })

  it('shows personal registration history without exposing an organization write action', async () => {
    const user = userEvent.setup()
    render(<ModelsPage />)
    await screen.findByText('组织主连接')
    await user.click(screen.getByRole('button', { name: '个人登记' }))
    expect(await screen.findByText('个人 Provider/model 登记')).toBeTruthy()
    expect(screen.getAllByText('新增 model').length).toBeGreaterThan(0)
    expect(screen.getByText('custom')).toBeTruthy()
    expect(api.listModelRegistrations).toHaveBeenCalled()
  })

  it('creates an org-prefixed Provider with a complete model profile and credential', async () => {
    const user = userEvent.setup()
    render(<ModelsPage />)
    await screen.findByText('组织主连接')

    await user.click(screen.getByRole('button', { name: '添加组织 Provider' }))
    const route = screen.getByLabelText('Provider ID')
    await user.type(route, 'acme')
    expect(screen.getByText('组织 Provider ID 必须匹配 org-名称，例如 org-primary。')).toBeTruthy()
    await user.clear(route)
    await user.type(route, 'org-secondary')
    await user.type(screen.getByLabelText('显示名称'), '次级连接')
    await user.type(screen.getByLabelText('API 地址'), 'https://secondary.example.com/v1')
    await user.selectOptions(screen.getByLabelText('API 协议'), 'openai-responses')
    await user.type(screen.getByLabelText('API 密钥'), 'sk-secondary')
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    await user.type(screen.getByLabelText('模型 ID 1'), 'chat-v2')
    await user.type(screen.getByLabelText('显示名称 1'), 'Chat V2')
    await user.click(screen.getByRole('button', { name: '创建组织 Provider' }))

    await waitFor(() => expect(api.mutateOrganizationModelSettings).toHaveBeenCalledWith({
      expectedRevision: 3,
      ops: [{
        op: 'set',
        path: ['providers', 'org-secondary'],
        value: {
          displayName: '次级连接',
          apiKeyEnv: 'DSH_ORG_SECONDARY_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://secondary.example.com/v1',
          models: [{ id: 'chat-v2', name: 'Chat V2' }],
        },
      }],
    }))
    expect(api.setOrganizationCredential).toHaveBeenCalledWith('DSH_ORG_SECONDARY_API_KEY', 'sk-secondary')
  })

  it('keeps authorization and pricing in the governance view', async () => {
    const user = userEvent.setup()
    render(<ModelsPage />)
    await screen.findByText('组织主连接')
    await user.click(screen.getByRole('button', { name: '权限与计价' }))

    expect(await screen.findByRole('heading', { name: '组织模型权限与计价' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登记模型' })).toBeNull()
    const override = screen.getAllByRole('combobox', { name: 'alice 的例外' })[0] as HTMLSelectElement
    await waitFor(() => expect(override.disabled).toBe(false))
    await user.selectOptions(override, 'allow')
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(7, 'org-primary', 'deepseek-chat', true))

    await user.click(screen.getAllByRole('button', { name: '配置模型治理' })[0]!)
    const dialog = within(screen.getByRole('dialog', { name: '配置模型治理' }))
    expect(dialog.getByText('org-primary/deepseek-chat')).toBeTruthy()
    expect(dialog.queryByLabelText('Provider ID')).toBeNull()
    const inputPrice = dialog.getByLabelText('输入')
    await user.clear(inputPrice)
    await user.type(inputPrice, '1.5000')
    await user.click(dialog.getByRole('button', { name: '保存治理配置' }))
    await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith({
      ...models[0],
      inputMicrosPerMillion: 1_500_000,
    }))
  })
})
