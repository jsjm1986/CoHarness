/** Shared user identity, state badges, instance controls, and account dialogs. */
import { Play, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { controlInstance, type AdminUser } from '../api.ts'
import { Button, ConfirmDialog, Dialog, Field, IconButton, StatusBadge, Switch } from './ui.tsx'

export type UserRole = AdminUser['role']

export type UserActionRunner = (key: string, action: () => Promise<void>) => Promise<boolean>

export function UserIdentity({ user }: { user: AdminUser }) {
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
  return <StatusBadge tone={role === 'admin' ? 'info' : 'neutral'}>{role === 'admin' ? '管理员' : '普通用户'}</StatusBadge>
}

export function AutoReviewBadge({ eligible }: { eligible: boolean }) {
  return <StatusBadge tone={eligible ? 'info' : 'neutral'}>{eligible ? '已授予' : '未授予'}</StatusBadge>
}

export function AccountBadge({ status }: { status: AdminUser['status'] }) {
  return <StatusBadge tone={status === 'active' ? 'success' : 'danger'}>{status === 'active' ? '正常' : '已禁用'}</StatusBadge>
}

export function InstanceState({ state }: { state: string }) {
  const labels: Record<string, string> = {
    running: '运行中',
    ready: '运行中',
    starting: '启动中',
    stopping: '停止中',
    stopped: '已停止',
    failed: '异常',
  }
  const tone = state === 'running' || state === 'ready' ? 'success' : state === 'starting' ? 'info' : state === 'failed' ? 'danger' : state === 'stopping' ? 'warning' : 'neutral'
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
  const busy = pending.startsWith(`instance:${user.id}:`)
  return (
    <div className="compactActions" aria-label={`${user.username} 实例操作`}>
      <IconButton
        label="启动实例"
        icon={Play}
        disabled={busy || user.instanceState === 'running'}
        loading={pending === `instance:${user.id}:start`}
        onClick={() => void run(`instance:${user.id}:start`, () => controlInstance(user.id, 'start'))}
      />
      <IconButton
        label="停止实例"
        icon={Square}
        disabled={busy || user.instanceState === 'stopped'}
        loading={pending === `instance:${user.id}:stop`}
        onClick={() => void run(`instance:${user.id}:stop`, () => controlInstance(user.id, 'stop'))}
      />
      <IconButton
        label="重启实例"
        icon={RefreshCw}
        disabled={busy || user.instanceState !== 'running'}
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
  const [draft, setDraft] = useState<UserDraft>(EMPTY_USER_DRAFT)
  useEffect(() => { if (open) setDraft(EMPTY_USER_DRAFT) }, [open])
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(draft)
  }
  return (
    <Dialog
      open={open}
      title="新建用户"
      description="创建登录账号并分配初始管理角色。"
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" form="create-user-form" variant="primary" loading={pending}>创建用户</Button>
        </>
      )}
    >
      <form id="create-user-form" className="formGrid" onSubmit={submit}>
        <Field label="用户名" hint="用于登录，创建后不可修改。">
          <input className="input" required autoComplete="off" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} />
        </Field>
        <Field label="显示名">
          <input className="input" value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} placeholder="可选" />
        </Field>
        <Field label="初始密码" className="formSpanFull">
          <input className="input" required type="password" autoComplete="new-password" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} />
        </Field>
        <Field label="角色" className="formSpanFull">
          <select className="select" value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value as UserRole })}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
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
      title={`编辑 ${user?.username ?? ''}`}
      description="更新显示名、管理角色和 Auto 审查资格。"
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" form="edit-user-form" variant="primary" loading={pending}>保存更改</Button>
        </>
      )}
    >
      <form id="edit-user-form" className="formGrid" onSubmit={submit}>
        <Field label="显示名">
          <input className="input" value={name} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label="角色">
          <select className="select" value={role} onChange={event => setRole(event.target.value as UserRole)}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </Field>
        <div className="field">
          <Switch label="允许选择 Auto 审查" checked={eligible} onChange={setEligible} disabled={pending} />
          <span className="fieldHint">授予资格不会自动启用 Auto，也不会改变已有会话或新会话的默认权限。用户仍需在当前会话主动选择。</span>
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
  const [password, setPassword] = useState('')
  useEffect(() => { if (user !== null) setPassword('') }, [user])
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(password)
  }
  return (
    <Dialog
      open={user !== null}
      title={`重置 ${user?.username ?? ''} 的密码`}
      description="新密码会立即替换当前登录密码。"
      onClose={() => { if (!pending) onClose() }}
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" form="reset-password-form" variant="primary" loading={pending}>重置密码</Button>
        </>
      )}
    >
      <form id="reset-password-form" onSubmit={submit}>
        <Field label="新密码">
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
  return (
    <ConfirmDialog
      open={user !== null}
      title="禁用用户"
      description={`禁用 ${user?.username ?? ''} 后，该账号将无法继续登录。`}
      confirmLabel="确认禁用"
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
  return (
    <ConfirmDialog
      open={user !== null}
      title="删除用户"
      description={`删除 ${user?.username ?? ''} 后会立即撤销登录、停止实例并移除项目成员关系。审计、用量、协作会话和本地历史会保留，用户名不可复用；此操作不可恢复。`}
      confirmLabel="确认删除"
      pending={pending}
      onClose={() => { if (!pending) onClose() }}
      onConfirm={onConfirm}
    />
  )
}
