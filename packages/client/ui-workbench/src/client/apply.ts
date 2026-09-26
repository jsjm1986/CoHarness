/** Contributes workbench controls without importing the conversation renderer. */
import { WorkspaceResourceError, commitSessionNavigation, parseWorkspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, ConversationViewport, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkbenchCatalog } from './catalog.ts'
import { WorkbenchEmpty } from './components/WorkbenchEmpty.tsx'
import { WorkbenchPaneHeader } from './components/WorkbenchPaneHeader.tsx'
import { WorkbenchSidebar, type WorkbenchSidebarInjected } from './components/WorkbenchSidebar.tsx'
import { WorkbenchToolbar } from './components/WorkbenchToolbar.tsx'
import { createWorkbenchStore, type WorkspaceBrowserOwner } from './stores.ts'
import { en as pdfEn, zh as pdfZh } from './pdf/locales.ts'
import { en as officeEn, zh as officeZh } from './office/locales.ts'
import { en as markdownEn, zh as markdownZh } from './markdown/locales.ts'
import { en as htmlEn, zh as htmlZh } from './html/locales.ts'
import { createReadHtmlRelative } from './html/read-relative.ts'
import { packHtml } from './html/pack.ts'
import { createHtmlDocument } from './html/bootstrap.ts'
import { FontNotice } from './office/FontNotice.tsx'
import { en, NS, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkspaceFileTab } from './components/WorkspaceFileTab.tsx'
import { createWorkspacePreviewReaders } from './preview-readers.ts'

/** Required Cordis capabilities; slot declarations may arrive in either order. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversationViewport', 'sidebarRight', 'sidebarRightTabs', 'layout', 'workspaceResources']

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
  const lifetime = new AbortController()
  let disposed = false
  const isDisposed = (): boolean => disposed
  ctx.effect(() => () => { disposed = true; lifetime.abort() }, 'ui-workbench: pending navigation lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workbench: dictionaries')
  ctx.effect(() => ctx.locale.register('sidebarPdf', { zh: pdfZh, en: pdfEn }))
  ctx.effect(() => ctx.locale.register('sidebarOffice', { zh: officeZh, en: officeEn }))
  ctx.effect(() => ctx.locale.register('sidebarMarkdown', { zh: markdownZh, en: markdownEn }))
  ctx.effect(() => ctx.locale.register('sidebarHtml', { zh: htmlZh, en: htmlEn }))
  const openResource = (request: WorkspaceResourceOpenRequest): void => {
    const target = ctx.sessions.runtimeTargetFor?.(request.sessionId) ?? { kind: 'base' as const }
    if (target.kind !== request.runtimeTarget.kind || (target.kind === 'project' && request.runtimeTarget.kind === 'project' && target.projectId !== request.runtimeTarget.projectId)) {
      throw new WorkspaceResourceError('access-revoked', 'Workspace resource runtime no longer owns this Session')
    }
    ctx.sidebarRight.openSessionResource(request.sessionId, request.address, {
      kind: 'workspace-file', ...(request.line === undefined ? {} : { params: { line: request.line } }),
    })
    ctx.layout.focusRightbar(request.sessionId)
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'workspace-file', kind: 'workspace-file', priority: 'fallback',
    patterns: ['dsh-resource://file/**'],
    canOpen: address => parseWorkspaceResourceAddress(address) !== undefined,
    title: address => parseWorkspaceResourceAddress(address)?.path ?? address,
  }), 'ui-workbench: workspace file tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'workspace-file', locale: NS,
    inject: sessionId => ({
      ...createWorkspacePreviewReaders(connection),
      pdfT: ctx.locale.bind('sidebarPdf'),
      officeT: ctx.locale.bind('sidebarOffice'),
      markdownT: ctx.locale.bind('sidebarMarkdown'),
      htmlT: ctx.locale.bind('sidebarHtml'),
      resources: ctx.workspaceResources,
      renderHtml: async (data, read, request, lifetime, signal) =>
        createHtmlDocument(await packHtml(data, createReadHtmlRelative(read, request, lifetime), signal)),
      fontNotice: FontNotice,
      runtimeTarget: () => ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const },
    }),
  }, WorkspaceFileTab))
  ctx.on('workspace/resource-open', (request) => {
    if (ctx.get('workspaceResources')?.hasProvider(request.runtimeTarget) !== true || connection === undefined) return
    openResource(request)
    return true
  })
  const chooseSession = async (item: import('./catalog.ts').WorkbenchConversation, replace: boolean, navigation = ctx.sessions.beginNavigation()) => {
    const current = viewport.snapshot.getSnapshot()
    if (!replace && current.paneIds.length >= 4 && !current.paneIds.includes(item.sessionId)) {
      return { ok: false as const, reason: 'limit' as const }
    }
    const available = await ctx.sessions.ensureSession?.(item.runtime, item.sessionId)
    if (disposed || navigation.aborted || available !== true) return { ok: false as const, reason: 'unknown' as const }
    let result: ReturnType<ConversationViewport['add']> = { ok: false, reason: 'unknown' }
    await commitSessionNavigation(ctx.sessions, item.sessionId, AbortSignal.any([navigation, lifetime.signal]), () => {
      result = replace ? viewport.replaceActive(item.sessionId) : viewport.add(item.sessionId)
    })
    return result
  }
  // The files entry appears wherever the toolbar hosts a Session: the toolbar
  // row above the workbench grid and the Session header's leading seat in the
  // single-conversation view. Provider availability follows runtime connection
  // state, so evaluate it at render time instead of freezing it into the
  // inject face.
  const filesAvailable = (sessionId: SessionId) => () =>
    connection?.isLoopback === false
    && ctx.get('workspaceResources')?.hasProvider(ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const }) === true
  const openFiles = (sessionId: SessionId) => () => {
    ctx.slots.bindStore(chooser).actions.openBrowser({
      sessionId,
      runtimeTarget: ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const },
    })
  }
  const activeSessionId = (): SessionId | undefined => {
    const snap = viewport.snapshot.getSnapshot()
    return snap.mode === 'workbench'
      ? (snap.activePaneId ?? snap.paneIds[0])
      : ctx.sessions.list.getSnapshot().current
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
          const navigation = ctx.sessions.beginNavigation()
          const id = await ctx.sessions.createSession?.(target)
          if (id === undefined) return { ok: false as const, reason: 'unknown' as const }
          return disposed || navigation.aborted ? { ok: false as const, reason: 'unknown' as const } : chooseSession({
            sessionId: id,
            runtime: target,
            visibility: target.kind === 'personal' ? 'personal' : 'project',
            creatorUserId: 0,
            creatorDisplayName: '',
            updatedAt: Date.now(),
            blank: true,
            canWrite: true,
          }, replace, navigation)
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
        filesAvailable: () => {
          const sessionId = activeSessionId()
          return sessionId !== undefined && filesAvailable(sessionId)()
        },
        openFiles: () => {
          const sessionId = activeSessionId()
          if (sessionId !== undefined) openFiles(sessionId)()
        },
        openWorkspaceResource: (request: WorkspaceResourceOpenRequest) => {
          openResource(request)
        },
        listWorkspaceDirectory: async (owner: WorkspaceBrowserOwner, path: string, signal: AbortSignal) => {
          if (connection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace connection is unavailable')
          const targetConnection = owner.runtimeTarget.kind === 'base'
            ? connection
            : connection.forTarget?.(owner.runtimeTarget)
          if (targetConnection === undefined) throw new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable')
          const response = await targetConnection.api.workspaceFiles.list({ sessionId: owner.sessionId, path }, signal)
          if (!response.result.ok) throw new WorkspaceResourceError(response.result.error.code, response.result.error.message)
          return response.result.value
        },

      }
    },
  }, WorkbenchToolbar))
  ctx.slots.inject('conversation.workbench.empty', () => ctx.slots.register({
    name: 'conversation.workbench.empty', locale: NS, store: chooser,
  }, WorkbenchEmpty))
  // The sidebar panel shares the chooser store: its Add action opens the
  // toolbar's picker dialog through the same bound handle.
  ctx.slots.inject('sidebar.workspaces.workbench', () => ctx.slots.register({
    name: 'sidebar.workspaces.workbench',
    locale: NS,
    store: chooser,
    children: {
      'conversation.workbench.display': { kind: 'single', scope: 'root' },
    },
    inject: (): WorkbenchSidebarInjected => ({
      hooks: { viewport: viewport.snapshot },
      focusPane: (sessionId) => { viewport.focus(sessionId) },
      removePane: (sessionId) => { viewport.remove(sessionId) },
      setPaneRatios: (ratios) => { viewport.setPaneRatios(ratios) },
      exitWorkbench: () => { viewport.setMode('single') },
    }),
  }, WorkbenchSidebar))
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
      filesAvailable: filesAvailable(sessionId),
      openFiles: openFiles(sessionId),
    }),
  }, WorkbenchPaneHeader))
}
