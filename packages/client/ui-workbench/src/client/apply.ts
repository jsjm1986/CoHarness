/** Contributes workbench controls without importing the conversation renderer. */
import { WorkspaceResourceError, clientSessionKey, runtimeTargetKey, commitSessionNavigation, parseClientSessionKey, parseWorkspaceResourceAddress, resolveWorkspacePath, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest, WorkspaceResourceSource, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, ConversationViewport, ProjectUiPolicySnapshot, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { parseWorkbenchCatalog, type WorkbenchCatalog } from './catalog.ts'
import type { LegacyWorkbenchRestore, WorkbenchRestoreOptions } from './layout-restore.ts'
import { WorkbenchEmpty } from './components/WorkbenchEmpty.tsx'
import { WorkbenchPaneHeader } from './components/WorkbenchPaneHeader.tsx'
import { WorkbenchSidebar, type WorkbenchSidebarInjected } from './components/WorkbenchSidebar.tsx'
import { WorkbenchToolbar } from './components/WorkbenchToolbar.tsx'
import { createWorkbenchStore, type WorkspaceBrowserOwner } from './stores.ts'
import { en as pdfEn, zh as pdfZh } from './pdf/locales.ts'
import { en as officeEn, zh as officeZh } from './office/locales.ts'
import { en as markdownEn, zh as markdownZh } from './markdown/locales.ts'
import { en as htmlEn, zh as htmlZh } from './html/locales.ts'
import { en as excelEn, zh as excelZh } from './excel/locales.ts'
import { Config } from '../config.ts'
import { createReadHtmlRelative } from './contract/html/read-relative.ts'
import { packHtml } from './contract/html/pack.ts'
import { createHtmlDocument } from './html/bootstrap.ts'
import { en, NS, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkspaceFileTab } from './components/WorkspaceFileTab.tsx'
import { WorkspaceFileTitle } from './components/WorkspaceFileTitle.tsx'
import { createWorkspacePreviewReaders } from './preview-readers.ts'

/** Required Cordis capabilities; slot declarations may arrive in either order. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'conversationViewport', 'sidebarRight', 'sidebarRightTabs', 'layout', 'workspaceResources', 'deploymentContext']

function controller(ctx: ClientContext): ConversationViewport {
  const viewport = ctx.get('conversationViewport')
  if (viewport === undefined) throw new Error('ui-workbench requires the conversation viewport capability')
  return viewport
}

/** Personal-scope policy placeholder while the projectUiPolicy service is absent. */
const ABSENT_PROJECT_POLICY_SNAPSHOT: ProjectUiPolicySnapshot = Object.freeze({
  scope: 'personal', theme: 'follow-user', revision: 0, accountPermissions: 'unknown',
})
const ABSENT_PROJECT_POLICY = {
  getSnapshot: (): ProjectUiPolicySnapshot => ABSENT_PROJECT_POLICY_SNAPSHOT,
  subscribe: () => () => {},
}

/** Optional workbench management methods contributed onto the conversation viewport. */
type WorkbenchViewport = ConversationViewport & {
  reconcileSessionKeys?: (resolve: (id: SessionId, version: 2 | 3) => SessionId | undefined) => void
  sessionKeyVersion?: () => 2 | 3
  needsCatalogRestore?: () => boolean
  listWorkbenches?: () => readonly { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }[]
  currentWorkbench?: () => { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }
  createWorkbench?: (name: string) => string
  renameWorkbench?: (id: string, name: string) => void
  duplicateWorkbench?: (id: string, name: string) => string
  deleteWorkbench?: (id: string) => void
  switchWorkbench?: (id: string) => void
}

/** Compare executable Runtime identities; display names do not identify a resource owner. */
function sameResourceRuntime(first: WorkspaceResourceTarget, second: WorkspaceResourceTarget): boolean {
  if (first.kind === 'base' || second.kind === 'base') return first.kind === second.kind
  return runtimeTargetKey(first) === runtimeTargetKey(second)
}

/** Mount the workbench's slot contributions and localized controls.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  const viewport = controller(ctx)
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const config = Config((globalThis as { __DSH_WORKBENCH_CONFIG__?: unknown }).__DSH_WORKBENCH_CONFIG__ ?? {})
  const chooser = createWorkbenchStore()
  const lifetime = new AbortController()
  let restoreOperation: AbortController | undefined
  let disposed = false
  const isDisposed = (): boolean => disposed
  ctx.effect(() => () => { disposed = true; lifetime.abort() }, 'ui-workbench: pending navigation lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workbench: dictionaries')
  ctx.effect(() => ctx.locale.register('sidebarPdf', { zh: pdfZh, en: pdfEn }))
  ctx.effect(() => ctx.locale.register('sidebarOffice', { zh: officeZh, en: officeEn }))
  ctx.effect(() => ctx.locale.register('sidebarMarkdown', { zh: markdownZh, en: markdownEn }))
  ctx.effect(() => ctx.locale.register('sidebarHtml', { zh: htmlZh, en: htmlEn }))
  ctx.effect(() => ctx.locale.register('sidebarExcel', { zh: excelZh, en: excelEn }), 'ui-workbench: excel dictionaries')
  const openResource = (request: WorkspaceResourceOpenRequest): void => {
    const target = ctx.sessions.runtimeTargetFor?.(request.sessionId) ?? { kind: 'base' as const }
    if (!sameResourceRuntime(target, request.runtimeTarget)) {
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
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: 'workspace-file' },
    WorkspaceFileTitle,
  ))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: 'workspace-file', locale: NS,
    inject: (sessionId) => {
      const runtimeTarget = () => ctx.sessions.runtimeTargetFor?.(sessionId) ?? { kind: 'base' as const }
      const sourceFor = (address: string): WorkspaceResourceSource | undefined => {
        // The empty key is a hidden tab: no source, no subscription.
        if (address === '') return undefined
        const parsed = parseWorkspaceResourceAddress(address)
        if (parsed === undefined || parsed.sessionId !== sessionId) return undefined
        return ctx.workspaceResources.source({
          sessionId, path: parsed.path,
          address: workspaceResourceAddress(sessionId, parsed.path),
          runtimeTarget: runtimeTarget(),
        })
      }
      // The authorized native-open path, mirroring the conversation's openFile
      // gate: only a base loopback Host that declares canOpenPath can hand the
      // Workspace path to a native desktop. The capability is re-read per call
      // so a post-mount handshake or reconnect flips the action's visibility.
      const nativeCapable = (): boolean => {
        const description = connection?.hostDescription.getSnapshot()
        return connection !== undefined && connection.isLoopback
          && runtimeTarget().kind === 'base'
          && description?.executionAuthorityRequired === false && description.canOpenPath
      }
      return {
        ...createWorkspacePreviewReaders(connection),
        pdfT: ctx.locale.bind('sidebarPdf'),
        officeT: ctx.locale.bind('sidebarOffice'),
        markdownT: ctx.locale.bind('sidebarMarkdown'),
        htmlT: ctx.locale.bind('sidebarHtml'),
        excelT: ctx.locale.bind('sidebarExcel'),
        excelLimits: config.excel,
        keyedHooks: { workspaceResource: sourceFor },
        reloadResource: request => ctx.workspaceResources.source(request).reload(),
        revokeResource: (request, message) => {
          ctx.workspaceResources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', message))
        },
        nativeOpenAvailable: nativeCapable,
        openNativePath: async (request) => {
          const target = runtimeTarget()
          if (!sameResourceRuntime(target, request.runtimeTarget)) {
            throw new WorkspaceResourceError('access-revoked', 'Workspace resource runtime no longer owns this Session')
          }
          if (!nativeCapable()) throw new Error('native path opening is unavailable in this application')
          const cwd = ctx.sessions.list.getSnapshot().byId[request.sessionId]?.cwd
          await ctx.workspaces.openPath(resolveWorkspacePath(cwd, request.path))
        },
        renderHtml: async (data, read, request, lifetime, signal) =>
          createHtmlDocument(await packHtml(data, createReadHtmlRelative(read, request, lifetime), signal)),
        runtimeTarget,
      }
    },
  }, WorkspaceFileTab))
  ctx.on('workspace/resource-open', (request) => {
    if (ctx.get('workspaceResources')?.hasProvider(request.runtimeTarget) !== true || connection === undefined) return
    openResource(request)
    return true
  })
  const openVerifiedPane = async (id: SessionId, replace: boolean, signal: AbortSignal) => {
    let result: ReturnType<ConversationViewport['add']> = { ok: false, reason: 'unknown' }
    await commitSessionNavigation(ctx.sessions, id, signal, () => {
      if (disposed || viewport.snapshot.getSnapshot().pendingIdentity) return
      result = replace ? viewport.replaceActive(id) : viewport.add(id)
    })
    return result
  }
  const chooseSession = async (item: import('./catalog.ts').WorkbenchConversation, replace: boolean, navigation = ctx.sessions.beginNavigation()) => {
    const original = item.sessionId
    const id = ctx.sessions.keyFor?.(original, item.runtime) ?? original
    const current = viewport.snapshot.getSnapshot()
    if (current.pendingIdentity === true) return { ok: false as const, reason: 'unknown' as const }
    if (!replace && current.paneIds.length >= 4 && !current.paneIds.includes(id)) {
      return { ok: false as const, reason: 'limit' as const }
    }
    if (ctx.sessions.usingRuntime === undefined) return { ok: false as const, reason: 'unknown' as const }
    return ctx.sessions.usingRuntime(item.runtime, AbortSignal.any([navigation, lifetime.signal]), async (signal) => {
      const available = await ctx.sessions.ensureSession?.(item.runtime, original, signal)
      if (disposed || navigation.aborted || available !== true) return { ok: false as const, reason: 'unknown' as const }
      return openVerifiedPane(id, replace, signal)
    })
  }
  // The files entry appears wherever the toolbar hosts a Session: the toolbar
  // row above the workbench grid and the Session header's leading seat in the
  // single-conversation view. Provider availability follows runtime connection
  // state, so evaluate it at render time instead of freezing it into the
  // inject face.
  const filesAvailable = (sessionId: SessionId) => () =>
    (ctx.sessions.runtimeIdentityFor === undefined || ctx.sessions.runtimeIdentityFor(sessionId) !== undefined)
    &&
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
      const gatewayEntries = ctx.get('gatewayEntryRequests')
      return {
        hooks: { deployment: ctx.deploymentContext },
        ...(gatewayEntries === undefined ? {} : { catalogAuthority: gatewayEntries.catalogAuthority, moreComputers: (signal: AbortSignal) => gatewayEntries.moreComputers(signal),
          readProjectDisplay: (scope: string, signal: AbortSignal) => gatewayEntries.selectedProjectDisplay(scope, signal),
          readCatalog: async (signal: AbortSignal, visible?: { scope?: string; q?: string; cursor?: string }) =>
            parseWorkbenchCatalog(await gatewayEntries.catalog(signal, visible)) }),
        listWorkbenches: () => wb.listWorkbenches?.() ?? [],
        currentWorkbench: () => wb.currentWorkbench?.(),
        createWorkbench: (name: string) => wb.createWorkbench?.(name) ?? '',
        renameWorkbench: (id: string, name: string) => { wb.renameWorkbench?.(id, name) },
        duplicateWorkbench: (id: string, name: string) => wb.duplicateWorkbench?.(id, name) ?? '',
        deleteWorkbench: (id: string) => { wb.deleteWorkbench?.(id) },
        switchWorkbench: (id: string) => { wb.switchWorkbench?.(id) },
        chooseSession: (item: import('./catalog.ts').WorkbenchConversation, replace: boolean, signal?: AbortSignal) =>
          chooseSession(item, replace, AbortSignal.any([ctx.sessions.beginNavigation(), ...(signal === undefined ? [] : [signal])])),
        focusSession: (id: SessionId) => { viewport.focus(id) },
        createSession: async (target: SessionRuntimeTarget, replace: boolean, signal?: AbortSignal) => {
          signal?.throwIfAborted()
          if (viewport.snapshot.getSnapshot().pendingIdentity === true) return { ok: false as const, reason: 'unknown' as const }
          // Enforce capacity before creating a Session; recheck after the async
          // create in case another navigation filled the last slot meanwhile.
          if (!replace && viewport.snapshot.getSnapshot().paneIds.length >= 4) return { ok: false as const, reason: 'limit' as const }
          const navigation = AbortSignal.any([ctx.sessions.beginNavigation(), ...(signal === undefined ? [] : [signal])])
          if (ctx.sessions.usingRuntime === undefined) return { ok: false as const, reason: 'unknown' as const }
          return ctx.sessions.usingRuntime(target, AbortSignal.any([navigation, lifetime.signal]), async (signal) => {
            const id = await ctx.workspaces.createRuntimeSession?.(target, undefined, signal)
            if (id === undefined || disposed || signal.aborted) return { ok: false as const, reason: 'unknown' as const }
            const address = parseClientSessionKey(id)
            if (address ? runtimeTargetKey(address.runtime) !== runtimeTargetKey(target) : target.runtimeId !== undefined) {
              return { ok: false as const, reason: 'unknown' as const }
            }
            return openVerifiedPane(id, replace, signal)
          })
        },
        hydrateCatalog: async (catalog: WorkbenchCatalog, paneIds: readonly SessionId[],
          options: WorkbenchRestoreOptions = {}): Promise<LegacyWorkbenchRestore | undefined> => {
          if (isDisposed()) return
          restoreOperation?.abort()
          restoreOperation = new AbortController()
          const signal = AbortSignal.any([lifetime.signal, restoreOperation.signal,
            ...(options.signal === undefined ? [] : [options.signal])])
          signal.throwIfAborted()
          ctx.sessions.setBaseRuntimeTarget?.(catalog.activeRuntime)
          const workbench = viewport as WorkbenchViewport
          if (workbench.needsCatalogRestore?.() === false) { viewport.markCatalogReady(); return }
          const version = workbench.sessionKeyVersion?.()
          const workbenchId = workbench.currentWorkbench?.().id
          if (options.selection !== undefined && options.selection.workbenchId !== workbenchId) return
          const ids = version === undefined ? paneIds : version === 2
            ? workbench.currentWorkbench?.().paneIds ?? [] : viewport.snapshot.getSnapshot().paneIds
          const allIds = version === 2 ? [...new Set(workbench.listWorkbenches?.().flatMap(row => row.paneIds) ?? ids)] : ids
          const candidatesFor = (id: SessionId, encoding: 2 | 3 | undefined) => {
            const rows = catalog.items.filter(candidate =>
              encoding === 2 || (encoding === undefined && parseClientSessionKey(id) === undefined)
                ? candidate.sessionId === id : clientSessionKey(candidate.runtime, candidate.sessionId) === id)
            if (encoding === 2 && catalog.paged) {
              const targets: SessionRuntimeTarget[] = [...(catalog.personalRuntimes ?? []), ...catalog.projects.flatMap(project =>
                project.runtimeId === undefined ? [] : [{ kind: 'project' as const, ...project, projectName: project.name }])]
              for (const runtime of targets) {
                if (rows.some(row => runtimeTargetKey(row.runtime) === runtimeTargetKey(runtime))) continue
                rows.push({ sessionId: id, runtime, visibility: runtime.kind, creatorUserId: 0, creatorDisplayName: '',
                  blank: false, updatedAt: 0, canWrite: false })
              }
            }
            const candidates = [...new Map(rows.map(row => [clientSessionKey(row.runtime, row.sessionId), row])).values()]
            const chosen = options.selection?.owners[id]
            return encoding !== 2 || chosen === undefined ? candidates : candidates.filter(row =>
              chosen !== null && clientSessionKey(row.runtime, row.sessionId) === chosen)
          }
          if (version === 2) {
            const issues = allIds.flatMap((sessionId) => {
              const candidates = candidatesFor(sessionId, version)
              const chosen = options.selection?.owners[sessionId]
              if (chosen === null || candidates.length === 1 && (chosen !== undefined || catalog.personalComplete)) return []
              return [{ sessionId, candidates }]
            })
            if (issues.length > 0) return { workbenchId, issues }
          }
          const verifyingLegacyOwners = version === 2 && catalog.paged === true && options.selection !== undefined
          if (verifyingLegacyOwners) {
            const activeIds = new Set(ids)
            await Promise.all(allIds.filter(id => !activeIds.has(id)).map(async (id) => {
              const candidate = candidatesFor(id, version)[0]
              if (candidate === undefined || catalog.items.some(row => row.sessionId === id
                && runtimeTargetKey(row.runtime) === runtimeTargetKey(candidate.runtime))) return
              const source = ctx.get('gatewayEntryRequests')
              const target = candidate.runtime
              if (source === undefined || target.runtimeId === undefined) throw new Error('Saved Session owner is unavailable')
              const scope = target.kind === 'project' ? String(target.projectId) : `personal:${target.runtimeId}`
              const found = parseWorkbenchCatalog(await source.catalog(signal, { scope, q: id }))
              if (!found.items.some(row => row.sessionId === id && runtimeTargetKey(row.runtime) === runtimeTargetKey(target))) {
                throw new Error('Saved Session is unavailable in its selected computer directory')
              }
            }))
          }
          const items = ids.flatMap((id) => {
            const candidates = candidatesFor(id, version)
            // Old records without a runtime never choose the first colliding ID.
            const item = candidates.length === 1 ? candidates[0] : undefined
            if (item !== undefined) return [item]
            const address = version === 3 && catalog.paged ? parseClientSessionKey(id) : undefined
            if (address?.runtime.runtimeId === undefined) return []
            // Pinned exact identities authorize their own history even when absent from the current page.
            return [{ ...address, visibility: address.runtime.kind, canWrite: false, creatorUserId: 0, creatorDisplayName: '', blank: false, updatedAt: 0 }]
          })
          const targets = [...new Map(items.map(item => [runtimeTargetKey(item.runtime), item.runtime])).values()]
          const restore = async (): Promise<void> => {
            const unavailable = new Set<SessionId>()
            const denied = new Set<SessionId>()
            const checking = new Map<SessionId, 'checking' | 'unavailable'>()
            const current = (): boolean => !signal.aborted && !disposed && workbench.currentWorkbench?.().id === workbenchId
              && workbench.sessionKeyVersion?.() === version
            const publish = (): void => { if (version === 3 && current()) viewport.setPaneVerification?.(Object.fromEntries(checking)) }
            if (verifyingLegacyOwners || viewport.snapshot.getSnapshot().mode === 'workbench') {
              for (const id of ids) checking.set(id, 'checking')
              publish()
              await Promise.all(items.map(async (item) => {
                const key = ctx.sessions.keyFor?.(item.sessionId, item.runtime) ?? item.sessionId
                try {
                  if (await ctx.sessions.ensureSession?.(item.runtime, item.sessionId, signal) !== true) denied.add(key)
                } catch (error) {
                  if (error instanceof WorkspaceResourceError && error.code === 'access-revoked'
                    || error instanceof Error && 'status' in error && (error.status === 401 || error.status === 403)) denied.add(key)
                  else unavailable.add(key)
                }
                if (denied.has(key) || unavailable.has(key)) checking.set(key, 'unavailable')
                else checking.delete(key)
                publish()
              }))
            }
            if (current()) {
              if (version === 2 && catalog.paged && (denied.size || unavailable.size)) throw new Error('Selected Session owner could not be verified')
              workbench.reconcileSessionKeys?.((id, version) => {
                if (version === 3 && catalog.paged
                  && parseClientSessionKey(id)?.runtime.runtimeId !== undefined) return denied.has(id) ? undefined : id
                const matches = candidatesFor(id, version)
                const item = matches.length === 1 ? matches[0] : undefined
                if (matches.length === 0 && version === 3 && !catalog.personalComplete
                  && parseClientSessionKey(id)?.runtime.kind === 'personal'
                  && (catalog.personalRuntimes === undefined || catalog.personalRuntimes.some(target =>
                    target.runtimeId === parseClientSessionKey(id)?.runtime.runtimeId))) {
                  unavailable.add(id)
                  return id
                }
                const key = item === undefined ? undefined : ctx.sessions.keyFor?.(item.sessionId, item.runtime) ?? item.sessionId
                return key === undefined || denied.has(key) ? undefined : key
              })
              viewport.markCatalogReady(unavailable)
              if (version === 3) viewport.setPaneVerification?.(Object.fromEntries([...unavailable].map(id => [id, 'unavailable'])))
            }
          }
          const hold = async (index: number): Promise<void> => {
            const target = targets[index]
            if (target === undefined) return restore()
            if (ctx.sessions.usingRuntime === undefined) throw new Error('Runtime discovery requires an owned runtime operation')
            return ctx.sessions.usingRuntime(target, signal, () => hold(index + 1))
          }
          await hold(0)
        },
        catalogUnavailable: () => {
          if (!disposed && connection?.hostDescription.getSnapshot()?.executionAuthorityRequired === false) viewport.markCatalogReady()
        },
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
      hooks: {
        viewport: viewport.snapshot,
        // Row tiles resolve the same per-pane steward tone as the pane header.
        projectPolicy: ctx.get('projectUiPolicy') ?? ABSENT_PROJECT_POLICY,
      },
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
      // The pane's steward tone follows its own session runtime, read from the
      // roster mirror — the page's active scope never applies to a pane.
      hooks: { projectPolicy: ctx.get('projectUiPolicy') ?? ABSENT_PROJECT_POLICY, deployment: ctx.deploymentContext },
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
