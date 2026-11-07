/** Runtime-owned task catalogs shared by page, sidebar and conversation readers. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle, ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createCatalogSource, type CatalogInjected } from './catalog-source.ts'

/** One exact transport and its shared retained task source. */
export interface RuntimeTaskCatalog {
  readonly remote: ClientRemote
  readonly source: CatalogInjected<ScheduleCatalogEntry>
}

/**
 * Capture each Runtime's calls, events and Session-key projection independently.
 * Resolving a source starts no Runtime; only connected alternate transports read.
 * @param ctx - plugin lifetime and the Session directory.
 * @returns cached sources for the bootstrap Runtime and addressed Sessions.
 */
export function createRuntimeTaskCatalogs(ctx: Context): {
  readonly base: RuntimeTaskCatalog
  readonly forTarget: (target?: ConnectionRuntimeTarget) => RuntimeTaskCatalog
  readonly forSession: (sessionId: SessionId) => RuntimeTaskCatalog
} {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const catalogs = new Map<ConnectionHandle | undefined, RuntimeTaskCatalog>()
  const forTarget = (target?: ConnectionRuntimeTarget): RuntimeTaskCatalog => {
    const transport = target === undefined ? connection : connection?.forTarget?.(target)
    if (target !== undefined && transport === undefined) throw new Error('Task Runtime connection is unavailable')
    const existing = catalogs.get(transport)
    if (existing !== undefined) return existing
    const remote = ctx.remote.$forTarget(target)
    const source: CatalogInjected<ScheduleCatalogEntry> = createCatalogSource({
      list: async () => {
        if (target !== undefined && transport?.state.getSnapshot() !== 'connected') {
          throw new Error('Task Runtime is not connected')
        }
        const result = await remote.schedule.catalog()
        if (!result.ok) return result
        return { ...result, value: result.value.map(entry => ({
          ...entry, sessionId: ctx.sessions.keyFor?.(entry.sessionId, target) ?? entry.sessionId,
        })) }
      },
      remove: (id) => {
        const record = source.hooks.catalog.getSnapshot().records.find(item => item.id === id)
        return record === undefined
          ? Promise.resolve({ ok: true as const, value: { id, deleted: false as const, code: 'schedule_not_found' as const } })
          : remote.schedule.delete({ sessionId: record.sessionId, id })
      },
      subscribeChanged: listener => remote.$on('schedule/changed', listener),
      subscribeReset: (listener) => {
        if (target === undefined) return ctx.on('connection/reset', listener)
        if (transport === undefined) throw new Error('Task Runtime connection is unavailable')
        return transport.state.subscribe(listener)
      },
    })
    const catalog = { remote, source }
    catalogs.set(transport, catalog)
    return catalog
  }
  ctx.effect(() => () => { catalogs.clear() }, 'ui-schedule: Runtime catalog identities')
  return { base: forTarget(), forTarget,
    forSession: sessionId => forTarget(ctx.sessions.runtimeTargetFor?.(sessionId)) }
}
