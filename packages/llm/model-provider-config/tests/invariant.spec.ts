import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ModelProviderConfig from '@deepseek-ai/dsh-model-provider-config'
import type { ModelProviderConfigSnapshot } from '@deepseek-ai/dsh-model-provider-config'
import * as ModelProviderConfigInvariant from '@deepseek-ai/dsh-model-provider-config/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

class StubModelProviderConfig extends ModelProviderConfig {
  current: ModelProviderConfigSnapshot = { revision: 1, providers: [] }

  override snapshot(): ModelProviderConfigSnapshot {
    return this.current
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ModelProviderConfigInvariant)
  return ctx
}

describe('model Provider configuration invariant companion', () => {
  it('accepts an event emitted after the matching snapshot is committed', async () => {
    const ctx = await setup()
    await ctx.plugin(StubModelProviderConfig)

    expect(() => { ctx.emit('model-provider-config/updated', 1) }).not.toThrow()
  })

  it('rejects events without a live service or with a stale revision', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('model-provider-config/updated', 1) })
      .toThrow(/emitted without a live service/)

    await ctx.plugin(StubModelProviderConfig)
    expect(() => { ctx.emit('model-provider-config/updated', 2) })
      .toThrow(/does not match the authoritative snapshot/)
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-model-provider-config', () => {})
    }).toThrow(/already registered/)
  })
})
