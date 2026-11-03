/** Admission for external runtimes without per-request parent model control. @module */
import type { Context } from '@deepseek-ai/cordis'
import { captureModelPolicy } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-resource-budget'
import type {} from '@deepseek-ai/dsh-execution-authority'
import { SubagentError } from './error.ts'

/**
 * Determine whether delegated inference must retain parent authorization or admission.
 * @param ctx - initiating Agent or provider registration context, including isolated services.
 * @returns whether model policy, capacity or execution authority requires parent model control.
 */
export function requiresParentModelControl(ctx: Context): boolean {
  const policy = captureModelPolicy(ctx)
  return policy.required || policy.owner !== undefined
    || ctx.get('resourceBudgetRequired') === true || ctx.get('resourceBudget') !== undefined
    || ctx.get('executionAuthorityRequired') === true || ctx.get('executionAuthority') !== undefined
}

/**
 * Refuse opaque external inference when its parent owns model authorization, capacity or execution authority.
 * One external turn can issue several model requests, so a turn or process permit
 * cannot establish their individual admission or usage attribution.
 * @param ctx - parent runtime owning the external provider.
 * @throws SubagentError when parent model control cannot reach the external runtime.
 */
export function assertExternalModelExecution(ctx: Context): void {
  if (requiresParentModelControl(ctx)) {
    throw new SubagentError(
      'This subagent provider cannot enforce the required model permissions, per-request limits and usage attribution. '
      + 'Choose an in-process or SDK subagent provider.',
      'UNSUPPORTED_CAPABILITY',
    )
  }
}
