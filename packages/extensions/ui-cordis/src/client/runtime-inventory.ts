/** Exact Runtime ownership of dynamic Plugin inventories, calls and live facts. @module */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { CordisRunnerFace, DynamicCordisLivePackage } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createCordisInventory } from './inventory.ts'
import type { CordisInventory } from './inventory.ts'
import type { CordisDynamicPort } from './dynamic-port.ts'
import type { CordisPanelActions } from './slots.ts'

interface RuntimeCordisSource {
  readonly inventory: CordisInventory
  readonly runner: CordisRunnerFace
  readonly loaded: HostObservable<readonly DynamicCordisLivePackage[]>
  readonly actions: CordisPanelActions
}

/**
 * Capture one Runtime per inventory; discovery never prepares a Runtime.
 * @param ctx - plugin lifetime, exact transports, Sessions and Plugin runners.
 * @returns stable inventories and actions for each addressed Session.
 */
export function createRuntimeCordisInventories(ctx: ClientContext): {
  forSession(sessionId?: SessionId): RuntimeCordisSource
} {
  const connection = ctx.get('connection') as ConnectionHandle
  const sources = new Map<ConnectionHandle, ReturnType<typeof create>>()
  const sessionSources = new Map<SessionId, ReturnType<typeof create>>()
  function create(sessionId?: SessionId): RuntimeCordisSource {
    const target = sessionId === undefined ? undefined : ctx.sessions.runtimeTargetFor?.(sessionId)
    const transport = target === undefined ? connection : connection.forTarget?.(target)
    if (transport === undefined) throw new Error('Dynamic Plugin Runtime transport is unavailable')
    const remote = ctx.remote.$forTarget(target)
    const runner = ctx.dynamicCordisRunner.forTarget(target)
    const port: CordisDynamicPort = {
      stop: async (id, pluginId) => {
        const result = await remote.dynamicCordisRunner.stopFromPanel(id, pluginId)
        if (!result.ok) return { ok: false, message: `${result.error.code}: ${result.error.message}` }
        return result.value.ok || result.value.reason === 'not-running'
          ? { ok: true } : { ok: false, message: result.value.message }
      },
      remove: async (id, pluginId) => {
        const result = await remote.dynamicCordisRunner.undefineFromPanel(id, pluginId)
        if (!result.ok) return { ok: false, message: `${result.error.code}: ${result.error.message}` }
        return result.value.ok ? { ok: true } : { ok: false, message: result.value.message }
      },
      inventory: async () => {
        if (target !== undefined && transport.state.getSnapshot() !== 'connected') {
          throw new Error('Dynamic Plugin Runtime is not connected')
        }
        const result = await remote.dynamicCordisRunner.inventory()
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.map(row => ({ ...row, agentId: ctx.sessions.keyFor?.(row.agentId, target) ?? row.agentId }))
      },
    }
    const inventory = createCordisInventory(port, (error) => {
      console.error('[ui-cordis] Reading the Runtime Plugin inventory failed:', error)
    })
    const loaded = { getSnapshot: () => runner.getSnapshot(), subscribe: (fn: () => void) => runner.subscribe(fn) }
    ctx.effect(() => inventory.subscribe(() => {
      const snapshot = inventory.getSnapshot()
      if (snapshot.read) runner.reconcileApprovals(snapshot.rows)
    }), 'ui-cordis: Runtime pending approvals')
    remote.$on('@deepseek-ai/cordis/dynamic-package', () => { inventory.refresh() })
    remote.$on('@deepseek-ai/cordis/dynamic-retract', () => { inventory.refresh() })
    remote.$on('@deepseek-ai/cordis/request-run', () => { inventory.refresh() })
    remote.$on('@deepseek-ai/cordis/request-run-resolved', () => { inventory.refresh() })
    if (target === undefined) ctx.on('connection/reset', () => { inventory.reset(); inventory.refresh() })
    else ctx.effect(() => transport.state.subscribe(() => {
      if (transport.state.getSnapshot() === 'connected') inventory.refresh()
    }), 'ui-cordis: Runtime inventory reconnect')
    const actions: CordisPanelActions = {
      runtimeKey: runner.viewPrefix || 'base',
      ...(target?.runtimeId === undefined ? {} : { runtimeId: target.runtimeId }),
      ...(target?.nodeName === undefined ? {} : { computerName: target.nodeName }),
      onApprove: (requestId, future) => runner.approve(requestId, future),
      onDecline: requestId => runner.decline(requestId),
      onRun: request => runner.startUserRun(request),
      onStop: async (id, pluginId) => {
        const result = await port.stop(id, pluginId)
        inventory.refresh()
        return result
      },
      onRemove: async (id, pluginId) => {
        const result = await port.remove(id, pluginId)
        if (result.ok) inventory.retire(pluginId)
        inventory.refresh()
        return result
      },
      onRefresh: () => { inventory.refresh() },
    }
    return { inventory, runner, loaded, actions }
  }
  const forSession = (sessionId?: SessionId): ReturnType<typeof create> => {
    const captured = sessionId === undefined ? undefined : sessionSources.get(sessionId)
    if (captured !== undefined) return captured
    const target = sessionId === undefined ? undefined : ctx.sessions.runtimeTargetFor?.(sessionId)
    const transport = target === undefined ? connection : connection.forTarget?.(target)
    if (transport === undefined) throw new Error('Dynamic Plugin Runtime transport is unavailable')
    let source = sources.get(transport)
    if (source === undefined) { source = create(sessionId); sources.set(transport, source) }
    if (sessionId !== undefined) sessionSources.set(sessionId, source)
    return source
  }
  ctx.effect(() => () => { sources.clear(); sessionSources.clear() }, 'ui-cordis: Runtime inventory identities')
  return { forSession }
}
