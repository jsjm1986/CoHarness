/**
 * Client Agent-scope primitive: mint a Cordis context tagged with the owning
 * Agent identity. The filter lives on the scoped context, so scoped dispatch
 * remains ordinary Cordis. The key is the branded SessionId shared by the
 * client Agent and Session axes; a cold session may retain its client scope
 * after the host Agent is disposed for history viewing.
 */

import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote, TypertRemoteScopeApi } from '@deepseek-ai/dsh-typert-protocol'

/** Client Cordis Context carrying one Agent identity and scoped Remote namespaces. */
export type AgentContext = Omit<Context, 'remote'> & {
  readonly remote: TypertClientRemote & TypertRemoteScopeApi<'agent'>
}

/** Context tag written by {@link createScope}. */
const kScope = Symbol('dsh.client.scope')

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
 * @param key - owning session identity used as the routing tag.
 * @returns tagged context and its backing fiber.
 */
export function createScope(ctx: Context, key: SessionId): AgentScopeHandle {
  const fiber = ctx.plugin(agentScope)
  const scoped = fiber.ctx.extend({
    [kScope]: key,
    [CordisContext.filter](listenerCtx: Context): boolean {
      const tag = scopeOf(listenerCtx)
      return tag === undefined || tag === key
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
  return (ctx as Context & { [kScope]?: SessionId })[kScope]
}
