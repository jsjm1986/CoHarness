/** Node resource kinds, ownership and quiescence obligations. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Independently budgeted local resources; terminals consume process permits. */
export type ResourceKind = 'model' | 'process'

/** One admitted resource whose accounting survives transport failure. */
export interface ResourceLease {
  /** Report proven execution quiescence; accounting stays held until acknowledged. */
  release(): void
  /** Report unconfirmed cleanup; the resource remains occupied. */
  uncertain(): void
}

/** Consumer metadata; the provider resolves verified actor and project facts. */
export interface ResourceRequest {
  readonly kind: ResourceKind
  readonly signal?: AbortSignal
  readonly sessionId?: Branded<'SessionId'>
}
