/** Node resource kinds, ownership and quiescence obligations. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Local execution resource classes; terminals consume process permits. */
export type ResourceKind = 'model' | 'process'

/** Provider-generated operation UUID; retries retain it across transport uncertainty. */
export type ResourceOperationId = Branded<'ResourceOperationId'>

/** Select execution attribution without supplying a user or project identity. */
export type ResourceOriginIntent = 'execution' | 'interactive' | 'infrastructure'

/** One admitted resource whose accounting survives transport failure. */
export interface ResourceLease {
  /** Caller or provider cancellation, including after uncertain cleanup; owners still report its actual outcome. */
  readonly signal: AbortSignal
  /** Report proven execution quiescence; accounting stays held until acknowledged. */
  release(): Promise<void>
  /** Report unconfirmed cleanup; occupation and cancellation remain until actual completion. */
  uncertain(): Promise<void>
}

/** Consumer metadata; the provider resolves verified actor and project facts. */
export interface ResourceRequest {
  readonly kind: ResourceKind
  readonly signal?: AbortSignal
  readonly sessionId?: Branded<'SessionId'>
  /** Execution is the Session default; terminals select interactive ownership and maintenance selects infrastructure. */
  readonly origin?: ResourceOriginIntent
}
