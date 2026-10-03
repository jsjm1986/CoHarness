/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half. WorkspaceBrowser additionally declares the two Session row
 * action lists, and this apply registers the shipped actions — pin, rename,
 * fork, archive — into them the way any client plugin would, each with its
 * own behavior, plus the rename dialog, the stop-and-archive confirmation,
 * and the row-action notice into `shell.overlay` (see the contract module
 * doc). It also declares two Session-row seats: the leading decoration a row
 * renders only while its own primary state is idle, and the section the
 * row's hover card renders between its relative time and its trailing
 * status line. Export discipline: packages/client/AGENTS.md.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace/types'
import {
  commitSessionNavigation, WorkspaceArchiveError,
  type ClientContext, type SessionId, type WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the layout plugin's Context merge (ctx.layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  menuOpenStateFactory,
  type ArchiveSessionInjected, type ForkSessionInjected, type PinSessionInjected,
  type RenameSessionInjected, type RowToast, type RowToastInjected, type RowToastState,
  type SessionArchiveConfirmInjected, type SessionArchiveConfirmRequest, type SessionRenameDialogInjected,
  type WorkspaceBrowserInjected, type WorkspacePickerInjected,
} from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from './shortcuts.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { derive } from './session-actions/derived.ts'
import { ArchiveSessionMenuItem, ArchiveSessionRowButton, SessionArchiveConfirmDialog } from './session-actions/ArchiveSession.tsx'
import { ForkSessionMenuItem } from './session-actions/ForkSession.tsx'
import { PinSessionMenuItem, PinSessionRowButton } from './session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from './session-actions/RenameSession.tsx'
import { RowActionToast } from './session-actions/RowActionToast.tsx'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  MenuOpenState, RowToast, SessionRenameTarget, SessionRowOwnerProps, UseMenuOpenState,
  SidebarWorkspacesWorkbenchOwnerProps,
  WorkspaceBrowserInjected, WorkspaceBrowserProps, WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

/** Session navigation face other plugins consume through `ctx.uiWorkspace`. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param sessionId - target Session; the navigation rejects when it was
   * archived meanwhile or is otherwise unavailable.
   */
  openSession(sessionId: SessionId): void
  /**
   * Start a New Session flow and navigate to its Session.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Fork a Session and open its child.
   * @param sessionId - source Session.
   * @param onCreated - observer notified once the child exists, before the open navigation.
   * @returns the child SessionId after the open navigation completes.
   */
  forkSession(sessionId: SessionId, onCreated?: (childId: SessionId) => void): Promise<SessionId>
  /**
   * Archive a Session on the Host.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-plugin Workspace/Session navigation capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection', 'conversationViewport', 'shortcuts', 'layout']

/**
 * Register the browser, the picker, the shipped Session actions, and the
 * overlay surfaces once their slot declarations are on the ledger. Inject
 * factories return plain callbacks; data reads use the framework's global hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const viewport = ctx.get('conversationViewport')
  const hostDescription = connection.hostDescription
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'ui-workspace: navigation lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await ctx.sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const openSession = async (
    sessionId: SessionId,
    navigation = AbortSignal.any([ctx.sessions.beginNavigation(), lifetime.signal]),
  ): Promise<void> => {
    await commitSessionNavigation(ctx.sessions, sessionId, navigation, () => {
      if (ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)) throw new Error('Session was archived during navigation')
      // A single-mode open must not materialize a workbench pane: on an empty
      // pane list `replaceActive` falls back to `add`, which switches the
      // viewport into workbench mode and collapses the session list. Route
      // through the active pane only while the workbench is actually engaged.
      if (viewport?.snapshot.getSnapshot().mode === 'workbench' && !viewport.replaceActive(sessionId).ok) {
        throw new Error(ctx.locale.bind(NS)('navigation.unavailable'))
      }
      ctx.sessions.open(sessionId)
      // Opening a Session always reveals its Conversation, including the
      // no-op reselection of the current Session from another main panel.
      ctx.layout.selectPanel(null)
    })
  }
  // Fork resolves only after the child opens so callers can classify the
  // host's fork refusal; the pointer menu swallows it, the command reports it.
  const forkSession = (sessionId: SessionId, onCreated?: (childId: SessionId) => void): Promise<SessionId> => {
    const navigation = AbortSignal.any([ctx.sessions.beginNavigation(), lifetime.signal])
    return ctx.sessions.fork({ sessionId, increaseTitle: true })
      .then(async (childId) => {
        onCreated?.(childId)
        await openSession(childId, navigation)
        return childId
      })
  }
  // One viewing-store instance, created here: the browser declares the
  // handle, the pin callback fronts the same instance's saved orders, and
  // the row toast reads the archived filter off it.
  const viewHandle = createWorkspaceViewStore()
  const viewInstance = viewHandle.create()
  const viewStore: typeof viewHandle = { ...viewHandle, create: () => viewInstance }

  const rowToast = createSnapshotStore<RowToastState | null>(null)
  let toastSeq = 0
  const notify = (toast: RowToast): void => { rowToast.set({ ...toast, seq: ++toastSeq }) }
  const uiWorkspace: UiWorkspace = {
    openSession: (sessionId) => {
      void openSession(sessionId).catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === 'AbortError') return
        console.warn('session navigation failed:', reason)
      })
    },
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    forkSession,
    archiveSession: (sessionId, options) => ctx.workspaces.archiveSession(sessionId, options),
    unarchiveSession: sessionId => ctx.workspaces.unarchiveSession(sessionId),
    pinSession: async (sessionId) => {
      await ctx.workspaces.pinSession(sessionId)
      // Front the Session in the saved orders of the accounts it leads;
      // the pin-set echo partitions the rendered rows independently.
      const { items, pinnedSessionIds, archivedSessionIds } = ctx.workspaces.list.getSnapshot()
      viewInstance.actions.pinSessionOrder(
        sessionId,
        pinOrderAccounts(items, sessionId),
        pinOrderSource(items, ctx.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
      )
    },
    unpinSession: sessionId => ctx.workspaces.unpinSession(sessionId),
  }
  ctx.effect(() => ctx.reflect.provide('uiWorkspace', uiWorkspace), 'ui-workspace: navigation service')
  const shortcutControls = createWorkspaceShortcutControls()
  // Registry-global sets as Sets, rebuilt only when the Workspace snapshot changes.
  const pinnedSet = derive(ctx.workspaces.list, snapshot => new Set<SessionId>(snapshot.pinnedSessionIds))
  const archivedSet = derive(ctx.workspaces.list, snapshot => new Set<SessionId>(snapshot.archivedSessionIds))
  // Plugin-private facts the row actions and their overlay surfaces share:
  // the pending rename request, the pending stop-and-archive confirmation,
  // and the notice on display. Each business writes through its own injected
  // callback and the surface reads through its bound hook.
  const renameRequest = derive(shortcutControls.state, state => state.renameTarget)
  const archiveRequest = createSnapshotStore<SessionArchiveConfirmRequest | null>(null)
  const requestSessionRename = shortcutControls.rename
  const unarchiveSession = (sessionId: SessionId): void => {
    uiWorkspace.unarchiveSession(sessionId).catch((reason: unknown) => {
      console.warn('session unarchive rejected:', reason)
    })
  }
  const renameSession: SessionRenameDialogInjected['renameSession'] = async (sessionId, title) => {
    await ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
      const result = await reference.binding.session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    })
  }
  const pinInjected = (): PinSessionInjected => ({
    hooks: { pinned: pinnedSet, archived: archivedSet },
    // Pin failures surface as a notice: nothing else on the surface moves, so
    // a silent failure would read as a dead action.
    pinSession: (sessionId) => {
      uiWorkspace.pinSession(sessionId).catch(() => { notify({ kind: 'pinFailed' }) })
    },
    unpinSession: (sessionId) => {
      uiWorkspace.unpinSession(sessionId).catch(() => { notify({ kind: 'unpinFailed' }) })
    },
  })
  const archiveInjected = (): ArchiveSessionInjected => ({
    hooks: { archived: archivedSet },
    // Archive preserves the log and the account position, so a quiet Session
    // needs no confirmation; the notice offers undo and the archived filter.
    // The Host's refusal for running work is the one case that asks first:
    // the confirmation names that work and offers to stop it.
    archiveSession: (sessionId) => {
      uiWorkspace.archiveSession(sessionId).then(() => {
        notify({ kind: 'archived', sessionId })
      }).catch((reason: unknown) => {
        const activity = activeSessionRefusal(reason)
        if (activity === undefined) {
          console.warn('session archive rejected:', reason)
          return
        }
        const displayTitle = ctx.sessions.list.getSnapshot().byId[sessionId]?.title ?? sessionId
        archiveRequest.set({ sessionId, displayTitle, activity })
      })
    },
    unarchiveSession,
  })
  installWorkspaceShortcuts(ctx, uiWorkspace, shortcutControls, archiveInjected().archiveSession)
  const archiveConfirmInjected = (): SessionArchiveConfirmInjected => ({
    hooks: { archiveRequest },
    settleSessionArchive: () => { archiveRequest.set(null) },
    stopAndArchiveSession: async (sessionId) => {
      await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
      notify({ kind: 'stoppedAndArchived', sessionId })
    },
  })
  const forkInjected = (): ForkSessionInjected => ({
    forkSession: (sessionId) => {
      uiWorkspace.forkSession(sessionId).catch(() => {
        // Fork or child-rename failure keeps the current selection.
      })
    },
  })
  const renameInjected = (): RenameSessionInjected => ({ requestSessionRename })
  const renameDialogInjected = (): SessionRenameDialogInjected => ({
    hooks: { renameRequest },
    settleSessionRename: shortcutControls.closeRename,
    renameSession,
  })
  const rowToastInjected = (): RowToastInjected => ({
    hooks: { toast: rowToast },
    dismissToast: () => { rowToast.set(null) },
    undoArchive: unarchiveSession,
    showArchived: () => { viewInstance.actions.setArchivedFilter('show') },
  })

  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; unscoped New Session inherits
    // the current Session Workspace before the recent-Workspace fallback.
    startSession: (workspaceId) => { uiWorkspace.startSession(workspaceId) },
    open: openSession,
    searchSessions,
    searchResultLimit: ctx.sessions.searchResultLimit,
    requestSessionRename,
    notifyArchivedNotOpenable: () => { notify({ kind: 'archivedNotOpenable' }) },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    unarchiveSession: async (sessionId) => { await uiWorkspace.unarchiveSession(sessionId) },
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: input => ctx.workspaces.create(input),
    listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
    requestSearch: shortcutControls.search,
    requestAddWorkspace: shortcutControls.add,
    closeAddWorkspace: shortcutControls.closeAdd,
    setDirectoryBusy: shortcutControls.directoryBusy,
    dismissForkError: shortcutControls.dismissForkError,
    hooks: {
      directoryFlow: browserFlowSource,
      hostDescription,
      viewport: viewport?.snapshot ?? { getSnapshot: () => ({ mode: 'single', paneIds: [], paneRatios: [] }), subscribe: () => () => {} },
      currentSessions: ctx.sessions.currentScopeList ?? ctx.sessions.list,
      workspaceShortcuts: shortcutControls.state,
      shortcuts: ctx.shortcuts.catalog,
    },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => ctx.workspaces.create(input),
    listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its directory-flow child in the same call;
  // slot injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.workbench': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.session.menu.item': {
          kind: 'list', scope: 'root',
          inject: { hooks: { menuOpenState: menuOpenStateFactory, shortcuts: ctx.shortcuts.catalog } },
        },
        'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
        'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      },
      store: viewStore,
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item', id: 'pin', order: 100, locale: NS,
        inject: pinInjected,
      },
      PinSessionMenuItem,
    )
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item', id: 'rename', order: 200, locale: NS,
        inject: renameInjected,
      },
      RenameSessionMenuItem,
    )
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item', id: 'fork', order: 300, locale: NS,
        inject: forkInjected,
      },
      ForkSessionMenuItem,
    )
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item', id: 'archive', order: 400, locale: NS,
        inject: archiveInjected,
      },
      ArchiveSessionMenuItem,
    )
  })
  ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.row.action', id: 'archive', order: 100, locale: NS,
        inject: archiveInjected,
      },
      ArchiveSessionRowButton,
    )
    yield ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.row.action', id: 'pin', order: 200, locale: NS,
        inject: pinInjected,
      },
      PinSessionRowButton,
    )
  })
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'shell.overlay', id: 'workspace.session-rename', locale: NS, inject: renameDialogInjected,
      },
      SessionRenameDialog,
    )
    yield ctx.slots.register(
      {
        name: 'shell.overlay', id: 'workspace.session-archive', locale: NS, inject: archiveConfirmInjected,
      },
      SessionArchiveConfirmDialog,
    )
    // The toast shares the browser's viewing store: it reads the archived
    // filter to drop the archived notice's filter action once rows are visible.
    yield ctx.slots.register(
      {
        name: 'shell.overlay', id: 'workspace.row-toast', locale: NS, store: viewStore, inject: rowToastInjected,
      },
      RowActionToast,
    )
  })
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}

/**
 * The activity a Host `session-active` refusal reported, or nothing for any
 * other failure. The class identity check goes by name: client plugin
 * bundles do not share error-class identity.
 */
function activeSessionRefusal(reason: unknown): readonly SessionActivity[] | undefined {
  if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return undefined
  const { rpcError } = reason as WorkspaceArchiveError
  return rpcError.code === 'session-active' ? rpcError.details.activity : undefined
}
