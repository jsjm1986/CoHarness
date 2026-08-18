import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ModelProviderConfig from '@deepseek-ai/dsh-model-provider-config'
import type { ModelProviderConfigSnapshot } from '@deepseek-ai/dsh-model-provider-config'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

class StaticModelProviderConfig extends ModelProviderConfig {
  constructor(ctx: Context, private readonly current: ModelProviderConfigSnapshot) {
    super(ctx)
  }

  override snapshot(): ModelProviderConfigSnapshot {
    return this.current
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

describe('organization-managed Provider composition', () => {
  it('materializes the complete managed profile into capabilities, defaults, and request options', async () => {
    vi.stubEnv('DSH_ORG_PRIMARY_API_KEY', 'organization-key')
    const server = await mockServer([{ events: textEvents }])
    const snapshot: ModelProviderConfigSnapshot = {
      revision: 7,
      providers: [{
        provider: 'org-primary',
        displayName: 'Organization Primary',
        driver: 'pi-ai',
        protocol: 'openai-completions',
        baseURL: `${server.url}/v1`,
        credentialRef: 'DSH_ORG_PRIMARY_API_KEY',
        profile: {
          defaultContextWindow: 65_536,
          defaultInput: ['text', 'image'],
          headers: { 'x-tenant': 'primary' },
          reasoning: 'high',
          thinkingBudgets: { high: 2048 },
          compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
          retryPolicy: {
            mode: 'always',
            backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
          },
        },
        models: [{
          id: 'acme-think',
          name: 'Acme Think',
          maxTokens: 4096,
          reasoningEfforts: { off: null, high: 'high' },
        }],
      }],
    }

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(StaticModelProviderConfig, snapshot)
    await ctx.plugin(LlmPiAi, {})

    expect(ctx.llm.listProviders()).toEqual([{ id: 'org-primary', name: 'Organization Primary' }])
    await expect(ctx.llm.resolveModelInfo('org-primary', 'acme-think')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
      context: { contextWindow: 65_536 },
      defaultMaxTokens: 4096,
      reasoning: { defaultEffort: 'high' },
    })
    expect(ctx.llm.providerRetryPolicy('org-primary')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })

    const result = await assemble(ctx, { provider: 'org-primary', model: 'acme-think', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer organization-key')
    expect(server.headers[0]?.['x-tenant']).toBe('primary')
    expect(server.requests[0]).toMatchObject({
      model: 'acme-think',
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    const request = server.requests[0] as Record<string, unknown>
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(4096)
  })
})
