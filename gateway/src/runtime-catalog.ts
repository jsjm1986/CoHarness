/** Authenticated environment-directory types; no operation starts or probes a runtime. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable environment identity, independent of process generation and display names. */
export type RuntimeId = Branded<'GatewayRuntimeId'>

/** Opaque, actor-scoped continuation of one directory page. */
export type RuntimeCatalogCursor = Branded<'RuntimeCatalogCursor'>

/** Compute-node identity returned by the authenticated environment directory. */
export type RuntimeNodeId = Branded<'RuntimeNodeId'>

/** Deployment limits applied to complete directory pages. */
export interface RuntimeCatalogLimits {
  /** Maximum rows in one page; a request may choose a smaller page. */
  pageSize: number
  /** Maximum UTF-8 bytes of the complete page JSON. */
  maxBytes: number
}

/** Authorized environment metadata, including its last reported process state. */
export interface RuntimeCatalogEntry {
  id: RuntimeId
  owner: { kind: 'personal' | 'project'; id: number; name: string }
  node: { id: RuntimeNodeId; name: string; status: 'active' | 'draining' | 'offline'; lastHeartbeatAt: string | null }
  /** Local execution is available only through the existing owning Gateway. */
  routing: 'local' | 'unavailable'
  observedState: string
  generation: number
  /** Local directory preparation must complete before process admission. */
  provisioning?: 'preparing' | 'ready'
}

/** One bounded keyset page; absence never establishes deletion of another page. */
export interface RuntimeCatalogPage {
  items: RuntimeCatalogEntry[]
  nextCursor: RuntimeCatalogCursor | null
}

/** Parser-owned HTTP query fields. Actor identity comes exclusively from authentication. */
export interface RuntimeCatalogQuery {
  cursor?: string
  limit?: string
  /** Up to 32 comma-separated UUIDs to resolve through the same current authorization query. */
  ids?: string
}

/** Expected directory refusals with stable machine-readable error codes. */
export type RuntimeCatalogErrorCode =
  | 'runtime-catalog/invalid-cursor'
  | 'runtime-catalog/invalid-limit'
  | 'runtime-catalog/invalid-id'
  | 'runtime-catalog/forbidden'
  | 'runtime-catalog/not-found'
  | 'runtime-catalog/entry-too-large'
  | 'runtime-catalog/remote-unavailable'
  | 'runtime-catalog/unavailable'
  | 'runtime-catalog/target-mismatch'
  | 'runtime-catalog/ambiguous-target'

/** Directory refusal retaining its HTTP status and declared error code. */
export class RuntimeCatalogError extends Error {
  /**
   * @param status - HTTP status owned by the directory operation.
   * @param code - stable refusal code, independent of localized presentation.
   */
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 503, readonly code: RuntimeCatalogErrorCode) {
    super(code)
    this.name = 'RuntimeCatalogError'
  }
}
