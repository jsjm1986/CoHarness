/** Session-authorized interactive desktop confirmation through the deployment policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import { ComputerUseUnavailableError, computerUseUnavailableReason } from '@deepseek-ai/dsh-computer-use'
import type { DesktopApi, DesktopStatus } from './api/desktop.ts'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'

interface Options {
  authorize(id: SessionId, authority?: CollaborationAuthority): Promise<
    { authority: CollaborationAuthority | undefined } | { error: RpcError }
  >
  agent(id: SessionId): Promise<{ agent: Agent } | { error: RpcError }>
  signal(signal: AbortSignal, authority: CollaborationAuthority | undefined): AbortSignal
}

/**
 * Create confirmation methods without admitting a model turn or borrowing tool approval.
 * @param ctx - deployment desktop policy.
 * @param options - existing Session ACL, resolver and principal lifetime.
 * @returns current-user desktop reads and explicit confirmation writes.
 */
export function createDesktopApi(ctx: Context, options: Options): DesktopApi {
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>()
  ctx.effect(() => async () => { lifetime.abort(); await Promise.allSettled([...pending]) }, 'apiproxy: desktop confirmation')
  function invoke<T>(request: RpcRequest<{ sessionId: SessionId }>, external: AbortSignal | undefined,
    operation: (agent: Agent, signal: AbortSignal) => Promise<T>, liveOnly?: false): Promise<RpcResponse<T>>
  function invoke<T>(request: RpcRequest<{ sessionId: SessionId }>, external: AbortSignal | undefined,
    operation: (agent: Agent, signal: AbortSignal) => Promise<T>, liveOnly: true): Promise<RpcResponse<T | null>>
  async function invoke<T>(request: RpcRequest<{ sessionId: SessionId }>, external: AbortSignal | undefined,
    operation: (agent: Agent, signal: AbortSignal) => Promise<T>, liveOnly = false): Promise<RpcResponse<T | null>> {
    let signal = external === undefined ? lifetime.signal : AbortSignal.any([external, lifetime.signal])
    const work = (async (): Promise<RpcResponse<T | null>> => {
      try {
        signal.throwIfAborted()
        const authorized = await options.authorize(request.payload.sessionId)
        if ('error' in authorized) return { rpcId: request.rpcId, result: { ok: false, error: authorized.error } }
        signal = options.signal(signal, authorized.authority)
        let agent: Agent
        if (liveOnly) {
          const live = ctx.agents.get(request.payload.sessionId)
          if (live === undefined) return { rpcId: request.rpcId, result: { ok: true, value: null } }
          agent = live
        } else {
          const found = await options.agent(request.payload.sessionId)
          if ('error' in found) return { rpcId: request.rpcId, result: { ok: false, error: found.error } }
          agent = found.agent
        }
        signal.throwIfAborted()
        const value = await operation(agent, signal)
        signal.throwIfAborted()
        const current = await options.authorize(request.payload.sessionId, authorized.authority)
        if ('error' in current) return { rpcId: request.rpcId, result: { ok: false, error: current.error } }
        return { rpcId: request.rpcId, result: { ok: true, value } }
      } catch (error) {
        return { rpcId: request.rpcId, result: { ok: false, error: signal.aborted
          ? { code: 'cancelled', message: 'Desktop confirmation was cancelled.', details: {} }
          : error instanceof ComputerUseUnavailableError
            ? { code: 'desktop-unavailable', message: error.message, details: { reason: error.reason } }
            : { code: 'internal', message: 'Desktop confirmation could not be completed. Refresh its current status.', details: {} } } }
      }
    })()
    pending.add(work)
    try { return await work } finally { pending.delete(work) }
  }
  return {
    status: (request, signal) => invoke<DesktopStatus>(request, signal, async (agent, abort) => {
      const unavailableReason = computerUseUnavailableReason(ctx)
      if (unavailableReason !== undefined) return { unavailableReason }
      return await ctx.get('computerUseAuthorization')?.confirmation?.read(agent, abort) ?? null
    }, true),
    confirm: (request, signal) => invoke(request, signal, async (agent, abort) => {
      const unavailableReason = computerUseUnavailableReason(ctx)
      if (request.payload.confirmed && unavailableReason !== undefined) throw new ComputerUseUnavailableError(unavailableReason)
      const policy = ctx.get('computerUseAuthorization')?.confirmation
      if (policy === undefined) throw new Error('Managed desktop confirmation is not configured.')
      return policy.set(agent, request.payload, request.payload.confirmed, abort)
    }),
  }
}
