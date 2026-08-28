import { describe, expect, it, vi } from 'vitest'
import { ProjectModelsBridge } from '../src/client/project-store.ts'

function view() {
  return {
    projectId: 7,
    revision: 2,
    writable: true,
    hasDocument: false as const,
    namespaces: [{
      ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
      applies: 'live' as const, secrets: [], revision: 2,
    }],
    providers: [],
    models: { groups: [], failures: [] },
  }
}

describe('ProjectModelsBridge', () => {
  it('shares one project read between the Models joins and settings mirror', async () => {
    const get = vi.fn(async () => view())
    const transport = {
      get,
      mutate: vi.fn(async () => view()),
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    const [providers, models, settings] = await Promise.all([
      bridge.api.llm.providers({}), bridge.api.llm.models({}), bridge.mirror.ensure(),
    ])
    expect(providers.result).toMatchObject({ ok: true, value: { providers: [] } })
    expect(models.result).toMatchObject({ ok: true, value: { groups: [], failures: [] } })
    expect(settings).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
    expect(bridge.mirror.getSnapshot().status).toBe('ready')
  })

  it('refreshes the project snapshot after the first read', async () => {
    const first = view()
    const second = {
      ...view(),
      revision: 3,
      namespaces: [{ ...view().namespaces[0]!, revision: 3 }],
    }
    const get = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const transport = {
      get,
      mutate: vi.fn(async () => second),
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    await bridge.api.llm.providers({})
    expect(get).toHaveBeenCalledTimes(2)
    expect(bridge.mirror.getSnapshot().view?.namespaces[0]?.revision).toBe(3)
  })

  it('keeps redacted headers and unrelated providers on compatibility updates', async () => {
    const first = {
      ...view(),
      namespaces: [{
        ...view().namespaces[0]!,
        value: {
          providers: {
            relay: { baseURL: 'https://relay.example/v1', headers: { 'x-secret': '[redacted]' } },
            other: { baseURL: 'https://other.example/v1' },
          },
        },
        user: {
          providers: {
            relay: { baseURL: 'https://relay.example/v1', headers: { 'x-secret': '[redacted]' } },
            other: { baseURL: 'https://other.example/v1' },
          },
        },
      }],
    }
    const mutate = vi.fn(async (_projectId: number, _body: unknown) => first)
    const transport = {
      get: vi.fn(async () => first),
      mutate,
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    await bridge.api.settings.update({ ns: 'llm-pi-ai', patch: {
      providers: { relay: { baseURL: 'https://relay.example/v2', headers: { 'x-secret': '[redacted]' } } },
    } })
    expect(mutate).toHaveBeenCalledWith(7, {
      ops: [{ op: 'set', path: ['providers', 'relay', 'baseURL'], value: 'https://relay.example/v2' }],
      expectedRevision: 2,
    })
  })
})
