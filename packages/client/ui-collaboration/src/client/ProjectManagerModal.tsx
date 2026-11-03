import { useEffect, useId, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Button, focusWithoutRing, Input, Menu, SegmentedTabs, IconChevronDownOutline14, IconFolderOpenOutline16, IconLoadingOutline16, IconPlusOutline16, IconUsersOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationComputer, CollaborationComputerId, ProjectInvitation, UserSummary } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import { CollaborationDialog } from './CollaborationDialog.tsx'
import css from './ProjectManagerModal.module.css'

/** Which project-management surface the modal is showing. */
export type ProjectManagerMode = 'create' | 'members'

/** Controlled project-management modal props. */
export interface ProjectManagerModalProps {
  open: boolean
  mode: ProjectManagerMode
  projectId?: number
  projectName?: string | undefined
  canManage?: boolean
  steward?: boolean
  initialScope?: 'current' | 'all'
  initialView?: 'received' | 'sent' | 'compose'
  currentUserId: number
  t: (key: CollaborationKey, params?: Record<string, string | number>) => string
  createProject?: (name: string, nodeId?: CollaborationComputerId) => Promise<number>
  listComputers?: () => Promise<CollaborationComputer[]>
  initialNodeId?: string
  /** Only this computer is available when this entry has local scope. */
  allowedNodeId?: CollaborationComputerId
  listInvitations?: (projectId?: number) => Promise<ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw') => Promise<ProjectInvitation>
  acceptInvitation?: (id: string) => Promise<void>
  listUsers?: (projectId?: number) => Promise<UserSummary[]>
  /** Enter the confirmed project and retain its name for switch recovery. */
  onCreated: (projectId: number) => void
  onClose: () => void
}

function errorText(error: unknown, t: ProjectManagerModalProps['t'], fallback: CollaborationKey = 'manager.failed'): string {
  if (error instanceof Error && error.message !== '') {
    const known: Record<string, CollaborationKey> = {
      'invitation-already-pending': 'manager.invitationPending',
      'invitation-already-member': 'manager.alreadyMember',
      'user-not-found': 'manager.userNotFound',
      'user-disabled': 'manager.userDisabled',
      'invitation-computer-required': 'manager.computerRequired',
      'invitation-forbidden': 'manager.invitationForbidden',
      forbidden: 'manager.invitationForbidden',
      'invitation-expired': 'manager.invitationExpired',
      'invitation-not-pending': 'manager.invitationNotPending',
      'invalid-invitation-id': 'manager.invalidInvitation',
      'cannot-invite-self': 'manager.cannotInviteSelf',
      'owner-protected': 'manager.ownerProtected',
      'owner-must-be-rw': 'manager.ownerMustRw',
      'project-not-found': 'manager.projectNotFound',
      'invitation-not-found': 'manager.invitationNotFound',
      'managed-projects-unavailable': 'manager.unavailable',
    }
    const key = known[error.message]
    if (key !== undefined) return t(key)
  }
  return t(fallback)
}

/** Keep incoming invitations readable when a separate project-management read fails. */
async function readInvitations(
  list: (projectId?: number) => Promise<ProjectInvitation[]>,
  managedProjectId: number | undefined,
): Promise<{ invitations: ProjectInvitation[]; failures: unknown[] }> {
  const results = await Promise.allSettled([
    list(),
    ...managedProjectId === undefined ? [] : [list(managedProjectId)],
  ])
  const invitations = new Map<string, ProjectInvitation>()
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
    else for (const invitation of result.value) invitations.set(invitation.id, invitation)
  }
  return { invitations: [...invitations.values()], failures }
}

/**
 * Render project creation and the scoped incoming/outgoing invitation views.
 * @param props - Existing account operations, project identity, and initial presentation.
 * @returns The controlled project creation or invitation dialog.
 */
export function ProjectManagerModal({
  open, mode, projectId, projectName, canManage = false, steward = false, currentUserId, t,
  initialScope = 'current', initialView = 'received',
  createProject, listComputers, initialNodeId, allowedNodeId,
  listInvitations, inviteMember, acceptInvitation, listUsers, onCreated, onClose,
}: ProjectManagerModalProps) {
  const id = useId()
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [memberMode, setMemberMode] = useState<'ro' | 'rw'>('rw')
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [users, setUsers] = useState<UserSummary[]>([])
  const [loadingInvitations, setLoadingInvitations] = useState(false)
  const [loadedScope, setLoadedScope] = useState<'current' | 'all' | 'none'>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [usersError, setUsersError] = useState(false)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [reload, setReload] = useState(0)
  const [usersReload, setUsersReload] = useState(0)
  const [view, setView] = useState<'list' | 'compose'>(initialView === 'compose' ? 'compose' : 'list')
  const [direction, setDirection] = useState<'received' | 'sent'>(initialView === 'sent' ? 'sent' : 'received')
  const [scope, setScope] = useState<'current' | 'all'>(projectId === undefined ? 'all' : initialScope)
  const [pendingOnly, setPendingOnly] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [userQuery, setUserQuery] = useState('')
  const [outcome, setOutcome] = useState<CollaborationKey>()
  const memberSearch = useRef<HTMLInputElement>(null)
  const keyboardPicker = useRef(false)
  const readSequence = useRef(0)
  const actionFocus = useRef<Element | null>(null)
  const memberContent = useRef<HTMLDivElement>(null)
  const [computers, setComputers] = useState<CollaborationComputer[]>([])
  const [nodeId, setNodeId] = useState<CollaborationComputerId | ''>('')
  const [loadingComputers, setLoadingComputers] = useState(false)
  const capturedNodeId = mode === 'create' && nodeId !== '' ? nodeId : initialNodeId
  const unavailableComputer = capturedNodeId !== undefined && allowedNodeId !== undefined && capturedNodeId !== allowedNodeId
    || mode === 'create' && nodeId !== '' && listComputers !== undefined && !loadingComputers
      && !computers.some(computer => computer.nodeId === nodeId && computer.status === 'active')
  const canInvite = canManage && !steward && projectId !== undefined && inviteMember !== undefined
  const hasLoadedScope = loadedScope === scope

  useEffect(() => {
    if (!open || mode !== 'create' || listComputers === undefined) return
    let active = true
    setLoadingComputers(true)
    void listComputers().then((next) => {
      if (!active) return
      setComputers(next)
      setNodeId(current => current !== '' ? current
        : next.find(item => item.nodeId === initialNodeId && item.status === 'active')?.nodeId
          ?? next.find(item => item.status === 'active')?.nodeId ?? '')
    }).catch(() => { if (active) setError(t('manager.computersFailed')) })
      .finally(() => { if (active) setLoadingComputers(false) })
    return () => { active = false }
  }, [open, mode, listComputers, initialNodeId, t])
  useEffect(() => {
    if (!open) return
    setName('')
    if (mode === 'create') setNodeId('')
    setUsername('')
    setMemberMode('rw')
    setError(undefined)
    setView(initialView === 'compose' ? 'compose' : 'list')
    setDirection(initialView === 'sent' ? 'sent' : 'received')
    setScope(projectId === undefined ? 'all' : initialScope)
    setPendingOnly(true)
    setPickerOpen(false)
    setUserQuery('')
    setOutcome(undefined)
  }, [open, mode, projectId, initialScope, initialView])
  useEffect(() => {
    if (!pickerOpen || !keyboardPicker.current) return
    // Portaled menus cannot receive focus until their initial placement is visible.
    const frame = requestAnimationFrame(() => { memberSearch.current?.focus() })
    return () => { cancelAnimationFrame(frame) }
  }, [pickerOpen])
  useLayoutEffect(() => {
    if (outcome !== undefined && actionFocus.current !== null && !actionFocus.current.isConnected
      && document.activeElement === document.body) {
      const target = memberContent.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (target != null) focusWithoutRing(target)
    }
  }, [outcome])
  useEffect(() => {
    if (!open || mode !== 'members' || listInvitations === undefined) return
    let active = true
    const sequence = ++readSequence.current
    setLoadingInvitations(true)
    setLoadError(undefined)
    const managedProjectId = scope === 'current' && canManage ? projectId : undefined
    const read = scope === 'current' ? readInvitations(listInvitations, managedProjectId)
      : listInvitations(undefined).then(next => ({ invitations: next, failures: [] as unknown[] }))
    void read
      .then((next) => {
        if (active && sequence === readSequence.current) {
          if (next.failures.length === 0 || next.invitations.length > 0) {
            setInvitations(next.invitations)
            setLoadedScope(scope)
          }
          if (next.failures.length > 0) setLoadError(errorText(next.failures[0], t, 'manager.invitationReadFailed'))
        }
      })
      .catch((cause: unknown) => {
        if (active && sequence === readSequence.current) setLoadError(errorText(cause, t, 'manager.invitationReadFailed'))
      })
      .finally(() => { if (active && sequence === readSequence.current) setLoadingInvitations(false) })
    return () => { active = false }
  }, [open, mode, listInvitations, scope, canManage, projectId, reload, t])
  useEffect(() => {
    if (!open || mode !== 'members' || !canInvite || listUsers === undefined) return
    let active = true
    setLoadingUsers(true)
    setUsersError(false)
    void listUsers(projectId)
      .then((next) => { if (active) setUsers(next) })
      .catch(() => { if (active) setUsersError(true) })
      .finally(() => { if (active) setLoadingUsers(false) })
    return () => { active = false }
  }, [open, mode, canInvite, listUsers, usersReload])

  const refreshAfterMutation = async (failure: CollaborationKey): Promise<void> => {
    if (listInvitations === undefined) return
    const sequence = ++readSequence.current
    setLoadingInvitations(true)
    setLoadError(undefined)
    const managedProjectId = scope === 'current' && canManage ? projectId : undefined
    try {
      const next = scope === 'current' ? await readInvitations(listInvitations, managedProjectId)
        : { invitations: await listInvitations(undefined), failures: [] as unknown[] }
      if (sequence !== readSequence.current) return
      if (next.failures.length === 0 || next.invitations.length > 0) {
        setInvitations(next.invitations)
        setLoadedScope(scope)
      }
      if (next.failures.length > 0) setLoadError(t(failure))
    } catch {
      if (sequence === readSequence.current) setLoadError(t(failure))
    } finally {
      if (sequence === readSequence.current) setLoadingInvitations(false)
    }
  }

  const submitCreate = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || unavailableComputer || createProject === undefined || name.trim() === ''
      || listComputers !== undefined && (loadingComputers || nodeId === '')) return
    setBusy(true)
    setError(undefined)
    try {
      onCreated(await (listComputers === undefined && initialNodeId === undefined
        ? createProject(name.trim()) : createProject(name.trim(), nodeId === '' ? undefined : nodeId)))
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const submitInvite = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || unavailableComputer || projectId === undefined || inviteMember === undefined || username.trim() === '') return
    setBusy(true)
    setError(undefined)
    setOutcome(undefined)
    try {
      const sent = await inviteMember(projectId, username.trim(), memberMode)
      setUsername('')
      setInvitations(current => [...current.filter(row => row.projectId === projectId && row.id !== sent.id), sent])
      await refreshAfterMutation('manager.inviteRefreshFailed')
      setDirection('sent')
      setScope('current')
      setView('list')
      setOutcome('manager.invitationSent')
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const accept = async (id: string): Promise<void> => {
    if (busy || unavailableComputer || acceptInvitation === undefined) return
    setBusy(true)
    setError(undefined)
    setOutcome(undefined)
    actionFocus.current = document.activeElement
    try {
      await acceptInvitation(id)
      setInvitations(current => current.map(row => row.id === id ? { ...row, status: 'accepted' } : row))
      setOutcome('manager.invitationAccepted')
      await refreshAfterMutation('manager.acceptRefreshFailed')
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const invitedMemberIds = new Set<number>()
  for (const invitation of invitations) {
    if (hasLoadedScope && invitation.projectId === projectId && invitation.invitee.id !== currentUserId) {
      invitedMemberIds.add(invitation.invitee.id)
    }
  }
  const normalizedUserQuery = userQuery.trim().toLowerCase()
  const matchedUsers = users.filter(user => user.id !== currentUserId && !invitedMemberIds.has(user.id)
    && `${user.displayName} ${user.username}`.toLowerCase().includes(normalizedUserQuery))
  const selectedUser = users.find(user => user.username === username)
  const visibleInvitations = invitations.filter(invitation => (
    (direction === 'received' ? invitation.invitee.id === currentUserId : invitation.invitee.id !== currentUserId)
    && (!pendingOnly || invitation.status === 'pending')
  ))
  const backToList = (): void => { setPickerOpen(false); setError(undefined); setOutcome(undefined); setView('list') }
  const compose = (): void => { setScope('current'); setPickerOpen(false); setError(undefined); setOutcome(undefined); setView('compose') }
  const inviteReason = steward ? t('manager.stewardNotice')
    : projectId === undefined ? t('manager.chooseProject') : t('project.managedByOwner')
  const title = mode === 'create' ? t('manager.createTitle')
    : view === 'compose' ? t('manager.composeTitle') : t('manager.invitationCenter')
  const fieldBlocked = busy || loadingUsers || loadingInvitations || usersError
    || (listInvitations !== undefined && (!hasLoadedScope || scope !== 'current' || loadError !== undefined))

  return (
    <CollaborationDialog open={open} title={title} busy={busy} onClose={onClose}
      closeLabel={t('manager.close')} description={mode === 'create' ? t('manager.createOwnerHint')
        : view === 'compose' || scope === 'current' ? projectName : t('manager.visibleInvites')}
      {...mode === 'members' && view === 'compose' ? { onBack: backToList, backLabel: t('manager.backInvitations') } : {}}
      footer={mode === 'create' ? (
        <><Button onClick={onClose} disabled={busy}>{t('manager.cancel')}</Button>
          <Button variant="primary" type="submit" form={`${id}-create`}
            disabled={busy || unavailableComputer || name.trim() === ''
              || listComputers !== undefined && (loadingComputers || nodeId === '')}>
            {busy ? t('manager.creating') : t('manager.create')}
          </Button></>
      ) : view === 'compose' ? (
        <><span className={css.footerHint}>{canInvite ? t('manager.awaitAcceptance') : inviteReason}</span>
          <Button onClick={backToList} disabled={busy}>{t('manager.backInvitations')}</Button>
          {canInvite && <Button variant="primary" type="submit" form={`${id}-invite`} disabled={fieldBlocked || username.trim() === ''}>
            {busy ? t('manager.inviting') : t('manager.invite')}
          </Button>}</>
      ) : (
        <><span className={css.footerHint}>{canInvite
          ? direction === 'received' ? t('manager.receivedCountHint') : t('manager.sentCountHint') : inviteReason}</span>
        <Button variant="primary" onClick={compose} disabled={!canInvite || busy} icon={<IconPlusOutline16 size={16} />}>
          {t('manager.composeTitle')}
        </Button></>
      )}>
      {mode === 'create' ? (
        <form id={`${id}-create`} className={css.form} onSubmit={(event) => { void submitCreate(event) }}>
          <p className={css.description}>{t('manager.createDescription')}</p>
          <label className={css.label} htmlFor={`${id}-name`}>{t('manager.nameLabel')}</label>
          <Input className={css.textField as string} id={`${id}-name`} value={name} onChange={(event) => { setName(event.target.value) }}
            placeholder={t('manager.namePlaceholder')} aria-describedby={`${id}-name-help`} maxLength={120} required disabled={busy} />
          <div id={`${id}-name-help`} className={css.fieldMeta}><span>{t('manager.nameHelp')}</span><span>{name.length} / 120</span></div>
          {listComputers !== undefined && <>
            <label className={css.label} htmlFor={`${id}-computer`}>{t('manager.computerLabel')}</label>
            <select id={`${id}-computer`} className={css.select} value={nodeId}
              disabled={busy || loadingComputers} required onChange={(event) => { setNodeId(computers.find(computer => computer.nodeId === event.target.value)?.nodeId ?? '') }}>
              <option value="">{t(loadingComputers ? 'manager.computersLoading' : 'manager.computerPlaceholder')}</option>
              {nodeId !== '' && !computers.some(computer => computer.nodeId === nodeId) && <option value={nodeId} disabled>
                {t('manager.targetUnavailable')}
              </option>}
              {computers.map(computer => <option key={computer.nodeId} value={computer.nodeId} disabled={computer.status !== 'active'}>
                {computer.name}{computer.status === 'active' ? '' : ` · ${t('manager.computerOffline')}`}
              </option>)}
            </select>
            <p className={css.muted}>{t('manager.computerNote')}</p>
          </>}
          {unavailableComputer && <div className={css.error} role="alert">{t('manager.targetUnavailable')}</div>}
          <dl className={css.creationFacts}><div><dt>{t('manager.creationOrigin')}</dt><dd>{t('manager.userCreated')}</dd></div>
            <div><dt>{t('manager.ownerLabel')}</dt><dd>{t('scope.you')}</dd></div></dl>
          <p className={css.pathNote}><IconFolderOpenOutline16 size={16} /><span>{t('manager.folderNote')}</span></p>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
        </form>
      ) : view === 'compose' ? (
        canInvite ? (
          <form id={`${id}-invite`} className={css.form} onSubmit={(event) => { void submitInvite(event) }}>
            <div className={css.target}><IconUsersOutline16 size={20} /><span><small>{t('manager.inviteTo')}</small><strong>{projectName}</strong></span></div>
            <label className={css.label} id={`${id}-member-label`} htmlFor={`${id}-member`}>{t('manager.usernameLabel')}</label>
            <Menu open={pickerOpen} onClose={() => { setPickerOpen(false) }} portal side="bottom" align="start"
              autoFocus={!keyboardPicker.current}
              listClassName={css.memberMenu} selectedIds={username === '' ? [] : [username]}
              header={<div className={css.memberHeader}><strong>{t('manager.usernameLabel')}</strong>
                <Input className={css.textField as string} ref={memberSearch} type="search"
                  aria-label={t('manager.searchUsers')} placeholder={t('manager.searchUsers')}
                  value={userQuery} onChange={(event) => { setUserQuery(event.target.value) }} /></div>}
              anchor={<button id={`${id}-member`} type="button" className={css.userTrigger} aria-labelledby={`${id}-member-label ${id}-chosen`}
                aria-haspopup="menu" aria-expanded={pickerOpen} disabled={fieldBlocked}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return
                  event.preventDefault()
                  event.stopPropagation()
                  keyboardPicker.current = true
                  setPickerOpen(true)
                }}
                onClick={(event) => { keyboardPicker.current = event.detail === 0; setPickerOpen(value => !value) }}>
                <span id={`${id}-chosen`}>{selectedUser?.displayName ?? t('manager.usernamePlaceholder')}</span><IconChevronDownOutline14 />
              </button>}
              items={matchedUsers.length === 0 ? [{ type: 'label', id: 'empty', text: t('manager.noEligibleUsers') }]
                : matchedUsers.map(user => ({ id: user.username,
                  label: <span className={css.userItem}><strong>{user.displayName}</strong><small>{user.username}</small></span>,
                }))}
              onSelect={(value) => { setUsername(value); setPickerOpen(false) }} />
            {loadingUsers && <div className={css.queryStatus} role="status"><IconLoadingOutline16 size={16} />{t('manager.loading')}</div>}
            {usersError && <div className={css.error} role="alert">{t('manager.usersFailed')}</div>}
            {usersError && <Button size="sm" onClick={() => { setUsersReload(value => value + 1) }}>{t('manager.retry')}</Button>}
            <fieldset className={css.permissionOptions}><legend>{t('manager.modeLabel')}</legend>
              {(['rw', 'ro'] as const).map(value => (
                <label key={value} className={css.permissionOption} data-selected={memberMode === value}>
                  <input type="radio" name={`${id}-mode`} value={value} checked={memberMode === value} disabled={busy}
                    onChange={() => { setMemberMode(value) }} />
                  <span><strong>{value === 'rw' ? t('manager.readWrite') : t('manager.readOnly')}</strong>
                    <small>{value === 'rw' ? t('manager.rwHint') : t('manager.roHint')}</small></span>
                </label>
              ))}
            </fieldset>
            {loadError !== undefined && <div className={css.error} role="alert">{loadError}</div>}
            {loadError !== undefined && <Button size="sm" onClick={() => { setReload(value => value + 1) }}>{t('manager.retry')}</Button>}
            {error !== undefined && <div className={css.error} role="alert">{error}</div>}
          </form>
        ) : <p className={css.notice}>{inviteReason}</p>
      ) : (
        <div ref={memberContent} className={css.members}>
          <h3 className={css.membersTitle}>{t('manager.membersTitle')}</h3>
          {outcome !== undefined && <p className={css.queryStatus} role="status">{t(outcome)}</p>}
          <div className={css.filters}>
            {projectId !== undefined ? <div className={css.scopeFilters} aria-label={t('manager.invitationScope')}>
              <Button size="sm" variant={scope === 'current' ? 'soft' : 'ghost'} aria-pressed={scope === 'current'} disabled={busy}
                onClick={() => { setScope('current') }}>{t('manager.currentProject')}</Button>
              <Button size="sm" variant={scope === 'all' ? 'soft' : 'ghost'} aria-pressed={scope === 'all'} disabled={busy}
                onClick={() => { setScope('all') }}>{t('manager.allVisible')}</Button>
            </div> : <span>{t('manager.allVisible')}</span>}
            <label className={css.pendingFilter}><input type="checkbox" checked={pendingOnly} onChange={(event) => { setPendingOnly(event.target.checked) }} />{t('manager.pendingOnly')}</label>
          </div>
          <SegmentedTabs<'received' | 'sent'> variant="underline" value={direction} onChange={setDirection} label={t('manager.invitationDirection')}
            items={[
              { value: 'received', label: t('manager.received'), id: `${id}-received-tab`, panelId: `${id}-received` },
              { value: 'sent', label: t('manager.sent'), id: `${id}-sent-tab`, panelId: `${id}-sent` },
            ]} />
          {loadError !== undefined && <div className={css.error} role="alert">{loadError}</div>}
          {loadError !== undefined && <Button size="sm" onClick={() => { setReload(value => value + 1) }}>{t('manager.retry')}</Button>}
          <section className={css.invitationSection} id={`${id}-${direction}`} role="tabpanel" aria-labelledby={`${id}-${direction}-tab`}>
            {loadingInvitations && !hasLoadedScope && <div className={css.skeleton} role="status" aria-label={t('manager.loading')}><span /><span /><span /></div>}
            {loadingInvitations && hasLoadedScope && <p className={css.queryStatus} role="status">{t('manager.loading')}</p>}
            {!loadingInvitations && loadError === undefined && hasLoadedScope && visibleInvitations.length === 0 && (
              <div className={css.empty}>
                <IconUsersOutline16 size={24} /><strong>{direction === 'received' ? t('manager.noReceived') : t('manager.noSent')}</strong>
                <p>{scope === 'current' ? t('manager.emptyCurrentHint') : t('manager.emptyHistoryHint')}</p>
                {scope === 'current' && <Button onClick={() => { setScope('all') }}>{t('manager.allVisible')}</Button>}
              </div>
            )}
            {hasLoadedScope && visibleInvitations.map((invitation) => {
              const received = invitation.invitee.id === currentUserId
              return <article className={css.invitation} key={invitation.id}>
                <div className={css.invitationTop}><span className={css.invitationIcon}><IconUsersOutline16 size={16} /></span>
                  <div className={css.invitationText}><strong>{received ? invitation.projectName : invitation.invitee.displayName}</strong>
                    <span>{received ? t('manager.invitedBy', { name: invitation.inviter.displayName })
                      : t('manager.sentBy', { project: invitation.projectName, name: invitation.inviter.id === currentUserId ? t('scope.you') : invitation.inviter.displayName })}</span>
                  </div>
                  {received && invitation.status === 'pending'
                    ? <Button variant="soft" size="sm" disabled={busy} onClick={() => { void accept(invitation.id) }}>{t('manager.accept')}</Button>
                    : <span className={css.invitationStatus} data-status={invitation.status}>{t(`manager.status.${invitation.status}`)}</span>}
                </div>
                <div className={css.invitationMeta}><span>{invitation.mode === 'rw' ? t('manager.readWrite') : t('manager.readOnly')}</span>
                  <time dateTime={invitation.createdAt}>{new Date(invitation.createdAt).toLocaleDateString()}</time>
                  {invitation.expiresAt !== null && <span>{t('manager.expires', { date: new Date(invitation.expiresAt).toLocaleDateString() })}</span>}
                </div>
              </article>
            })}
          </section>
          <p className={css.pathNote}>{direction === 'received' ? t('manager.acceptHint') : t('manager.sentVisibilityHint')}</p>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
        </div>
      )}
    </CollaborationDialog>
  )
}
