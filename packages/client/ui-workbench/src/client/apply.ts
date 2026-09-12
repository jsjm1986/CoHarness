/** Contributes workbench controls without importing the conversation renderer. */
import { WorkspaceResourceError } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, ConversationViewport, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkbenchCatalog } from './catalog.ts'
import { WorkbenchEmpty } from './components/WorkbenchEmpty.tsx'
import { WorkbenchPaneHeader } from './components/WorkbenchPaneHeader.tsx'
import { WorkbenchToolbar } from './components/WorkbenchToolbar.tsx'
import { createWorkbenchStore } from './stores.ts'
import { en, NS, zh } from './locales.ts'

/** Required Cordis capabilities; slot declarations may arrive in either order. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversationViewport']

function controller(ctx: ClientContext): ConversationViewport {
  const viewport = ctx.get('conversationViewport')
  if (viewport === undefined) throw new Error('ui-workbench requires the conversation viewport capability')
  return viewport
}

/** Optional workbench management methods contributed onto the conversation viewport. */
type WorkbenchViewport = ConversationViewport & {
  listWorkbenches?: () => readonly { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }[]
  currentWorkbench?: () => { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }
  createWorkbench?: (name: string) => string
  renameWorkbench?: (id: string, name: string) => void
  duplicateWorkbench?: (id: string, name: string) => string
  deleteWorkbench?: (id: string) => void
  switchWorkbench?: (id: string) => void
}

/** Mount the workbench's slot contributions and localized controls.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  const viewport = controller(ctx)
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const chooser = createWorkbenchStore()
  let disposed = false
  const isDisposed = (): boolean => disposed
  ctx.effect(() => () => { disposed = true }, 'ui-workbench: pending navigation lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workbench: dictionaries')
  ctx.on('workspace/resource-open', (request) => {
    if (ctx.get('workspaceResources')?.hasProvider(request.runtimeTarget) !== true || connection === undefined) return
    ctx.slots.bindStore(chooser).actions.openPreview(request)
    return true
  })
  const chooseSession = async (item: import('./catalog.ts').WorkbenchConversation, replace: boolean) => {
    const current = viewport.snapshot.getSnapshot()
    if (!replace && current.paneIds.length >= 4 && !current.paneIds.includes(item.sessionId)) {
      return { ok: false as const, reason: 'limit' as const }
    }
    const available = await ctx.sessions.ensureSession?.(item.runtime, item.sessionId)
    if (disposed || available !== true) return { ok: false as const, reason: 'unknown' as const }
    return replace ? viewport.replaceActive(item.sessionId) : viewport.add(item.sessionId)
  }
  ctx.slots.inject('conversation.workbench.toolbar', () => ctx.slots.register({
    name: 'conversation.workbench.toolbar',
    locale: NS,
    store: chooser,
    inject: () => {
      const wb = viewport as WorkbenchViewport
      return {
        listWorkbenches: () => wb.listWorkbenches?.() ?? [],
        currentWorkbench: () => wb.currentWorkbench?.(),
        createWorkbench: (name: string) => wb.createWorkbench?.(name) ?? '',
        renameWorkbench: (id: string, name: string) => { wb.renameWorkbench?.(id, name) },
        duplicateWorkbench: (id: string, name: string) => wb.duplicateWorkbench?.(id, name) ?? '',
        deleteWorkbench: (id: string) => { wb.deleteWorkbench?.(id) },
        switchWorkbench: (id: string) => { wb.switchWorkbench?.(id) },
        chooseSession,
        focusSession: (id: SessionId) => { viewport.focus(id) },
        createSession: async (target: SessionRuntimeTarget, replace: boolean) => {
          // Enforce capacity before creating a Session; recheck after the async
          // create in case another navigation filled the last slot meanwhile.
          if (!replace && viewport.snapshot.getSnapshot().paneIds.length >= 4) return { ok: false as const, reason: 'limit' as const }
          const id = await ctx.sessions.createSession?.(target)
          if (id === undefined) return { ok: false as const, reason: 'unknown' as const }
          return disposed ? { ok: false as const, reason: 'unknown' as const } : chooseSession({
            sessionId: id,
            runtime: target,
            visibility: target.kind === 'personal' ? 'personal' : 'project',
            creatorUserId: 0,
            creatorDisplayName: '',
            updatedAt: Date.now(),
            blank: true,
            canWrite: true,
          }, replace)
        },
        hydrateCatalog: async (catalog: WorkbenchCatalog, paneIds: readonly SessionId[]) => {
          if (isDisposed()) return
          ctx.sessions.setBaseRuntimeTarget?.(catalog.activeRuntime)
          await Promise.allSettled(paneIds.flatMap((id) => {
            const item = catalog.items.find(candidate => candidate.sessionId === id)
            return item === undefined || ctx.sessions.ensureSession === undefined
              ? []
              : [ctx.sessions.ensureSession(item.runtime, id)]
          }))
          if (!disposed) viewport.markCatalogReady()
        },
        markCatalogReady: () => { if (!disposed) viewport.markCatalogReady() },
        setMode: (mode: 'single' | 'workbench') => { viewport.setMode(mode) },
        resources: ctx.get('workspaceResources'),
        workspaceRemote: connection?.isLoopback === false,
        // Root slot inject faces are cached for the registration lifetime by
        // the Cordis renderer.  Keep the owner as a getter so a pane switch
        // cannot leave Workspace browsing bound to the first active Session.
        workspaceResourceOwner: () => {
          const sessionId = viewport.snapshot.getSnapshot().activePaneId
          if (sessionId === undefined) return undefined
          return { sessionId, runtimeTarget: ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const } }
        },
        openWorkspaceResource: (request: WorkspaceResourceOpenRequest) => {
          ctx.slots.bindStore(chooser).actions.openPreview(request)
        },
        listWorkspaceDirectory: async (path: string, signal: AbortSignal) => {
          if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection is unavailable')
          const owner = viewport.snapshot.getSnapshot().activePaneId
          if (owner === undefined) throw new WorkspaceResourceError('workspace-file/unknown-session', 'No active Workspace Session')
          const target = ctx.sessions.runtimeTargetFor?.(owner)
          const targetConnection = target === undefined ? connection : connection.forTarget?.(target)
          if (targetConnection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
          const response = await targetConnection.api.workspaceFiles.list({ sessionId: owner, path }, signal)
          if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
          return response.result.value
        },
        readPreview: async (
          request: { resource: WorkspaceResourceOpenRequest; offset: number; version: string }, signal: AbortSignal,
        ) => {
          if (connection === undefined) throw new Error('Workspace file preview requires a connection')
          const { runtimeTarget, sessionId, path } = request.resource
          const targetConnection = runtimeTarget.kind === 'base'
            ? connection
            : connection.forTarget?.(runtimeTarget)
          if (targetConnection === undefined) {
            throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
          }
          const response = await targetConnection.api.workspaceFiles.read(
            { sessionId, path, offset: request.offset, version: request.version }, signal,
          )
          if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
          return response.result.value
        },
        readBytesPreview: async (
          request: { resource: WorkspaceResourceOpenRequest; offset: number; length: number; version: string }, signal: AbortSignal,
        ) => {
          if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection requires a live runtime')
          const { runtimeTarget, sessionId, path } = request.resource
          const targetConnection = runtimeTarget.kind === 'base' ? connection : connection.forTarget?.(runtimeTarget)
          if (targetConnection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
          const response = await targetConnection.api.workspaceFiles.readBytes(
            { sessionId, path, offset: request.offset, length: request.length, version: request.version }, signal,
          )
          if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
          return response.result.value
        },
      }
    },
  }, WorkbenchToolbar))
  ctx.slots.inject('conversation.workbench.empty', () => ctx.slots.register({
    name: 'conversation.workbench.empty', locale: NS, store: chooser,
  }, WorkbenchEmpty))
  ctx.slots.inject('conversation.workbench.pane.header', () => ctx.slots.register({
    name: 'conversation.workbench.pane.header',
    id: 'workbench-pane-header',
    locale: NS,
    inject: (sessionId: SessionId) => ({
      replacePane: () => {
        viewport.focus(sessionId)
        ctx.slots.bindStore(chooser).actions.openPicker(true)
      },
      movePane: (direction: 'previous' | 'next') => { viewport.move(sessionId, direction) },
    }),
  }, WorkbenchPaneHeader))
}
