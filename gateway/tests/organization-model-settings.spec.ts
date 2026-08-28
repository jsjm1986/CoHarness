import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverOrganizationModels,
  organizationModelSettingsSchema,
  validateProjectProfiles,
  validateOrganizationProfiles,
} from '../src/organization-model-settings.ts'

const profile = {
  displayName: 'Primary',
  apiKeyEnv: 'DSH_ORG_PRIMARY_API_KEY',
  api: 'openai-responses',
  baseURL: 'https://models.example.test/v1',
  models: [{ id: 'chat', name: 'Chat' }],
}

const openAiProfile = {
  ...profile,
  api: 'openai-completions',
  models: [{
    id: 'chat',
    name: 'Chat',
    reasoningEfforts: { off: null, low: 'low', high: 'high' },
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
  }],
  compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
  thinkingBudgets: { minimal: 256, low: 512, medium: 1024, high: 2048 },
  streamIdleTimeoutMs: 120_000,
  retryPolicy: {
    mode: 'normal',
    maxRetries: 3,
    retryableCodes: ['TIMEOUT', 'TRANSPORT'],
    backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.2 },
  },
}

describe('organization model settings validation', () => {
  it('accepts namespaced organization credential references, including rotated refs', () => {
    expect(validateOrganizationProfiles({
      providers: {
        'org-primary': profile,
        'org-rotated': { ...profile, apiKeyEnv: 'DSH_ORG_ROTATED_API_KEY' },
      },
    })).toMatchObject({
      'org-primary': profile,
      'org-rotated': { apiKeyEnv: 'DSH_ORG_ROTATED_API_KEY' },
    })
  })

  it('rejects a personal-style credential reference in an organization profile', () => {
    expect(() => validateOrganizationProfiles({
      providers: { 'org-primary': { ...profile, apiKeyEnv: 'OPENAI_API_KEY' } },
    })).toThrow(/must use an organization credential reference beginning with DSH_/)
  })

  it('rejects a project-scoped credential reference in an organization profile', () => {
    expect(() => validateOrganizationProfiles({
      providers: { 'org-primary': { ...profile, apiKeyEnv: 'DSH_PROJECT_7_RELAY_API_KEY' } },
    })).toThrow(/must not use a project credential reference/)
  })

  it('rejects non-empty catalog overrides because organization models are explicit', () => {
    expect(() => validateOrganizationProfiles({
      providers: { 'org-primary': { ...profile, modelOverrides: { chat: { name: 'Renamed' } } } },
    })).toThrow(/modelOverrides is unsupported; declare organization model fields in models/)
  })

  it('accepts the empty modelOverrides default emitted by the shared schema', () => {
    expect(validateOrganizationProfiles({
      providers: { 'org-primary': { ...profile, modelOverrides: {} } },
    })).toMatchObject({ 'org-primary': { modelOverrides: {} } })
  })

  it('does not expose catalog-only overrides in the organization editor schema', () => {
    expect(JSON.stringify(organizationModelSettingsSchema())).not.toContain('modelOverrides')
  })

  it('accepts the complete rc.7 reasoning, timer, and retry profile', () => {
    expect(validateOrganizationProfiles({ providers: { 'org-primary': openAiProfile } }))
      .toMatchObject({ 'org-primary': openAiProfile })
  })

  it('accepts empty compat defaults on protocols that do not use the switches', () => {
    expect(validateOrganizationProfiles({
      providers: { 'org-primary': { ...profile, compat: {}, models: [{ id: 'chat', compat: {} }] } },
    })).toMatchObject({ 'org-primary': { compat: {}, models: [{ compat: {} }] } })
  })

  it('rejects literal API keys in project profiles', () => {
    expect(() => validateProjectProfiles({
      providers: {
        relay: {
          ...profile,
          apiKey: 'must-not-be-persisted',
          apiKeyEnv: 'DSH_PROJECT_7_RELAY_API_KEY',
        },
      },
    })).toThrow(/must be stored through the project credentials service/)
  })

  it.each([
    ['route compat on another protocol', { ...profile, compat: { thinkingFormat: 'deepseek' } }, /only by openai-completions/],
    ['model compat on another protocol', { ...profile, models: [{ id: 'chat', compat: { thinkingFormat: 'deepseek' } }] }, /only by openai-completions/],
    ['unsupported thinking format', { ...openAiProfile, compat: { thinkingFormat: 'chat-template' } }, /thinkingFormat is unsupported/],
    ['unmanaged compat field', { ...openAiProfile, compat: { supportsStore: true } }, /unsupported field supportsStore/],
    ['empty reasoning efforts', { ...openAiProfile, models: [{ id: 'chat', reasoningEfforts: {} }] }, /at least one reasoning level/],
    ['empty reasoning spelling', { ...openAiProfile, models: [{ id: 'chat', reasoningEfforts: { high: '' } }] }, /must contain a wire value/],
    ['null thinking spelling', { ...openAiProfile, models: [{ id: 'chat', reasoningEfforts: { high: null } }] }, /only off may be empty/],
    ['off-only reasoning efforts', { ...openAiProfile, models: [{ id: 'chat', reasoningEfforts: { off: null } }] }, /beyond off/],
    ['unknown thinking budget', { ...openAiProfile, thinkingBudgets: { max: 4096 } }, /thinkingBudgets contains an invalid level/],
    ['zero stream idle timeout', { ...openAiProfile, streamIdleTimeoutMs: 0 }, /positive finite number/],
    ['oversized stream idle timeout', { ...openAiProfile, streamIdleTimeoutMs: 2_147_483_648 }, /no greater than/],
    ['unknown retry field', { ...openAiProfile, retryPolicy: { mode: 'normal', maxRetires: 1 } }, /unsupported field maxRetires/],
    ['mode-specific retry field', { ...openAiProfile, retryPolicy: { mode: 'always', maxRetries: 1 } }, /unsupported field maxRetries/],
    ['invalid retry backoff', { ...openAiProfile, retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 0 } } }, /initialDelayMs/],
    ['reversed retry backoff', { ...openAiProfile, retryPolicy: { mode: 'always', backoff: { initialDelayMs: 20, maxDelayMs: 10 } } }, /less than or equal/],
    ['duplicate retry codes', { ...openAiProfile, retryPolicy: { mode: 'normal', retryableCodes: ['TIMEOUT', 'TIMEOUT'] } }, /must not contain duplicates/],
  ] satisfies Array<[string, Record<string, unknown>, RegExp]>)('rejects %s', (_name, invalid, message) => {
    expect(() => validateOrganizationProfiles({ providers: { 'org-primary': invalid } })).toThrow(message)
  })
})

describe('organization model discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the shared OpenAI listing request and preserves deployment paths', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ data: [{ id: 'gpt-acme', context_length: 32_768 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await expect(discoverOrganizationModels({
      baseURL: 'https://gateway.example.test/openai/v1/',
      api: 'openai-completions',
      apiKey: 'openai-key',
    })).resolves.toEqual([{ id: 'gpt-acme', contextWindow: 32_768 }])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example.test/openai/v1/models')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer openai-key')
    expect(requests[0]?.headers.get('x-api-key')).toBeNull()
  })

  it('uses the shared Anthropic listing path and authentication headers', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ data: [{ id: 'claude-acme', display_name: 'Claude Acme' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await expect(discoverOrganizationModels({
      baseURL: 'https://gateway.example.test',
      api: 'anthropic-messages',
      apiKey: 'anthropic-key',
    })).resolves.toEqual([{ id: 'claude-acme', name: 'Claude Acme' }])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example.test/v1/models')
    expect(requests[0]?.headers.get('x-api-key')).toBe('anthropic-key')
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(requests[0]?.headers.get('authorization')).toBeNull()
  })

  it('does not duplicate an Anthropic v1 base path', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ data: [{ id: 'claude-acme' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await discoverOrganizationModels({
      baseURL: 'https://gateway.example.test/v1',
      api: 'anthropic-messages',
    })

    expect(urls).toEqual(['https://gateway.example.test/v1/models'])
  })
})
