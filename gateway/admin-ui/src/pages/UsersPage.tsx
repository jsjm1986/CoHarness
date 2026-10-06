import {
  ChevronRight,
  KeyRound,
  Pencil,
  Plus,
  Power,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createUser,
  deleteUser,
  listUsers,
  patchUser,
  resetPassword,
  type AdminUser,
} from '../api.ts'
import {
  Button,
  EmptyState,
  ErrorBanner,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
} from '../components/ui.tsx'
import {
  AccountBadge,
  AutoReviewBadge,
  Definition,
  InstanceCell,
  InstanceControls,
  InstanceState,
  RoleBadge,
  UserCreateDialog,
  UserDeleteConfirm,
  UserDisableConfirm,
  UserEditDialog,
  UserIdentity,
  UserPasswordDialog,
  type UserDraft,
  type UserRole,
} from '../components/users.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as usersZh, en as usersEn } from './users.copy.ts'

export function UsersPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usersZh, en: usersEn }), [])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null)
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null)
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setUsers(await listUsers())
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void reload(true) }, [reload])

  async function run(key: string, action: () => Promise<void>): Promise<boolean> {
    setPending(key)
    try {
      await action()
      await reload()
      return true
    } catch (cause) {
      setError(messageFrom(cause))
      return false
    } finally {
      setPending('')
    }
  }

  async function onCreate(draft: UserDraft) {
    const saved = await run('create', async () => { await createUser({
      username: draft.username,
      password: draft.password,
      role: draft.role,
      displayName: draft.displayName === '' ? undefined : draft.displayName,
    }) })
    if (saved) setCreateOpen(false)
  }

  async function onEdit(patch: { displayName?: string; role?: UserRole; autoReviewEligible?: boolean }) {
    if (editTarget === null) return
    const saved = await run(`edit:${editTarget.id}`, () => patchUser(editTarget.id, patch))
    if (saved) setEditTarget(null)
  }

  async function onResetPassword(password: string) {
    if (passwordTarget === null) return
    const saved = await run(`password:${passwordTarget.id}`, () => resetPassword(passwordTarget.id, password))
    if (saved) setPasswordTarget(null)
  }

  async function onDisable() {
    if (disableTarget === null) return
    const saved = await run(`status:${disableTarget.id}`, () => patchUser(disableTarget.id, { status: 'disabled' }))
    if (saved) setDisableTarget(null)
  }

  async function onDelete() {
    if (deleteTarget === null) return
    const saved = await run(`delete:${deleteTarget.id}`, () => deleteUser(deleteTarget.id))
    if (saved) setDeleteTarget(null)
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading ? undefined : t('userCount', { count: String(users.length) })}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>{t('createUser')}</Button>}
      />
      <ErrorBanner message={error} />
      <Section className="responsiveSection" title={t('sectionTitle')} meta={loading ? undefined : t('recordCount', { count: String(users.length) })}>
        {loading ? <LoadingState label={t('loadingUsers')} /> : users.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('emptyTitle')}
            detail={t('emptyDetail')}
            action={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>{t('createUser')}</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>{t('colUser')}</th>
                    <th>{t('colRole')}</th>
                    <th>{t('colAutoReview')}</th>
                    <th>{t('colAccount')}</th>
                    <th>{t('colInstance')}</th>
                    <th>{t('colPort')}</th>
                    <th aria-label={t('colActions')} />
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user.id}>
                      <td><Link className="userLink" to={`/users/${user.id}`}><UserIdentity user={user} /></Link></td>
                      <td><RoleBadge role={user.role} /></td>
                      <td><AutoReviewBadge eligible={user.autoReviewEligible} /></td>
                      <td><AccountBadge status={user.status} /></td>
                      <td><InstanceCell user={user} pending={pending} run={run} /></td>
                      <td><span className="codeText">{user.port}</span></td>
                      <td>
                        <UserActions
                          user={user}
                          pending={pending}
                          onEdit={() => setEditTarget(user)}
                          onPassword={() => setPasswordTarget(user)}
                          onDisable={() => setDisableTarget(user)}
                          onDelete={() => setDeleteTarget(user)}
                          onEnable={() => { void run(`status:${user.id}`, () => patchUser(user.id, { status: 'active' })) }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {users.map(user => (
                <article className="mobileItem" key={user.id}>
                  <div className="mobileItemHeader">
                    <Link className="userLink" to={`/users/${user.id}`}><UserIdentity user={user} /></Link>
                    <AccountBadge status={user.status} />
                  </div>
                  <div className="mobileItemBody">
                    <dl className="definitionGrid">
                      <Definition label={t('colRole')}><RoleBadge role={user.role} /></Definition>
                      <Definition label={t('colAutoReview')}><AutoReviewBadge eligible={user.autoReviewEligible} /></Definition>
                      <Definition label={t('colPort')}><span className="codeText">{user.port}</span></Definition>
                    </dl>
                    <div className="mobileControlRow">
                      <InstanceState state={user.instanceState} />
                      <InstanceControls user={user} pending={pending} run={run} />
                    </div>
                    <UserActions
                      mobile
                      user={user}
                      pending={pending}
                      onEdit={() => setEditTarget(user)}
                      onPassword={() => setPasswordTarget(user)}
                      onDisable={() => setDisableTarget(user)}
                      onDelete={() => setDeleteTarget(user)}
                      onEnable={() => { void run(`status:${user.id}`, () => patchUser(user.id, { status: 'active' })) }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>

      <UserCreateDialog open={createOpen} pending={pending === 'create'} onSubmit={draft => void onCreate(draft)} onClose={() => setCreateOpen(false)} />
      <UserEditDialog user={editTarget} pending={pending.startsWith('edit:')} onSubmit={patch => void onEdit(patch)} onClose={() => setEditTarget(null)} />
      <UserPasswordDialog user={passwordTarget} pending={pending.startsWith('password:')} onSubmit={password => void onResetPassword(password)} onClose={() => setPasswordTarget(null)} />
      <UserDisableConfirm user={disableTarget} pending={pending.startsWith('status:')} onConfirm={() => void onDisable()} onClose={() => setDisableTarget(null)} />
      <UserDeleteConfirm user={deleteTarget} pending={pending.startsWith('delete:')} onConfirm={() => void onDelete()} onClose={() => setDeleteTarget(null)} />
    </div>
  )
}

function UserActions({ user, pending, onEdit, onPassword, onDisable, onDelete, onEnable, mobile = false }: {
  user: AdminUser
  pending: string
  onEdit: () => void
  onPassword: () => void
  onDisable: () => void
  onDelete: () => void
  onEnable: () => void
  mobile?: boolean
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usersZh, en: usersEn }), [])
  const statusPending = pending === `status:${user.id}`
  const deletePending = pending === `delete:${user.id}`
  if (mobile) {
    return (
      <div className="mobileActions">
        <Link className="button button-secondary" to={`/users/${user.id}`}>{t('detail')}</Link>
        <Button icon={Pencil} onClick={onEdit}>{t('edit')}</Button>
        <Button icon={KeyRound} onClick={onPassword}>{t('password')}</Button>
        <Button
          variant={user.status === 'active' ? 'danger' : 'secondary'}
          icon={Power}
          loading={statusPending}
          onClick={user.status === 'active' ? onDisable : onEnable}
        >
          {user.status === 'active' ? t('disable') : t('enable')}
        </Button>
        <Button variant="danger" icon={Trash2} loading={deletePending} onClick={onDelete}>{t('deleteAction')}</Button>
      </div>
    )
  }
  return (
    <div className="rowActions">
      <Link className="iconButton iconButton-ghost" to={`/users/${user.id}`} aria-label={t('manageDetail')} title={t('manageDetail')}><ChevronRight /></Link>
      <IconButton label={t('editUser')} icon={Pencil} onClick={onEdit} />
      <IconButton label={t('resetPassword')} icon={KeyRound} onClick={onPassword} />
      <IconButton
        label={user.status === 'active' ? t('disableUser') : t('enableUser')}
        icon={user.status === 'active' ? Power : UserRound}
        variant={user.status === 'active' ? 'danger' : 'ghost'}
        loading={statusPending}
        onClick={user.status === 'active' ? onDisable : onEnable}
      />
      <IconButton
        label={t('deleteUser')}
        icon={Trash2}
        variant="danger"
        loading={deletePending}
        onClick={onDelete}
      />
    </div>
  )
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
