import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const ns = settingsNamespace('authorized-section')
const schema = z.object({ mode: z.string().default('ordinary'), count: z.number().default(1) })

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(MemorySettings, { doc: { [ns]: { mode: 'restored' } } })
  return { ctx, fiber, provider: ctx.settings as MemorySettings }
}

describe('write-only settings authorization', () => {
  it('retains namespace validation and project write ownership with an asynchronous write policy', async () => {
    const { ctx, provider } = await fixture()
    const calls: unknown[] = []
    await ctx.plugin(Object.assign((owner: Context) => {
      installSettingsSection(owner, ns, schema, { mode: 'ordinary', count: 1 }, {
        setSource() {}, onChange() {}, owner: 'project', projectWrite: 'manager', projectWritePaths: [['mode']],
        validate: (value) => { if (value.count < 0) throw new Error('negative count') },
        authorizeWrite: async (value) => { calls.push(value) },
      })
    }, { inject: ['settings'] }))
    expect(ctx.settings.describe()[0]).toMatchObject({ owner: 'project', projectWrite: 'manager', projectWritePaths: [['mode']] })
    await expect(ctx.settings.update(ns, { count: -1 })).rejects.toThrow('negative count')
    expect(calls).toEqual([])
    await ctx.settings.mutate(ns, [{ op: 'set', path: ['mode'], value: 'accepted' }])
    expect(calls).toEqual([{ mode: 'accepted', count: 1 }])
    expect(provider.doc[ns]).toEqual({ mode: 'accepted' })
  })

  it('authorizes resolved writes while registration and provider reload remain pure validation', async () => {
    const { ctx, provider } = await fixture()
    const seen: unknown[] = []
    ctx.settings.register(ns, schema, { authorizeWrite: async (value) => {
      seen.push(value)
      expect(Object.isFrozen(value)).toBe(true)
      if (value.mode === 'forbidden') throw new Error('not allowed')
    } })
    expect(seen).toEqual([])
    provider.pushExternal({ [ns]: { mode: 'external', count: 2 } })
    expect(seen).toEqual([])
    await ctx.settings.update(ns, { count: 3 })
    await ctx.settings.replace(ns, { mode: 'replaced' })
    await ctx.settings.mutate(ns, [{ op: 'set', path: ['mode'], value: 'mutated' }])
    expect(seen).toEqual([{ mode: 'external', count: 3 }, { mode: 'replaced', count: 1 }, { mode: 'mutated', count: 1 }])
    await expect(ctx.settings.mutate(ns, [{ op: 'set', path: ['mode'], value: 'forbidden' }])).rejects.toThrow('not allowed')
    expect(provider.persisted).toHaveLength(3)
    expect(provider.doc[ns]).toEqual({ mode: 'mutated' })
  })

  it.each(['owner', 'service'] as const)('does not persist a late grant after the %s is unloaded', async (which) => {
    const { ctx, provider, fiber } = await fixture()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const owner = await ctx.plugin(Object.assign((child: Context) => {
      installSettingsSection(child, ns, schema, { mode: 'ordinary', count: 1 }, {
        setSource() {}, onChange() {},
        authorizeWrite: async () => { entered.resolve(undefined); await release.promise },
      })
    }, { inject: ['settings'] }))
    const pending = ctx.settings.mutate(ns, [{ op: 'set', path: ['mode'], value: 'allowed' }])
    const rejected = expect(pending).rejects.toThrow('disposed during write authorization')
    await entered.promise
    const disposal = (which === 'owner' ? owner : fiber).dispose()
    release.resolve(undefined)
    await rejected
    await disposal
    expect(provider.persisted).toEqual([])
    expect(provider.doc[ns]).toEqual({ mode: 'restored' })
  })

  it('refuses a stale authorized candidate after an external update', async () => {
    const { ctx, provider } = await fixture()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    ctx.settings.register(ns, schema, { authorizeWrite: async () => { entered.resolve(undefined); await release.promise } })
    const pending = ctx.settings.update(ns, { count: 5 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
    await entered.promise
    provider.pushExternal({ [ns]: { mode: 'external-new', count: 8 } })
    release.resolve(undefined)
    await rejected
    expect(provider.persisted).toEqual([])
    expect(provider.doc[ns]).toEqual({ mode: 'external-new', count: 8 })
  })
})
