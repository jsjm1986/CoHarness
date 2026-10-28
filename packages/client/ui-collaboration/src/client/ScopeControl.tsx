import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14, IconGlobeOutline14,
  IconSearchOutline16, IconPlusOutline16, IconSettingsOutline16, IconShieldOutline16, IconUserOutline16,
  IconUsersOutline16, IconWarningOutline16,
  Button, focusWithoutRing, Menu, SegmentedTabs, Tooltip, useDismissOnOutsidePointer, useMediaQuery, useModalLayer, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  CollaborationSnapshot, CollaborationVisibility, ProjectMembership,
} from './collaboration-client.ts'
import type { NS } from './locales.ts'
import { ProjectManagerModal, type ProjectManagerMode } from './ProjectManagerModal.tsx'
import { ProjectSettingsModal } from './ProjectSettingsModal.tsx'
import { ScopeSwitchStatus } from './ScopeSwitchStatus.tsx'
import css from './ScopeControl.module.css'

/** Registration-side collaboration state and actions for the sidebar footer. */
export interface ScopeControlInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
  /** Persist a different runtime scope and reload the page. */
  switchScope: (scope: { kind: 'personal' } | { kind: 'project'; projectId: number }) => Promise<void>
  /** Stage visibility for the next project conversation. */
  stageVisibility: (visibility: CollaborationVisibility) => void
  /** User-owned project and invitation operations. */
  createProject?: (name: string) => Promise<number>
  listInvitations?: (projectId?: number) => Promise<import('./collaboration-client.ts').ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw') => Promise<import('./collaboration-client.ts').ProjectInvitation>
  acceptInvitation?: (id: string) => Promise<void>
  /** List active users for the invitation member picker. */
  listUsers?: () => Promise<import('./collaboration-client.ts').UserSummary[]>
  /** Count pending invitations where the current user is the invitee. */
  getInvitationCount?: () => Promise<{ pending: number }>
  /** Load and mutate the logical project configuration panel. */
  loadProjectConfiguration?: (projectId: number) => Promise<import('./collaboration-client.ts').ProjectConfiguration>
  setProjectThemePolicy?: (
    projectId: number,
    policy: import('./collaboration-client.ts').ProjectThemePolicy,
  ) => Promise<import('./collaboration-client.ts').ProjectConfiguration>
  /** Organization SSH targets with the project's share flags, for managers. */
  listProjectSshTargets?: (projectId: number) => Promise<import('./collaboration-client.ts').ProjectSshTarget[]>
  /** Toggle one target's share toward the project, for managers. */
  shareProjectSshTarget?: (
    projectId: number,
    targetId: number,
    shared: boolean,
  ) => Promise<{ publicId: number; name: string; shared: boolean }>
}

/** Full sidebar collaboration-control props. */
export type ScopeControlProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<ScopeControlInjected>
  & PropsLocale<typeof NS>

/** Deterministic identity tile tones; a project keeps one hue across renders. */
const tileTones = [css.tileBlue, css.tileGreen, css.tileAmber, css.tileRed, css.tileDeep] as const

/**
 * Pick a project's tile tone from its name so the same space always wears the
 * same colour in the list and the trigger.
 * @param name - project display name.
 * @returns the tone class for the tile.
 */
function tileTone(name: string): string {
  let sum = 0
  for (const char of name) sum += char.codePointAt(0) ?? 0
  return tileTones[sum % tileTones.length] ?? ''
}

/**
 * A project's leading glyph: the first full code point, which keeps CJK and
 * emoji names legible instead of splitting a surrogate pair.
 * @param name - project display name.
 * @returns the first glyph.
 */
function tileGlyph(name: string): string {
  return Array.from(name)[0] ?? ''
}

/**
 * Render the personal/project runtime selector and project create visibility.
 * Wide modes — the desktop column and the compact drawer alike — push a page
 * over the sidebar: on compact it covers the whole drawer, on wider layouts
 * it aligns to the browsing region so the column's chrome stays in view, and
 * it carries a second level for visibility staging.
 * The collapsed rail keeps the floating menu.
 * @param props - composed slot props.
 * @returns scope trigger plus its page or menu, or null outside Gateway collaboration.
 */
export function ScopeControl({
  wide, useCollaboration, switchScope, stageVisibility,
  createProject, listInvitations, inviteMember, acceptInvitation, listUsers, getInvitationCount,
  loadProjectConfiguration, setProjectThemePolicy, listProjectSshTargets, shareProjectSshTarget, t,
}: ScopeControlProps) {
  const state = useCollaboration(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  // Visibility is a nested page within the management tab.
  const [pageView, setPageView] = useState<'root' | 'visibility'>('root')
  const [hubTab, setHubTab] = useState<'list' | 'manage'>('list')
  const pageRef = useRef<HTMLDivElement>(null)
  const pageHeading = useRef<HTMLHeadingElement>(null)
  const previousPage = useRef(pageView)
  const compact = useMediaQuery('(max-width: 767px)')
  const [lastTarget, setLastTarget] = useState<{ kind: 'personal' } | { kind: 'project'; projectId: number; name: string }>()
  const [pageNav, setPageNav] = useState<'push' | 'pop'>('push')
  const pageId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The menu tracks the trigger's rendered width — the sidebar is draggable,
  // so the floating list re-measures on every layout change instead of
  // pinning a fixed width.
  const [menuWidth, setMenuWidth] = useState<number>()
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const measure = (): void => {
      setMenuWidth(Math.min(Math.max(trigger.offsetWidth, 240), 400))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(trigger)
    return () => { observer.disconnect() }
  }, [])
  const [managerMode, setManagerMode] = useState<ProjectManagerMode>()
  const [managerScope, setManagerScope] = useState<'current' | 'all'>('current')
  const [managerView, setManagerView] = useState<'received' | 'sent' | 'compose'>('received')
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [invitationCount, setInvitationCount] = useState(0)
  const [projectQuery, setProjectQuery] = useState('')
  const context = state.context
  const normalizedProjectQuery = projectQuery.trim().toLowerCase()
  const visibleProjects = context === undefined || normalizedProjectQuery === ''
    ? context?.projects ?? []
    : context.projects.filter(project => project.name.toLowerCase().includes(normalizedProjectQuery))

  const grantText = (project: ProjectMembership): string => (
    project.kind === 'steward' ? t('scope.steward')
      : project.mode === 'ro' ? t('scope.readOnly') : ''
  )
  const goBack = (): void => {
    if (pageView === 'visibility') {
      setPageNav('pop')
      setPageView('root')
      setHubTab('manage')
      return
    }
    setOpen(false)
  }
  const available = state.status === 'ready' && context !== undefined
    && (context.scope.kind === 'project' || context.projects.length > 0
      || createProject !== undefined || listInvitations !== undefined)
  useModalLayer(pageRef, open && wide && available, goBack)
  const childDialogOpen = managerMode !== undefined || projectSettingsOpen
  useDismissOnOutsidePointer(pageRef, open && wide && available && !childDialogOpen, setOpen, triggerRef)
  useLayoutEffect(() => {
    if (!open || !wide) return
    if (pageView === 'visibility' && pageHeading.current !== null) focusWithoutRing(pageHeading.current)
    else if (previousPage.current === 'visibility') {
      const target = pageRef.current?.querySelector<HTMLElement>('[data-scope-visibility]')
      if (target !== null && target !== undefined) focusWithoutRing(target)
    }
    previousPage.current = pageView
  }, [open, wide, pageView])
  useEffect(() => {
    if (state.scopeError === undefined || state.scopeBusy || lastTarget === undefined) return
    setHubTab('list')
    setPageView('root')
    setOpen(true)
  }, [state.scopeError, state.scopeBusy, lastTarget])

  useEffect(() => {
    if (getInvitationCount === undefined) return
    let active = true
    void getInvitationCount()
      .then((next) => { if (active) setInvitationCount(next.pending) })
      .catch(() => { if (active) setInvitationCount(0) })
    return () => { active = false }
  }, [open, managerMode, getInvitationCount])
  useEffect(() => {
    if (!open || context?.projects.length === 0) setProjectQuery('')
  }, [open, context?.projects.length])
  // The page always reopens at its root; Escape steps back one level before
  // closing so the visibility picker cannot swallow the keypress.
  useEffect(() => {
    if (!open) {
      setPageView('root')
      setHubTab('list')
      previousPage.current = 'root'
      setPageNav('push')
    }
  }, [open])
  if (state.status !== 'ready' || context === undefined
    || (context.scope.kind === 'personal' && context.projects.length === 0
      && createProject === undefined && listInvitations === undefined)) return null

  const projectScope = context.scope.kind === 'project' ? context.scope : undefined
  const currentLabel = projectScope?.projectName ?? t('scope.personal')
  const currentScopeId = projectScope === undefined
    ? 'scope:personal'
    : `scope:project:${projectScope.projectId}`
  const selectScope = (scope: { kind: 'personal' } | { kind: 'project'; projectId: number }): void => {
    const selected = scope.kind === 'personal' ? projectScope === undefined
      : projectScope?.projectId === scope.projectId
    if (selected || state.scopeBusy) return
    setLastTarget(scope.kind === 'personal' ? scope : {
      ...scope, name: context.projects.find(project => project.projectId === scope.projectId)?.name
        ?? (lastTarget?.kind === 'project' && lastTarget.projectId === scope.projectId ? lastTarget.name : t('scope.projects')),
    })
    setOpen(false)
    void switchScope(scope.kind === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: scope.projectId })
  }
  const openManager = (scope: 'current' | 'all', view: 'received' | 'sent' | 'compose'): void => {
    setManagerScope(scope)
    setManagerView(view)
    setManagerMode('members')
  }
  /** The current scope's identity tile, shared by the hub card and the trigger. */
  const currentTile = (size: number, large = false): ReactNode => (
    projectScope === undefined
      ? (
        <span className={`${css.tile} ${css.tileRound} ${css.tileBlue}${large ? ` ${css.tileLg}` : ''}`} aria-hidden="true">
          <IconUserOutline16 size={size} />
        </span>
      )
      : projectScope.steward === true
        ? (
          <span className={`${css.tile} ${css.tileWarn}${large ? ` ${css.tileLg}` : ''}`} aria-hidden="true">
            <IconShieldOutline16 size={size} />
          </span>
        )
        : (
          <span className={`${css.tile} ${tileTone(projectScope.projectName)}${large ? ` ${css.tileLg}` : ''}`} aria-hidden="true">
            {tileGlyph(projectScope.projectName)}
          </span>
        )
  )
  const projectEntries: MenuEntry[] = visibleProjects.map((project) => {
    const flag = grantText(project)
    return {
      id: `scope:project:${project.projectId}`,
      label: (
        <span className={css.scopeRow}>
          {project.kind === 'steward'
            ? (
              <span className={`${css.tile} ${css.tileWarn}`} aria-hidden="true">
                <IconShieldOutline16 size={11} />
              </span>
            )
            : (
              <span className={`${css.tile} ${tileTone(project.name)}`} aria-hidden="true">
                {tileGlyph(project.name)}
              </span>
            )}
          <span className={css.scopeName}>{project.name}</span>
          {flag !== '' && (
            <span className={project.kind === 'steward'
              ? css.scopeFlagWarn
              : project.mode === 'ro' && project.canManage !== true ? css.scopeFlagMark : css.scopeFlag}>
              {flag}
            </span>
          )}
        </span>
      ),
      disabled: state.scopeBusy,
    }
  })
  if (visibleProjects.length === 0 && normalizedProjectQuery !== '') {
    projectEntries.push({
      type: 'label', id: 'project-search-empty', text: t('scope.searchEmpty'),
    })
  }
  const entries: MenuEntry[] = [
    {
      id: 'scope:personal',
      label: (
        <span className={css.scopeRow}>
          <span className={`${css.tile} ${css.tileRound} ${css.tileBlue}`} aria-hidden="true">
            <IconUserOutline16 size={11} />
          </span>
          <span className={css.scopeName}>{t('scope.personal')}</span>
          <span className={css.scopeFlag}>{t('scope.personalFlag')}</span>
        </span>
      ),
      disabled: state.scopeBusy,
    },
    { type: 'separator', id: 'scope-separator' },
    { type: 'label', id: 'project-label', text: t('scope.projects') },
    ...projectEntries,
  ]

  const currentProject = projectScope === undefined
    ? undefined
    : context.projects.find(project => project.projectId === projectScope.projectId)
  const settingsAvailable = projectScope !== undefined && currentProject !== undefined
    && loadProjectConfiguration !== undefined && setProjectThemePolicy !== undefined
  // The rail menu pins every capability as a footer entry. The wide page
  // renders the same actions as rows, so these entries never reach it.
  const footerEntries: MenuEntry[] = []
  if (createProject !== undefined) {
    footerEntries.push({
      id: 'project:create',
      label: t('manager.createAction'),
      icon: <IconPlusOutline16 size={16} />,
    })
  }
  if (listInvitations !== undefined) {
    footerEntries.push({
      id: 'project:members',
      label: (
        <span className={css.entryLabel}>
          {currentProject?.canManage === true ? t('manager.membersAction') : t('manager.invitationsAction')}
          {invitationCount > 0 && <span className={css.badge}>{invitationCount}</span>}
        </span>
      ),
      icon: <IconUsersOutline16 size={16} />,
    })
  }
  // Keep the entry visible to every project member. The panel explains which
  // namespaces are owner-managed, so a disabled action is understandable
  // instead of looking like a missing feature.
  if (settingsAvailable) {
    footerEntries.push({
      id: 'project:settings',
      label: t('manager.settingsAction'),
      icon: <IconSettingsOutline16 size={16} />,
    })
  }

  // The rail menu stages visibility inline; the page pushes it one level
  // deep from the settings group instead.
  if (projectScope?.mode === 'rw') {
    entries.push(
      { type: 'separator', id: 'visibility-separator' },
      { type: 'label', id: 'visibility-label', text: t('newConversation.label') },
      {
        id: 'visibility:project',
        label: (
          <span className={css.menuText}>
            <span className={css.menuTitle}>{t('visibility.project')}</span>
            <span className={css.menuDescription}>{t('visibility.project.description')}</span>
          </span>
        ),
        icon: <IconGlobeOutline14 size={16} />,
      },
      {
        id: 'visibility:private',
        label: (
          <span className={css.menuText}>
            <span className={css.menuTitle}>{t('visibility.private')}</span>
            <span className={css.menuDescription}>{t('visibility.private.description')}</span>
          </span>
        ),
        icon: <IconUserOutline16 size={16} />,
      },
    )
  }

  const scopeTitle = state.scopeError === undefined
    ? state.scopeBusy ? t('scope.switching') : t('scope.aria')
    : t('scope.failed')
  const searchField = context.projects.length > 0 && (
    <div className={css.menuSearch}>
      <span className={css.menuSearchIcon} aria-hidden="true">
        <IconSearchOutline16 size={16} />
      </span>
      <input
        type="search"
        className={css.menuSearchInput}
        aria-label={t('scope.searchAria')}
        placeholder={t('scope.searchPlaceholder')}
        value={projectQuery}
        onChange={(event) => { setProjectQuery(event.currentTarget.value) }}
      />
      {projectQuery.length > 0 && (
        <button
          type="button"
          className={css.menuSearchClear}
          aria-label={t('scope.searchClear')}
          onClick={() => { setProjectQuery('') }}
        >
          <span aria-hidden="true"><IconCloseFill14 size={14} /></span>
        </button>
      )}
    </div>
  )
  // The rail menu keeps the compact header — a title plus the search field.
  const menuHeader = (
    <>
      <div className={css.sheetHead}>
        <div className={css.menuHeader}>{t('scope.menuTitle')}</div>
      </div>
      {searchField}
    </>
  )

  const trigger = (
    <button
      type="button"
      ref={triggerRef}
      className={wide ? css.trigger : `${css.trigger} ${css.rail}`}
      aria-label={t('scope.aria')}
      aria-expanded={open}
      {...(wide
        ? { 'aria-controls': pageId }
        : { 'aria-haspopup': 'menu' as const })}
      title={scopeTitle}
      disabled={state.scopeBusy}
      onClick={() => { setOpen(value => !value) }}
    >
      {state.scopeError === undefined
        ? currentTile(wide ? 12 : 11)
        : <IconWarningOutline16 size={wide ? 16 : 18} />}
      {wide && (
        <>
          <span className={css.label}>{currentLabel}</span>
          {/* The page's hero states the scope mode; the trigger flag only
              marks non-default scopes — maintenance or read-only. */}
          {projectScope !== undefined && (projectScope.steward === true || projectScope.mode === 'ro') && (
            <span className={projectScope.steward === true ? css.modeFlagWarn : css.modeFlag}>
              {projectScope.steward === true ? t('scope.steward') : t('scope.readOnly')}
            </span>
          )}
          <IconChevronRightOutline14 className={css.chevron} />
        </>
      )}
    </button>
  )
  const pageCheck = <span className={css.pageCheck} aria-hidden="true"><IconCheckOutline16 size={16} /></span>
  const pageDisclose = <IconChevronRightOutline14 className={css.pageDisclose} size={14} />
  const currentSource = projectScope === undefined ? t('visibility.private')
    : projectScope.steward === true ? t('scope.stewardSource')
      : currentProject?.origin === 'admin' ? t('scope.adminSource')
        : currentProject?.origin === 'user'
          ? t('scope.userSource', { name: currentProject.owner?.id === context.user.id
            ? t('scope.you') : currentProject.owner?.displayName || currentProject.owner?.username || t('project.ownerUnknown') })
          : t('scope.projects')
  return (
    <>
      {/* The rail renders its trigger through the Menu anchor; wide owns the
          trigger row plus the pushed page. */}
      {wide && trigger}
      {open && wide && (
        <div ref={pageRef} id={pageId} className={css.scopePage} role="dialog" tabIndex={-1}
          aria-modal={childDialogOpen ? undefined : true} aria-hidden={childDialogOpen ? true : undefined}
          aria-label={t('scope.aria')}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing
              || event.ctrlKey || event.altKey || event.metaKey) return
            event.preventDefault()
            event.stopPropagation()
            goBack()
          }}>
          <header className={css.pageNav}>
            <Tooltip label={pageView === 'visibility' ? t('scope.backManage') : t('scope.returnWorkbench')}
              side="bottom" portal disabled={compact}>
              <button type="button" className={css.pageBack} onClick={goBack}
                aria-label={pageView === 'visibility' ? t('scope.backManage') : t('scope.returnWorkbench')}>
                <IconChevronLeftOutline14 size={16} />
              </button>
            </Tooltip>
            <h2 ref={pageHeading} tabIndex={-1} className={css.pageTitle}>
              {pageView === 'visibility' ? t('newConversation.label') : t('scope.centerTitle')}
            </h2>
            {pageView === 'root' && createProject !== undefined && (
              <Tooltip label={t('manager.createAction')} side="bottom" portal disabled={compact}>
                <button type="button" className={css.pageBack} aria-label={t('manager.createAction')}
                  onClick={() => { setManagerMode('create') }}><IconPlusOutline16 size={16} /></button>
              </Tooltip>
            )}
          </header>
          {pageView === 'visibility' ? (
            <div className={`${css.pageScroll} ${pageNav === 'pop' ? css.pagePop : css.pagePush}`}>
              <p className={css.pageHint}>{t('scope.visibilityHint')}</p>
              <fieldset className={css.visibilityOptions} aria-label={t('newConversation.label')}>
                {(['project', 'private'] as const).map(value => (
                  <label key={value} className={css.visibilityOption} data-selected={state.stagedVisibility === value}>
                    <input type="radio" name={`${pageId}-visibility`} value={value}
                      checked={state.stagedVisibility === value} onChange={() => { stageVisibility(value) }} />
                    <span><strong>{t(`visibility.${value}`)}</strong><small>{t(`visibility.${value}.description`)}</small></span>
                  </label>
                ))}
              </fieldset>
              <p className={css.pageHint}>{t('scope.visibilityLifetime')}</p>
            </div>
          ) : (
            <>
              <div className={css.pageHero}>
                {state.scopeError === undefined ? currentTile(16, true) : <IconWarningOutline16 size={18} />}
                <span className={css.pageHeroBody}>
                  <span className={css.pageHeroMeta}>{currentSource}</span>
                  <span className={css.pageHeroName}>{currentLabel}</span>
                </span>
                {settingsAvailable && (
                  <Tooltip label={t('manager.settingsAction')} side="bottom" portal disabled={compact}>
                    <button type="button" className={css.pageBack} aria-label={t('manager.settingsAction')}
                      onClick={() => { setProjectSettingsOpen(true) }}><IconSettingsOutline16 size={16} /></button>
                  </Tooltip>
                )}
              </div>
              <SegmentedTabs<'list' | 'manage'> variant="underline" className={css.hubTabs} value={hubTab} onChange={setHubTab} label={t('scope.centerTitle')}
                items={[
                  { value: 'list', label: t('scope.switchTab'), id: `${pageId}-list-tab`, panelId: `${pageId}-list` },
                  { value: 'manage', label: t('scope.manageTab'), id: `${pageId}-manage-tab`, panelId: `${pageId}-manage` },
                ]} />
              {hubTab === 'list' ? (
                <>
                  {state.scopeError !== undefined && (
                    <div className={css.pageError} role="alert">
                      <span>{lastTarget?.kind === 'project' ? t('scope.failedTarget', { name: lastTarget.name }) : t('scope.failed')}</span>
                      {lastTarget !== undefined && <Button size="sm" onClick={() => { selectScope(lastTarget) }}>{t('scope.retry')}</Button>}
                    </div>
                  )}
                  <div className={css.pageSearch}>{searchField}</div>
                  <div className={css.listHeading}><span>{t('scope.allSpaces')}</span><span role="status">
                    {normalizedProjectQuery === '' ? t('scope.totalCount', { count: context.projects.length + 1 })
                      : t('scope.matchCount', { count: visibleProjects.length })}
                  </span></div>
                  <div className={css.pageScroll} id={`${pageId}-list`} role="tabpanel" aria-labelledby={`${pageId}-list-tab`}>
                    <button type="button" className={`${css.pageRow}${projectScope === undefined ? ` ${css.pageRowCurrent}` : ''}`}
                      aria-current={projectScope === undefined ? 'true' : undefined} disabled={state.scopeBusy}
                      onClick={() => { selectScope({ kind: 'personal' }) }}>
                      <span className={`${css.tile} ${css.tileRound} ${css.tileBlue}`} aria-hidden="true"><IconUserOutline16 size={14} /></span>
                      <span className={css.pageRowName}>{t('scope.personal')}</span>{projectScope === undefined && pageCheck}
                    </button>
                    <div className={css.rosterDivider} />
                    {visibleProjects.map((project) => {
                      const selected = projectScope?.projectId === project.projectId
                      const flag = grantText(project)
                      return <button key={project.projectId} type="button"
                        className={`${css.pageRow}${selected ? ` ${css.pageRowCurrent}` : ''}`}
                        aria-current={selected ? 'true' : undefined} disabled={state.scopeBusy}
                        onClick={() => { selectScope({ kind: 'project', projectId: project.projectId }) }}>
                        {project.kind === 'steward'
                          ? <span className={`${css.tile} ${css.tileWarn}`} aria-hidden="true"><IconShieldOutline16 size={14} /></span>
                          : <span className={`${css.tile} ${tileTone(project.name)}`} aria-hidden="true">{tileGlyph(project.name)}</span>}
                        <span className={css.pageRowName}>{project.name}</span>
                        {flag !== '' && <span className={project.kind === 'steward' ? css.pageValueWarn : css.pageValue}>{flag}</span>}
                        {selected && pageCheck}
                      </button>
                    })}
                    {visibleProjects.length === 0 && normalizedProjectQuery !== '' && (
                      <div className={css.emptySearch}><p>{t('scope.searchEmpty')}</p><Button onClick={() => { setProjectQuery('') }}>{t('scope.searchClear')}</Button></div>
                    )}
                  </div>
                  <footer className={css.pageFooter}>
                    <span>{t('scope.reloadHint')}</span>
                    {listInvitations !== undefined && <Button size="sm" onClick={() => { openManager('all', 'received') }}>
                      <IconUsersOutline16 size={14} />{t('scope.invitationsShort')}{invitationCount > 0 && <span className={css.badge}>{invitationCount}</span>}
                    </Button>}
                  </footer>
                </>
              ) : (
                <div className={css.pageScroll} id={`${pageId}-manage`} role="tabpanel" aria-labelledby={`${pageId}-manage-tab`}>
                  <div className={css.currentFacts}><span>{t('scope.currentSpace')}</span><strong>{currentLabel}</strong><small>{currentSource}</small></div>
                  {projectScope !== undefined && <div className={css.pageGroup}>{t('scope.currentProject')}</div>}
                  {settingsAvailable && <button type="button" className={css.managementRow} onClick={() => { setProjectSettingsOpen(true) }}>
                    <IconSettingsOutline16 size={16} /><span><strong>{t('manager.settingsAction')}</strong><small>{t('scope.configurationHint')}</small></span>{pageDisclose}
                  </button>}
                  {listInvitations !== undefined && projectScope !== undefined && <button type="button" className={css.managementRow}
                    onClick={() => {
                      if (projectScope.steward === true) setProjectSettingsOpen(true)
                      else openManager('current', currentProject?.canManage === true ? 'sent' : 'received')
                    }}>
                    <IconUsersOutline16 size={16} /><span><strong>{t('project.membersTitle')}</strong><small>{projectScope.steward === true ? t('scope.stewardInviteHint') : t('scope.projectInviteHint')}</small></span>{pageDisclose}
                  </button>}
                  {projectScope?.mode === 'rw' && <button type="button" className={css.managementRow} data-scope-visibility
                    onClick={() => { setPageNav('push'); setPageView('visibility') }}>
                    <IconGlobeOutline14 size={16} /><span><strong>{t('newConversation.label')}</strong><small>{state.stagedVisibility === 'project' ? t('visibility.project') : t('visibility.private')}</small></span>{pageDisclose}
                  </button>}
                  <div className={css.pageGroup}>{t('scope.otherActions')}</div>
                  {listInvitations !== undefined && <button type="button" className={css.managementRow} onClick={() => { openManager('all', 'received') }}>
                    <IconUsersOutline16 size={16} /><span><strong>{t('manager.invitationCenter')}</strong><small>{t('scope.inviteCenterHint')}</small></span>{invitationCount > 0 && <span className={css.badge}>{invitationCount}</span>}{pageDisclose}
                  </button>}
                  {createProject !== undefined && <button type="button" className={css.managementRow} onClick={() => { setManagerMode('create') }}>
                    <IconPlusOutline16 size={16} /><span><strong>{t('manager.createAction')}</strong><small>{t('scope.createOwnerHint')}</small></span>{pageDisclose}
                  </button>}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!wide && (
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={entries}
          header={menuHeader}
          {...footerEntries.length > 0 ? { footer: footerEntries } : {}}
          /* The rail keeps the portaled menu, which is the shared bottom
             sheet below the compact breakpoint. */
          portal
          listClassName={css.scopeMenu}
          listStyle={menuWidth === undefined ? undefined : { width: menuWidth }}
          selectedIds={[
            currentScopeId,
            ...(projectScope?.mode === 'rw' ? [`visibility:${state.stagedVisibility}`] : []),
          ]}
          onSelect={(id) => {
            setOpen(false)
            if (id === 'scope:personal') {
              selectScope({ kind: 'personal' })
              return
            }
            if (id.startsWith('scope:project:')) {
              selectScope({ kind: 'project', projectId: Number(id.slice('scope:project:'.length)) })
              return
            }
            if (id === 'project:create') {
              setManagerMode('create')
              return
            }
            if (id === 'project:members') {
              openManager('current', currentProject?.canManage === true ? 'sent' : 'received')
              return
            }
            if (id === 'project:settings') {
              setProjectSettingsOpen(true)
              return
            }
            stageVisibility(id.slice('visibility:'.length) as CollaborationVisibility)
          }}
          side="top"
          align="start"
          anchor={trigger}
        />
      )}
      {managerMode !== undefined && <ProjectManagerModal
        open
        mode={managerMode}
        currentUserId={context.user.id}
        projectName={currentProject?.name}
        initialScope={managerScope}
        initialView={managerView}
        steward={currentProject?.kind === 'steward'}
        t={t}
        {...projectScope === undefined ? {} : { projectId: projectScope.projectId }}
        {...currentProject?.canManage === true ? { canManage: true } : {}}
        {...createProject === undefined ? {} : { createProject }}
        {...listInvitations === undefined ? {} : { listInvitations }}
        {...inviteMember === undefined ? {} : { inviteMember }}
        {...acceptInvitation === undefined ? {} : { acceptInvitation }}
        {...listUsers === undefined ? {} : { listUsers }}
        onCreated={(projectId, name) => {
          setManagerMode(undefined)
          setLastTarget({ kind: 'project', projectId, name })
          setOpen(false)
          void switchScope({ kind: 'project', projectId })
        }}
        onClose={() => { setManagerMode(undefined) }}
      />}
      {projectScope !== undefined && currentProject !== undefined
        && loadProjectConfiguration !== undefined && setProjectThemePolicy !== undefined ? (
          <ProjectSettingsModal
            open={projectSettingsOpen}
            project={currentProject}
            t={t}
            load={loadProjectConfiguration}
            setThemePolicy={setProjectThemePolicy}
            {...listProjectSshTargets === undefined ? {} : { listSshTargets: listProjectSshTargets }}
            {...shareProjectSshTarget === undefined ? {} : { shareSshTarget: shareProjectSshTarget }}
            onMembers={() => {
              setProjectSettingsOpen(false)
              openManager('current', currentProject.canManage === true ? 'sent' : 'received')
            }}
            onClose={() => { setProjectSettingsOpen(false) }}
          />
        ) : null}
      {state.scopeBusy && state.scopeTarget !== undefined && (
        <ScopeSwitchStatus target={state.scopeTarget} t={t} />
      )}
    </>
  )
}
