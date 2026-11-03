import { useEffect, useState, type SyntheticEvent } from 'react'
import { Button, Input, Modal, IconFolderOpenOutline16, IconPlusOutline16, IconUsersOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationComputer, CollaborationComputerId, ProjectInvitation, UserSummary } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import css from './ProjectManagerModal.module.css'

/** Which project-management surface the modal is showing. */
export type ProjectManagerMode = 'create' | 'members'

/** Controlled project-management modal props. */
export interface ProjectManagerModalProps {
  open: boolean
  mode: ProjectManagerMode
  projectId?: number
  canManage?: boolean
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
  onCreated: (projectId: number) => void
  onClose: () => void
}

function errorText(error: unknown, t: ProjectManagerModalProps['t']): string {
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
  return t('manager.failed')
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

/** Render the user-owned project creation and member invitation dialog. */
export function ProjectManagerModal({
  open, mode, projectId, canManage = false, currentUserId, t,
  createProject, listComputers, initialNodeId, allowedNodeId, listInvitations, inviteMember, acceptInvitation, listUsers,
  onCreated, onClose,
}: ProjectManagerModalProps) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [memberMode, setMemberMode] = useState<'ro' | 'rw'>('rw')
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [users, setUsers] = useState<UserSummary[]>([])
  const [loadingInvitations, setLoadingInvitations] = useState(false)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [computers, setComputers] = useState<CollaborationComputer[]>([])
  const [nodeId, setNodeId] = useState<CollaborationComputerId | ''>('')
  const [loadingComputers, setLoadingComputers] = useState(false)
  const managedProjectId = mode === 'members' && canManage ? projectId : undefined
  const capturedNodeId = mode === 'create' && nodeId !== '' ? nodeId : initialNodeId
  const unavailableComputer = capturedNodeId !== undefined && allowedNodeId !== undefined && capturedNodeId !== allowedNodeId
    || mode === 'create' && nodeId !== '' && listComputers !== undefined && !loadingComputers
      && !computers.some(computer => computer.nodeId === nodeId && computer.status === 'active')

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
    setUsers([])
    setLoadingUsers(false)
    if (mode !== 'members' || listInvitations === undefined) {
      setInvitations([])
      return
    }
    let active = true
    setLoadingInvitations(true)
    void readInvitations(listInvitations, managedProjectId)
      .then((next) => {
        if (!active) return
        setInvitations(next.invitations)
        if (next.failures.length > 0) setError(errorText(next.failures[0], t))
      })
      .catch((nextError: unknown) => { if (active) setError(errorText(nextError, t)) })
      .finally(() => { if (active) setLoadingInvitations(false) })
    if (listUsers !== undefined && managedProjectId !== undefined) {
      setLoadingUsers(true)
      void listUsers(managedProjectId)
        .then((next) => { if (active) setUsers(next) })
        .catch(() => { if (active) setError(t('manager.usersFailed')) })
        .finally(() => { if (active) setLoadingUsers(false) })
    }
    return () => { active = false }
  }, [open, mode, managedProjectId, listInvitations, listUsers, t])

  const refreshInvitations = async (): Promise<void> => {
    if (listInvitations === undefined) return
    const next = await readInvitations(listInvitations, managedProjectId)
    setInvitations(next.invitations)
    if (next.failures.length > 0) setError(errorText(next.failures[0], t))
  }

  const submitCreate = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || unavailableComputer || createProject === undefined || name.trim() === ''
      || listComputers !== undefined && (loadingComputers || nodeId === '')) return
    setBusy(true)
    setError(undefined)
    try {
      onCreated(await createProject(name.trim(), nodeId === '' ? undefined : nodeId))
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
    try {
      await inviteMember(projectId, username.trim(), memberMode)
      setUsername('')
      await refreshInvitations()
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
    try {
      await acceptInvitation(id)
      await refreshInvitations()
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const pending = invitations.filter(invitation => invitation.status === 'pending')
  const invitedMemberIds = new Set<number>()
  for (const inv of invitations) {
    if (inv.invitee.id !== currentUserId) invitedMemberIds.add(inv.invitee.id)
  }
  const title = mode === 'create' ? t('manager.createTitle') : t('manager.membersTitle')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('manager.close')}
      description={mode === 'create' ? t('manager.createDescription') : t('manager.membersDescription')}
      footer={(
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t('manager.cancel')}
        </Button>
      )}
    >
      {unavailableComputer && <div className={css.error} role="alert">{t('manager.targetUnavailable')}</div>}
      {mode === 'create' ? (
        <form className={css.form} onSubmit={(event) => { void submitCreate(event) }}>
          <label className={css.label} htmlFor="collaboration-project-name">{t('manager.nameLabel')}</label>
          <Input
            id="collaboration-project-name"
            value={name}
            onChange={(event) => { setName(event.target.value) }}
            placeholder={t('manager.namePlaceholder')}
            autoFocus
            maxLength={120}
            required
          />
          {listComputers !== undefined && <>
            <label className={css.label} htmlFor="collaboration-project-computer">{t('manager.computerLabel')}</label>
            <select id="collaboration-project-computer" className={css.select} value={nodeId}
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
          <div className={css.pathNote}>
            <IconFolderOpenOutline16 size={16} />
            <span>{t('manager.folderNote')}</span>
          </div>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
          <Button variant="primary" type="submit" disabled={busy || unavailableComputer || name.trim() === ''
            || listComputers !== undefined && (loadingComputers || nodeId === '')} icon={<IconPlusOutline16 size={16} />}>
            {busy ? t('manager.creating') : t('manager.create')}
          </Button>
        </form>
      ) : (
        <div className={css.members}>
          {canManage && projectId !== undefined && (
            <form className={css.form} onSubmit={(event) => { void submitInvite(event) }}>
              <label className={css.label} htmlFor="collaboration-invite-username">{t('manager.usernameLabel')}</label>
              <select
                id="collaboration-invite-username"
                className={css.select}
                value={username}
                disabled={loadingUsers || busy}
                onChange={(event) => { setUsername(event.target.value) }}
                autoFocus
                required
              >
                <option value="">{t('manager.usernamePlaceholder')}</option>
                {users
                  .filter(u => u.id !== currentUserId && !invitedMemberIds.has(u.id))
                  .map(u => (
                    <option key={u.id} value={u.username}>{u.displayName}</option>
                  ))}
              </select>
              {!loadingUsers && !loadingInvitations && error === undefined && users.length === 0 && <p className={css.muted}>{t('manager.noInvitableUsers')}</p>}
              <label className={css.label} htmlFor="collaboration-invite-mode">{t('manager.modeLabel')}</label>
              <select
                id="collaboration-invite-mode"
                className={css.select}
                value={memberMode}
                onChange={(event) => { setMemberMode(event.target.value === 'ro' ? 'ro' : 'rw') }}
              >
                <option value="rw">{t('manager.readWrite')}</option>
                <option value="ro">{t('manager.readOnly')}</option>
              </select>
              <Button variant="primary" type="submit" disabled={busy || unavailableComputer || username.trim() === ''} icon={<IconUsersOutline16 size={16} />}>
                {busy ? t('manager.inviting') : t('manager.invite')}
              </Button>
            </form>
          )}
          <section className={css.invitationSection} aria-label={t('manager.invitationsLabel')}>
            <h3 className={css.sectionTitle}>{t('manager.invitationsLabel')}</h3>
            {loadingInvitations && <p className={css.muted}>{t('manager.loading')}</p>}
            {!loadingInvitations && pending.length === 0 && <p className={css.muted}>{t('manager.none')}</p>}
            {pending.map(invitation => (
              <div className={css.invitation} key={invitation.id}>
                <div className={css.invitationText}>
                  <strong>{invitation.projectName}</strong>
                  <span>{invitation.invitee.id === currentUserId
                    ? t('manager.invitedBy', { name: invitation.inviter.displayName })
                    : t('manager.invitedUser', { name: invitation.invitee.displayName })}</span>
                </div>
                {invitation.invitee.id === currentUserId && (
                  <Button variant="outline" size="sm" disabled={busy || unavailableComputer} onClick={() => { void accept(invitation.id) }}>
                    {t('manager.accept')}
                  </Button>
                )}
              </div>
            ))}
          </section>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  )
}
