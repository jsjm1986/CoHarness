/**
 * The Memory page's authoritative Remote state: the scope catalog, the
 * selected scope's entries, and member writes — refreshed by the Host's
 * `memory/changed` event and by connection resets.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  MemoryDeleteRequest, MemoryEntry, MemoryScope, MemoryScopeCatalog, MemorySaveRequest,
  MemoryWriteResult,
} from '@deepseek-ai/dsh-memory/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { scopeKeyOf } from './memory.ts'

/** Remote operations and invalidations bound by the plugin body. */
export interface MemorySourceDeps {
  readonly scopes: () => Promise<RemoteResult<MemoryScopeCatalog>>
  readonly list: (scope: MemoryScope) => Promise<RemoteResult<MemoryEntry[]>>
  readonly save: (request: MemorySaveRequest) => Promise<RemoteResult<MemoryWriteResult>>
  readonly remove: (request: MemoryDeleteRequest) => Promise<RemoteResult<MemoryWriteResult>>
  readonly subscribeChanged: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
  /** Open one entry's source Session, when the row offers it. */
  readonly openSource: (sessionId: SessionId) => void
  /**
   * The on-screen Session's working directory, when it has one. A catalog
   * arriving with no prior selection prefers the workspace scope whose
   * `directory` matches, so the panel opens on the context the Agent writes
   * into; other scopes stay one switch away.
   */
  readonly sessionDirectory?: () => string | undefined
}

/** What the page renders: the catalog, the selected scope, and its entries. */
export interface MemorySnapshot {
  /** `loading` until a catalog read settles, `error` after the last read failed. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Whether the `memory` settings section keeps the feature on. */
  readonly enabled: boolean
  /** Offered scopes with their entry counts and per-caller writability. */
  readonly scopes: MemoryScopeCatalog['scopes']
  /** Selection key from {@link scopeKeyOf}; undefined before the first catalog. */
  readonly selected: string | undefined
  /** The selected scope's entries, in catalog order; undefined before its first read. */
  readonly entries: readonly MemoryEntry[] | undefined
  /** Whether the entry read of the selected scope failed. */
  readonly entriesFailed: boolean
  /** Whether the caller's last Remote read has ever succeeded. */
  readonly settled: boolean
}

/** Component callbacks the page's slot registration injects. */
export interface MemoryInjected {
  readonly hooks: { readonly memory: HostObservable<MemorySnapshot> }
  /** Select a scope by its {@link scopeKeyOf} key and load its entries. */
  readonly select: (scopeKey: string) => void
  /** Re-read the catalog and the selected scope. */
  readonly refresh: () => void
  /** Create or replace an entry; resolves the wire result for the editor to report. */
  readonly save: (request: MemorySaveRequest) => Promise<RemoteResult<MemoryWriteResult>>
  /** Delete an entry; resolves the wire result for the editor to report. */
  readonly remove: (request: MemoryDeleteRequest) => Promise<RemoteResult<MemoryWriteResult>>
  /** Open the source Session an entry attributes its last write to. */
  readonly openSource: (sessionId: SessionId) => void
}

/**
 * Create the Memory page's observable over Remote reads. Remote
 * subscriptions follow framework subscribers, so an unmounted page costs
 * nothing; a change event re-reads the catalog and the open scope together.
 * @param deps - Remote calls and invalidation subscriptions.
 * @returns the snapshot hook and the page's action callbacks.
 */
export function createMemorySource(deps: MemorySourceDeps): MemoryInjected {
  let snapshot: MemorySnapshot = {
    status: 'loading', enabled: true, scopes: [], selected: undefined,
    entries: undefined, entriesFailed: false, settled: false,
  }
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposers: readonly (() => void)[] = []
  const publish = (next: MemorySnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const scopeOf = (key: string | undefined): MemoryScope | undefined =>
    snapshot.scopes.find(view => scopeKeyOf(view.scope) === key)?.scope

  const loadEntries = async (scope: MemoryScope, key: string, current: number): Promise<void> => {
    let result: RemoteResult<MemoryEntry[]>
    try {
      result = await deps.list(scope)
    } catch {
      result = { ok: false, error: undefined as never }
    }
    if (current !== epoch || snapshot.selected !== key) return
    publish(result.ok
      ? { ...snapshot, entries: result.value, entriesFailed: false }
      : { ...snapshot, entries: undefined, entriesFailed: true })
  }

  const load = async (): Promise<void> => {
    const current = ++epoch
    let result: RemoteResult<MemoryScopeCatalog>
    try {
      result = await deps.scopes()
    } catch {
      result = { ok: false, error: undefined as never }
    }
    if (current !== epoch) return
    if (!result.ok) {
      publish({ ...snapshot, status: 'error' })
      return
    }
    const catalog = result.value
    const directory = deps.sessionDirectory?.()
    const contextual = directory === undefined
      ? undefined
      : catalog.scopes.find(view => view.scope.kind === 'workspace' && view.scope.directory === directory)
    const selected = catalog.scopes.some(view => scopeKeyOf(view.scope) === snapshot.selected)
      ? snapshot.selected
      : scopeKeyOf((contextual ?? catalog.scopes[0])?.scope ?? { kind: 'personal' })
    publish({
      ...snapshot,
      status: 'ready',
      settled: true,
      enabled: catalog.enabled,
      scopes: catalog.scopes,
      selected,
      ...(snapshot.selected === selected ? {} : { entries: undefined, entriesFailed: false }),
    })
    const scope = scopeOf(selected)
    if (scope !== undefined && selected !== undefined) void loadEntries(scope, selected, current)
  }

  const write = async (
    run: () => Promise<RemoteResult<MemoryWriteResult>>,
  ): Promise<RemoteResult<MemoryWriteResult>> => {
    const result = await run()
    // An acknowledged write re-reads everything rather than merging, so the
    // page mirrors the durable store the same way a changed-event refresh does.
    if (result.ok && result.value.ok) void load()
    return result
  }

  return {
    hooks: {
      memory: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposers = [deps.subscribeChanged(() => { void load() }), deps.subscribeReset(() => { void load() })]
            void load()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            for (const dispose of disposers) dispose()
            disposers = []
            epoch++
          }
        },
      },
    },
    select: (scopeKey) => {
      const scope = scopeOf(scopeKey)
      if (scope === undefined || scopeKey === snapshot.selected) return
      publish({ ...snapshot, selected: scopeKey, entries: undefined, entriesFailed: false })
      void loadEntries(scope, scopeKey, epoch)
    },
    refresh: () => { void load() },
    save: request => write(() => deps.save(request)),
    remove: request => write(() => deps.remove(request)),
    openSource: deps.openSource,
  }
}
