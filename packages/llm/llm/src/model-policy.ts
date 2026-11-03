/** Model-policy ownership retained across asynchronous request admission. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ModelAccessService, ModelAccessTarget } from '@deepseek-ai/dsh-model-access'
import { LlmError } from './error.ts'

/** Policy provider and managed-runtime requirement at stream construction. */
export interface CapturedModelPolicy {
  readonly owner: ModelAccessService | undefined
  readonly required: boolean
}

/**
 * Retain the policy owner before streaming middleware can await other services.
 * @param ctx - context performing the model call.
 * @returns the current provider identity and policy requirement.
 */
export function captureModelPolicy(ctx: Context): CapturedModelPolicy {
  return { owner: ctx.get('modelAccess'), required: ctx.get('modelAccessRequired') === true }
}

/**
 * Refuse dispatch when the request's policy owner was withdrawn or replaced.
 * Route authorization remains the owning provider's pre-dispatch responsibility.
 * @param ctx - context performing the model call.
 * @param captured - policy owner retained before request middleware.
 * @throws LlmError when a required policy is absent or its owner changed.
 */
export function assertModelPolicy(ctx: Context, captured: CapturedModelPolicy): void {
  const current = ctx.get('modelAccess')
  const original = (value: ModelAccessService | undefined): ModelAccessService | undefined =>
    (value as (ModelAccessService & { [symbols.original]?: ModelAccessService }) | undefined)?.[symbols.original] ?? value
  if (original(current) !== original(captured.owner)
    || (captured.required || ctx.get('modelAccessRequired') === true) && current === undefined) {
    throw new LlmError('The model authorization policy is unavailable; retry after it is restored.',
      'MODEL_POLICY_UNAVAILABLE')
  }
}

/**
 * Enforce the retained provider's decision after all asynchronous dispatch guards.
 * @param ctx - context performing the model call.
 * @param captured - policy provider retained before middleware.
 * @param target - exact prepared provider and model.
 * @throws LlmError when the provider changed, is missing or refuses this route.
 */
export function authorizeModelPolicy(ctx: Context, captured: CapturedModelPolicy, target: ModelAccessTarget): void {
  assertModelPolicy(ctx, captured)
  const decision = captured.owner?.decide(target)
  if (decision?.allowed === false) throw new LlmError(decision.reason, 'MODEL_FORBIDDEN')
}
