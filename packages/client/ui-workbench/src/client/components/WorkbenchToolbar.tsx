/** Workbench controls, Workspace/session chooser, and compact pane tabs. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronDownOutline14, IconPlusOutline16, Menu, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceResourceRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { AddPaneResult, ConversationViewportMode, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { createWorkbenchStore } from '../stores.ts'
import { NS } from '../locales.ts'
import { loadWorkbenchCatalog, type WorkbenchCatalog, type WorkbenchConversation } from '../catalog.ts'
import css from './Workbench.module.css'
import { WorkspaceFileBrowser, type ListWorkspaceDirectory, type OpenWorkspaceResource } from './WorkspaceFileBrowser.tsx'
import { WorkspaceFilePreview, type ReadWorkspacePreview } from './WorkspaceFilePreview.tsx'

interface Actions {
  listWorkbenches?: () => readonly { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }[]
  currentWorkbench?: () => { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number } | undefined
  createWorkbench?: (name: string) => string
  renameWorkbench?: (id: string, name: string) => void
  duplicateWorkbench?: (id: string, name: string) => string
  deleteWorkbench?: (id: string) => void
  switchWorkbench?: (id: string) => void
  chooseSession: (item: WorkbenchConversation, replace: boolean) => Promise<AddPaneResult>
  focusSession: (id: SessionId) => void
  createSession: (target: { kind: 'personal' } | { kind: 'project'; projectId: number }, replace: boolean) => Promise<AddPaneResult>
  hydrateCatalog?: (catalog: WorkbenchCatalog, paneIds: readonly SessionId[]) => Promise<void>
  markCatalogReady?: () => void
  setMode: (mode: ConversationViewportMode) => void
  readPreview?: ReadWorkspacePreview
  readBytesPreview?: import('./WorkspaceFilePreview.tsx').ReadWorkspaceBytesPreview
  listWorkspaceDirectory?: ListWorkspaceDirectory
  openWorkspaceResource?: OpenWorkspaceResource
  workspaceResourceOwner?: () => { sessionId: SessionId; runtimeTarget: import('@deepseek-ai/dsh-client-runtime/client').WorkspaceResourceTarget } | undefined
  workspaceRemote?: boolean
  resources?: WorkspaceResourceRegistry | undefined
}
type Props = PropsRuntime<'conversation.workbench.toolbar'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createWorkbenchStore>> & Actions

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
  viewport, tabbed, inline = false, useStore, actions, useSessions, useWorkspaces,
  chooseSession, focusSession, createSession, hydrateCatalog, markCatalogReady, setMode,
  listWorkbenches, currentWorkbench, switchWorkbench, createWorkbench, renameWorkbench,
  duplicateWorkbench, deleteWorkbench, readPreview, readBytesPreview,
  listWorkspaceDirectory, openWorkspaceResource, workspaceResourceOwner,
  workspaceRemote, resources, t,
}: Props) {
  const { pickerOpen, replace, preview } = useStore(state => state)
  // The injected face is cached by the root slot; resolve the active pane at
  // render time so multi-runtime Workbench controls follow focus changes.
  const activeWorkspaceOwner = workspaceResourceOwner?.()
  const sessions = useSessions(s => s)
  const workspaces = useWorkspaces(s => s)
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [workbenchMenuOpen, setWorkbenchMenuOpen] = useState(false)
  const [workbenchDialog, setWorkbenchDialog] = useState<'create' | 'rename' | 'duplicate' | undefined>()
  const [deleteWorkbenchOpen, setDeleteWorkbenchOpen] = useState(false)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [workbenchName, setWorkbenchName] = useState('')
  const [catalog, setCatalog] = useState<WorkbenchCatalog | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    const abort = new AbortController()
    void loadWorkbenchCatalog(abort.signal).then((next) => {
      if (abort.signal.aborted) return
      setCatalog(next)
      const runtime = next.activeRuntime
      const project = runtime.kind === 'project'
        ? next.projects.find(candidate => candidate.projectId === runtime.projectId)
        : undefined
      const activeRuntime: SessionRuntimeTarget = runtime.kind === 'project' && project !== undefined
        ? { ...runtime, projectName: project.name }
        : runtime
      if (hydrateCatalog !== undefined) {
        void hydrateCatalog({ ...next, activeRuntime }, viewport.paneIds)
      }
    }, () => { if (!abort.signal.aborted) markCatalogReady?.() })
    return () => { abort.abort() }
  }, [pickerOpen])
  const full = viewport.paneIds.length >= 4 && !replace
  const showFileBrowser = workspaceRemote === true && resources !== undefined
    && activeWorkspaceOwner !== undefined && resources.hasProvider(activeWorkspaceOwner.runtimeTarget)
    && listWorkspaceDirectory !== undefined && openWorkspaceResource !== undefined
  const browserLabels = {
    close: t('previewClose'), title: t('files'), root: t('filesRoot'), up: t('filesUp'),
    loading: t('previewLoading'), empty: t('filesEmpty'), directory: t('filesDirectory'),
    truncated: t('filesTruncated'), error: t('createError'), reload: t('previewReload'),
  }
  const selectedProject = workspace === 'personal' || workspace === ''
    ? undefined
    : catalog?.projects.find(project => String(project.projectId) === workspace)
  const fallbackCandidates: WorkbenchConversation[] = sessions.ids.flatMap((id) => {
    const summary = sessions.byId[id]
    if (summary === undefined || summary.origin === 'subagent'
      || (summary.blank && summary.id !== sessions.current)
      || workspaces.archivedSessionIds.includes(summary.id)) return []
    return [{
      sessionId: summary.id,
      runtime: summary.projectId === undefined
        ? { kind: 'personal' as const }
        : { kind: 'project' as const, projectId: summary.projectId, projectName: `Project ${String(summary.projectId)}` },
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
  const catalogItems = catalog?.items ?? fallbackCandidates
  const candidates = catalogItems.filter((item) => {
    const projectId = item.runtime.kind === 'project' ? String(item.runtime.projectId) : 'personal'
    return (!item.blank || item.sessionId === sessions.current)
      && !workspaces.archivedSessionIds.includes(item.sessionId)
      && (workspace === '' || workspace === projectId)
      && `${item.title ?? item.sessionId} ${item.cwd ?? ''} ${item.runtime.kind === 'project'
        ? item.runtime.projectName
        : catalog?.personal.name ?? ''}`
        .toLocaleLowerCase().includes(query.toLocaleLowerCase())
  })
  const finish = (result: AddPaneResult): void => {
    if (result.ok || result.reason === 'duplicate') { actions.closePicker(); setError(undefined) }
    else setError(t(result.reason === 'limit' ? 'limit' : 'unavailable'))
  }
  const create = (): void => {
    /* v8 ignore next -- the create button is disabled during pending and read-only workspaces */
    if (pending || selectedProject?.mode === 'ro') {
      if (selectedProject?.mode === 'ro') setError(t('readOnly'))
      return
    }
    setPending(true)
    setError(undefined)
    const target = workspace === 'personal'
      ? { kind: 'personal' as const }
      : { kind: 'project' as const, projectId: Number(workspace) }
    void createSession(target, replace).then(finish, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t('createError'))
    }).finally(() => { setPending(false) })
  }
  /* v8 ignore next -- the picker CSS module class is always defined */
  const pickerClass = css.picker ?? ''
  return (
    <div className={css.toolbar} data-workbench-toolbar="" data-inline={inline || undefined} data-tabbed={tabbed || undefined}>
      {preview !== undefined && readPreview !== undefined && resources !== undefined && <WorkspaceFilePreview key={JSON.stringify([preview.runtimeTarget, preview.address])} request={preview} read={readPreview} readBytes={readBytesPreview} resources={resources} close={actions.closePreview} labels={{ close: t('previewClose'), reload: t('previewReload'), previous: t('previewPrevious'), next: t('previewNext'), loading: t('previewLoading'), changed: t('previewChanged'), binary: t('previewBinary') }} />}
      <div className={css.toolbarTitle}>
        <Menu open={workbenchMenuOpen} onClose={() => { setWorkbenchMenuOpen(false) }} onSelect={(id) => {
          setWorkbenchMenuOpen(false)
          if (id === '__new') { setWorkbenchName(''); setWorkbenchDialog('create') }
          else if (id === '__rename') { setWorkbenchName(currentWorkbench?.()?.name ?? ''); setWorkbenchDialog('rename') }
          else if (id === '__duplicate') { setWorkbenchName(`${currentWorkbench?.()?.name ?? '我的工作台'} 副本`); setWorkbenchDialog('duplicate') }
          else if (id === '__delete') setDeleteWorkbenchOpen(true)
          else if (id === '__exit') setMode('single')
          else { setMode('workbench'); switchWorkbench?.(id) }
        }} items={[
          ...(listWorkbenches?.() ?? [{ id: 'default', name: '我的工作台', paneIds: [], updatedAt: Date.now() }]).map(item => ({ id: item.id, label: `${item.name} · ${item.paneIds.length}/4` })),
          { type: 'separator' as const, id: 'workbench-actions-separator' },
          { id: '__new', label: t('newWorkbench') },
          { id: '__rename', label: t('renameWorkbench') },
          { id: '__duplicate', label: t('duplicateWorkbench') },
          { id: '__delete', label: t('deleteWorkbench'), danger: true },
          { type: 'separator' as const, id: 'workbench-exit-separator' },
          { id: '__exit', label: t('exitWorkbench') },
        ]} selectedId={viewport.mode === 'workbench' ? currentWorkbench?.()?.id : undefined} anchor={<button type="button" className={css.workbenchTrigger} aria-label="选择工作台" aria-haspopup="menu" aria-expanded={workbenchMenuOpen} onClick={() => { setWorkbenchMenuOpen(value => !value) }}>{viewport.mode === 'workbench' ? currentWorkbench?.()?.name ?? t('mode') : t('mode')} <IconChevronDownOutline14 /></button>} />
        {viewport.mode === 'workbench' && <span className={css.paneCount} aria-label={`${viewport.paneIds.length}/4`}>{viewport.paneIds.length}/4</span>}
      </div>
      <div className={css.toolbarActions}>
        {showFileBrowser && (
          <Button size="sm" variant="toolbar" onClick={() => { setFileBrowserOpen(true) }}>
            {t('files')}
          </Button>
        )}
        {viewport.mode === 'workbench' && (
          <Button size="sm" variant="toolbar" icon={<IconPlusOutline16 />} onClick={() => { setError(undefined); actions.openPicker() }}>
            {t('add')}
          </Button>
        )}
      </div>
      {fileBrowserOpen && showFileBrowser && (
        <WorkspaceFileBrowser
          key={`${activeWorkspaceOwner.runtimeTarget.kind}:${activeWorkspaceOwner.runtimeTarget.kind === 'project' ? String(activeWorkspaceOwner.runtimeTarget.projectId) : 'base'}:${activeWorkspaceOwner.sessionId}`}
          sessionId={activeWorkspaceOwner.sessionId}
          runtimeTarget={activeWorkspaceOwner.runtimeTarget}
          list={listWorkspaceDirectory}
          open={openWorkspaceResource}
          close={() => { setFileBrowserOpen(false) }}
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
            const status = summary?.pendingInteraction !== undefined ? 'waiting' : summary?.running ? 'running' : 'ready'
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
                <StateDot state={status === 'waiting' ? 'warning' : status === 'running' ? 'ongoing' : 'done'} size={8} />
                <span>{workspaceName === undefined ? '' : `${workspaceName} · `}{summary?.displayTitle ?? t('untitled')}</span>
                <span className={css.srOnly}>{t(status)}</span>
              </button>
            )
          })}
        </div>
      )}
      <Modal open={pickerOpen} onClose={() => { if (!pending) actions.closePicker() }}
        title={t(replace ? 'replace' : 'add')} closeLabel={t('dismiss')} className={pickerClass}>
        <div className={css.pickerFilters}>
          <input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={t('search')} aria-label={t('search')} />
          <Menu
            open={workspaceMenuOpen}
            onClose={() => { setWorkspaceMenuOpen(false) }}
            selectedId={workspace}
            onSelect={(id) => { setWorkspace(id); setWorkspaceMenuOpen(false) }}
            portal dense align="end" listClassName={css.workspaceMenu}
            items={[
              { id: '', label: <span className={css.workspaceOption}><strong>{t('allWorkspaces')}</strong><small>{t('workspace')}</small></span> },
              { id: 'personal', label: <span className={css.workspaceOption}><strong>{t('personal')}</strong><small>{catalog?.personal.name ?? ''}</small></span> },
              ...(catalog?.projects ?? []).map(item => ({ id: String(item.projectId), label: <span className={css.workspaceOption}><strong>{item.name}</strong><small>{item.mode === 'ro' ? t('readOnlyBadge') : t('workspace')}</small></span> })),
            ]}
            anchor={<button type="button" className={css.workspaceTrigger} aria-label={t('workspace')} aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => { setWorkspaceMenuOpen(value => !value) }}>
              <span>{workspace === '' ? t('allWorkspaces') : workspace === 'personal' ? t('personal') : /* v8 ignore next -- a project workspace always resolves in the loaded catalog */ selectedProject?.name ?? t('workspace')}</span>
              <IconChevronDownOutline14 />
            </button>}
          />
        </div>
        {full && <div className={css.notice} role="status">{t('limit')} <Button size="sm" onClick={() => { actions.openPicker(true) }}>{t('replace')}</Button></div>}
        {error !== undefined && <p role="alert" className={css.notice}>{error}</p>}
        <div className={css.catalogSummary}><span>{t('history')}</span><span>{candidates.length}</span></div>
        <div className={css.candidates}>
          {candidates.length === 0 && <p className={css.notice}>{t('noSessions')}</p>}
          {candidates.map((item) => {
            const pinned = viewport.paneIds.includes(item.sessionId)
            const title = conversationDisplayName(item, t('untitled'))
            /* v8 ignore next -- scopeName is always a personal or project name */
            const scopeName = (item.runtime.kind === 'project' ? item.runtime.projectName : t('personal')) ?? ''
            return (
              <button
                key={`${item.runtime.kind}:${item.runtime.kind === 'project' ? item.runtime.projectId : 'personal'}:${item.sessionId}`}
                type="button" aria-label={`${title} ${item.cwd ?? ''}`}
                disabled={pending || (full && !pinned)} className={css.candidate}
                onClick={() => {
                  setPending(true)
                  void Promise.resolve(chooseSession(item, replace)).then(
                    finish,
                    (cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    },
                  ).finally(() => { setPending(false) })
                }}>
                <span><strong>{title}</strong><small title={item.cwd}>{scopeName}{item.cwd === undefined ? '' : ` · ${workspaceTitleOf(item.cwd) || item.cwd}`}</small></span>
                {pinned ? <small className={css.rowBadge}>{t('opened')}</small> : !item.canWrite && <small className={css.rowBadge}>{t('readOnlyBadge')}</small>}
              </button>
            )
          })}
        </div>
        <div className={css.pickerFooter}>
          <span>{t('chooseWorkspace')}</span>
          <Button variant="primary" size="sm" disabled={workspace === '' || pending || full || selectedProject?.mode === 'ro'} onClick={create}>{t(pending ? 'creating' : 'create')}</Button>
        </div>
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
