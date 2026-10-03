import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminApi from './api.ts'
import { createOrganizationModelsApi, createOrganizationModelsMirror } from './model-settings-api.ts'

vi.mock('./api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.ts')>()
  return {
    ...actual,
    describeOrganizationCredentials: vi.fn(),
    describeOrganizationModelSettings: vi.fn(),
    discoverOrganizationModels: vi.fn(),
    listModelProviders: vi.fn(),
    mutateOrganizationModelSettings: vi.fn(),
    setOrganizationCredential: vi.fn(),
    unsetOrganizationCredential: vi.fn(),
  }
})

const profile = {
  displayName: 'Primary',
  apiKeyEnv: 'DSH_ORG_PRIMARY_API_KEY',
  api: 'openai-responses',
  baseURL: 'https://api.example.com/v1',
  models: [{ id: 'chat', name: 'Chat' }],
}

function settingsView(revision = 4): adminApi.OrganizationModelSettingsView {
  const providers = { 'org-primary': profile }
  return {
    writable: true,
    hasDocument: false,
    namespaces: [{
      ns: 'llm-pi-ai',
      schema: {},
      value: { providers },
      base: { providers: {} },
      user: { providers },
      applies: 'live',
      secrets: [{ path: ['providers', 'org-primary', 'apiKeyEnv'], set: true }],
      revision,
    }],
  }
}

describe('organization models RPC facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminApi.describeOrganizationModelSettings).mockResolvedValue(settingsView())
    vi.mocked(adminApi.listModelProviders).mockResolvedValue([{
      provider: 'org-primary',
      displayName: 'Primary',
      driver: 'pi-ai',
      protocol: 'openai-responses',
      baseURL: 'https://api.example.com/v1',
      authMode: 'api-key',
      status: 'enabled',
      credentialRef: 'DSH_ORG_PRIMARY_API_KEY',
      credentialConfigured: true,
      source: 'managed',
      revision: 4,
      modelCount: 1,
      profile,
    }])
    vi.mocked(adminApi.mutateOrganizationModelSettings).mockResolvedValue(settingsView(5))
    vi.mocked(adminApi.describeOrganizationCredentials).mockResolvedValue({
      credentials: { DSH_ORG_PRIMARY_API_KEY: { configured: true, source: 'organization', writable: true } },
    })
    vi.mocked(adminApi.setOrganizationCredential).mockResolvedValue(undefined)
    vi.mocked(adminApi.unsetOrganizationCredential).mockResolvedValue(undefined)
    vi.mocked(adminApi.discoverOrganizationModels).mockResolvedValue({
      models: [{ id: 'chat', name: 'Chat', contextWindow: 128_000, maxTokens: 8_192 }],
    })
  })

  it('projects organization profiles into the shared provider and model directory', async () => {
    const facade = createOrganizationModelsApi()
    const providers = await facade.llm.providers()
    const models = await facade.llm.models()

    expect(providers).toMatchObject({ result: { ok: true, value: { providers: [{
      provider: 'org-primary',
      displayName: 'Primary',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'org-primary'],
      active: true,
      management: 'organization',
      declared: true,
    }] } } })
    expect(models).toMatchObject({ result: { ok: true, value: {
      groups: [{ id: 'org-primary', name: 'Primary', models: [{ id: 'chat', name: 'Chat' }] }],
      failures: [],
    } } })
  })

  it('maps settings writes and revision conflicts to the shared protocol', async () => {
    const onChanged = vi.fn()
    const facade = createOrganizationModelsApi({ onChanged })
    const ops = [{ op: 'set' as const, path: ['providers', 'org-primary', 'baseURL'], value: 'https://new.example/v1' }]
    const accepted = await facade.settings.mutate({ ns: 'llm-pi-ai', ops, expectedRevision: 4 })

    expect(adminApi.mutateOrganizationModelSettings).toHaveBeenCalledWith({ ops, expectedRevision: 4 })
    expect(accepted).toMatchObject({ result: { ok: true, value: { ns: 'llm-pi-ai', revision: 5 } } })
    expect(onChanged).toHaveBeenCalledTimes(1)

    vi.mocked(adminApi.mutateOrganizationModelSettings)
      .mockRejectedValueOnce(new adminApi.AdminRequestError(409, 'settings-conflict'))
    vi.mocked(adminApi.describeOrganizationModelSettings).mockResolvedValueOnce(settingsView(9))
    const conflict = await facade.settings.mutate({ ns: 'llm-pi-ai', ops, expectedRevision: 4 })
    expect(conflict).toMatchObject({ result: { ok: false, error: {
      code: 'settings-conflict',
      details: { ns: 'llm-pi-ai', expected: 4, actual: 9 },
    } } })
  })

  it('folds write answers and credential revision bumps into the describe mirror', async () => {
    const { describeFace, api } = createOrganizationModelsMirror()
    await describeFace.ensure()
    const revision = () => describeFace.getSnapshot().view?.namespaces
      .find(namespace => namespace.ns === 'llm-pi-ai')?.revision
    expect(revision()).toBe(4)

    // A mutate answer carries the fresh namespace and folds without a re-read.
    vi.mocked(adminApi.mutateOrganizationModelSettings).mockResolvedValueOnce(settingsView(5))
    await api.settings.mutate({ ns: 'llm-pi-ai', ops: [], expectedRevision: 4 })
    expect(revision()).toBe(5)
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(1)

    // A credential write bumps the same server revision; the mirror re-reads
    // so a follow-up mutate does not self-conflict on a stale expectedRevision.
    vi.mocked(adminApi.describeOrganizationModelSettings).mockResolvedValueOnce(settingsView(6))
    await api.credentials.set({ ref: 'DSH_ORG_PRIMARY_API_KEY', value: 'sk-secret' })
    await vi.waitFor(() => { expect(revision()).toBe(6) })

    // A conflict answer also refreshes the mirror so the next write can retry.
    vi.mocked(adminApi.mutateOrganizationModelSettings)
      .mockRejectedValueOnce(new adminApi.AdminRequestError(409, 'settings-conflict'))
    vi.mocked(adminApi.describeOrganizationModelSettings).mockResolvedValue(settingsView(7))
    const conflict = await api.settings.mutate({ ns: 'llm-pi-ai', ops: [], expectedRevision: 6 })
    expect(conflict).toMatchObject({ result: { ok: false, error: { code: 'settings-conflict' } } })
    await vi.waitFor(() => { expect(revision()).toBe(7) })
  })

  it('forwards credential and discovery operations without exposing key values', async () => {
    const onChanged = vi.fn()
    const facade = createOrganizationModelsApi({ onChanged })
    const described = await facade.credentials.describe({ refs: ['DSH_ORG_PRIMARY_API_KEY'] })
    await facade.credentials.set({ ref: 'DSH_ORG_PRIMARY_API_KEY', value: 'sk-secret' })
    await facade.credentials.unset({ ref: 'DSH_ORG_PRIMARY_API_KEY' })
    const discovered = await facade.llm.discoverModels({
      settingsNs: 'llm-pi-ai',
      provider: 'org-primary',
      baseURL: 'https://api.example.com/v1',
      api: 'openai-responses',
      apiKey: 'sk-probe',
    })

    expect(described).toMatchObject({ result: { ok: true, value: { credentials: {
      DSH_ORG_PRIMARY_API_KEY: { configured: true, source: 'organization', writable: true },
    } } } })
    expect(adminApi.setOrganizationCredential).toHaveBeenCalledWith('DSH_ORG_PRIMARY_API_KEY', 'sk-secret')
    expect(adminApi.unsetOrganizationCredential).toHaveBeenCalledWith('DSH_ORG_PRIMARY_API_KEY')
    expect(adminApi.discoverOrganizationModels).toHaveBeenCalledWith({
      provider: 'org-primary',
      baseURL: 'https://api.example.com/v1',
      api: 'openai-responses',
      apiKey: 'sk-probe',
    })
    expect(discovered).toMatchObject({ result: { ok: true, value: { models: [{ id: 'chat' }] } } })
    expect(onChanged).toHaveBeenCalledTimes(2)
  })
})
