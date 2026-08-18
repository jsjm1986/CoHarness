import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ModelProviderConfig from '@deepseek-ai/dsh-model-provider-config'
import type { ModelProviderConfigSnapshot } from '@deepseek-ai/dsh-model-provider-config'

const SNAPSHOT: ModelProviderConfigSnapshot = {
  revision: 7,
  providers: [{
    provider: 'org-primary',
    displayName: 'Organization Primary',
    driver: 'pi-ai',
    protocol: 'openai-responses',
    baseURL: 'https://models.example.test/v1',
    credentialRef: 'ORG_PRIMARY_API_KEY',
    models: [{ id: 'reasoner', name: 'Reasoner' }],
  }],
}

class StubModelProviderConfig extends ModelProviderConfig {
  override snapshot(): ModelProviderConfigSnapshot {
    return SNAPSHOT
  }
}

describe('ModelProviderConfig service', () => {
  it('registers the organization Provider snapshot on the Context', async () => {
    const ctx = new Context()
    await ctx.plugin(StubModelProviderConfig)

    expect(ctx.modelProviderConfig.snapshot()).toBe(SNAPSHOT)
  })

  it('rejects a duplicate Provider and unregisters on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubModelProviderConfig)

    await expect(ctx.plugin(StubModelProviderConfig)).rejects.toThrow(/registered/)
    await fiber.dispose()
    expect(ctx.get('modelProviderConfig')).toBeUndefined()
  })
})
