/** Sidebar presence for authorized blank Sessions still holding this document's input. */
import type { ISessions, SessionId, SessionRetainInfo, ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Observe existing composer ownership without acquiring a Session or opening a Runtime.
 * @param sessions - currently authorized directory and read-only reference counts.
 * @param publish - publish only when the owned blank identity list changes.
 * @returns disposal of directory and per-Session subscriptions.
 */
export function observeInputDraftSessions(
  sessions: Pick<ISessions, 'list' | 'retainInfo'>,
  publish: (ids: readonly SessionId[]) => void,
): () => void {
  const candidates = new Map<SessionId, { source: ObservableSnapshot<SessionRetainInfo>; stop(): void }>()
  let previous: readonly SessionId[] = []
  let disposed = false
  const update = (): void => {
    if (disposed) return
    const next = [...candidates].filter(([, entry]) => (entry.source.getSnapshot().retainedBy.composer ?? 0) > 0).map(([id]) => id)
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) return
    previous = next
    publish(next)
  }
  const reconcile = (): void => {
    if (disposed) return
    const list = sessions.list.getSnapshot()
    const ids = new Set(list.ids.filter(id => list.byId[id]?.blank === true))
    for (const [id, entry] of candidates) {
      if (ids.has(id)) continue
      entry.stop(); candidates.delete(id)
    }
    for (const id of ids) {
      if (candidates.has(id)) continue
      const source = sessions.retainInfo(id)
      const entry = { source, stop: () => {} }
      candidates.set(id, entry)
      entry.stop = source.subscribe(update)
    }
    update()
  }
  const stopList = sessions.list.subscribe(reconcile)
  reconcile()
  return () => {
    disposed = true
    stopList()
    for (const entry of candidates.values()) entry.stop()
    candidates.clear()
  }
}
