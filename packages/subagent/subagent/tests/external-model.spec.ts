/** External turns cannot substitute for individual parent model admissions. */
import { Context } from '@deepseek-ai/cordis'
import { ResourceBudget } from '@deepseek-ai/dsh-resource-budget'
import { expect, it } from 'vitest'
import { assertExternalModelExecution, requiresParentModelControl } from '../src/index.ts'

it.each(['model-required', 'model-owner', 'budget-required', 'budget-owner', 'execution-required', 'execution-owner'] as const)(
  'refuses external inference while parent control is present: %s', async (control) => {
    const ctx = new Context()
    try {
      if (control === 'model-required') ctx.provide('modelAccessRequired', true)
      if (control === 'model-owner') ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
      if (control === 'budget-required') ctx.provide('resourceBudgetRequired', true)
      if (control === 'budget-owner') {
        class Budget extends ResourceBudget {
          async acquire(): Promise<never> { throw new Error('No resource may be acquired') }
        }
        await ctx.plugin(Budget)
      }
      if (control === 'execution-required') ctx.provide('executionAuthorityRequired', true)
      if (control === 'execution-owner') ctx.provide('executionAuthority', {
        capture: () => { throw new Error('Opaque inference cannot capture execution authority') },
      })
      expect(requiresParentModelControl(ctx)).toBe(true)
      expect(() => { assertExternalModelExecution(ctx) }).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }))
    } finally { await ctx.fiber.dispose() }
  },
)

it('allows independent external runtimes without parent model control', async () => {
  const ctx = new Context()
  try {
    expect(() => { assertExternalModelExecution(ctx) }).not.toThrow()
    expect(requiresParentModelControl(ctx)).toBe(false)
    ctx.provide('modelAccessRequired', false)
    ctx.provide('resourceBudgetRequired', false)
    ctx.provide('executionAuthorityRequired', false)
    expect(() => { assertExternalModelExecution(ctx) }).not.toThrow()
    expect(requiresParentModelControl(ctx)).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
