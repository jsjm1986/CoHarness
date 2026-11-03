import type { CollaborationComputer, CollaborationComputerId } from './collaboration-client.ts'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14, IconGlobeOutline14,
  IconSearchOutline16, IconPlusOutline16, IconSettingsOutline16, IconShieldOutline16, IconUserOutline16,
  IconUsersOutline16, IconWarningOutline16, IconFollowsystemOutline16,
  Button, Menu, Modal, Tag, useMediaQuery, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  CollaborationSnapshot, CollaborationVisibility, ProjectMembership,
} from './collaboration-client.ts'
import type { NS, CollaborationKey } from './locales.ts'
import { ProjectManagerModal, type ProjectManagerMode } from './ProjectManagerModal.tsx'
import { ProjectSettingsModal } from './ProjectSettingsModal.tsx'
import { ScopeSwitchStatus } from './ScopeSwitchStatus.tsx'
import { spaceDestinations, type SpaceDestination } from './space-destinations.ts'
import css from './ScopeControl.module.css'

/** Registration-side collaboration state and actions for the sidebar footer. */
export interface ScopeControlInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
    /** Entry policy shared with workspace and document features. */
    deployment: HostObservable<import('@deepseek-ai/dsh-client-runtime/client').DeploymentContextSnapshot>
  }
  /** Retry the entry-owned policy read without changing the current environment. */
  refreshDeployment?: () => Promise<void>
  /** Prepare a Runtime and navigate when this tab can recover its input. */
  switchScope: (scope: import('@deepseek-ai/dsh-client-runtime/client').SessionRuntimeTarget) => Promise<void>
  /** Keep this tab's input mounted after a target is prepared for a separate tab. */
  dismissScopeOffer?: () => void
  /** Acknowledge a failed switch while retaining the source document. */
  dismissScopeError?: () => void
  /** Bookmark the verified current Runtime; never changes the selected environment. */
  toggleFavorite?: () => void
  /** Read another bounded page of center metadata. */
  loadEnvironments?: (cursor?: string) => Promise<void>
  /** Open the authenticated selection page without changing other tabs. */
  chooseEnvironment?: () => void
  /** Open the current exact environment in a separate browser tab. */
  openEnvironmentTab?: (runtimeId: string) => void
  /** Open the existing authorized environment picker in a new tab, retaining this document's unsaved configuration. */
  openEnvironmentPickerTab?: () => void
  /** Stage visibility for the next project conversation. */
  stageVisibility: (visibility: CollaborationVisibility) => void
  /** User-owned project and invitation operations. */
  createProject?: (name: string, nodeId?: CollaborationComputerId) => Promise<number>
  listComputers?: () => Promise<CollaborationComputer[]>
  listInvitations?: (projectId?: number) => Promise<import('./collaboration-client.ts').ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw') => Promise<import('./collaboration-client.ts').ProjectInvitation>
  acceptInvitation?: (id: string) => Promise<void>
  /** List active users for the invitation member picker. */
  listUsers?: (projectId?: number) => Promise<import('./collaboration-client.ts').UserSummary[]>
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
  wide, useCollaboration, useDeployment, useSessions, switchScope, stageVisibility, refreshDeployment,
  createProject, listComputers, listInvitations, inviteMember, acceptInvitation, listUsers, getInvitationCount,
  loadProjectConfiguration, setProjectThemePolicy, listProjectSshTargets, shareProjectSshTarget, t,
  loadEnvironments, openEnvironmentTab, dismissScopeOffer, dismissScopeError, toggleFavorite,
}: ScopeControlProps) {
  const state = useCollaboration(snapshot => snapshot)
  const deployment = useDeployment(snapshot => snapshot)
  const showComputer = deployment.showComputer
  const currentRuntimeId = useSessions(snapshot => snapshot.current === undefined
    ? undefined : snapshot.byId[snapshot.current]?.runtime?.runtimeId)
  const [open, setOpen] = useState(false)
  // The page stacks one level deep: the root lists spaces plus the settings
  // group, and the visibility picker pushes in from the root's disclosure
  // row. `pageNav` only steers the remount animation direction.
  const [pageView, setPageView] = useState<'root' | 'visibility'>('root')
  const [pageNav, setPageNav] = useState<'push' | 'pop'>('push')
  const pageId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const phone = useMediaQuery('(max-width: 767px)')
  useLayoutEffect(() => {
    if (!open || !wide) return
    backRef.current?.focus({ preventScroll: true })
    const page = pageRef.current
    return () => { queueMicrotask(() => {
      if (document.activeElement === document.body || page?.contains(document.activeElement)) {
        triggerRef.current?.focus({ preventScroll: true })
      }
    }) }
  }, [open, wide])
  useLayoutEffect(() => {
    if (!open || !wide) return
    const page = pageRef.current
    const sidebar = page?.closest<HTMLElement>('[data-sidebar-root]')
    if (page === null || sidebar === undefined || sidebar === null) return
    const covered = new Set<HTMLElement>()
    if (phone) {
      for (let branch: HTMLElement | null = page; branch !== null && branch !== sidebar; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling !== branch && sibling instanceof HTMLElement) covered.add(sibling)
        }
      }
    } else {
      const browsing = sidebar.querySelector<HTMLElement>('[data-sidebar-browsing]')
      if (browsing !== null) covered.add(browsing)
    }
    const previous = [...covered].map(element => ({ element, inert: element.inert }))
    for (const { element } of previous) element.inert = true
    if (previous.some(({ element }) => element.contains(document.activeElement))) backRef.current?.focus({ preventScroll: true })
    return () => { for (const { element, inert } of previous) element.inert = inert }
  }, [open, wide, phone])
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
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [invitationCount, setInvitationCount] = useState(0)
  const [projectQuery, setProjectQuery] = useState('')
  const context = state.context
  const normalizedProjectQuery = projectQuery.trim().toLowerCase()
  const destinations = spaceDestinations(state, deployment.aggregateComputers ? undefined : deployment.context?.entry.nodeId)
  const visibleDestinations = destinations.filter(item => normalizedProjectQuery === ''
    || `${item.name} ${showComputer ? item.nodeName ?? '' : ''} ${item.target.kind === 'personal' ? t('scope.personal') : ''} ${item.target.runtimeId ?? ''}`.toLowerCase().includes(normalizedProjectQuery))
  const favorites = new Set(state.favoriteRuntimeIds ?? [])
  const favoriteSpaces = visibleDestinations.filter(item => item.target.runtimeId !== undefined && favorites.has(item.target.runtimeId))
  const recentSpaces = (state.recentRuntimeIds ?? []).flatMap((id) => {
    const item = visibleDestinations.find(destination => destination.target.runtimeId === id)
    return item === undefined || favorites.has(id) ? [] : [item]
  })
  const promoted = new Set([...favoriteSpaces, ...recentSpaces].map(item => item.id))
  const remaining = visibleDestinations.filter(item => !promoted.has(item.id))
  const spaceGroups = [
    { id: 'favorites', label: t('scope.favorites'), items: favoriteSpaces },
    { id: 'recent', label: t('scope.recent'), items: recentSpaces },
    { id: 'personal', label: t('scope.personal'), items: remaining.filter(item => item.target.kind === 'personal') },
    { id: 'projects', label: t('scope.projects'), items: remaining.filter(item => item.target.kind === 'project') },
  ].filter(group => group.items.length > 0)

  // The grant flag answers "what differs from your usual access": the tier
  // that dominates the roster — admin or plain read-write — carries no
  // information, so it renders unflagged and only the minority tier (plus
  // personal, read-only, and steward) keeps a mark. A tie suppresses admin,
  // the visually heavier label. The tally reads the full roster, never the
  // filtered view, so searching cannot flip which tier stays quiet.
  const adminGrantCount = context === undefined ? 0
    : context.projects.filter(project => project.kind !== 'steward' && project.canManage === true).length
  const rwGrantCount = context === undefined ? 0
    : context.projects.filter(project => project.kind !== 'steward' && project.canManage !== true && project.mode === 'rw').length
  const suppressedGrant: 'admin' | 'rw' = adminGrantCount >= rwGrantCount ? 'admin' : 'rw'
  const grantText = (project: ProjectMembership): string => (
    project.kind === 'steward'
      ? t('scope.steward')
      : project.canManage === true
        ? (suppressedGrant === 'admin' ? '' : t('scope.admin'))
        : project.mode === 'ro'
          ? t('scope.readOnly')
          : (suppressedGrant === 'rw' ? '' : t('scope.readWrite'))
  )

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
      setPageNav('push')
    }
  }, [open])
  useEffect(() => {
    if (!open || !wide) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pageView === 'visibility') {
        setPageNav('pop')
        setPageView('root')
        return
      }
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, pageView, wide])
  if (state.status !== 'ready' || context === undefined
    || (context.scope.kind === 'personal' && context.projects.length === 0
      && createProject === undefined && listInvitations === undefined && context.environment === undefined)) return null

  const projectScope = context.scope.kind === 'project' ? context.scope : undefined
  const currentLabel = projectScope?.projectName ?? t('scope.personal')
  const currentScopeId = destinations.find(item => item.current)?.id
  const environment = context.environment
  const selectDestination = (destination: SpaceDestination): void => {
    setOpen(false)
    if (!destination.current) void switchScope(destination.target)
  }
  const destinationName = (destination: SpaceDestination): string => {
    if (destination.target.kind === 'project') return destination.name
    return t('scope.personal')
  }
  const destinationState = (destination: SpaceDestination): ReactNode => {
    const status = destination.state
    if (status === undefined) return null
    const key = status.nodeStatus === 'offline' ? 'computer.state.offline'
      : status.nodeStatus === 'draining' ? 'computer.state.draining'
        : status.provisioning === 'preparing' ? 'computer.state.preparing'
          : status.observedState === 'stopped' ? 'computer.state.stopped'
            : status.observedState === 'ready' || status.observedState === 'running' ? 'computer.state.ready'
              : status.observedState === 'starting' ? 'computer.state.starting' : 'computer.state.unavailable'
    return key === 'computer.state.ready' ? null : <Tag tone="warning">{t(key)}</Tag>
  }
  const destinationLabel = (destination: SpaceDestination): ReactNode => (
    <span className={css.scopeRow}>
      <span className={`${css.tile} ${destination.target.kind === 'personal' ? `${css.tileRound} ${css.tileBlue}`
        : destination.project?.kind === 'steward' ? css.tileWarn : tileTone(destination.name)}`} aria-hidden="true">
        {destination.target.kind === 'personal' ? <IconUserOutline16 size={11} />
          : destination.project?.kind === 'steward' ? <IconShieldOutline16 size={11} /> : tileGlyph(destination.name)}
      </span>
      <span className={css.destinationText}>
        <span className={css.scopeName}>{destinationName(destination)}</span>
        {showComputer && destination.nodeName !== undefined && <span className={css.destinationComputer}>{destination.nodeName}</span>}
        {destinationState(destination)}
      </span>
      {destination.project !== undefined && grantText(destination.project) !== '' && (
        <span className={destination.project.kind === 'steward' ? css.scopeFlagWarn
          : destination.project.mode === 'ro' && destination.project.canManage !== true ? css.scopeFlagMark : css.scopeFlag}>
          {grantText(destination.project)}
        </span>
      )}
    </span>
  )
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
  const entries: MenuEntry[] = [
    ...spaceGroups.flatMap(group => [
      { type: 'label' as const, id: `${group.id}-label`, text: group.label },
      ...group.items.map(destination => ({ id: destination.id, label: destinationLabel(destination),
        disabled: state.scopeBusy || !state.contextVerified })),
    ]),
    ...visibleDestinations.length === 0 ? [{ type: 'label' as const, id: 'space-search-empty', text: t('scope.searchEmpty') }] : [],
    ...state.environmentsError ? [{ type: 'label' as const, id: 'directory-error', text: t('computer.directoryError') }] : [],
    ...state.spacePreferencesError ? [{ type: 'label' as const, id: 'favorite-error', text: t('scope.favoriteFailed') }] : [],
  ]

  const currentProject = projectScope === undefined
    ? undefined
    : context.projects.find(project => project.projectId === projectScope.projectId)
  const settingsAvailable = projectScope !== undefined && currentProject !== undefined
    && loadProjectConfiguration !== undefined && setProjectThemePolicy !== undefined
  // The rail menu pins every capability as a footer entry. The wide page
  // renders the same actions as rows, so these entries never reach it.
  const footerEntries: MenuEntry[] = []
  if (openEnvironmentTab !== undefined && environment !== undefined) footerEntries.push({
    id: 'environment:new-tab', label: t('computer.newTab'),
    disabled: !state.contextVerified || state.scopeBusy,
  })
  if (toggleFavorite !== undefined && environment !== undefined) footerEntries.push({
    id: 'favorite:toggle', label: t(favorites.has(environment.id) ? 'scope.unfavorite' : 'scope.favorite'),
    disabled: !state.contextVerified || state.scopeBusy,
  })
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
  if (loadEnvironments !== undefined) {
    if (state.environments?.nextCursor) footerEntries.push({ id: 'directory:more', label: t('scope.more'), disabled: state.environmentsLoading === true || state.scopeBusy })
    footerEntries.push({ id: 'directory:refresh', label: t('scope.refresh'), disabled: state.environmentsLoading === true || state.scopeBusy })
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

  const failureKeys: Partial<Record<string, CollaborationKey>> = {
    offline: 'scope.failure.offline', busy: 'scope.failure.busy', quota: 'scope.failure.quota', preparing: 'scope.failure.preparing',
    timeout: 'scope.failure.timeout', forbidden: 'scope.failure.forbidden', retired: 'scope.failure.retired', auth: 'scope.failure.auth',
    'draft-unsaved': 'scope.draftPreserved',
  }
  const failureKey = state.scopeError === undefined ? 'scope.failed' : failureKeys[state.scopeError] ?? 'scope.failed'
  const failedDestination = destinations.find(item => item.target.runtimeId !== undefined
    && item.target.runtimeId === state.scopeFailedTarget?.runtimeId)
  const failureName = failedDestination === undefined ? '' : `${destinationName(failedDestination)}${showComputer && failedDestination.nodeName !== undefined ? ` · ${failedDestination.nodeName}` : ''}`
  const scopeTitle = state.scopeError === undefined
    ? state.scopeBusy ? t('scope.switching') : t('scope.aria')
    : t('scope.failed')
  const currentMeta = state.scopeError !== undefined
    ? t('scope.failed')
    : state.scopeBusy
      ? t('scope.switching')
      : projectScope === undefined
        ? t('visibility.private')
        : projectScope.steward === true
          ? t('scope.steward')
          : projectScope.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')
  const searchField = destinations.length > 0 && (
    <div className={css.menuSearch}>
      <span className={css.menuSearchIcon} aria-hidden="true">
        <IconSearchOutline16 size={16} />
      </span>
      <input
        type="search"
        className={css.menuSearchInput}
        aria-label={t(showComputer ? 'scope.searchAria' : 'scope.searchLocal')}
        placeholder={t(showComputer ? 'scope.searchPlaceholder' : 'scope.searchLocal')}
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
      data-has-computer={showComputer && projectScope !== undefined && environment?.nodeName !== undefined || undefined}
      aria-description={!showComputer || projectScope === undefined || environment?.nodeName === undefined ? undefined : `${t('computer.label')}: ${environment.nodeName}`}
      {...(wide
        ? { 'aria-controls': pageId }
        : { 'aria-haspopup': 'menu' as const })}
      title={scopeTitle}
      disabled={state.scopeBusy}
      onClick={() => {
        if (!open && state.environments === undefined && !state.environmentsLoading) void loadEnvironments?.()
        setOpen(value => !value)
      }}
    >
      {state.scopeError === undefined
        ? currentTile(wide ? 12 : 11)
        : <IconWarningOutline16 size={wide ? 16 : 18} />}
      {wide && (
        <>
          <span className={css.scopeIdentity}>
            <span className={css.label}>{currentLabel}</span>
            {showComputer && projectScope !== undefined && environment?.nodeName !== undefined && <span className={css.currentComputer}>
              <IconFollowsystemOutline16 size={12} /><span>{environment.nodeName}</span>
            </span>}
          </span>
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
  const pageCheck = (
    <span className={css.pageCheck} aria-hidden="true"><IconCheckOutline16 size={16} /></span>
  )
  const pageDisclose = <IconChevronRightOutline14 className={css.pageDisclose} size={14} />
  const goBack = (): void => {
    if (pageView === 'visibility') {
      setPageNav('pop')
      setPageView('root')
      return
    }
    setOpen(false)
  }
  return (
    <>
      {/* The rail renders its trigger through the Menu anchor; wide owns the
          trigger row plus the pushed page. */}
      {wide && trigger}
      {state.scopeError !== undefined && <Modal open onClose={() => { dismissScopeError?.() }} title={t('scope.failed')} closeLabel={t('manager.close')}
        footer={<>
          <Button onClick={() => { dismissScopeError?.() }}>{t('scope.stay')}</Button>
          {state.scopeFailedTarget !== undefined && !['forbidden', 'retired', 'auth'].includes(state.scopeError)
            ? <Button variant="primary" disabled={state.scopeBusy || !state.contextVerified} onClick={() => { if (state.scopeFailedTarget !== undefined) void switchScope(state.scopeFailedTarget) }}>{t('scope.retry')}</Button>
            : <Button variant="primary" disabled={state.environmentsLoading === true} onClick={() => { dismissScopeError?.(); setOpen(true); void loadEnvironments?.() }}>{t('scope.refresh')}</Button>}
        </>}>
        {failureName !== '' && <p><strong>{failureName}</strong></p>}
        <p role="alert">{t(failureKey)}</p>
      </Modal>}
      {open && wide && (
        /* The page stacks one level deep: the root carries the hero, the
           settings group, and the roster; visibility pushes in as the second
           level. CSS scopes the surface — whole drawer on compact, the
           browsing region on wider layouts. */
        <div ref={pageRef} id={pageId} className={css.scopePage} role="group" aria-label={t('scope.aria')}>
          <div className={css.pageNav}>
            <button
              type="button"
              ref={backRef}
              className={css.pageBack}
              aria-label={t('manager.close')}
              onClick={goBack}
            >
              <IconChevronLeftOutline14 size={16} />
            </button>
            <span className={css.pageTitle}>
              {pageView === 'visibility' ? t('newConversation.label') : t('scope.menuTitle')}
            </span>
          </div>
          <div key={pageView} className={`${css.pageScroll} ${pageNav === 'pop' ? css.pagePop : css.pagePush}`}>
            {pageView === 'visibility' ? (
              <>
                <button
                  type="button"
                  className={css.pageRow}
                  onClick={() => { stageVisibility('project') }}
                >
                  <span className={css.pageIcon} aria-hidden="true"><IconGlobeOutline14 size={16} /></span>
                  <span className={css.pageRowText}>
                    <span className={css.pageRowName}>{t('visibility.project')}</span>
                    <span className={css.pageRowMeta}>{t('visibility.project.description')}</span>
                  </span>
                  {state.stagedVisibility === 'project' && pageCheck}
                </button>
                <button
                  type="button"
                  className={css.pageRow}
                  onClick={() => { stageVisibility('private') }}
                >
                  <span className={css.pageIcon} aria-hidden="true"><IconUserOutline16 size={16} /></span>
                  <span className={css.pageRowText}>
                    <span className={css.pageRowName}>{t('visibility.private')}</span>
                    <span className={css.pageRowMeta}>{t('visibility.private.description')}</span>
                  </span>
                  {state.stagedVisibility === 'private' && pageCheck}
                </button>
              </>
            ) : (
              <>
                <div className={css.pageHero}>
                  {state.scopeError === undefined
                    ? currentTile(15, true)
                    : <IconWarningOutline16 size={18} />}
                  <span className={css.pageHeroBody}>
                    <span className={css.pageHeroName}>{currentLabel}</span>
                    <span className={css.pageHeroMeta}>{currentMeta}</span>
                  </span>
                  {settingsAvailable && (
                    <button
                      type="button"
                      className={css.pageManage}
                      onClick={() => {
                        setOpen(false)
                        setProjectSettingsOpen(true)
                      }}
                    >
                      {t('scope.manage')}
                      {pageDisclose}
                    </button>
                  )}
                </div>
                <div className={css.pageGroup}>
                  {t(state.environments?.nextCursor ? 'scope.loadedSpaces' : 'scope.allSpaces')} · {destinations.length}
                </div>
                <div className={css.pageSearch}>{searchField}</div>
                {deployment.phase === 'error' && <div className={css.pageLabel} role="alert">{t('deployment.readFailed')} {refreshDeployment && <Button onClick={() => void refreshDeployment()}>{t('deployment.retry')}</Button>}</div>}
                {state.environmentsError && <div className={css.pageLabel} role="status">{t('computer.directoryError')}</div>}
                {state.spacePreferencesError && <div className={css.pageLabel} role="status">{t('scope.favoriteFailed')}</div>}
                {spaceGroups.map(group => (
                  <div key={group.id}>
                    <div className={css.pageGroup}>{group.label}</div>
                    {group.items.map(destination => (
                      <button key={destination.id} type="button"
                        className={`${css.pageRow}${destination.current ? ` ${css.pageRowCurrent}` : ''}`}
                        aria-current={destination.current ? 'true' : undefined}
                        disabled={state.scopeBusy || !state.contextVerified}
                        onClick={() => { selectDestination(destination) }}>
                        {destinationLabel(destination)}
                        {destination.current && pageCheck}
                      </button>
                    ))}
                  </div>
                ))}
                {visibleDestinations.length === 0 && <div className={css.pageLabel}>{t('scope.searchEmpty')}</div>}
                {loadEnvironments !== undefined && <>
                  {state.environments?.nextCursor && <button type="button" className={css.pageRow}
                    disabled={state.environmentsLoading === true || state.scopeBusy}
                    onClick={() => { if (state.environments?.nextCursor) void loadEnvironments(state.environments.nextCursor) }}>
                    <span className={css.pageRowName}>{t('scope.more')}</span>
                  </button>}
                  <button type="button" className={css.pageRow} disabled={state.environmentsLoading === true || state.scopeBusy}
                    onClick={() => { void loadEnvironments() }}>
                    <span className={css.pageRowName}>{t('scope.refresh')}</span>
                  </button>
                </>}
                {(toggleFavorite !== undefined || projectScope?.mode === 'rw' || listInvitations !== undefined || settingsAvailable) && (
                  <div className={css.pageGroup}>{t('scope.settingsGroup')}</div>
                )}
                {openEnvironmentTab !== undefined && environment !== undefined && <button type="button" className={css.pageRow}
                  disabled={!state.contextVerified || state.scopeBusy}
                  onClick={() => { openEnvironmentTab(currentRuntimeId ?? environment.id) }}>
                  <span className={css.pageRowName}>{t('computer.newTab')}</span>
                </button>}
                {toggleFavorite !== undefined && environment !== undefined && <button type="button" className={css.pageRow}
                  aria-pressed={favorites.has(environment.id)} disabled={!state.contextVerified || state.scopeBusy}
                  onClick={toggleFavorite}>
                  <span className={css.pageRowName}>{t(favorites.has(environment.id) ? 'scope.unfavorite' : 'scope.favorite')}</span>
                </button>}
                {projectScope?.mode === 'rw' && (
                  <button
                    type="button"
                    className={css.pageRow}
                    onClick={() => {
                      setPageNav('push')
                      setPageView('visibility')
                    }}
                  >
                    <span className={css.pageRowName}>{t('newConversation.label')}</span>
                    <span className={css.pageValue}>
                      {state.stagedVisibility === 'project' ? t('visibility.project') : t('visibility.private')}
                    </span>
                    {pageDisclose}
                  </button>
                )}
                {listInvitations !== undefined && (
                  <button
                    type="button"
                    className={css.pageRow}
                    onClick={() => {
                      setOpen(false)
                      setManagerMode('members')
                    }}
                  >
                    <span className={css.pageRowName}>
                      {currentProject?.canManage === true
                        ? t('manager.membersAction')
                        : t('manager.invitationsAction')}
                    </span>
                    {invitationCount > 0 && <span className={css.badge}>{invitationCount}</span>}
                    {pageDisclose}
                  </button>
                )}
                {settingsAvailable && (
                  <button
                    type="button"
                    className={css.pageRow}
                    onClick={() => {
                      setOpen(false)
                      setProjectSettingsOpen(true)
                    }}
                  >
                    <span className={css.pageRowName}>{t('manager.settingsAction')}</span>
                    {pageDisclose}
                  </button>
                )}
                {createProject !== undefined && (
                  <button
                    type="button"
                    className={`${css.pageRow} ${css.pageCreate}`}
                    onClick={() => {
                      setOpen(false)
                      setManagerMode('create')
                    }}
                  >
                    <span className={css.pageIcon} aria-hidden="true"><IconPlusOutline16 size={16} /></span>
                    <span className={css.pageRowName}>{t('manager.createAction')}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {!wide && (
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={deployment.phase === 'error' ? [{ id: 'deployment:refresh', label: t('deployment.readFailed'), disabled: refreshDeployment === undefined }, ...entries] : entries}
          header={menuHeader}
          {...footerEntries.length > 0 ? { footer: footerEntries } : {}}
          /* The rail keeps the portaled menu, which is the shared bottom
             sheet below the compact breakpoint. */
          portal
          listClassName={css.scopeMenu}
          listStyle={menuWidth === undefined ? undefined : { width: menuWidth }}
          selectedIds={[
            ...(currentScopeId === undefined ? [] : [currentScopeId]),
            ...(projectScope?.mode === 'rw' ? [`visibility:${state.stagedVisibility}`] : []),
          ]}
          onSelect={(id) => {
            if (id === 'deployment:refresh') { void refreshDeployment?.(); return }
            if (id === 'environment:new-tab' && environment !== undefined) {
              openEnvironmentTab?.(currentRuntimeId ?? environment.id)
              return
            }
            if (id === 'favorite:toggle') {
              toggleFavorite?.()
              return
            }
            if (id === 'directory:more') {
              void loadEnvironments?.(state.environments?.nextCursor ?? undefined)
              return
            }
            if (id === 'directory:refresh') {
              void loadEnvironments?.()
              return
            }
            const destination = destinations.find(item => item.id === id)
            if (destination !== undefined) {
              selectDestination(destination)
              return
            }
            setOpen(false)
            if (id === 'project:create') {
              setManagerMode('create')
              return
            }
            if (id === 'project:members') {
              setManagerMode('members')
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
      <ProjectManagerModal
        open={managerMode !== undefined}
        mode={managerMode ?? 'create'}
        currentUserId={context.user.id}
        t={t}
        {...deployment.aggregateComputers || deployment.context?.entry.nodeId === undefined
          ? {} : { allowedNodeId: deployment.context.entry.nodeId }}
        {...projectScope === undefined ? {} : { projectId: projectScope.projectId }}
        {...currentProject?.canManage === true ? { canManage: true } : {}}
        {...createProject === undefined ? {} : { createProject }}
        {...listComputers === undefined || !deployment.aggregateComputers ? {} : { listComputers }}
        {...context.environment === undefined ? {} : { initialNodeId: context.environment.nodeId }}
        {...listInvitations === undefined ? {} : { listInvitations }}
        {...inviteMember === undefined ? {} : { inviteMember }}
        {...acceptInvitation === undefined ? {} : { acceptInvitation }}
        {...listUsers === undefined ? {} : { listUsers }}
        onCreated={(projectId) => {
          setManagerMode(undefined)
          void switchScope({ kind: 'project', projectId })
        }}
        onClose={() => { setManagerMode(undefined) }}
      />
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
              setManagerMode('members')
            }}
            onClose={() => { setProjectSettingsOpen(false) }}
          />
        ) : null}
      {state.scopeBusy && state.scopeTarget !== undefined && (
        <ScopeSwitchStatus target={state.scopeTarget} t={t} showComputer={showComputer} />
      )}
      {state.scopeOffer !== undefined && <Modal open onClose={() => { dismissScopeOffer?.() }}
        title={t('scope.draftTitle')}
        closeLabel={t('manager.close')}
        footer={<>
          <Button onClick={() => { dismissScopeOffer?.() }}>{t('scope.stay')}</Button>
          <Button variant="primary" disabled={openEnvironmentTab === undefined} onClick={() => {
            if (state.scopeOffer !== undefined) openEnvironmentTab?.(state.scopeOffer.runtimeId)
            dismissScopeOffer?.()
          }}>{t('computer.newTab')}</Button>
        </>}>
        <p>{t('scope.draftPreserved')}</p><p>{state.scopeOffer.target.kind === 'personal' ? t('scope.personal') : state.scopeOffer.target.projectName}{!showComputer || state.scopeOffer.target.nodeName === undefined ? '' : ` · ${state.scopeOffer.target.nodeName}`}</p>
      </Modal>}
    </>
  )
}
