/** Missing managed configuration cannot recreate independent local authority. */
import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import ExecutionAuthority, { executionAuthorityOf, sameExecutionAuthority } from '../src/index.ts'

it('rejects mounting the definition as an implementation', () => {
  expect(() => { Reflect.construct(ExecutionAuthority, [new Context()]) }).toThrow(/requires a concrete provider/)
})

it('allows service absence only outside an explicitly managed deployment', () => {
  const local = new Context()
  expect(executionAuthorityOf(local)).toBeUndefined()
  local.provide('executionAuthorityRequired', false)
  expect(executionAuthorityOf(local)).toBeUndefined()
  const managed = new Context()
  managed.provide('executionAuthorityRequired', true)
  expect(() => executionAuthorityOf(managed)).toThrow(expect.objectContaining({
    code: 'execution/forbidden', details: { capability: 'execute' },
  }))
})

it('returns the actual provider and rejects its absence after removal', () => {
  const ctx = new Context()
  ctx.provide('executionAuthorityRequired', true)
  const provider = Object.create(ExecutionAuthority.prototype) as ExecutionAuthority
  const remove = ctx.provide('executionAuthority', provider)
  expect(executionAuthorityOf(ctx)).toBe(provider)
  remove()
  expect(() => executionAuthorityOf(ctx)).toThrow(/requires its authorization provider/)
})

it('recognizes the same service through distinct Cordis proxies and refuses a replacement', async () => {
  class Provider extends Service { constructor(ctx: Context) { super(ctx, 'executionAuthority') } }
  const ctx = new Context()
  let fiber = ctx.plugin(Provider)
  try {
    await fiber.await()
    const original = executionAuthorityOf(ctx)
    const next = executionAuthorityOf(ctx)
    expect(next).not.toBe(original)
    expect(sameExecutionAuthority(next, original)).toBe(true)
    await fiber.dispose()
    expect(sameExecutionAuthority(executionAuthorityOf(ctx), original)).toBe(false)
    fiber = ctx.plugin(Provider)
    await fiber.await()
    expect(sameExecutionAuthority(executionAuthorityOf(ctx), original)).toBe(false)
    expect(sameExecutionAuthority(undefined, undefined)).toBe(true)
  } finally { await fiber.dispose() }
})
