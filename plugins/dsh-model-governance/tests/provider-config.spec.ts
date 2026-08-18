import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelProviderConfigSnapshot } from '@deepseek-ai/dsh-model-provider-config'
import { ReloadableModelProviderConfig } from '../src/provider-config.ts'

function snapshot(): ModelProviderConfigSnapshot {
  return {
    revision: 1,
    providers: [{
      provider: 'org-primary',
      displayName: 'Primary',
      driver: 'pi-ai',
      protocol: 'openai-completions',
      baseURL: 'https://models.example.test/v1',
      credentialRef: 'DSH_ORG_PRIMARY_API_KEY',
      profile: {
        headers: { 'x-tenant': 'primary' },
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
        retryPolicy: { mode: 'always', backoff: { initialDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 } },
      },
      defaultInput: ['text', 'image'],
      thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
      models: [{
        id: 'chat',
        name: 'Chat',
        input: ['text', 'image'],
        reasoningEfforts: { off: null, high: 'high' },
        compat: { thinkingFormat: 'deepseek' },
      }],
    }],
  }
}

describe('ReloadableModelProviderConfig', () => {
  it('detaches and deep-freezes every published configuration value', async () => {
    const input = snapshot()
    const ctx = new Context()
    const service = new ReloadableModelProviderConfig(ctx, input)
    const published = service.snapshot()
    const provider = published.providers[0]!
    const profile = provider.profile!
    const model = provider.models[0]!

    input.providers[0]!.profile!.headers = { 'x-tenant': 'mutated' }
    input.providers[0]!.models[0]!.input!.push('text')
    expect((profile.headers as Record<string, unknown>)['x-tenant']).toBe('primary')
    expect(model.input).toEqual(['text', 'image'])

    expect(Object.isFrozen(published)).toBe(true)
    expect(Object.isFrozen(published.providers)).toBe(true)
    expect(Object.isFrozen(provider)).toBe(true)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.headers)).toBe(true)
    expect(Object.isFrozen(profile.compat)).toBe(true)
    expect(Object.isFrozen(profile.retryPolicy)).toBe(true)
    expect(Object.isFrozen((profile.retryPolicy as { backoff: object }).backoff)).toBe(true)
    expect(Object.isFrozen(provider.models)).toBe(true)
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.input)).toBe(true)
    expect(Object.isFrozen(model.reasoningEfforts)).toBe(true)
    expect(Object.isFrozen(model.compat)).toBe(true)
    expect(Object.isFrozen(provider.defaultInput)).toBe(true)
    expect(Object.isFrozen(provider.thinkingBudgets)).toBe(true)

    expect(() => { (profile.headers as Record<string, unknown>)['x-tenant'] = 'changed' }).toThrow(TypeError)
    expect(() => { (model.compat as Record<string, unknown>).thinkingFormat = 'openai' }).toThrow(TypeError)
    expect(() => { (model.input as string[]).push('text') }).toThrow(TypeError)
    expect(() => { (provider.thinkingBudgets as Record<string, number>).high = 4096 }).toThrow(TypeError)
    await ctx.fiber.dispose()
  })

  it('publishes a detached replacement and emits its revision', async () => {
    const ctx = new Context()
    const service = new ReloadableModelProviderConfig(ctx, snapshot())
    const revisions: number[] = []
    ctx.on('model-provider-config/updated', revision => { revisions.push(revision) })
    const next = snapshot()
    next.revision = 2
    service.replace(next)
    next.providers[0]!.models[0]!.name = 'mutated after replace'
    expect(service.snapshot().revision).toBe(2)
    expect(service.snapshot().providers[0]!.models[0]!.name).toBe('Chat')
    expect(revisions).toEqual([2])
    await ctx.fiber.dispose()
  })
})
