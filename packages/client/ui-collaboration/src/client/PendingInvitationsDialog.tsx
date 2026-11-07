import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectInvitation } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import css from './PendingInvitationsDialog.module.css'

/**
 * Present the invitations still pending for the signed-in account without
 * touching project-managed reads, so a read-only space stays untouched.
 * @param props - Dialog state, account id, and invitation actions.
 * @returns The pending-invitations dialog.
 */
export function PendingInvitationsDialog({
  open, onClose, t, currentUserId, listInvitations, acceptInvitation,
}: {
  open: boolean
  onClose: () => void
  t: (key: CollaborationKey, params?: Record<string, string | number>) => string
  currentUserId: number
  listInvitations: () => Promise<ProjectInvitation[]>
  acceptInvitation: (id: string) => Promise<void>
}): ReactNode {
  const regionId = useId()
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError(undefined)
    void listInvitations()
      .then((next) => { if (active) setInvitations(next) })
      .catch(() => { if (active) setError(t('manager.invitationReadFailed')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, reload, listInvitations, t])
  const accept = async (id: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await acceptInvitation(id)
      setInvitations(current => current.filter(invitation => invitation.id !== id))
    } catch {
      setError(t('manager.acceptRefreshFailed'))
    } finally {
      setBusy(false)
    }
  }
  const pending = invitations.filter(invitation => invitation.status === 'pending' && invitation.invitee.id === currentUserId)
  return (
    <Modal open={open} title={t('manager.membersTitle')} closeLabel={t('manager.close')}
      description={t('manager.membersDescription')} onClose={() => { if (!busy) onClose() }}
      footer={<Button onClick={onClose} disabled={busy}>{t('manager.cancel')}</Button>}>
      <section className={css.pending} aria-labelledby={regionId}>
        <h3 id={regionId} className={css.pendingTitle}>{t('manager.invitationsLabel')}</h3>
        {loading && <p role="status">{t('manager.loading')}</p>}
        {error !== undefined && (
          <div className={css.error} role="alert">
            <span>{error}</span>
            <Button size="sm" onClick={() => { setReload(value => value + 1) }}>{t('manager.retry')}</Button>
          </div>
        )}
        {!loading && error === undefined && pending.length === 0 && <p>{t('manager.none')}</p>}
        {pending.map(invitation => (
          <div className={css.pendingRow} key={invitation.id}>
            <strong>{invitation.projectName}</strong>
            <span>{t('manager.invitedBy', { name: invitation.inviter.displayName })}</span>
            <Button variant="soft" size="sm" disabled={busy} onClick={() => { void accept(invitation.id) }}>
              {t('manager.accept')}
            </Button>
          </div>
        ))}
      </section>
    </Modal>
  )
}
