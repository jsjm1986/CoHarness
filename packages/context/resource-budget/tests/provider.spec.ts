/** Resource admission requires an implementation with a scoped Cordis service lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import ResourceBudget, { resourceBudgetOf, type ResourceLease, type ResourceRequest } from '../src/index.ts'

it('rejects mounting the abstract definition as an admission provider', async () => {
  const ctx = new Context()
  try {
    expect(() => { Reflect.construct(ResourceBudget, [ctx]) }).toThrow('resource-budget requires a concrete provider')
    expect(ctx.get('resourceBudget')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('publishes a concrete provider only for its owning fiber lifetime', async () => {
  class Provider extends ResourceBudget {
    async acquire(request: ResourceRequest): Promise<ResourceLease> {
      request.signal?.throwIfAborted()
      throw new Error('fixture admission is closed')
    }
  }
  const ctx = new Context()
  try {
    expect(resourceBudgetOf(ctx)).toBeUndefined()
    ctx.provide('resourceBudgetRequired', true)
    expect(() => resourceBudgetOf(ctx)).toThrow('requires its resource admission provider')
    expect(ctx.get('resourceBudget')).toBeUndefined()
    const fiber = await ctx.plugin(Provider)
    expect(ctx.get('resourceBudget')).toBeInstanceOf(Provider)
    expect(resourceBudgetOf(ctx)).toBeInstanceOf(Provider)
    await expect(ctx.resourceBudget.acquire({ kind: 'model' })).rejects.toThrow('fixture admission is closed')
    const cancellation = new AbortController()
    cancellation.abort(new Error('caller cancelled'))
    await expect(ctx.resourceBudget.acquire({ kind: 'process', signal: cancellation.signal })).rejects.toThrow('caller cancelled')
    await fiber.dispose()
    expect(ctx.get('resourceBudget')).toBeUndefined()
    expect(() => resourceBudgetOf(ctx)).toThrow('requires its resource admission provider')
  } finally { await ctx.fiber.dispose() }
})
