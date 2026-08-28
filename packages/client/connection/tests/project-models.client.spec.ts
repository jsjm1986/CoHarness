import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserProjectModelSettingsTransport,
  parseProjectModelSettings,
  ProjectModelSettingsRequestError,
} from '../src/client/project-models.ts'

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 7,
    revision: 2,
    writable: true,
    hasDocument: false,
    namespaces: [{
      ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
      applies: 'live', secrets: [], revision: 2,
    }],
    providers: [{
      provider: 'relay', runtimeProvider: 'project-7-relay', displayName: 'Relay',
      protocol: 'anthropic-messages', baseURL: 'https://relay.example/v1', authMode: 'api-key',
      status: 'enabled', credentialRef: 'DSH_PROJECT_7_RELAY_API_KEY', credentialConfigured: true,
      revision: 1, modelCount: 1, profile: {}, models: [{ id: 'chat', name: 'Chat' }],
    }],
    models: {
      groups: [{
        id: 'relay', name: 'Relay', models: [{
          id: 'chat', name: 'Chat', contextWindow: 32_768, maxTokens: 4096, inputModalities: ['text'],
        }],
      }],
      failures: [],
    },
    ...overrides,
  }
}

describe('project model settings response parsing', () => {
  it('normalizes a complete redacted project response', () => {
    expect(parseProjectModelSettings(response())).toMatchObject({
      projectId: 7,
      providers: [{ protocol: 'anthropic-messages', models: [{ id: 'chat' }] }],
      models: { groups: [{ models: [{ contextWindow: 32_768, inputModalities: ['text'] }] }] },
    })
  })

  it.each([
    ['missing namespaces', { namespaces: undefined }],
    ['invalid namespace revision', { namespaces: [{ ns: 'x', schema: {}, value: {}, applies: 'live', secrets: [], revision: -1 }] }],
    ['invalid provider protocol', { providers: [{
      provider: 'relay', runtimeProvider: 'project-7-relay', displayName: 'Relay', protocol: 'other',
      baseURL: 'https://relay.example/v1', authMode: 'api-key', status: 'enabled',
      credentialRef: 'DSH_PROJECT_7_RELAY_API_KEY', credentialConfigured: true, revision: 1, modelCount: 1,
    }] }],
    ['invalid model capacity', { models: { groups: [{ id: 'x', name: 'x', models: [{ id: 'm', name: 'm', maxTokens: 0 }] }], failures: [] } }],
  ] as const)('rejects %s', (_label, overrides) => {
    expect(() => parseProjectModelSettings(response(overrides))).toThrow(/invalid project model/)
  })
})

describe('project model settings browser transport', () => {
  it('uses the project routes for reads, writes, credentials, and discovery', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/credentials?refs=KEY')) {
        return new Response(JSON.stringify({ credentials: { KEY: { configured: true, source: 'project', writable: true } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/discover')) {
        return new Response(JSON.stringify({ models: [{ id: 'chat', name: 'Chat', contextWindow: 4096 }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'PUT' || init?.method === 'PATCH') {
        return new Response(JSON.stringify(response()), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify(response()), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const transport = createBrowserProjectModelSettingsTransport(fetcher as unknown as typeof fetch)
    await transport.get(7)
    await transport.mutate(7, { ops: [{ op: 'set', path: ['providers', 'relay'], value: {} }] })
    await expect(transport.describeCredentials(7, ['KEY'])).resolves.toEqual({
      credentials: { KEY: { configured: true, source: 'project', writable: true } },
    })
    await transport.setCredential(7, 'KEY', 'secret')
    await transport.unsetCredential(7, 'KEY')
    await expect(transport.discover(7, { api: 'anthropic-messages' })).resolves.toEqual({
      models: [{ id: 'chat', name: 'Chat', contextWindow: 4096 }],
    })
    expect(fetcher).toHaveBeenCalled()
  })

  it('keeps HTTP error codes and rejects malformed discovery rows', async () => {
    const failed = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    }))
    const transport = createBrowserProjectModelSettingsTransport(failed)
    await expect(transport.get(7)).rejects.toMatchObject({
      status: 403, code: 'forbidden',
    } satisfies Partial<ProjectModelSettingsRequestError>)

    const malformed = vi.fn(async () => new Response(JSON.stringify({ models: [{ id: '' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const malformedTransport = createBrowserProjectModelSettingsTransport(malformed)
    await expect(malformedTransport.discover(7, {})).rejects.toThrow(/discovered model id/)

    const shell = vi.fn(async () => new Response('<html />', {
      status: 200, headers: { 'content-type': 'text/html' },
    }))
    const shellTransport = createBrowserProjectModelSettingsTransport(shell)
    await expect(shellTransport.get(7)).rejects.toMatchObject({
      status: 501, code: 'project-model-settings-unsupported',
    } satisfies Partial<ProjectModelSettingsRequestError>)
  })
})
