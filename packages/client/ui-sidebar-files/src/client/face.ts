/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Host API face: the tree keys
 * every level by absolute path and the endpoint answers workspace-relative
 * listings, so the binding converts through the Session's workspace root before
 * each call and drops the echoed path.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { IApiClient, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceResourceRegistry, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import { DirectoryNode } from './directory-node.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the workspace-resources change feed.
 *
 * The Host's `host/workspace-file-changed` frames already name every observed
 * relative path; arming the watcher therefore yields `ready` immediately, and
 * each frame under the watched directory yields `change`. The generator parks on
 * a one-slot wake signal so frames cannot queue between yields.
 * @param resources - the workspace-resources registry that owns change frames.
 * @param targetOf - runtime target holding the Session's Host connection.
 * @param relativeOf - absolute path to workspace-relative conversion; `undefined` when outside the root.
 * @returns a watcher bound to the registry's feed.
 */
export function createWatch(
  resources: Pick<WorkspaceResourceRegistry, 'observeChanges'>,
  targetOf: (sessionId: SessionId) => WorkspaceResourceTarget | undefined,
  relativeOf: (sessionId: SessionId, path: string) => string | undefined,
): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    if (signal.aborted) return
    const target = targetOf(sessionId)
    const directory = relativeOf(sessionId, path)
    if (target === undefined || directory === undefined) return
    const queue: 'change'[] = []
    let wake: (() => void) | undefined
    const stop = resources.observeChanges(target, (change) => {
      if (change.sessionId !== sessionId) return
      const changed = change.path.replace(/\\/g, '/')
      if (directory !== '' && changed !== directory && !changed.startsWith(`${directory}/`)) return
      queue.push('change')
      const waking = wake
      wake = undefined
      waking?.()
    })
    const aborted = (): boolean => signal.aborted
    try {
      yield 'ready'
      while (!aborted()) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        if (aborted()) return
        while (queue.length > 0) { queue.shift(); yield 'change' }
      }
    } finally { stop() }
  }
}

/**
 * One directory listing, bound to the Host API face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * An API call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RpcResult<DirLevel>>

/** The slice of the Session API face this package calls: `workspaceFiles.list`. */
export type WorkspaceFilesListApi = Pick<IApiClient['workspaceFiles'], 'list'>

/**
 * Resolve the absolute path to the workspace-relative form the API requires.
 * @param path - absolute directory path.
 * @param cwd - the Session's workspace root.
 * @returns `''` for the workspace root, the relative path, or `undefined` when outside the root.
 */
export function directoryRelative(path: string, cwd: string | undefined): string | undefined {
  const root = cwd?.replace(/[/\\]+$/, '')
  if (root === undefined || root === '') return undefined
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = root.replace(/\\/g, '/')
  if (normalized === base) return ''
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1)
  return undefined
}

/**
 * Bind the listing to one API lookup, keeping only what the tree stores.
 * @param resolve - per-Session `workspaceFiles` face; `undefined` when the runtime is unavailable.
 * @param relativeOf - absolute path to workspace-relative conversion; `undefined` when outside the root.
 * @returns the listing the tree's face performs.
 */
export function createList(
  resolve: (sessionId: SessionId) => WorkspaceFilesListApi | undefined,
  relativeOf: (sessionId: SessionId, path: string) => string | undefined,
): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const api = resolve(sessionId)
    const directory = relativeOf(sessionId, path)
    if (api === undefined || directory === undefined) {
      return { ok: false, error: { code: 'internal', message: 'Workspace runtime is unavailable', details: {} } }
    }
    const response = await api.list(directory === '' ? { sessionId } : { sessionId, path: directory }, signal)
    if (!response.result.ok) return response.result
    return { ok: true, value: { entries: response.result.value.entries, truncated: response.result.value.truncated } }
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const roots = new Map<TabId, DirectoryNode>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      return list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
        return result.ok ? result.value : undefined
      })
    }
    return {
      refresh: (tabId) => { void roots.get(tabId)?.refreshTree() },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        roots.get(tabId)?.setAutomatic(enabled)
      },
      start(tabId, root, signal) {
        actions.start(tabId, root)
        signal.addEventListener('abort', () => {
          void roots.get(tabId)?.close()
          roots.delete(tabId)
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        roots.set(tabId, new DirectoryNode(root,
          (path, lifetime) => load(tabId, path, lifetime),
          (path, lifetime) => watch(sessionId, path, lifetime),
          (path, error) => {
            if (!signal.aborted) actions.failed(tabId, path, { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} })
          }, signal,
        ).open())
      },
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const root = roots.get(tabId)
        if (root === undefined) return
        const parent = root.find(parentPath)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        root.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
