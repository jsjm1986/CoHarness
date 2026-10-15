import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14, IconGlobeOutline14,
  IconSearchOutline16, IconPlusOutline16, IconSettingsOutline16, IconShieldOutline16, IconUserOutline16,
  IconUsersOutline16, IconWarningOutline16,
  Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  CollaborationSnapshot, CollaborationVisibility,
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
  // The page stacks one level deep: the root lists spaces plus the settings
  // group, and the visibility picker pushes in from the root's disclosure
  // row. `pageNav` only steers the remount animation direction.
  const [pageView, setPageView] = useState<'root' | 'visibility'>('root')
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
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [invitationCount, setInvitationCount] = useState(0)
  const [projectQuery, setProjectQuery] = useState('')
  const context = state.context
  const normalizedProjectQuery = projectQuery.trim().toLowerCase()
  const visibleProjects = context === undefined || normalizedProjectQuery === ''
    ? context?.projects ?? []
    : context.projects.filter(project => project.name.toLowerCase().includes(normalizedProjectQuery))

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
      && createProject === undefined && listInvitations === undefined)) return null

  const projectScope = context.scope.kind === 'project' ? context.scope : undefined
  const currentLabel = projectScope?.projectName ?? t('scope.personal')
  const currentScopeId = projectScope === undefined
    ? 'scope:personal'
    : `scope:project:${projectScope.projectId}`
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
  const projectEntries: MenuEntry[] = visibleProjects.map(project => ({
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
        <span className={project.kind === 'steward' ? css.scopeModeSteward : css.scopeMode}>
          {project.kind === 'steward'
            ? t('scope.steward')
            : project.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')}
        </span>
      </span>
    ),
    disabled: state.scopeBusy,
  }))
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
  const currentMeta = state.scopeError !== undefined
    ? t('scope.failed')
    : state.scopeBusy
      ? t('scope.switching')
      : projectScope === undefined
        ? t('visibility.private')
        : projectScope.steward === true
          ? t('scope.steward')
          : projectScope.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')
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
          {/* The page's hero states the scope mode; the trigger pill only
              flags non-default scopes — maintenance or read-only. */}
          {projectScope !== undefined && (projectScope.steward === true || projectScope.mode === 'ro') && (
            <span className={projectScope.steward === true ? css.modeSteward : css.mode}>
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
      {open && wide && (
        /* The page stacks one level deep: the root carries the hero, the
           settings group, and the roster; visibility pushes in as the second
           level. CSS scopes the surface — whole drawer on compact, the
           browsing region on wider layouts. */
        <div id={pageId} className={css.scopePage} role="group" aria-label={t('scope.aria')}>
          <div className={css.pageNav}>
            <button
              type="button"
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
                {(projectScope?.mode === 'rw' || listInvitations !== undefined || settingsAvailable) && (
                  <div className={css.pageGroup}>{t('scope.settingsGroup')}</div>
                )}
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
                <div className={css.pageGroup}>
                  {t('scope.allSpaces')} · {context.projects.length + 1}
                </div>
                {context.projects.length > 4 && (
                  <div className={css.pageSearch}>{searchField}</div>
                )}
                <button
                  type="button"
                  className={`${css.pageRow}${currentScopeId === 'scope:personal' ? ` ${css.pageRowCurrent}` : ''}`}
                  aria-current={currentScopeId === 'scope:personal' ? 'true' : undefined}
                  disabled={state.scopeBusy}
                  onClick={() => {
                    setOpen(false)
                    void switchScope({ kind: 'personal' })
                  }}
                >
                  <span className={`${css.tile} ${css.tileRound} ${css.tileBlue}`} aria-hidden="true">
                    <IconUserOutline16 size={11} />
                  </span>
                  <span className={css.pageRowName}>{t('scope.personal')}</span>
                  {currentScopeId === 'scope:personal' && pageCheck}
                </button>
                {visibleProjects.map((project) => {
                  const id = `scope:project:${project.projectId}`
                  const selected = id === currentScopeId
                  const modeText = project.kind === 'steward'
                    ? t('scope.steward')
                    : project.mode === 'ro' ? t('scope.readOnly') : ''
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`${css.pageRow}${selected ? ` ${css.pageRowCurrent}` : ''}`}
                      aria-current={selected ? 'true' : undefined}
                      disabled={state.scopeBusy}
                      onClick={() => {
                        setOpen(false)
                        void switchScope({ kind: 'project', projectId: project.projectId })
                      }}
                    >
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
                      <span className={css.pageRowName}>{project.name}</span>
                      {modeText !== '' && (
                        <span className={project.kind === 'steward' ? css.pageValueWarn : css.pageValue}>
                          {modeText}
                        </span>
                      )}
                      {selected && pageCheck}
                    </button>
                  )
                })}
                {visibleProjects.length === 0 && normalizedProjectQuery !== '' && (
                  <div className={css.pageLabel}>{t('scope.searchEmpty')}</div>
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
              void switchScope({ kind: 'personal' })
              return
            }
            if (id.startsWith('scope:project:')) {
              void switchScope({ kind: 'project', projectId: Number(id.slice('scope:project:'.length)) })
              return
            }
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
        {...projectScope === undefined ? {} : { projectId: projectScope.projectId }}
        {...currentProject?.canManage === true ? { canManage: true } : {}}
        {...createProject === undefined ? {} : { createProject }}
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
        <ScopeSwitchStatus target={state.scopeTarget} t={t} />
      )}
    </>
  )
}
