/** Node-wide permits held through execution quiescence. @module @deepseek-ai/dsh-resource-budget */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ResourceRequest, ResourceLease } from './types.ts'
export type { ResourceKind, ResourceOperationId, ResourceOriginIntent, ResourceRequest, ResourceLease } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    resourceBudget: ResourceBudget
    /** Managed execution cannot bypass admission when its provider is absent. */
    resourceBudgetRequired: boolean
  }
}

/** Admission failed before execution; retained accounting is never evidence of quiescence. */
export class ResourceAdmissionError extends Error {
  /**
   * @param reason - stable failure category.
   * @param message - credential-free diagnostic.
   * @param options - underlying transport or authority failure.
   */
  constructor(readonly reason: 'unavailable' | 'cancelled' | 'expired' | 'refused', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResourceAdmissionError'
  }
}

/** Provider-owned node budget; standalone compositions may omit this service. */
export abstract class ResourceBudget extends Service {
  constructor(ctx: Context) {
    if (new.target === ResourceBudget) throw new Error('resource-budget requires a concrete provider')
    super(ctx, 'resourceBudget')
  }
  /**
   * Wait for one bounded, fairly scheduled reservation before execution.
   * @param request - resource, cancellation and optional executing Session.
   * @returns a permit retained until the caller proves execution quiescence.
   * @throws when admission is refused, canceled, expired or unavailable.
   */
  abstract acquire(request: ResourceRequest): Promise<ResourceLease>
}

/**
 * Resolve resource admission without treating a withdrawn managed provider as independent execution.
 * @param ctx - actual consumer Context.
 * @returns the provider, or absence in an independent composition.
 */
export function resourceBudgetOf(ctx: Context): ResourceBudget | undefined {
  const budget = ctx.get('resourceBudget')
  if (budget === undefined && ctx.get('resourceBudgetRequired') === true) {
    throw new ResourceAdmissionError('unavailable', 'Managed execution requires its resource admission provider.')
  }
  return budget
}
export default ResourceBudget
