import { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-client-runtime/client'
/** Workbench controls, Workspace/session chooser, and compact pane tabs. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconChevronDownOutline14, IconCopyOutline16, IconEditOutline16, IconFolderOpenOutline16, IconLogoutOutline16,
  IconPlusOutline16, IconSplitPanesOutline16, IconTrashOutline16, IconWarningOutline16, Menu, Modal, relativeTime, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchLayoutPreset } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AddPaneResult, ConversationViewportMode, DeploymentContextSnapshot, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { createWorkbenchStore } from '../stores.ts'
import { NS } from '../locales.ts'
import { loadWorkbenchCatalog, type WorkbenchCatalog, type WorkbenchConversation } from '../catalog.ts'
import type { LegacyWorkbenchRestore, WorkbenchRestoreOptions } from '../layout-restore.ts'
import { ScopeTile } from './ScopeTile.tsx'
import css from './Workbench.module.css'
import { WorkspaceFileBrowser, type ListWorkspaceDirectory, type OpenWorkspaceResource } from './WorkspaceFileBrowser.tsx'

/** Initial and user-requested increments of visible chooser rows. */
const CONVERSATION_PAGE_SIZE = 50
const stableAuthority = { subscribe: () => () => {}, getSnapshot: () => 0 }

interface Actions {
  catalogAuthority?: { subscribe(notify: () => void): () => void; getSnapshot(): number }
  readProjectDisplay?: (scope: string, signal: AbortSignal) => Promise<{ projectId: number; name: string } | undefined>
  moreComputers?: (signal: AbortSignal) => Promise<void>
  readCatalog?: (signal: AbortSignal, visible?: { scope?: string; q?: string; cursor?: string }) => Promise<WorkbenchCatalog>
  listWorkbenches?: () => readonly { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }[]
  currentWorkbench?: () => { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number } | undefined
  createWorkbench?: (name: string) => string
  renameWorkbench?: (id: string, name: string) => void
  duplicateWorkbench?: (id: string, name: string) => string
  deleteWorkbench?: (id: string) => void
  switchWorkbench?: (id: string) => void
  chooseSession: (item: WorkbenchConversation, replace: boolean, signal?: AbortSignal) => Promise<AddPaneResult>
  focusSession: (id: SessionId) => void
  createSession: (target: SessionRuntimeTarget, replace: boolean, signal?: AbortSignal) => Promise<AddPaneResult>
  hydrateCatalog?: (
    catalog: WorkbenchCatalog, paneIds: readonly SessionId[], options?: WorkbenchRestoreOptions,
  ) => Promise<LegacyWorkbenchRestore | void>
  catalogUnavailable?: () => void
  setMode: (mode: ConversationViewportMode) => void
  listWorkspaceDirectory?: ListWorkspaceDirectory
  openWorkspaceResource?: OpenWorkspaceResource
  /** Provider availability for the addressed Session's runtime, evaluated at render time. */
  filesAvailable?: (() => boolean) | undefined
  /** Open the Workspace file browser for the active Session and runtime target. */
  openFiles?: (() => void) | undefined
}
type Props = PropsRuntime<'conversation.workbench.toolbar'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createWorkbenchStore>> & Actions
  & PropsHooks<{ deployment: HostObservable<DeploymentContextSnapshot> }>

function conversationDisplayName(item: WorkbenchConversation, untitled: string): string {
  const title = item.title?.trim()
  if (title !== undefined && title !== '') return title
  const date = new Date(item.updatedAt)
  /* v8 ignore next -- conversation timestamps are always finite epoch millis */
  if (Number.isNaN(date.getTime())) return untitled
  return `${untitled} · ${date.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })}`
}

/** Render compact controls and a bounded session picker.
 * @param props - root runtime/store props and viewport actions.
 * @returns the toolbar and its controlled picker dialog.
 */
export function WorkbenchToolbar({
  viewport, tabbed, inline = false, layout, onSelectLayout, toolsHostId, useStore, actions, useSessions, useWorkspaces, useDeployment,
  chooseSession, focusSession, createSession, hydrateCatalog, readCatalog, readProjectDisplay, moreComputers, catalogAuthority, catalogUnavailable, setMode,
  listWorkbenches, currentWorkbench, switchWorkbench, createWorkbench, renameWorkbench,
  duplicateWorkbench, deleteWorkbench,
  listWorkspaceDirectory, openWorkspaceResource, filesAvailable, openFiles, t,
}: Props) {
  const { pickerOpen, replace, browser, workbenchMenuOpen } = useStore(state => state)
  const sessions = useSessions(s => s)
  const workspaces = useWorkspaces(s => s)
  const deployment = useDeployment(value => value)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(CONVERSATION_PAGE_SIZE)
  const [continuation, setContinuation] = useState<{ scope: string; query: string; cursor: string }>()
  const [workspace, setWorkspace] = useState('')
  const [chosenProject, setChosenProject] = useState<Pick<WorkbenchCatalog['projects'][number], 'projectId' | 'runtimeId' | 'nodeId'>>()
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  /** Non-focused panes asking for attention: pending interaction, in pane order. */
  const attentionPanes = viewport.mode === 'workbench'
    ? viewport.paneIds.filter(id => id !== (viewport.activePaneId ?? viewport.paneIds[0])
        && sessions.byId[id]?.pendingInteraction !== undefined)
    : []
  const now = Date.now()
  const [workbenchDialog, setWorkbenchDialog] = useState<'create' | 'rename' | 'duplicate' | undefined>()
  const [deleteWorkbenchOpen, setDeleteWorkbenchOpen] = useState(false)
  const [workbenchName, setWorkbenchName] = useState('')
  const authority = catalogAuthority ?? stableAuthority
  const revision = useSyncExternalStore(authority.subscribe, authority.getSnapshot, authority.getSnapshot)
  const [receivedCatalog, setCatalog] = useState<WorkbenchCatalog | undefined>()
  const [receivedRevision, setReceivedRevision] = useState(revision)
  const catalog = revision === receivedRevision ? receivedCatalog : undefined
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [catalogPhase, setCatalogPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pending, setPending] = useState(false)
  const pendingOperation = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { pendingOperation.current?.abort() }, [revision])
  const [error, setError] = useState<string | undefined>()
  const [legacyRestore, setLegacyRestore] = useState<LegacyWorkbenchRestore>()
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restoreOwners, setRestoreOwners] = useState<Record<string, string>>({})
  const [restorePending, setRestorePending] = useState(false)
  const [restoreError, setRestoreError] = useState<string>()
  const restoreRequest = useRef<AbortController | undefined>(undefined)
  const activeWorkbenchId = currentWorkbench?.()?.id
  const wasOpen = useRef(false)
  useEffect(() => {
    restoreRequest.current?.abort()
    restoreRequest.current = undefined
    setRestorePending(false)
    setRestoreOpen(false)
    setRestoreOwners({})
  }, [activeWorkbenchId])
  useEffect(() => () => { restoreRequest.current?.abort(); restoreRequest.current = undefined }, [])
  useEffect(() => { setVisibleCount(CONVERSATION_PAGE_SIZE); setContinuation(undefined) }, [pickerOpen, query, workspace, revision])
  const paged = readCatalog !== undefined && (catalog === undefined || catalog.paged === true)
  const remoteScope = paged ? workspace : ''
  const remoteQuery = paged ? query : ''
  const remotePage = paged ? continuation : undefined
  useEffect(() => {
    const closing = wasOpen.current && !pickerOpen
    wasOpen.current = pickerOpen
    if (closing) return
    const abort = new AbortController()
    setCatalogPhase('loading')
    const token = pickerOpen && revision === receivedRevision && remotePage?.scope === remoteScope && remotePage.query === remoteQuery
      ? remotePage.cursor : undefined
    const visible = pickerOpen && paged ? { scope: remoteScope, ...(remoteQuery === '' ? {} : { q: remoteQuery }),
      ...(token === undefined ? {} : { cursor: token }) } : undefined
    void (readCatalog === undefined ? loadWorkbenchCatalog(abort.signal) : readCatalog(abort.signal, visible)).then((next) => {
      if (abort.signal.aborted || authority.getSnapshot() !== revision) return
      setReceivedRevision(revision)
      setCatalog((previous) => {
        if (!next.paged || token === undefined || previous === undefined) return next
        const rows = new Map([...previous.items, ...next.items].map(row => [clientSessionKey(row.runtime, row.sessionId), row]))
        return { ...next, items: [...rows.values()] }
      })
      setCatalogPhase('ready')
      if (pickerOpen && next.paged && workspace !== '' && readProjectDisplay) {
        void readProjectDisplay(workspace, abort.signal).then((display) => {
          if (abort.signal.aborted || !display) return
          setCatalog(current => current && { ...current, projects: current.projects.map(row =>
            row.projectId === display.projectId ? { ...row, name: display.name } : row) })
        }).catch(() => {
          // Authorized rows remain usable under the project's number while the owner name is unavailable.
        })
      }
    }, () => {
      if (abort.signal.aborted) return
      if (readCatalog) setCatalog(undefined)
      setCatalogPhase('error')
      catalogUnavailable?.()
    })
    return () => { abort.abort() }
  }, [pickerOpen, catalogAttempt, deployment.context?.revision, remoteScope, remoteQuery, remotePage, revision])
  useEffect(() => () => {
    const request = pendingOperation.current
    pendingOperation.current = undefined
    request?.abort()
  }, [])
  useEffect(() => {
    if (pickerOpen) return
    pendingOperation.current?.abort()
    pendingOperation.current = undefined
    setPending(false)
  }, [pickerOpen])
  const restoredPanes = JSON.stringify(viewport.paneIds)
  useEffect(() => {
    if (catalog === undefined || hydrateCatalog === undefined || restorePending) return
    const abort = new AbortController()
    const runtime = catalog.activeRuntime
    const project = runtime.kind === 'project'
      ? catalog.projects.find(candidate => candidate.projectId === runtime.projectId) : undefined
    const activeRuntime: SessionRuntimeTarget = runtime.kind === 'project' && project !== undefined
      ? { ...runtime, projectName: project.name } : runtime
    void hydrateCatalog({ ...catalog, activeRuntime }, viewport.paneIds, { signal: abort.signal }).then((result) => {
      if (abort.signal.aborted) return
      setLegacyRestore(result || undefined)
      setRestoreError(undefined)
    }, () => { if (!abort.signal.aborted) setRestoreError(t('layoutRestoreError')) })
    return () => { abort.abort() }
  }, [catalog, viewport.mode, restoredPanes, restorePending, activeWorkbenchId])
  const closeRestore = (): void => {
    restoreRequest.current?.abort()
    restoreRequest.current = undefined
    setRestorePending(false)
    setRestoreOpen(false)
  }
  const restoreLayout = (): void => {
    if (catalog === undefined || legacyRestore === undefined || hydrateCatalog === undefined || restorePending) return
    const request = new AbortController()
    restoreRequest.current = request
    const owners = Object.fromEntries(legacyRestore.issues.map(issue => [issue.sessionId,
      restoreOwners[issue.sessionId] === '__remove' ? null : restoreOwners[issue.sessionId] as SessionId]))
    setRestorePending(true)
    setRestoreError(undefined)
    void hydrateCatalog(catalog, viewport.paneIds, { signal: request.signal,
      selection: { workbenchId: legacyRestore.workbenchId, owners } }).then((result) => {
      if (restoreRequest.current !== request) return
      setLegacyRestore(result || undefined)
      if (!result) setRestoreOpen(false)
    }, () => { if (restoreRequest.current === request) setRestoreError(t('layoutRestoreError')) })
      .finally(() => { if (restoreRequest.current === request) { restoreRequest.current = undefined; setRestorePending(false) } })
  }
  const restoreCandidateLabel = (item: WorkbenchConversation): string => {
    const owner = item.runtime.kind === 'personal' ? t('personal') : item.runtime.projectName
    return [owner, deployment.showComputer ? item.runtime.nodeName : undefined, item.runtime.runtimeId?.slice(0, 8)]
      .filter(part => part !== undefined).join(' · ')
  }
  const full = viewport.paneIds.length >= 4 && !replace
  // The root crumb names the owning pane's Workspace so cross-project browsing
  // cannot be mistaken for the active pane's scope.
  const browserSummary = browser === undefined ? undefined : sessions.byId[browser.sessionId]
  const browserScope = browser === undefined ? undefined
    : workspaces.items.find(item => item.sessionIds.includes(browser.sessionId))?.title
      ?? browserSummary?.workspaceName
      ?? (browser.runtimeTarget.kind === 'project' ? browser.runtimeTarget.projectName : undefined)
      ?? (browserSummary?.cwd === undefined ? undefined : workspaceTitleOf(browserSummary.cwd) || browserSummary.cwd)
  const browserLabels = {
    close: t('previewClose'), title: t('files'), root: browserScope ?? t('filesRoot'), up: t('filesUp'),
    loading: t('previewLoading'), empty: t('filesEmpty'), directory: t('filesDirectory'),
    truncated: t('filesTruncated'), error: t('createError'), reload: t('previewReload'),
  }
  const allocatedRuntimes = catalog?.personalRuntimes ?? (catalog?.activeRuntime.kind === 'personal' ? [catalog.activeRuntime] : [{ kind: 'personal' as const }])
  const entryNode = deployment.context?.scope === 'local' ? deployment.context.entry.nodeId : catalog?.activeRuntime.nodeId
  const personalRuntimes = deployment.aggregateComputers ? allocatedRuntimes : allocatedRuntimes.filter(item =>
    entryNode === undefined ? item.runtimeId === catalog?.activeRuntime.runtimeId : item.nodeId === entryNode)
  const personalKey = (runtime: SessionRuntimeTarget): string => runtime.runtimeId === undefined ? 'personal' : `personal:${runtime.runtimeId}`
  const personalLabel = (runtime: SessionRuntimeTarget): string => {
    const name = deployment.showComputer ? runtime.nodeName ?? t('personal') : t('personal')
    return personalRuntimes.filter(item => item.nodeId === runtime.nodeId).length > 1 && runtime.runtimeId !== undefined
      ? `${name} · ${runtime.runtimeId.slice(0, 8)}` : name
  }
  const selectedPersonal = workspace.startsWith('personal:')
    ? personalRuntimes.find(item => personalKey(item) === workspace)
    : workspace === 'personal' && personalRuntimes.length === 1 && personalRuntimes[0]?.runtimeId === undefined
      && !catalog?.moreComputers ? personalRuntimes[0] : undefined
  const selectedProject = workspace === 'personal' || workspace.startsWith('personal:') || workspace === ''
    ? undefined
    : catalog?.projects.find(project => String(project.projectId) === workspace && project.projectId === chosenProject?.projectId
      && (chosenProject.runtimeId === undefined || project.runtimeId === chosenProject.runtimeId)
      && (chosenProject.nodeId === undefined || project.nodeId === chosenProject.nodeId))
  useEffect(() => {
    if (selectedProject?.runtimeId !== undefined && chosenProject?.runtimeId === undefined) setChosenProject(selectedProject)
  }, [selectedProject, chosenProject])
  const creatableScope = (readCatalog === undefined || catalog !== undefined)
    && (selectedPersonal !== undefined || selectedProject !== undefined && selectedProject.mode !== 'ro'
      && (!catalog?.paged || selectedProject.runtimeId !== undefined))
  // `archivedById` merges every pooled runtime's archive set; the Workspace
  // mirror covers a non-pooled runtime whose sessions list keeps archived rows
  // unpartitioned.
  const isArchived = (id: SessionId): boolean => sessions.archivedById[id] !== undefined
    || workspaces.archivedSessionIds.includes(id)
  const fallbackCandidates: WorkbenchConversation[] = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || summary.origin === 'subagent'
      || (summary.blank && summary.id !== sessions.current)
      || isArchived(summary.id)) return []
    const address = parseClientSessionKey(summary.id)
    const runtime: SessionRuntimeTarget = summary.runtime ?? address?.runtime ?? (summary.projectId === undefined
      ? { kind: 'personal' } : { kind: 'project', projectId: summary.projectId })
    return [{
      sessionId: address?.sessionId ?? summary.id,
      runtime: runtime.kind === 'personal' ? runtime
        : { ...runtime, projectName: summary.workspaceName ?? `Project ${String(runtime.projectId)}` },
      title: summary.title ?? summary.displayTitle,
      ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
      visibility: summary.projectId === undefined ? 'personal' as const : 'project' as const,
      creatorUserId: 0,
      creatorDisplayName: '',
      updatedAt: summary.updatedAt,
      blank: summary.blank,
      canWrite: true,
    }]
  })
  const browserKey = (item: WorkbenchConversation): SessionId => clientSessionKey(item.runtime, item.sessionId)
  const catalogItems = catalog === undefined ? readCatalog ? [] : fallbackCandidates : [...new Map([
    ...catalog.items.map(item => [browserKey(item), item] as const),
    ...(!catalog.paged && !catalog.personalComplete ? fallbackCandidates.filter(item => item.runtime.kind === 'personal'
      && catalog.personalRuntimes?.some(target => target.runtimeId === item.runtime.runtimeId) === true)
      .map(item => [browserKey(item), item] as const) : []),
  ]).values()].filter(item => deployment.aggregateComputers || item.runtime.kind !== 'personal'
    || personalRuntimes.some(runtime => runtime.runtimeId === item.runtime.runtimeId))
  const candidates = catalogItems.filter((item) => {
    const projectId = item.runtime.kind === 'project' ? String(item.runtime.projectId) : 'personal'
    return (!item.blank || browserKey(item) === sessions.current)
      && !isArchived(browserKey(item))
      && (workspace === '' || workspace === projectId || (item.runtime.kind === 'personal' && workspace === personalKey(item.runtime)))
      && (catalog?.paged || [item.title, item.sessionId, item.cwd, deployment.showComputer ? item.runtime.nodeName : undefined,
        item.runtime.kind === 'project' ? item.runtime.projectName : catalog?.personal.name]
        .some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  })
  const finish = (result: AddPaneResult): void => {
    if (result.ok || result.reason === 'duplicate') { actions.closePicker(); setError(undefined) }
    else setError(t(result.reason === 'limit' ? 'limit' : 'unavailable'))
  }
  const cancelPending = (): void => {
    pendingOperation.current?.abort()
    pendingOperation.current = undefined
    setPending(false)
  }
  const closePicker = (): void => { cancelPending(); actions.closePicker() }
  const runSelection = (operation: (signal: AbortSignal) => Promise<AddPaneResult>, creating: boolean): void => {
    if (pendingOperation.current !== undefined) return
    const request = new AbortController()
    pendingOperation.current = request
    setPending(true)
    setError(undefined)
    void (async () => {
      try {
        const result = await operation(request.signal)
        if (pendingOperation.current === request) finish(result)
      } catch (cause: unknown) {
        if (pendingOperation.current === request && !request.signal.aborted) {
          setError(cause instanceof Error ? cause.message : creating ? t('createError') : String(cause))
        }
      } finally {
        if (pendingOperation.current === request) {
          pendingOperation.current = undefined
          setPending(false)
        }
      }
    })()
  }
  const create = (): void => {
    /* v8 ignore next -- the create button is disabled during pending and read-only workspaces */
    if (pending || !creatableScope) {
      if (selectedProject?.mode === 'ro') setError(t('readOnly'))
      return
    }
    const target: SessionRuntimeTarget = selectedPersonal !== undefined
      ? selectedPersonal
      : {
        kind: 'project' as const, projectId: Number(workspace),
        // The name rides the target so a runtime first opened by this create
        // still stamps workspaceName on its summaries (pane scope label).
        ...(selectedProject === undefined ? {} : { projectName: selectedProject.name }),
        ...(selectedProject?.runtimeId === undefined ? {} : { runtimeId: selectedProject.runtimeId }),
        ...(selectedProject?.nodeId === undefined ? {} : { nodeId: selectedProject.nodeId }),
        ...(selectedProject?.nodeName === undefined ? {} : { nodeName: selectedProject.nodeName }),
      }
    runSelection(signal => createSession(target, replace, signal), true)
  }
  /* v8 ignore next -- the picker CSS module class is always defined */
  const pickerClass = css.picker ?? ''
  return (
    <div className={css.toolbar} data-workbench-toolbar="" data-inline={inline || undefined} data-tabbed={tabbed || undefined}>
      <div className={css.toolbarTitle}>
        <Menu open={workbenchMenuOpen} onClose={() => { actions.closeWorkbenchMenu() }} onSelect={(id) => {
          actions.closeWorkbenchMenu()
          if (id === '__new') { setWorkbenchName(''); setWorkbenchDialog('create') }
          else if (id === '__rename') { setWorkbenchName(currentWorkbench?.()?.name ?? ''); setWorkbenchDialog('rename') }
          else if (id === '__duplicate') { setWorkbenchName(t('workbenchCopy', { name: currentWorkbench?.()?.name || t('defaultWorkbenchName') })); setWorkbenchDialog('duplicate') }
          else if (id === '__delete') setDeleteWorkbenchOpen(true)
          else if (id === '__exit') setMode('single')
          else { setMode('workbench'); switchWorkbench?.(id) }
        }} items={[
          ...(listWorkbenches?.() ?? [{ id: 'default', name: '', paneIds: [], updatedAt: Date.now() }]).map(item => ({ id: item.id, label: `${item.name || t('defaultWorkbenchName')} · ${item.paneIds.length}/4` })),
          { type: 'separator' as const, id: 'workbench-actions-separator' },
          { id: '__new', label: t('newWorkbench'), icon: <IconPlusOutline16 />, disabled: viewport.pendingIdentity === true },
          { id: '__rename', label: t('renameWorkbench'), icon: <IconEditOutline16 />, disabled: viewport.pendingIdentity === true },
          { id: '__duplicate', label: t('duplicateWorkbench'), icon: <IconCopyOutline16 />, disabled: viewport.pendingIdentity === true },
          { id: '__delete', label: t('deleteWorkbench'), icon: <IconTrashOutline16 />, danger: true, disabled: viewport.pendingIdentity === true },
          { type: 'separator' as const, id: 'workbench-exit-separator' },
          { id: '__exit', label: t('exitWorkbench'), icon: <IconLogoutOutline16 /> },
        ]} selectedId={viewport.mode === 'workbench' ? currentWorkbench?.()?.id : undefined} anchor={<button type="button" className={css.workbenchTrigger} aria-label={t('select')} aria-haspopup="menu" aria-expanded={workbenchMenuOpen} onClick={() => { actions.toggleWorkbenchMenu() }}><span className={css.workbenchTriggerLabel}>{viewport.mode === 'workbench' ? currentWorkbench?.()?.name || t('defaultWorkbenchName') : t('mode')}</span><IconChevronDownOutline14 /></button>} />
        {viewport.mode === 'workbench' && (
          <span className={css.toolbarCapacity} role="img" aria-label={t('seatCount', { used: viewport.paneIds.length, total: 4 })} title={t('seatCount', { used: viewport.paneIds.length, total: 4 })}>
            <span aria-hidden="true">{viewport.paneIds.length}<span className={css.capacityTotal}> / 4</span></span>
          </span>
        )}
      </div>
      {toolsHostId !== undefined && <div id={toolsHostId} className={css.sessionTools} data-workbench-tools-host="" />}
      <div className={css.toolbarActions}>
        {attentionPanes.length > 0 && (
          <button
            type="button"
            className={css.attentionPill}
            onClick={() => { const first = attentionPanes[0]; if (first !== undefined) focusSession(first) }}
          >
            <IconWarningOutline16 />
            {t('attention', { count: attentionPanes.length })}
          </button>
        )}
        {viewport.mode === 'workbench' && onSelectLayout !== undefined && (
          <Menu
            open={layoutMenuOpen}
            onClose={() => { setLayoutMenuOpen(false) }}
            selectedId={layout}
            align="end" portal dense
            items={[
              { id: 'equal', label: t('layoutEqual') },
              { id: 'lead', label: t('layoutLead') },
              { id: 'trail', label: t('layoutTrail') },
              { type: 'separator' as const, id: 'layout-mode-separator' },
              { id: 'tabbed', label: t('layoutTabbed') },
            ]}
            onSelect={(id) => { setLayoutMenuOpen(false); onSelectLayout(id as WorkbenchLayoutPreset) }}
            anchor={(
              <button
                type="button"
                className={css.iconAction}
                aria-label={t('layout')}
                title={t('layout')}
                aria-haspopup="menu"
                aria-expanded={layoutMenuOpen}
                onClick={() => { setLayoutMenuOpen(open => !open) }}
              >
                <IconSplitPanesOutline16 />
              </button>
            )}
          />
        )}
        {filesAvailable?.() === true && openFiles !== undefined && (
          <button
            type="button"
            className={css.iconAction}
            aria-label={t('files')}
            title={t('files')}
            onClick={() => { openFiles() }}
          >
            <IconFolderOpenOutline16 />
          </button>
        )}
        {viewport.mode === 'workbench' && (
          <Button size="toolbar" variant="soft" className={css.addConversation} disabled={viewport.pendingIdentity === true} icon={<IconPlusOutline16 />} onClick={() => { setError(undefined); actions.openPicker() }}>
            {t('add')}
          </Button>
        )}
      </div>
      {viewport.pendingIdentity === true && (
        <div className={css.notice} role="status">
          {t('layoutPending')}
          <Button size="sm" onClick={() => { setCatalogAttempt(value => value + 1) }}>{t('retryCatalog')}</Button>
          {legacyRestore !== undefined && <Button size="sm" onClick={() => { setRestoreOpen(true) }}>{t('layoutChooseOwner')}</Button>}
          {restoreError !== undefined && <span role="alert">{restoreError}</span>}
        </div>
      )}
      {browser !== undefined && listWorkspaceDirectory !== undefined && openWorkspaceResource !== undefined && (
        <WorkspaceFileBrowser
          key={`${browser.runtimeTarget.kind}:${browser.runtimeTarget.kind === 'project' ? String(browser.runtimeTarget.projectId) : 'base'}:${browser.sessionId}`}
          sessionId={browser.sessionId}
          runtimeTarget={browser.runtimeTarget}
          list={listWorkspaceDirectory}
          open={openWorkspaceResource}
          close={actions.closeBrowser}
          labels={browserLabels}
        />
      )}
      {tabbed && viewport.mode === 'workbench' && (
        <div className={css.tabs} role="tablist" aria-label={t('mode')}>
          {viewport.paneIds.map((id, index) => {
            const summary = sessions.byId[id]
            const workspaceName = sessions.byId[id]?.projectId === undefined
              ? catalog?.personal.name
              : catalog?.projects.find(project => project.projectId === sessions.byId[id]?.projectId)?.name
            const status = summary === undefined ? 'notLoaded' : summary.pendingInteraction !== undefined ? 'waiting' : summary.running ? 'running' : 'ready'
            return (
              <button key={id} type="button" role="tab" aria-selected={viewport.activePaneId === id}
                tabIndex={viewport.activePaneId === id ? 0 : -1}
                title={`${workspaceName ?? ''} · ${summary?.displayTitle ?? t('untitled')} · ${t(status)}`}
                onClick={() => { focusSession(id) }}
                onKeyDown={(event) => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % viewport.paneIds.length
                    : event.key === 'ArrowLeft' ? (index + viewport.paneIds.length - 1) % viewport.paneIds.length
                      : event.key === 'Home' ? 0 : event.key === 'End' ? viewport.paneIds.length - 1 : undefined
                  if (next === undefined) return
                  event.preventDefault()
                  const nextId = viewport.paneIds[next]
                  /* v8 ignore next -- next is always a valid pane index here, so nextId cannot be undefined */
                  if (nextId !== undefined) focusSession(nextId)
                  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  tabs?.[next]?.focus()
                }}>
                <StateDot state={status === 'waiting' || status === 'notLoaded' ? 'warning' : status === 'running' ? 'ongoing' : 'done'} size={8} />
                <span>{workspaceName === undefined ? '' : `${workspaceName} · `}{summary?.displayTitle ?? t('untitled')}</span>
                <span className={css.srOnly}>{t(status)}</span>
              </button>
            )
          })}
        </div>
      )}
      <Modal open={pickerOpen} onClose={closePicker}
        title={t(replace ? 'replace' : 'add')} closeLabel={t('dismiss')} className={pickerClass}>
        <div className={css.pickerFilters}>
          <input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={t('search')} aria-label={t('search')} />
          <Menu
            open={workspaceMenuOpen}
            onClose={() => { setWorkspaceMenuOpen(false) }}
            selectedId={workspace}
            onSelect={(id) => {
              if (id === 'more-computers' && moreComputers !== undefined) {
                const request = new AbortController()
                pendingOperation.current?.abort()
                pendingOperation.current = request
                setPending(true)
                void moreComputers(request.signal).then(() => { if (!request.signal.aborted) setCatalogAttempt(n => n + 1) },
                  () => { if (!request.signal.aborted) setError(t('unavailable')) }).finally(() => {
                  if (pendingOperation.current === request) { pendingOperation.current = undefined; setPending(false) }
                })
              } else {
                const onlyPersonal = id === 'personal' && !catalog?.moreComputers && personalRuntimes.length === 1 ? personalRuntimes[0] : undefined
                setWorkspace(onlyPersonal === undefined ? id : personalKey(onlyPersonal))
                setChosenProject(catalog?.projects.find(project => String(project.projectId) === id))
              }
              setWorkspaceMenuOpen(false)
            }}
            portal dense align="end" listClassName={css.workspaceMenu}
            items={[
              ...(catalog?.moreComputers && moreComputers !== undefined ? [{ id: 'more-computers', label: t('moreComputers') }] : []),
              { id: '', label: <span className={css.workspaceOption}><strong>{t('allWorkspaces')}</strong><small>{t('workspace')}</small></span> },
              { id: 'personal', label: <span className={css.workspaceOption}>
                <strong>{t('personal')}</strong><small>{catalog?.personal.name ?? ''}</small></span> },
              ...(deployment.aggregateComputers || personalRuntimes.length > 1 ? personalRuntimes
                .filter(item => item.runtimeId !== undefined).map(item => ({
                  id: personalKey(item), label: <span className={css.workspaceOption}>
                    <strong>{personalLabel(item)}</strong><small>{t('personal')}</small></span>,
                })) : []),
              ...(catalog?.projects ?? []).map(item => ({ id: String(item.projectId), label: <span className={css.workspaceOption}>
                <strong>{item.name}</strong><small>{[
                  deployment.showComputer ? item.nodeName : undefined,
                  item.mode === 'ro' ? t('readOnlyBadge') : t('workspace'),
                ].filter(Boolean).join(' · ')}</small></span> })),
            ]}
            anchor={<button type="button" className={css.workspaceTrigger} aria-label={t('workspace')} aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => { setWorkspaceMenuOpen(value => !value) }}>
              <span>{workspace === '' ? t('allWorkspaces') : workspace === 'personal' ? t('personal')
                : workspace.startsWith('personal:') ? selectedPersonal === undefined ? t('unavailable') : personalLabel(selectedPersonal)
                  : /* v8 ignore next -- a project workspace always resolves in the loaded catalog */ selectedProject?.name ?? t('workspace')}</span>
              <IconChevronDownOutline14 />
            </button>}
          />
        </div>
        {catalogPhase === 'loading' && <p className={css.notice} role="status">{t('catalogLoading')}</p>}
        {(catalogPhase === 'error' || catalog && !catalog.paged && !catalog.personalComplete) && <p className={css.notice} role="status">
          {t(catalogPhase === 'error' ? catalogAuthority ? 'directoryUnavailable' : 'catalogError' : 'catalogIncomplete')}
          <Button size="sm" disabled={catalogPhase === 'loading'} onClick={() => { setCatalogAttempt(value => value + 1) }}>{t('retryCatalog')}</Button>
        </p>}
        {catalogPhase === 'ready' && catalog?.scopePartial === true && <p className={css.notice} role="status">
          {t(query ? 'loadedSearch' : 'loadedDirectory')}
          <Button variant="ghost" size="sm" onClick={() => { setWorkspaceMenuOpen(true) }}>{t('chooseSearchScope')}</Button>
        </p>}
        {full && <div className={css.notice} role="status">{t('limit')} <Button size="sm" onClick={() => { actions.openPicker(true) }}>{t('replace')}</Button></div>}
        {error !== undefined && <p role="alert" className={css.notice}>{error}</p>}
        <div className={css.catalogSummary}><span>{t('history')}</span><span>{candidates.length}</span></div>
        <div className={css.candidates}>
          {candidates.length === 0 && catalogPhase === 'ready' && (catalog?.scopePartial === false || catalog?.personalComplete !== false)
            && <p className={css.notice}>{t('noSessions')}</p>}
          {candidates.slice(0, visibleCount).map((item) => {
            const pinned = viewport.paneIds.includes(browserKey(item))
            const title = conversationDisplayName(item, t('untitled'))
            /* v8 ignore next -- scopeName is always a personal or project name */
            const scopeName = (item.runtime.kind === 'project' ? item.runtime.projectName : t('personal')) ?? ''
            const { unit, n } = relativeTime(item.updatedAt, now)
            return (
              <button
                key={browserKey(item)}
                type="button" aria-label={`${title} ${item.cwd ?? ''}${deployment.showComputer && item.runtime.nodeName !== undefined ? ` ${item.runtime.nodeName}` : ''}`}
                disabled={viewport.pendingIdentity === true || pending || (full && !pinned)} className={css.candidate}
                onClick={() => {
                  runSelection(signal => chooseSession(item, replace, signal), false)
                }}>
                <ScopeTile name={scopeName} tone={item.runtime.kind === 'project' ? 'project' : 'personal'} />
                <span className={css.candidateText}><strong>{title}</strong><small title={item.cwd}>{scopeName}{deployment.showComputer && item.runtime.nodeName !== undefined ? ` · ${item.runtime.nodeName}` : ''}{item.cwd === undefined ? '' : ` · ${workspaceTitleOf(item.cwd) || item.cwd}`}</small></span>
                <small className={css.candidateTime}>{unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })}</small>
                {pinned ? <small className={css.rowBadge}>{t('opened')}</small> : !item.canWrite && <small className={css.rowBadge}>{t('readOnlyBadge')}</small>}
              </button>
            )
          })}
          {catalog?.paged && catalog.nextCursor && candidates.length <= visibleCount && <Button variant="ghost" size="sm"
            disabled={pending || catalogPhase === 'loading'} onClick={() => {
              if (catalog.nextCursor) {
                setContinuation({ scope: workspace, query, cursor: catalog.nextCursor,
                })
                setVisibleCount(n => n + CONVERSATION_PAGE_SIZE)
              }
            }}>{t('moreRows')}</Button>}
          {candidates.length > visibleCount && <Button variant="ghost" size="sm" disabled={pending}
            onClick={() => { setVisibleCount(count => count + CONVERSATION_PAGE_SIZE) }}>
            {t('moreConversations', { count: candidates.length - visibleCount })}
          </Button>}
        </div>
        <div className={css.pickerFooter}>
          <span>{t(workspace === 'personal' && selectedPersonal === undefined
            ? deployment.showComputer ? 'chooseComputer' : 'choosePersonalRuntime' : 'chooseWorkspace')}</span>
          {pending && <Button variant="outline" size="sm" onClick={cancelPending}>{t('cancelPending')}</Button>}
          <Button variant="primary" size="sm" disabled={viewport.pendingIdentity === true || !creatableScope || pending || full}
            onClick={create}>{t(pending ? 'creating' : 'create')}</Button>
        </div>
      </Modal>
      <Modal open={restoreOpen && legacyRestore !== undefined} onClose={closeRestore}
        title={t('layoutChooseOwner')} closeLabel={t('dismiss')}
        footer={<><Button variant="outline" onClick={closeRestore}>{t('cancel')}</Button>
          <Button variant="primary" disabled={restorePending || legacyRestore?.issues.some(issue => !restoreOwners[issue.sessionId]) === true}
            onClick={restoreLayout}>{t(restorePending ? 'layoutRestoring' : 'layoutRestore')}</Button></>}>
        <p className={css.notice}>{t('layoutChooseOwnerBody')}</p>
        {legacyRestore?.issues.map(issue => <label key={issue.sessionId} className={css.restoreRow}>
          <span>{issue.candidates[0]?.title ?? t('untitled')}</span>
          <select value={restoreOwners[issue.sessionId] ?? ''} disabled={restorePending}
            onChange={(event) => {
              const choice = event.target.value
              setRestoreOwners(previous => ({ ...previous, [issue.sessionId]: choice }))
            }}>
            <option value="">{t('layoutChooseRuntime')}</option>
            {issue.candidates.map(item => <option key={browserKey(item)} value={browserKey(item)}>{restoreCandidateLabel(item)}</option>)}
            <option value="__remove">{t('layoutRemoveReference')}</option>
          </select>
        </label>)}
        {restoreError !== undefined && <p role="alert" className={css.notice}>{restoreError}</p>}
      </Modal>
      <Modal open={workbenchDialog !== undefined} onClose={() => { setWorkbenchDialog(undefined) }} title={t(workbenchDialog === 'rename' ? 'renameWorkbench' : workbenchDialog === 'duplicate' ? 'duplicateWorkbench' : 'newWorkbench')} closeLabel={t('dismiss')}
        footer={<><Button variant="outline" onClick={() => { setWorkbenchDialog(undefined) }}>{t('cancel')}</Button><Button variant="primary" disabled={workbenchName.trim() === ''} onClick={() => {
          const current = currentWorkbench?.()
          if (workbenchDialog === 'create') createWorkbench?.(workbenchName)
          else if (workbenchDialog === 'rename' && current !== undefined) renameWorkbench?.(current.id, workbenchName)
          else if (workbenchDialog === 'duplicate' && current !== undefined) duplicateWorkbench?.(current.id, workbenchName)
          setWorkbenchDialog(undefined)
        }}>{t('confirm')}</Button></>}
      >
        <input className={css.workbenchNameInput} autoFocus value={workbenchName} onChange={(event) => { setWorkbenchName(event.target.value) }} aria-label={t('workbenchName')} />
      </Modal>
      <Modal open={deleteWorkbenchOpen} onClose={() => { setDeleteWorkbenchOpen(false) }} title={t('deleteWorkbench')} closeLabel={t('dismiss')}
        footer={<><Button variant="outline" onClick={() => { setDeleteWorkbenchOpen(false) }}>{t('cancel')}</Button><Button variant="primary" onClick={() => {
          deleteWorkbench?.(currentWorkbench?.()?.id ?? '')
          setDeleteWorkbenchOpen(false)
        }}>{t('confirm')}</Button></>}
      >
        <p className={css.workbenchDeleteDescription}>{t('deleteWorkbenchDescription')}</p>
      </Modal>
    </div>
  )
}
