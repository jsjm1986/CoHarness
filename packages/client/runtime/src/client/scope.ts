/** Client scope generations route local events independently of Host Agent residency. */

import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ClientRemote, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/** Client Cordis Context carrying one Agent identity and scoped Remote namespaces. */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: ClientRemote & TypertRemoteScopeApi<'agent'>
}

/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope')

interface ScopeIdentity {
  readonly sessionId: SessionId
}

/** A minted Agent scope and its disposal boundary. */
export interface AgentScopeHandle {
  /** Tagged context used for scoped registrations and dispatch. */
  ctx: AgentContext
  /** Backing fiber; disposal tears down scope-owned registrations. */
  fiber: Fiber
}

/** Shared no-op plugin backing each Agent scope fiber. */
function agentScope(): void {}

/**
 * Mint an Agent scope under `ctx`.
 * @param ctx - client root context the scope fiber mounts under.
 * @param key - durable Session identity carried by this generation.
 * @returns tagged context and its backing fiber.
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const identity: ScopeIdentity = { sessionId: key }
  const scoped = fiber.ctx.extend({
    [kScope]: identity,
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeIdentityOf(listenerCtx)
      return tag === undefined || tag === identity
    },
  }) as AgentContext
  return { fiber, ctx: scoped }
}

/**
 * Read the nearest Agent tag inherited by a context.
 * @param ctx - any client context.
 * @returns session identity, or undefined for root contexts.
 */
export function scopeOf(ctx: Context): SessionId | undefined {
  return scopeIdentityOf(ctx)?.sessionId
}

/**
 * Read the exact generation identity inherited by a Client Context.
 * @param ctx - scoped or root Client Context.
 * @returns the generation identity, or undefined for an unscoped Context.
 */
export function scopeIdentityOf(ctx: Context): ScopeIdentity | undefined {
  return (ctx as Context & { [kScope]?: ScopeIdentity })[kScope]
}
