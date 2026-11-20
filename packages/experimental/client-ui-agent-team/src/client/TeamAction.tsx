import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamTaskView as TeamTask } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
import {
  IconChevronDownOutline14, IconCloseOutline16, IconRefreshOutline14,
  IconUserOutline16, StateDot, Switch, Tag, Tooltip,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Save the root selection; null means success, otherwise the string describes the failure. */
  selectTeamMode: (sessionId: SessionId, enabled: boolean) => Promise<string | null>
  /** Repull the root's direct-child catalog. */
  refreshMembers: (sessionId: SessionId) => Promise<void>
  openTeammate: (sessionId: SessionId, memberId: SessionId) => Promise<void>
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- the wire view filters deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function memberStatusKey(activity: 'running' | 'inactive'): TeamKey {
  return activity === 'running' ? 'memberStatus.running' : 'memberStatus.inactive'
}

/** One catalog member row as the panel renders it. */
interface MemberRow {
  readonly id: SessionId
  readonly name: string
  readonly activity: 'running' | 'inactive'
}

/** Render the root Session's mode selection, subagent roster, and shared task board. */
export function TeamAction({
  sessionId, useSession, useSessions, useProjection,
  selectTeamMode, refreshMembers, openTeammate, t,
}: TeamActionProps) {
  const addressedChild = useSession(snapshot => snapshot.subagent !== null)
  const listedChild = useSessions(state => state.byId[sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootTeamAction
    sessionId={sessionId} useSessions={useSessions} useProjection={useProjection}
    selectTeamMode={selectTeamMode} refreshMembers={refreshMembers} openTeammate={openTeammate} t={t}
  />
}

function RootTeamAction({
  sessionId, useSessions, useProjection,
  selectTeamMode, refreshMembers, openTeammate, t,
}: Pick<TeamActionProps,
  'sessionId' | 'useSessions' | 'useProjection' | 'selectTeamMode' | 'refreshMembers' | 'openTeammate' | 't'
>) {
  const team = useProjection('agentTeam')
  const catalog = useSessions(state => state.subagentsByParent[sessionId])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef(sessionId)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, align: 'end', gap: 5, margin: 16,
  })
  const positioned = position !== null
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  sessionRef.current = sessionId
  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [sessionId])

  const members: MemberRow[] = [
    { id: sessionId, name: t('lead'), activity: 'running' },
    ...(catalog?.entries ?? [])
      .filter((entry): entry is Extract<SubagentListEntry, { kind: 'child' }> => entry.kind === 'child')
      .map(entry => ({ id: entry.id, name: entry.label ?? entry.id, activity: entry.activity })),
  ]
  const teammates = members.filter(member => member.id !== sessionId)
  const enabled = team?.enabled === true
  const compact = teammates.length === 0 && (team?.tasks.length ?? 0) === 0

  const cancelHoverChange = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => cancelHoverChange, [])

  useLayoutEffect(() => {
    if (open && positioned && pinnedRef.current) panelRef.current?.focus()
  }, [open, positioned])

  const changeOpen = (next: boolean): void => {
    cancelHoverChange()
    if (!next) pinnedRef.current = false
    setOpen(next)
    if (next) void refreshMembers(sessionId).catch(() => undefined)
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverChange()
    if (open) return
    const label = triggerLabelRef.current
    /* v8 ignore next -- the label mounts with the trigger that received the hover. */
    if (label === null) return
    // Icon-only trigger (label collapsed by the header container query):
    // hover-open would surprise on such a small target, so only click opens.
    if (getComputedStyle(label).display === 'none') return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverChange()
    if (pinnedRef.current) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useDismissOnOutsidePointer(rootRef, open, changeOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelHoverChange()
      pinnedRef.current = false
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  if (team === undefined) return null

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-team-action
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        className={css.trigger}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          cancelHoverChange()
          pinnedRef.current = true
          if (!open) changeOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconUserOutline16 size={14} />
        <span ref={triggerLabelRef} className={css.triggerLabel}>{t('trigger')}</span>
        {enabled && teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={compact ? `${css.panel} ${css.panelCompact}` : css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
          onMouseEnter={cancelHoverChange}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            <button
              type="button" className={css.iconButton} aria-label={t('refresh')}
              onClick={() => { void refreshMembers(sessionId).catch(() => undefined) }}
            >
              <IconRefreshOutline14 />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={() => { changeOpen(false) }}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <TeamModeRow
            sessionId={sessionId}
            enabled={enabled}
            selectTeamMode={selectTeamMode}
            onError={setError}
            t={t}
          />
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {team.failure !== undefined && (
            <div className={css.error} role="alert">{t('failure', { message: team.failure })}</div>
          )}
          {!enabled && <div className={css.notice}>{t('mode.disabled')}</div>}
          {enabled && (
            <>
              <section>
                <h3>
                  {t('roster')}
                  {members.length > 1 && <span className={css.count}>{members.length}</span>}
                </h3>
                <div className={css.roster}>
                  {members.map(member => (
                    <TeamMemberRow
                      key={member.id}
                      member={member}
                      memberCount={members.length}
                      sessionId={sessionId}
                      openTeammate={openTeammate}
                      onOpened={() => { if (sessionRef.current === sessionId) changeOpen(false) }}
                      onError={setError}
                      t={t}
                    />
                  ))}
                </div>
              </section>
              <section>
                {team.tasks.length === 0
                  ? <div className={css.notice}>{t('empty')}</div>
                  : (
                    <>
                      <h3>
                        {t('tasks')}
                        <span className={css.count}>{team.tasks.length}</span>
                      </h3>
                      <div className={css.tasks}>
                        {team.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
                      </div>
                    </>
                  )}
              </section>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Saved-mode switch; disabling arms a two-step confirmation inside the row. */
function TeamModeRow({
  sessionId, enabled, selectTeamMode, onError, t,
}: {
  sessionId: SessionId
  enabled: boolean
  selectTeamMode: TeamActionInjected['selectTeamMode']
  onError: (message: string) => void
  t: TeamActionProps['t']
}) {
  const [pending, setPending] = useState(false)
  const [armed, setArmed] = useState(false)
  useEffect(() => { setArmed(false) }, [sessionId])
  const select = (next: boolean): void => {
    if (pending) return
    if (!next && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setPending(true)
    void selectTeamMode(sessionId, next).then((failure) => {
      if (failure !== null) onError(t('mode.failed', { message: failure }))
    }, (reason: unknown) => {
      onError(t('mode.failed', { message: reason instanceof Error ? reason.message : String(reason) }))
    }).finally(() => { setPending(false) })
  }
  return (
    <div className={css.modeRow} data-team-mode>
      <span className={css.modeLabel}>
        <Tooltip label={t('mode.description')} side="bottom" gap={4}>
          <span>{t('mode.label')}</span>
        </Tooltip>
      </span>
      {armed && (
        <span className={css.modeConfirm} data-team-disable-confirm>
          <span className={css.modeWarning}>{t('disable.warning')}</span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('disable.confirm')}
            disabled={pending}
            onClick={() => { select(false) }}
          >
            {t('disable.confirm')}
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('disable.cancel')}
            disabled={pending}
            onClick={() => { setArmed(false) }}
          >
            {t('disable.cancel')}
          </button>
        </span>
      )}
      {!armed && (
        <Switch
          className={css.modeToggle}
          checked={enabled}
          disabled={pending}
          label={t('mode.label')}
          onChange={select}
        />
      )}
    </div>
  )
}

function TeamMemberRow({
  member, memberCount, sessionId, openTeammate, onOpened, onError, t,
}: {
  member: MemberRow
  memberCount: number
  sessionId: SessionId
  openTeammate: TeamActionInjected['openTeammate']
  onOpened: () => void
  onError: (message: string) => void
  t: TeamActionProps['t']
}) {
  const isCurrent = member.id === sessionId
  const highlightCurrent = isCurrent && memberCount > 1

  return (
    <Tooltip label={t('open')} side="bottom" gap={4} disabled={isCurrent}>
      <button
        type="button"
        className={highlightCurrent ? `${css.member} ${css.memberCurrent}` : css.member}
        disabled={isCurrent}
        onClick={() => {
          void openTeammate(sessionId, member.id).then(onOpened, (reason: unknown) => { onError(String(reason)) })
        }}
      >
        <StateDot state={member.activity === 'running' ? 'ongoing' : 'done'} />
        <span className={css.memberText}>
          <span className={css.memberName}>
            <span className={css.memberNameText}>{member.name}</span>
            {isCurrent && <Tag tone="info" className={css.currentTag}>{t('current')}</Tag>}
          </span>
          <small>{t(memberStatusKey(member.activity))}</small>
        </span>
      </button>
    </Tooltip>
  )
}

function taskDotState(task: TeamTask): StateDotState {
  return task.status === 'in_progress' ? 'ongoing' : task.status === 'pending' && !task.ready ? 'warning' : 'done'
}

/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, t }: { task: TeamTask; t: TeamActionProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  const owner = task.ownerName ?? task.ownerId ?? t('unowned')
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(statusKey(task.status))}</span>
        </span>
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      <div className={css.meta}>
        {(clamped || expanded) && (
          <button
            type="button"
            className={css.expandToggle}
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {t(expanded ? 'task.collapse' : 'task.expand')}
            <IconChevronDownOutline14 size={12} className={expanded ? css.expandToggleOpen : undefined} />
          </button>
        )}
        <span>{task.id}</span>
        <span>{t('owner')}: {owner}</span>
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
        {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
        {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
      </div>
    </article>
  )
}
