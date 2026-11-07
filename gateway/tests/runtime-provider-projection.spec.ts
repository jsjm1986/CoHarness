/** Behavior and work-count coverage for invocation-local Provider normalization. */
import { describe, expect, it, vi } from 'vitest'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { createProjectionHarness, syntheticProviderRows, type ProjectionScope } from './runtime-provider-projection.fixture.ts'

describe.each<ProjectionScope>(['organization', 'project'])('%s runtime Provider projection', scope => {
  it('normalizes each Provider profile once per query result', async () => {
    const rows = [...syntheticProviderRows(16), ...syntheticProviderRows(8, 'second-provider')]
    const project = createProjectionHarness(PostgresModelGovernanceService)
    const clone = globalThis.structuredClone
    let clonedModels = 0
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
      const models = (value as { models?: unknown }).models
      if (Array.isArray(models)) clonedModels += models.length
      return clone(value)
    })
    try {
      const result = await project(scope, rows)
      expect(result.map(provider => provider.models.length)).toEqual([16, 8])
      expect(spy).toHaveBeenCalledTimes(2)
      expect(clonedModels).toBe(24)
    } finally { spy.mockRestore() }
  })

  it('preserves first matching model metadata, order, URL normalization and key removal', async () => {
    const rows = syntheticProviderRows(3)
    const profile: Record<string, unknown> = {
      baseURL: 'https://example.invalid/v1/',
      apiKey: 'synthetic-literal-key',
      headers: { 'x-synthetic-header': 'retained-runtime-value', api_key: 'synthetic-legacy-key' },
      models: [
        { id: 'synthetic-0', contextWindow: 123, maxTokens: 45, input: ['image', 'audio', 'text'],
          reasoningEfforts: false, compat: { supportsStore: false, apiKey: 'synthetic-model-key' } },
        { id: 'synthetic-0', contextWindow: 999, maxTokens: 999 },
        { id: 'synthetic-1', reasoningEfforts: { minimal: 'low' } },
      ],
    }
    for (const row of rows) {
      row.profile = profile
      row.credential_ref = 'synthetic-credential-reference'
    }
    const project = createProjectionHarness(PostgresModelGovernanceService)
    const result = await project(scope, rows)
    const provider = result[0]!
    expect(provider).toMatchObject({
      displayName: 'Synthetic synthetic-provider', driver: 'pi-ai', protocol: 'openai-completions',
      baseURL: 'https://example.invalid/v1', credentialRef: 'synthetic-credential-reference', scope,
      ...scope === 'project' ? { projectId: 42 } : {},
    })
    expect(provider.provider).toBe(scope === 'project' ? 'project-42-synthetic-provider' : 'synthetic-provider')
    expect(provider.models).toEqual([
      { id: 'synthetic-0', name: 'Synthetic 0', contextWindow: 123, maxTokens: 45,
        input: ['image', 'text'], reasoningEfforts: false, compat: { supportsStore: false } },
      { id: 'synthetic-1', name: 'Synthetic 1', reasoningEfforts: { minimal: 'low' } },
      { id: 'synthetic-2', name: 'Synthetic 2' },
    ])
    expect(provider.profile).toMatchObject({
      baseURL: 'https://example.invalid/v1', headers: { 'x-synthetic-header': 'retained-runtime-value' },
    })
    expect(JSON.stringify(provider.profile)).not.toContain('synthetic-literal-key')
    expect(JSON.stringify(provider.profile)).not.toContain('synthetic-legacy-key')
    expect(JSON.stringify(provider.profile)).not.toContain('synthetic-model-key')
    expect(profile.baseURL).toBe('https://example.invalid/v1/')
    expect(profile.apiKey).toBe('synthetic-literal-key')
  })

  it('uses fresh profiles after an update and isolates Providers with identical model ids', async () => {
    const project = createProjectionHarness(PostgresModelGovernanceService)
    const firstRows = syntheticProviderRows(1)
    const first = await project(scope, firstRows)
    const updated = syntheticProviderRows(1)
    const other = syntheticProviderRows(1, 'other-provider')
    updated[0]!.profile = { models: [{ id: 'synthetic-0', contextWindow: 16384 }] }
    other[0]!.profile = { models: [{ id: 'synthetic-0', contextWindow: 32768 }] }
    const next = await project(scope, [...updated, ...other])
    expect(first[0]!.models[0]!.contextWindow).toBe(8192)
    expect(next.map(provider => provider.models[0]!.contextWindow)).toEqual([16384, 32768])
    expect(next[0]!.profile).not.toBe(first[0]!.profile)
  })

  it.each([
    { profile: { models: {} }, error: 'provider models must be an array' },
    { profile: { models: [{ id: 'synthetic-0' }, null] }, error: 'models[1] must be an object' },
  ])('rejects malformed stored profile models: $error', async ({ profile, error }) => {
    const rows = syntheticProviderRows(1)
    rows[0]!.profile = profile
    await expect(createProjectionHarness(PostgresModelGovernanceService)(scope, rows)).rejects.toThrow(error)
  })
})
