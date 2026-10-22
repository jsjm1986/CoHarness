/** Node-wide permits held through execution quiescence. @module @deepseek-ai/dsh-resource-budget */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ResourceRequest, ResourceLease } from './types.ts'
export type { ResourceKind, ResourceRequest, ResourceLease } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { resourceBudget: ResourceBudget }
}

/** Provider-owned node budget; standalone compositions may omit this service. */
export abstract class ResourceBudget extends Service {
  constructor(ctx: Context) { super(ctx, 'resourceBudget') }
  /**
   * Wait for one bounded, fairly scheduled reservation before execution.
   * @param request - resource, cancellation and optional executing Session.
   * @returns a permit retained until the caller proves execution quiescence.
   * @throws when admission is refused, canceled, expired or unavailable.
   */
  abstract acquire(request: ResourceRequest): Promise<ResourceLease>
}
export default ResourceBudget
