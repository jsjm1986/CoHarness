/** Shared user identity, state badges, instance controls, and account dialogs. */
import { Play, RefreshCw, Square } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { controlInstance, type AdminUser } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { Button, ConfirmDialog, Dialog, Field, IconButton, StatusBadge, Switch } from './ui.tsx'
import { zh, en } from './users.copy.ts'

export type UserRole = AdminUser['role']

export type UserActionRunner = (key: string, action: () => Promise<void>) => Promise<boolean>

export function UserIdentity({ user }: { user: Pick<AdminUser, 'id' | 'username' | 'displayName'> }) {
  const initial = (user.displayName || user.username).slice(0, 1)
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{initial}</span>
      <span className="identityText">
        <strong>{user.displayName || user.username}</strong>
        <span>@{user.username} · ID {user.id}</span>
      </span>
    </div>
  )
}

export function RoleBadge({ role }: { role: UserRole }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <StatusBadge tone={role === 'admin' ? 'info' : 'neutral'}>{role === 'admin' ? t('roleAdmin') : t('roleUser')}</StatusBadge>
}

export function AutoReviewBadge({ eligible }: { eligible: boolean }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <StatusBadge tone={eligible ? 'info' : 'neutral'}>{eligible ? t('granted') : t('notGranted')}</StatusBadge>
}

export function AccountBadge({ status }: { status: AdminUser['status'] }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <StatusBadge tone={status === 'active' ? 'success' : 'danger'}>{status === 'active' ? t('accountActive') : t('accountDisabled')}</StatusBadge>
}

export function InstanceState({ state }: { state: string }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const labels: Record<string, string> = {
    ready: t('stateReady'),
    starting: t('stateStarting'),
    stopping: t('stateStopping'),
    stopped: t('stateStopped'),
  }
  const tone = state === 'ready' ? 'success' : state === 'starting' ? 'info' : state === 'stopping' ? 'warning' : 'neutral'
  return <StatusBadge tone={tone}>{labels[state] ?? state}</StatusBadge>
}

export function InstanceCell({ user, pending, run }: { user: AdminUser; pending: string; run: UserActionRunner }) {
  return (
    <div className="instanceBlock">
      <InstanceState state={user.instanceState} />
      <InstanceControls user={user} pending={pending} run={run} />
    </div>
  )
}

export function InstanceControls({ user, pending, run }: { user: AdminUser; pending: string; run: UserActionRunner }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const busy = pending.startsWith(`instance:${user.id}:`)
  return (
    <div className="compactActions" aria-label={t('instanceActionsAria', { name: user.username })}>
      <IconButton
        label={t('instanceStart')}
        icon={Play}
        disabled={busy || user.status !== 'active' || user.instanceState === 'ready' || user.instanceState === 'starting'}
        loading={pending === `instance:${user.id}:start`}
        onClick={() => void run(`instance:${user.id}:start`, () => controlInstance(user.id, 'start'))}
      />
      <IconButton
        label={t('instanceStop')}
        icon={Square}
        disabled={busy || user.instanceState === 'stopped' || user.instanceState === 'stopping'}
        loading={pending === `instance:${user.id}:stop`}
        onClick={() => void run(`instance:${user.id}:stop`, () => controlInstance(user.id, 'stop'))}
      />
      <IconButton
        label={t('instanceRestart')}
        icon={RefreshCw}
        disabled={busy || user.instanceState !== 'ready'}
        loading={pending === `instance:${user.id}:restart`}
        onClick={() => void run(`instance:${user.id}:restart`, () => controlInstance(user.id, 'restart'))}
      />
    </div>
  )
}

export function Definition({ label, children }: { label: string; children: ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

export type UserDraft = {
  username: string
  password: string
  displayName: string
  role: UserRole
}

export const EMPTY_USER_DRAFT: UserDraft = {
  username: '',
  password: '',
  displayName: '',
  role: 'user',
}

export function UserCreateDialog({ open, pending, onSubmit, onClose }: {
  open: boolean
  pending: boolean
  onSubmit: (draft: UserDraft) => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [draft, setDraft] = useState<UserDraft>(EMPTY_USER_DRAFT)
  useEffect(() => { if (open) setDraft(EMPTY_USER_DRAFT) }, [open])
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(draft)
  }
  return (
    <Dialog
      open={open}
      title={t('createTitle')}
      description={t('createDescription')}
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>{t('cancel')}</Button>
          <Button type="submit" form="create-user-form" variant="primary" loading={pending}>{t('createSubmit')}</Button>
        </>
      )}
    >
      <form id="create-user-form" className="formGrid" onSubmit={submit}>
        <Field label={t('fieldUsername')} hint={t('hintUsername')}>
          <input className="input" required autoComplete="off" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} />
        </Field>
        <Field label={t('fieldDisplayName')}>
          <input className="input" value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} placeholder={t('placeholderOptional')} />
        </Field>
        <Field label={t('fieldInitialPassword')} className="formSpanFull">
          <input className="input" required type="password" autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} />
        </Field>
        <Field label={t('fieldRole')} className="formSpanFull">
          <select className="select" value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as UserRole })}>
            <option value="user">{t('roleUser')}</option>
            <option value="admin">{t('roleAdmin')}</option>
          </select>
        </Field>
      </form>
    </Dialog>
  )
}

export function UserEditDialog({ user, pending, onSubmit, onClose }: {
  user: AdminUser | null
  pending: boolean
  onSubmit: (patch: { displayName?: string; role?: UserRole; autoReviewEligible?: boolean }) => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [eligible, setEligible] = useState(false)
  useEffect(() => {
    if (user === null) return
    setName(user.displayName)
    setRole(user.role)
    setEligible(user.autoReviewEligible)
  }, [user])
  function submit(event: FormEvent) {
    event.preventDefault()
    if (user === null) return
    onSubmit({
      ...(name === user.displayName ? {} : { displayName: name }),
      ...(role === user.role ? {} : { role }),
      ...(eligible === user.autoReviewEligible ? {} : { autoReviewEligible: eligible }),
    })
  }
  return (
    <Dialog
      open={user !== null}
      title={t('editTitle', { name: user?.username ?? '' })}
      description={t('editDescription')}
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>{t('cancel')}</Button>
          <Button type="submit" form="edit-user-form" variant="primary" loading={pending}>{t('saveChanges')}</Button>
        </>
      )}
    >
      <form id="edit-user-form" className="formGrid" onSubmit={submit}>
        <Field label={t('fieldDisplayName')}>
          <input className="input" value={name} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('fieldRole')}>
          <select className="select" value={role} onChange={event => setRole(event.target.value as UserRole)}>
            <option value="user">{t('roleUser')}</option>
            <option value="admin">{t('roleAdmin')}</option>
          </select>
        </Field>
        <div className="field">
          <Switch label={t('autoReviewLabel')} checked={eligible} onChange={setEligible} disabled={pending} />
          <span className="fieldHint">{t('autoReviewHint')}</span>
        </div>
      </form>
    </Dialog>
  )
}

export function UserPasswordDialog({ user, pending, onSubmit, onClose }: {
  user: AdminUser | null
  pending: boolean
  onSubmit: (password: string) => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [password, setPassword] = useState('')
  useEffect(() => { if (user !== null) setPassword('') }, [user])
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(password)
  }
  return (
    <Dialog
      open={user !== null}
      title={t('passwordTitle', { name: user?.username ?? '' })}
      description={t('passwordDescription')}
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>{t('cancel')}</Button>
          <Button type="submit" form="reset-password-form" variant="primary" loading={pending}>{t('passwordSubmit')}</Button>
        </>
      )}
    >
      <form id="reset-password-form" onSubmit={submit}>
        <Field label={t('fieldNewPassword')}>
          <input className="input" required autoFocus type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

export function UserDisableConfirm({ user, pending, onConfirm, onClose }: {
  user: AdminUser | null
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return (
    <ConfirmDialog
      open={user !== null}
      title={t('disableTitle')}
      description={t('disableDescription', { name: user?.username ?? '' })}
      confirmLabel={t('disableConfirm')}
      pending={pending}
      onClose={() => { if (!pending) onClose() }}
      onConfirm={onConfirm}
    />
  )
}

export function UserDeleteConfirm({ user, pending, onConfirm, onClose }: {
  user: AdminUser | null
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return (
    <ConfirmDialog
      open={user !== null}
      title={t('deleteTitle')}
      description={t('deleteDescription', { name: user?.username ?? '' })}
      confirmLabel={t('deleteConfirm')}
      pending={pending}
      onClose={() => { if (!pending) onClose() }}
      onConfirm={onConfirm}
    />
  )
}
