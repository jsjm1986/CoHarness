import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, IconChevronLeftOutline14, IconCloseFill14, IconGlobeOutline14, IconSearchOutline16,
  IconPlusOutline16, IconSettingsOutline16, IconShieldOutline16, IconUserOutline16, IconUsersOutline16,
  IconWarningOutline16,
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
 * The project roster is searchable, capped to a viewport-safe menu height,
 * and presented through the shared phone sheet below the compact breakpoint.
 * @param props - composed slot props.
 * @returns scope trigger and its portaled menu, or null outside Gateway collaboration.
 */
export function ScopeControl({
  wide, useCollaboration, switchScope, stageVisibility,
  createProject, listInvitations, inviteMember, acceptInvitation, listUsers, getInvitationCount,
  loadProjectConfiguration, setProjectThemePolicy, listProjectSshTargets, shareProjectSshTarget, t,
}: ScopeControlProps) {
  const state = useCollaboration(snapshot => snapshot)
  const [open, setOpen] = useState(false)
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
  // The wide hub carries members and settings inside its header card, so the
  // pinned footer only keeps project creation. The rail menu keeps every
  // capability as a footer entry.
  const footerEntries: MenuEntry[] = []
  if (createProject !== undefined) {
    footerEntries.push({
      id: 'project:create',
      label: t('manager.createAction'),
      icon: <IconPlusOutline16 size={16} />,
    })
  }
  if (!wide) {
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
  }

  // Visibility stays a menu section on the rail; the wide hub renders it as a
  // segmented radio inside the current-space card.
  if (!wide && projectScope?.mode === 'rw') {
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
  // Wide: the sheet becomes a space hub — a persistent working surface for
  // settings, members, invitations, and visibility above the searchable list.
  // Rail keeps the compact floating menu header.
  const projectSearch = wide ? (
    <div className={css.hub}>
      <div className={css.hubHead}>
        <button
          type="button"
          className={css.hubBack}
          aria-label={t('manager.close')}
          onClick={() => { setOpen(false) }}
        >
          <IconChevronLeftOutline14 size={14} />
        </button>
        <div className={css.menuHeader}>{t('scope.menuTitle')}</div>
        <span className={css.hubCount}>{context.projects.length}</span>
      </div>
      <div className={css.currentCard}>
        <div className={css.currentTop}>
          {state.scopeError === undefined
            ? currentTile(15, true)
            : <IconWarningOutline16 size={16} />}
          <span className={css.currentBody}>
            <span className={css.currentName}>{currentLabel}</span>
            <span className={css.currentMeta}>{currentMeta}</span>
          </span>
          {settingsAvailable && (
            <button
              type="button"
              className={css.cardAct}
              aria-label={t('manager.settingsAction')}
              onClick={() => {
                setOpen(false)
                setProjectSettingsOpen(true)
              }}
            >
              <IconSettingsOutline16 size={14} />
            </button>
          )}
        </div>
        {projectScope?.mode === 'rw' && (
          <div className={css.visField}>
            <span className={css.visLabel}>{t('newConversation.label')}</span>
            <div
              className={css.visSeg}
              role="radiogroup"
              aria-label={t('newConversation.label')}
              style={{ '--dsh-vis-index': state.stagedVisibility === 'private' ? 1 : 0 } as CSSProperties}
            >
              <button
                type="button"
                role="radio"
                aria-checked={state.stagedVisibility === 'project'}
                className={`${css.visOpt}${state.stagedVisibility === 'project' ? ` ${css.visOptOn}` : ''}`}
                title={t('visibility.project.description')}
                onClick={() => { stageVisibility('project') }}
              >
                {t('visibility.project')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={state.stagedVisibility === 'private'}
                className={`${css.visOpt}${state.stagedVisibility === 'private' ? ` ${css.visOptOn}` : ''}`}
                title={t('visibility.private.description')}
                onClick={() => { stageVisibility('private') }}
              >
                {t('visibility.private')}
              </button>
            </div>
          </div>
        )}
      </div>
      {listInvitations !== undefined && (
        <button
          type="button"
          className={`${css.invRow}${invitationCount > 0 ? ` ${css.invRowWarn}` : ''}`}
          onClick={() => {
            setOpen(false)
            setManagerMode('members')
          }}
        >
          <IconUsersOutline16 size={14} />
          <span className={css.invLabel}>
            {currentProject?.canManage === true ? t('manager.membersAction') : t('manager.invitationsAction')}
          </span>
          {invitationCount > 0 && <span className={css.badge}>{invitationCount}</span>}
        </button>
      )}
      {searchField}
    </div>
  ) : (
    <>
      <div className={css.sheetHead}>
        <div className={css.menuHeader}>{t('scope.menuTitle')}</div>
      </div>
      {searchField}
    </>
  )

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={entries}
        header={projectSearch}
        {...footerEntries.length > 0 ? { footer: footerEntries } : {}}
        /* The expanded sidebar opens the list as an in-flow drawer above its
           trigger — a panel inside the card, not a floating overlay. The rail
           keeps the floating menu. */
        portal={!wide}
        className={wide ? css.scopeField : undefined}
        listClassName={wide ? `${css.scopeMenu} ${css.scopeSheet}` : css.scopeMenu}
        listStyle={wide || menuWidth === undefined ? undefined : { width: menuWidth }}
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
        anchor={(
          <button
            type="button"
            ref={triggerRef}
            className={wide
              ? `${css.trigger} ${css.context}${projectScope?.steward === true ? ` ${css.contextSteward}` : ''}`
              : `${css.trigger} ${css.rail}`}
            aria-label={t('scope.aria')}
            aria-haspopup="menu"
            aria-expanded={open}
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
                {projectScope !== undefined && (
                  <span className={projectScope.steward === true ? css.modeSteward : css.mode}>
                    {projectScope.steward === true
                      ? t('scope.steward')
                      : projectScope.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')}
                  </span>
                )}
                <IconChevronDownOutline14 className={css.chevron} />
              </>
            )}
          </button>
        )}
      />
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
