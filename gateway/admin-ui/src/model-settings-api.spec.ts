import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminApi from './api.ts'
import { createOrganizationModelsApi, createOrganizationModelsMirror, OrganizationModelsStore } from './model-settings-api.ts'
import { ModelsSettingsStore } from '../../../packages/client/ui-settings-models/src/client/store.ts'
import { createSettingsSchemaOperations } from '../../../packages/client/ui-settings-models/src/client/schema-operations.ts'
import { SettingsSchemaService } from '../../../packages/client/ui-settings/src/client/schema.ts'
import { Context } from '@deepseek-ai/cordis'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('organization models RPC facade', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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

  it('shares one pending organization settings read across the mounted facade readers', async () => {
    let release!: (view: adminApi.OrganizationModelSettingsView) => void
    const pending = new Promise<adminApi.OrganizationModelSettingsView>(resolve => { release = resolve })
    vi.mocked(adminApi.describeOrganizationModelSettings).mockReturnValue(pending)
    const { describeFace, api } = createOrganizationModelsMirror()
    const described = describeFace.ensure()
    await vi.waitFor(() => expect(describeFace.getSnapshot().status).toBe('loading'))
    const providers = api.llm.providers()
    const models = api.llm.models()
    try {
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(1)
    } finally {
      release(settingsView())
      await Promise.all([described, providers, models])
    }
  })

  it('reads again after settlement and isolates independent facade owners', async () => {
    const pending = deferred<adminApi.OrganizationModelSettingsView>()
    vi.mocked(adminApi.describeOrganizationModelSettings).mockReturnValue(pending.promise)
    const first = createOrganizationModelsApi()
    const second = createOrganizationModelsApi()
    const readers = [first.settings.describe(), first.llm.models(), second.settings.describe()]
    try {
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
    } finally {
      pending.resolve(settingsView())
      await Promise.all(readers)
    }
    vi.mocked(adminApi.describeOrganizationModelSettings).mockResolvedValueOnce(settingsView(9))
    expect(await first.settings.describe()).toMatchObject({ result: { ok: true, value: {
      namespaces: [{ revision: 9 }],
    } } })
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(3)
  })

  it('starts a fresh explicit round while an older read is pending and keeps the latest rows', async () => {
    const old = deferred<adminApi.OrganizationModelSettingsView>()
    const fresh = deferred<adminApi.OrganizationModelSettingsView>()
    vi.mocked(adminApi.describeOrganizationModelSettings).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const { api, describeFace } = createOrganizationModelsMirror()
    const schema = createSettingsSchemaOperations(new SettingsSchemaService(new Context()))
    const controller = new OrganizationModelsStore(api, schema, describeFace)
    const older = controller.load()
    await vi.waitFor(() => expect(describeFace.getSnapshot().status).toBe('loading'))
    const latest = controller.load()
    try {
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
      const changed = settingsView(5)
      changed.namespaces[0]!.value = { providers: { 'org-primary': {
        ...profile, displayName: 'Latest organization route', models: [{ id: 'new-model', name: 'New model' }],
      } } }
      fresh.resolve(changed)
      old.resolve(settingsView())
      await Promise.all([older, latest])
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', rows: [{
        entry: { displayName: 'Latest organization route' }, models: [{ id: 'new-model' }],
      }] })
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
    } finally {
      old.resolve(settingsView())
      fresh.resolve(settingsView(5))
      await Promise.all([older, latest])
    }
  })

  it('retries a failed shared read without retaining its failure', async () => {
    const pending = deferred<adminApi.OrganizationModelSettingsView>()
    vi.mocked(adminApi.describeOrganizationModelSettings).mockReturnValueOnce(pending.promise)
    const api = createOrganizationModelsApi()
    const readers = [api.settings.describe(), api.llm.providers(), api.llm.models()]
    pending.reject(new Error('read interrupted'))
    for (const result of await Promise.all(readers)) expect(result).toMatchObject({ result: { ok: false } })
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(1)
    expect(await api.settings.describe()).toMatchObject({ result: { ok: true } })
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
  })

  it.each(['settings', 'set', 'unset'] as const)('invalidates shared reads before and after a %s write', async kind => {
    const old = deferred<adminApi.OrganizationModelSettingsView>()
    const during = deferred<adminApi.OrganizationModelSettingsView>()
    const fresh = deferred<adminApi.OrganizationModelSettingsView>()
    const write = deferred<void>()
    vi.mocked(adminApi.describeOrganizationModelSettings)
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(during.promise).mockReturnValueOnce(fresh.promise)
    if (kind === 'settings') {
      vi.mocked(adminApi.mutateOrganizationModelSettings).mockImplementationOnce(async () => {
        await write.promise
        return settingsView(5)
      })
    } else if (kind === 'set') vi.mocked(adminApi.setOrganizationCredential).mockReturnValueOnce(write.promise)
    else vi.mocked(adminApi.unsetOrganizationCredential).mockReturnValueOnce(write.promise)
    let notificationRead: Promise<unknown> | undefined
    const api = createOrganizationModelsApi({ onChanged: () => { notificationRead = api.settings.describe() } })
    const older = api.settings.describe()
    const writing = kind === 'settings'
      ? api.settings.mutate({ ns: 'llm-pi-ai', ops: [], expectedRevision: 4 })
      : kind === 'set' ? api.credentials.set({ ref: 'DSH_ORG_PRIMARY_API_KEY', value: 'synthetic-key' })
        : api.credentials.unset({ ref: 'DSH_ORG_PRIMARY_API_KEY' })
    const whileWriting = api.settings.describe()
    try {
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
      write.resolve()
      expect(await writing).toMatchObject({ result: { ok: true } })
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(3)
      old.resolve(settingsView())
      during.resolve(settingsView())
      await Promise.all([older, whileWriting])
      const joined = api.settings.describe()
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(3)
      fresh.resolve(settingsView(6))
      expect(await joined).toMatchObject({ result: { ok: true, value: { namespaces: [{ revision: 6 }] } } })
    } finally {
      write.resolve()
      old.resolve(settingsView())
      during.resolve(settingsView())
      fresh.resolve(settingsView(6))
      await Promise.all([older, whileWriting, writing, notificationRead])
    }
  })

  it('rejects late shared results and new reads after the page owner is aborted', async () => {
    const pending = deferred<adminApi.OrganizationModelSettingsView>()
    const owner = new AbortController()
    vi.mocked(adminApi.describeOrganizationModelSettings).mockReturnValueOnce(pending.promise)
    const api = createOrganizationModelsApi({ signal: owner.signal })
    const readers = [api.settings.describe(), api.llm.providers(), api.llm.models()]
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledWith(owner.signal)
    owner.abort()
    pending.resolve(settingsView())
    for (const result of await Promise.all(readers)) expect(result).toMatchObject({ result: { ok: false } })
    expect(await api.settings.describe()).toMatchObject({ result: { ok: false } })
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(1)
    expect(await createOrganizationModelsApi().settings.describe()).toMatchObject({ result: { ok: true } })
    expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(2)
  })

  it('uses a fresh revision when a conflict arrives while an older read is pending', async () => {
    const old = deferred<adminApi.OrganizationModelSettingsView>()
    const during = deferred<adminApi.OrganizationModelSettingsView>()
    const write = deferred<adminApi.OrganizationModelSettingsView>()
    vi.mocked(adminApi.describeOrganizationModelSettings)
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(during.promise).mockResolvedValueOnce(settingsView(9))
    vi.mocked(adminApi.mutateOrganizationModelSettings).mockReturnValueOnce(write.promise)
    const api = createOrganizationModelsApi()
    const older = api.settings.describe()
    const writing = api.settings.mutate({ ns: 'llm-pi-ai', ops: [], expectedRevision: 4 })
    const whileWriting = api.settings.describe()
    try {
      write.reject(new adminApi.AdminRequestError(409, 'settings-conflict'))
      expect(await writing).toMatchObject({ result: { ok: false, error: {
        code: 'settings-conflict', details: { expected: 4, actual: 9 },
      } } })
      expect(adminApi.describeOrganizationModelSettings).toHaveBeenCalledTimes(3)
    } finally {
      old.resolve(settingsView())
      during.resolve(settingsView())
      await Promise.all([older, whileWriting, writing])
    }
  })

  it('keeps a late conflict structured when its owner has already been aborted', async () => {
    const write = deferred<adminApi.OrganizationModelSettingsView>()
    const owner = new AbortController()
    vi.mocked(adminApi.mutateOrganizationModelSettings).mockReturnValueOnce(write.promise)
    const api = createOrganizationModelsApi({ signal: owner.signal })
    const writing = api.settings.mutate({ ns: 'llm-pi-ai', ops: [], expectedRevision: 4 })
    owner.abort()
    write.reject(new adminApi.AdminRequestError(409, 'settings-conflict'))
    expect(await writing).toMatchObject({ result: { ok: false, error: {
      code: 'settings-conflict', details: { expected: 4, actual: 4 },
    } } })
    expect(adminApi.describeOrganizationModelSettings).not.toHaveBeenCalled()
  })

  it('stops a departed page before a late provider list can start credential reads', async () => {
    const providers = deferred<Awaited<ReturnType<typeof adminApi.listModelProviders>>>()
    const owner = new AbortController()
    vi.mocked(adminApi.listModelProviders).mockReturnValueOnce(providers.promise)
    const { api, describeFace } = createOrganizationModelsMirror({ signal: owner.signal })
    // Provider rejection ends the read before schema operations are reachable.
    const controller = new ModelsSettingsStore(api as never, {} as never, describeFace)
    const loaded = controller.load()
    try {
      await vi.waitFor(() => expect(describeFace.getSnapshot().status).toBe('ready'))
      owner.abort()
    } finally {
      owner.abort()
      providers.resolve([])
      await loaded
    }
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(adminApi.describeOrganizationCredentials).not.toHaveBeenCalled()
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
    }, undefined)
    expect(discovered).toMatchObject({ result: { ok: true, value: { models: [{ id: 'chat' }] } } })
    expect(onChanged).toHaveBeenCalledTimes(2)
  })
})
