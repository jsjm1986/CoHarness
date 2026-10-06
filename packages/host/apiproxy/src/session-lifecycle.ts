/** Handle ownership for idle Session removal through the Host API. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Host-internal lifecycle operations; this service is not a Remote or HTTP endpoint. */
export interface HostSessionLifecycle {
  /**
   * Retain the disposer returned to this Host entry point by the Agent factory.
   * @param handle - newly created or resumed Agent owned by this API.
   * @returns that exact Agent for ordinary request routing.
   */
  own(handle: AgentHandle): Agent
  /**
   * Release idle API-owned Sessions in runtime child-first order while preventing same-identity recreation.
   * @param ids - the complete durable tree selected by the archive owner.
   * @param remove - durable removal, invoked only after all releases succeed.
   * @returns the removal result; busy or unknown owners leave persistent data untouched.
   */
  withReleased<T>(ids: readonly SessionId[], remove: () => Promise<T>): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Factory handles retained by the Host API for controlled idle release. */
    hostSessionLifecycle: HostSessionLifecycle
  }
}

/**
 * Reuse the runtime's Host owner or register it for this API lifetime.
 * @param ctx - Host context that creates or resumes the returned Agents.
 * @returns the shared owner of those exact handles.
 */
export function hostSessionLifecycle(ctx: Context): HostSessionLifecycle {
  const existing = ctx.get('hostSessionLifecycle')
  if (existing !== undefined) return existing
  const handles = new Map<SessionId, AgentHandle>()
  ctx.on('agent/disposed', ({ agent }) => {
    if (handles.get(agent.id)?.agent === agent) handles.delete(agent.id)
  }, { global: true })
  const service: HostSessionLifecycle = {
    own(handle) {
      if (ctx.agents.get(handle.agent.id) !== handle.agent) throw new Error('Host Session owner changed before publication completed')
      handles.set(handle.agent.id, handle)
      return handle.agent
    },
    async withReleased(ids, remove) {
      using _reservation = ctx.agents.reserveRemoval(ids)
      const releasing: AgentHandle[] = []
      for (const id of new Set(ids)) {
        const agent = ctx.agents.get(id)
        if (agent === undefined && ctx.sessions.get(id) === undefined) continue
        const handle = handles.get(id)
        if (handle === undefined || handle.agent !== agent) {
          throw new Error('Session has another lifecycle owner; stop its task before purging')
        }
        releasing.push(handle)
      }
      const pending = new Set(releasing)
      const release = async (handle: AgentHandle): Promise<void> => {
        if (!pending.delete(handle)) return
        for (const child of releasing) {
          if (ctx.agents.isOwnedBy(child.agent.id, handle.agent)) await release(child)
        }
        let released: boolean
        try { released = await handle.tryDisposeIdle() }
        catch (error) { throw new AggregateError([error], 'Session release failed; durable archive data was retained') }
        if (!released) throw new Error('Session has active work, child tasks, terminals or pending input; stop them before purging')
      }
      for (const handle of releasing) await release(handle)
      for (const id of ids) {
        if (ctx.agents.get(id) !== undefined || ctx.sessions.get(id) !== undefined) throw new Error('Session release has not completed')
      }
      return await remove()
    },
  }
  ctx.provide('hostSessionLifecycle', service)
  return service
}
