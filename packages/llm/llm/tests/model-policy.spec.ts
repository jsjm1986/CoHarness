import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { assertModelPolicy, authorizeModelPolicy, captureModelPolicy } from '../src/model-policy.ts'

function context() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

it('permits standalone calls without an installed or required policy', () => {
  const ctx = context()
  const captured = captureModelPolicy(ctx)
  expect(captured).toEqual({ owner: undefined, required: false })
  expect(() => { assertModelPolicy(ctx, captured) }).not.toThrow()
  expect(() => { authorizeModelPolicy(ctx, captured, { provider: 'p', model: 'm' }) }).not.toThrow()
})

it('requires the managed policy both before and after the requirement is published', () => {
  const ctx = context()
  const standalone = captureModelPolicy(ctx)
  ctx.provide('modelAccessRequired', true)
  const managed = captureModelPolicy(ctx)
  for (const captured of [standalone, managed]) {
    expect(() => { assertModelPolicy(ctx, captured) }).toThrow(expect.objectContaining({ code: 'MODEL_POLICY_UNAVAILABLE' }))
  }
})

it('retains the installed owner without repeating its route decision', () => {
  const ctx = context()
  const decide = vi.fn(() => ({ allowed: true as const }))
  ctx.provide('modelAccess', { decide })
  const captured = captureModelPolicy(ctx)
  expect(() => { assertModelPolicy(ctx, captured) }).not.toThrow()
  expect(decide).not.toHaveBeenCalled()
  authorizeModelPolicy(ctx, captured, { provider: 'p', model: 'm' })
  expect(decide).toHaveBeenCalledExactlyOnceWith({ provider: 'p', model: 'm' })
})

it('preserves the policy provider denial without a middleware-dependent fallback', () => {
  const ctx = context()
  ctx.provide('modelAccess', { decide: () => ({ allowed: false, reason: 'The selected model is disabled.' }) })
  expect(() => { authorizeModelPolicy(ctx, captureModelPolicy(ctx), { provider: 'p', model: 'm' }) })
    .toThrow(expect.objectContaining({ code: 'MODEL_FORBIDDEN', message: 'The selected model is disabled.' }))
})

it('refuses a policy installed after stream construction', () => {
  const ctx = context()
  const captured = captureModelPolicy(ctx)
  ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
  expect(() => { assertModelPolicy(ctx, captured) }).toThrow(expect.objectContaining({ code: 'MODEL_POLICY_UNAVAILABLE' }))
})

it('retains a Service policy across fresh Cordis tracing proxies', async () => {
  const [{ default: ModelAccessPolicy }, { default: LlmRuntime, LlmAdapter }] = await Promise.all([
    import('@deepseek-ai/dsh-model-access'), import('../src/index.ts'),
  ])
  const ctx = context(), calls = vi.fn()
  class Policy extends ModelAccessPolicy {
    override decide() { return { allowed: true as const } }
  }
  class Adapter extends LlmAdapter {
    override async *stream() { calls(); yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
  }
  await ctx.plugin(Policy)
  await ctx.plugin(LlmRuntime)
  ctx.provide('modelAccessRequired', true)
  ctx.effect(() => ctx.llm.registerAdapter(['service-policy'], new Adapter()))
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'service-policy', model: 'm', messages: [] })) chunks.push(chunk)
  expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  expect(calls).toHaveBeenCalledOnce()
})
