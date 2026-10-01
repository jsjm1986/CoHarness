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
import { useCallback, useEffect, useState } from 'react'
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

export function UsersPage() {
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
        title="用户管理"
        description="管理账号权限、登录状态和每位用户的独立 Harness 实例。点击用户进入详情页管理准入资格、模型例外、项目成员和配额。"
        meta={loading ? undefined : `${users.length} 位用户`}
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建用户</Button>}
      />
      <ErrorBanner message={error} />
      <Section className="responsiveSection" title="账号与实例" meta={loading ? undefined : `${users.length} 条记录`}>
        {loading ? <LoadingState label="正在加载用户" /> : users.length === 0 ? (
          <EmptyState
            icon={Users}
            title="还没有用户"
            detail="创建第一个账号后，可在这里配置角色并控制其 Harness 实例。"
            action={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建用户</Button>}
          />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>角色</th>
                    <th>Auto 审查资格</th>
                    <th>账号</th>
                    <th>实例</th>
                    <th>端口</th>
                    <th aria-label="操作" />
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
                      <Definition label="角色"><RoleBadge role={user.role} /></Definition>
                      <Definition label="Auto 审查资格"><AutoReviewBadge eligible={user.autoReviewEligible} /></Definition>
                      <Definition label="端口"><span className="codeText">{user.port}</span></Definition>
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
  const statusPending = pending === `status:${user.id}`
  const deletePending = pending === `delete:${user.id}`
  if (mobile) {
    return (
      <div className="mobileActions">
        <Link className="button button-secondary" to={`/users/${user.id}`}>详情</Link>
        <Button icon={Pencil} onClick={onEdit}>编辑</Button>
        <Button icon={KeyRound} onClick={onPassword}>密码</Button>
        <Button
          variant={user.status === 'active' ? 'danger' : 'secondary'}
          icon={Power}
          loading={statusPending}
          onClick={user.status === 'active' ? onDisable : onEnable}
        >
          {user.status === 'active' ? '禁用' : '启用'}
        </Button>
        <Button variant="danger" icon={Trash2} loading={deletePending} onClick={onDelete}>删除</Button>
      </div>
    )
  }
  return (
    <div className="rowActions">
      <Link className="iconButton iconButton-ghost" to={`/users/${user.id}`} aria-label="管理详情" title="管理详情"><ChevronRight /></Link>
      <IconButton label="编辑用户" icon={Pencil} onClick={onEdit} />
      <IconButton label="重置密码" icon={KeyRound} onClick={onPassword} />
      <IconButton
        label={user.status === 'active' ? '禁用用户' : '启用用户'}
        icon={user.status === 'active' ? Power : UserRound}
        variant={user.status === 'active' ? 'danger' : 'ghost'}
        loading={statusPending}
        onClick={user.status === 'active' ? onDisable : onEnable}
      />
      <IconButton
        label="删除用户"
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
