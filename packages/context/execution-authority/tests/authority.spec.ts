/** Missing managed configuration cannot recreate independent local authority. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import ExecutionAuthority, { executionAuthorityOf } from '../src/index.ts'

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
