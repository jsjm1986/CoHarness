/** Resource provider identity retained through model preparation, admission and dispatch. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ResourceBudget } from '@deepseek-ai/dsh-resource-budget'
import { LlmError } from './error.ts'

/** Resource provider and managed requirement when the model stream is constructed. */
export interface CapturedResourceOwner {
  readonly owner: ResourceBudget | undefined
  readonly required: boolean
}

/**
 * Retain the model request's provider before middleware can await other work.
 * @param ctx - context performing the model call.
 * @returns the original resource provider and its required-provider flag.
 */
export function captureResourceOwner(ctx: Context): CapturedResourceOwner {
  return { owner: ctx.get('resourceBudget'), required: ctx.get('resourceBudgetRequired') === true }
}

/**
 * Refuse dispatch when model admission was withdrawn, replaced or became required without a provider.
 * @param ctx - context performing the model call.
 * @param captured - resource provider retained at stream construction.
 * @throws LlmError when the original provider is unavailable.
 */
export function assertResourceOwner(ctx: Context, captured: CapturedResourceOwner): void {
  const current = ctx.get('resourceBudget')
  const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
    (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
  if (original(current) !== original(captured.owner)
    || (captured.required || ctx.get('resourceBudgetRequired') === true) && current === undefined) {
    throw new LlmError('The model resource admission provider is unavailable; retry after it is restored.',
      'RESOURCE_BUDGET_UNAVAILABLE')
  }
}
