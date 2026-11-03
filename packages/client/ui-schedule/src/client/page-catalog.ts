/** Explicit task-page activation retains only the Runtime selected by this view. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogInjected, CatalogSnapshot } from './catalog-source.ts'

interface TaskPageOwner {
  readonly abort: AbortController
  readonly ready: Promise<boolean>
  stop?: (() => void) | undefined
}

/**
 * Keep the selected Runtime available without retaining or changing a conversation.
 * Source construction is passive; subscribing is the task page's explicit entry.
 * @param ctx - view owner and exact Runtime preparation services.
 * @param target - captured alternate Runtime.
 * @param source - shared catalog of that Runtime.
 * @returns page-owned activation and the original catalog's mutations.
 */
export function createTaskPageCatalog(
  ctx: Context, target: ConnectionRuntimeTarget, source: CatalogInjected<ScheduleCatalogEntry>,
): CatalogInjected<ScheduleCatalogEntry> {
  const listeners = new Set<() => void>()
  const operations = new Set<Promise<void>>()
  let snapshot: CatalogSnapshot<ScheduleCatalogEntry> = { ...source.hooks.catalog.getSnapshot(), status: 'loading' }
  let owner: TaskPageOwner | undefined
  let disposed = false
  const publish = (next: CatalogSnapshot<ScheduleCatalogEntry>): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const stop = (): void => {
    const previous = owner
    owner = undefined
    previous?.stop?.()
    previous?.abort.abort()
  }
  const activate = (): Promise<boolean> => {
    if (disposed || listeners.size === 0) return Promise.resolve(false)
    if (owner !== undefined) return owner.ready
    let answer!: (value: boolean) => void
    const ready = new Promise<boolean>((resolve) => { answer = resolve })
    const selected: TaskPageOwner = { abort: new AbortController(), ready }
    owner = selected
    publish({ ...snapshot, status: 'loading' })
    const sessions = ctx.sessions
    const hold = sessions.usingRuntime?.bind(sessions)
    const prepare = sessions.prepareRuntime?.bind(sessions)
    const operation = (async () => {
      try {
        if (hold === undefined || prepare === undefined) throw new Error('Runtime management is unavailable')
        await hold(target, selected.abort.signal, async (signal) => {
          await prepare(target, signal)
          signal.throwIfAborted()
          if (owner !== selected) return
          const changed = (): void => { if (owner === selected) publish(source.hooks.catalog.getSnapshot()) }
          selected.stop = source.hooks.catalog.subscribe(changed)
          changed()
          answer(true)
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        })
      } catch (error: unknown) {
        if (owner === selected && !selected.abort.signal.aborted) {
          publish({ ...snapshot, status: 'error' })
          console.error('[ui-schedule] Selected Runtime preparation failed:', error)
        }
      } finally { answer(false) }
    })()
    operations.add(operation)
    void operation.then(() => { operations.delete(operation) })
    return ready
  }
  ctx.effect(() => async () => {
    disposed = true
    stop()
    await Promise.allSettled([...operations])
  }, 'ui-schedule: selected task Runtime')
  return {
    hooks: { catalog: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        if (listeners.size === 1) void activate()
        return () => { listeners.delete(listener); if (listeners.size === 0) stop() }
      },
    } },
    onDelete: source.onDelete,
    onRetry: async (since) => {
      if (snapshot.status === 'error') { stop(); if (!await activate()) return }
      await source.onRetry(since)
    },
  }
}
