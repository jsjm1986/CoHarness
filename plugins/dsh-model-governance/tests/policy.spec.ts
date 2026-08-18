import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../src/policy.ts'

function writePolicy(value: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
  const filename = join(home, 'model-governance.json')
  writeFileSync(filename, JSON.stringify(value))
  return filename
}

function completePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const profile = {
    apiKeyEnv: 'DSH_ACME_KEY',
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.example.test/v1',
    models: [{
      id: 'acme-think',
      name: 'Acme Think',
      contextWindow: 131072,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', high: 'high' },
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    }],
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text', 'image'],
    headers: { 'x-tenant': 'acme' },
    reasoning: 'high',
    thinkingBudgets: { low: 1024, high: 4096 },
    cacheRetention: 'short',
    transport: 'sse',
    timeoutMs: 5000,
    websocketConnectTimeoutMs: 3000,
    streamIdleTimeoutMs: 120000,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.2 },
    },
  }
  return {
    version: 7,
    defaultAllowed: false,
    userDeclaredAllowed: false,
    models: [{ provider: 'org-acme', model: 'acme-think', allowed: true }],
    providers: [{
      provider: 'org-acme',
      displayName: 'Acme Gateway',
      driver: 'pi-ai',
      protocol: 'openai-completions',
      baseURL: 'https://gateway.example.test/v1',
      credentialRef: 'DSH_ACME_KEY',
      profile,
      defaultContextWindow: 262144,
      defaultMaxTokens: 32768,
      defaultInput: ['text', 'image'],
      headers: { 'x-tenant': 'acme' },
      reasoning: 'high',
      thinkingBudgets: { low: 1024, high: 4096 },
      cacheRetention: 'short',
      transport: 'sse',
      timeoutMs: 5000,
      websocketConnectTimeoutMs: 3000,
      streamIdleTimeoutMs: 120000,
      retryPolicy: profile.retryPolicy,
      models: profile.models,
    }],
    intakeUrl: 'http://127.0.0.1:1/usage',
    intakeToken: 'token',
    ...overrides,
  }
}

function completeProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const provider = (completePolicy().providers as Array<Record<string, unknown>>)[0]
  if (provider === undefined) throw new Error('complete policy has no Provider')
  return { ...structuredClone(provider), ...overrides }
}

function completeProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const profile = completeProvider().profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('complete Provider has no profile')
  }
  return { ...structuredClone(profile), ...overrides }
}

function completeModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const model = (completeProvider().models as Array<Record<string, unknown>>)[0]
  if (model === undefined) throw new Error('complete Provider has no model')
  return { ...structuredClone(model), ...overrides }
}

describe('model-governance policy projection', () => {
  it('retains the complete organization Provider and model profile', () => {
    const raw = completePolicy()
    const loaded = loadPolicy(writePolicy(raw))
    expect(loaded.providers).toEqual(raw.providers)
    expect(loaded.providers[0]?.profile).toEqual((raw.providers as Array<Record<string, unknown>>)[0]?.profile)
  })

  it('accepts empty compat defaults on protocols that do not use the switches', () => {
    const model = completeModel({ compat: {} })
    const provider = completeProvider({
      protocol: 'openai-responses',
      profile: completeProfile({ api: 'openai-responses', compat: {}, models: [model] }),
      models: [model],
    })
    expect(loadPolicy(writePolicy(completePolicy({ providers: [provider] }))).providers[0])
      .toMatchObject({ protocol: 'openai-responses', profile: { compat: {} }, models: [{ compat: {} }] })
  })

  it.each([
    ['top-level credential reference', { providers: [completeProvider({ credentialRef: 'OPENAI_API_KEY' })] }],
    ['nested credential reference', {
      providers: [completeProvider({ profile: completeProfile({ apiKeyEnv: 'OPENAI_API_KEY' }) })],
    }],
    ['invalid stream timeout', { providers: [completeProvider({ streamIdleTimeoutMs: 0 })] }],
    ['oversized stream timeout', { providers: [completeProvider({ streamIdleTimeoutMs: 2_147_483_648 })] }],
    ['invalid retry policy', { providers: [completeProvider({ retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 0 } } })] }],
    ['unknown retry field', { providers: [completeProvider({ retryPolicy: { mode: 'normal', maxRetires: 1 } })] }],
    ['invalid embedded retry policy', { providers: [completeProvider({ profile: completeProfile({ retryPolicy: { mode: 'always', maxRetries: 1 } }) })] }],
    ['unsupported thinking format', { providers: [completeProvider({ profile: completeProfile({ compat: { thinkingFormat: 'chat-template' } }) })] }],
    ['unmanaged compat field', { providers: [completeProvider({ profile: completeProfile({ compat: { supportsStore: true } }) })] }],
    ['empty reasoning efforts', { providers: [completeProvider({ models: [completeModel({ reasoningEfforts: {} })] })] }],
    ['null thinking spelling', { providers: [completeProvider({ models: [completeModel({ reasoningEfforts: { high: null } })] })] }],
    ['off-only reasoning efforts', { providers: [completeProvider({ models: [completeModel({ reasoningEfforts: { off: null } })] })] }],
    ['unknown thinking budget', { providers: [completeProvider({ profile: completeProfile({ thinkingBudgets: { max: 4096 } }) })] }],
    ['route compat on another protocol', (() => {
      const model = completeModel({ compat: {} })
      return { providers: [completeProvider({
        protocol: 'openai-responses',
        profile: completeProfile({ api: 'openai-responses', models: [model] }),
        models: [model],
      })] }
    })()],
    ['model compat on another protocol', (() => {
      const model = completeModel({ compat: { thinkingFormat: 'deepseek' } })
      return { providers: [completeProvider({
        protocol: 'openai-responses',
        profile: completeProfile({ api: 'openai-responses', compat: {}, models: [model] }),
        models: [model],
      })] }
    })()],
    ['organization model override', {
      providers: [completeProvider({
        profile: completeProfile({ modelOverrides: { 'acme-think': { name: 'Renamed' } } }),
      })],
    }],
  ] satisfies Array<[string, Record<string, unknown>]>)('rejects %s before publishing a Provider snapshot', (_name, overrides) => {
    expect(() => loadPolicy(writePolicy(completePolicy(overrides)))).toThrow(/model-governance/)
  })
})
