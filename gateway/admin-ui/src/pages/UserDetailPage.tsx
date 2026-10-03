/** User-centric administration: account, qualifications, model overrides, memberships, and quota. */
import { ArrowLeft, KeyRound, Pencil, Power, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  AdminRequestError,
  deleteUser,
  getDesktopPolicy,
  getModelAccess,
  getPluginPolicy,
  getSshPolicy,
  getTerminalPolicy,
  getUser,
  getUserQuota,
  listModels,
  listProjects,
  listUserMemberships,
  patchUser,
  removeMember,
  resetPassword,
  setDesktopPolicy,
  setMember,
  setModelAccess,
  setPluginPolicy,
  setQuota,
  setSshPolicy,
  setTerminalPolicy,
  type AdminUser,
  type GrantMode,
  type ModelGovernanceRow,
  type Project,
  type UserMembership,
  type UserQuotaMode,
  type UserQuotaView,
} from '../api.ts'
import { ModelIdentity, modelKey, OverrideSelect } from '../components/models.tsx'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'
import { UserQualificationCard } from '../components/UserQualificationCard.tsx'
import {
  AccountBadge,
  AutoReviewBadge,
  Definition,
  InstanceControls,
  InstanceState,
  RoleBadge,
  UserDeleteConfirm,
  UserDisableConfirm,
  UserEditDialog,
  UserPasswordDialog,
  type UserRole,
} from '../components/users.tsx'

const messageFrom = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

export function UserDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const userId = Number(params.id)

  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setUser(await getUser(userId))
      setError('')
      setNotFound(false)
    } catch (cause) {
      if (cause instanceof AdminRequestError && cause.status === 404) setNotFound(true)
      else setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [userId])

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

  async function onEdit(patch: { displayName?: string; role?: UserRole; autoReviewEligible?: boolean }) {
    const saved = await run(`edit:${userId}`, () => patchUser(userId, patch))
    if (saved) setEditOpen(false)
  }

  async function onResetPassword(password: string) {
    const saved = await run(`password:${userId}`, () => resetPassword(userId, password))
    if (saved) setPasswordOpen(false)
  }

  async function onDisable() {
    const saved = await run(`status:${userId}`, () => patchUser(userId, { status: 'disabled' }))
    if (saved) setDisableOpen(false)
  }

  async function onDelete() {
    const saved = await run(`delete:${userId}`, () => deleteUser(userId))
    if (saved) { setDeleteOpen(false); navigate('/') }
  }

  if (notFound) {
    return (
      <div className="page">
        <Link className="backLink" to="/"><ArrowLeft aria-hidden="true" />返回用户列表</Link>
        <EmptyState icon={UserRound} title="用户不存在" detail="该账号可能已被删除。" />
      </div>
    )
  }

  return (
    <div className="page">
      <Link className="backLink" to="/"><ArrowLeft aria-hidden="true" />返回用户列表</Link>
      <PageHeader
        title={user === null ? '用户详情' : `用户 · ${user.displayName || user.username}`}
        description={user === null ? undefined : `@${user.username} · ID ${user.id} · 端口 ${user.port}`}
        meta={user === null ? undefined : (
          <span className="pageBadges">
            <RoleBadge role={user.role} />
            <AccountBadge status={user.status} />
            <InstanceState state={user.instanceState} />
          </span>
        )}
        actions={user === null ? undefined : (
          <div className="rowActions">
            <Button icon={Pencil} onClick={() => setEditOpen(true)}>编辑账号</Button>
            <Button icon={KeyRound} onClick={() => setPasswordOpen(true)}>重置密码</Button>
            <Button
              variant={user.status === 'active' ? 'danger' : 'secondary'}
              icon={Power}
              loading={pending === `status:${userId}`}
              onClick={() => { if (user.status === 'active') setDisableOpen(true); else void run(`status:${userId}`, () => patchUser(userId, { status: 'active' })) }}
            >
              {user.status === 'active' ? '禁用' : '启用'}
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>删除</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      {loading && user === null ? <LoadingState label="正在加载用户" /> : user === null ? null : (
        <>
          <Section title="账号与实例">
            <div className="sectionBody">
              <dl className="definitionGrid">
                <Definition label="用户名"><span className="codeText">@{user.username}</span></Definition>
                <Definition label="显示名">{user.displayName === '' ? '未设置' : user.displayName}</Definition>
                <Definition label="Auto 审查资格"><AutoReviewBadge eligible={user.autoReviewEligible} /></Definition>
                <Definition label="实例">
                  <div className="instanceBlock">
                    <InstanceState state={user.instanceState} />
                    <InstanceControls user={user} pending={pending} run={run} />
                  </div>
                </Definition>
                <Definition label="端口"><span className="codeText">{user.port}</span></Definition>
                <Definition label="宿主目录"><span className="codeText">{user.homePath}</span></Definition>
              </dl>
            </div>
          </Section>

          <Section title="能力准入" className="responsiveSection">
            <div className="sectionBody">
              <p className="muted">个人空间的能力资格按用户授予；项目空间同时要求项目授权，在项目详情页和各资源频道管理。</p>
              <div className="qualificationGrid">
                <UserQualificationCard
                  name="SSH"
                  description="远程 SSH 目标上的文件与命令执行资格。"
                  userId={userId}
                  read={getSshPolicy}
                  write={setSshPolicy}
                />
                <UserQualificationCard
                  name="终端"
                  description="在个人空间打开交互式终端会话的资格。"
                  userId={userId}
                  read={getTerminalPolicy}
                  write={setTerminalPolicy}
                />
                <UserQualificationCard
                  name="桌面"
                  description="申请交互桌面授权的资格，不替代会话内的桌面确认。"
                  userId={userId}
                  read={getDesktopPolicy}
                  write={setDesktopPolicy}
                />
                <UserQualificationCard
                  name="插件管理"
                  description="在个人空间管理插件（启用、安装、移除）的资格；项目空间另需项目授权。"
                  userId={userId}
                  read={getPluginPolicy}
                  write={setPluginPolicy}
                />
              </div>
            </div>
          </Section>

          <UserModelAccess key={`${userId}:${user.role}`} userId={userId} role={user.role} />

          <UserMemberships userId={userId} role={user.role} />

          <UserQuota userId={userId} />
        </>
      )}

      <UserEditDialog user={editOpen ? user : null} pending={pending.startsWith('edit:')} onSubmit={patch => void onEdit(patch)} onClose={() => setEditOpen(false)} />
      <UserPasswordDialog user={passwordOpen ? user : null} pending={pending.startsWith('password:')} onSubmit={password => void onResetPassword(password)} onClose={() => setPasswordOpen(false)} />
      <UserDisableConfirm user={disableOpen ? user : null} pending={pending.startsWith('status:')} onConfirm={() => void onDisable()} onClose={() => setDisableOpen(false)} />
      <UserDeleteConfirm user={deleteOpen ? user : null} pending={pending.startsWith('delete:')} onConfirm={() => void onDelete()} onClose={() => setDeleteOpen(false)} />
    </div>
  )
}

function UserModelAccess({ userId, role }: { userId: number; role: UserRole }) {
  const [models, setModels] = useState<ModelGovernanceRow[] | null>(null)
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())
  const [effective, setEffective] = useState<Map<string, boolean>>(new Map())
  const [defaultAllowed, setDefaultAllowed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pendingKey, setPendingKey] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const [rows, access] = await Promise.all([listModels(), getModelAccess(userId)])
      setModels(rows)
      setOverrides(new Map(access.overrides.map(row => [modelKey(row), row.allowed])))
      setEffective(new Map(access.effective.models.map(row => [modelKey(row), row.allowed])))
      setDefaultAllowed(access.effective.defaultAllowed)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  async function changeOverride(row: ModelGovernanceRow, value: string) {
    const key = modelKey(row)
    setPendingKey(key)
    try {
      const allowed = value === 'inherit' ? null : value === 'allow'
      await setModelAccess(userId, row.provider, row.model, allowed)
      const access = await getModelAccess(userId)
      setOverrides(new Map(access.overrides.map(item => [modelKey(item), item.allowed])))
      setEffective(new Map(access.effective.models.map(item => [modelKey(item), item.allowed])))
      setDefaultAllowed(access.effective.defaultAllowed)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPendingKey('')
    }
  }

  const overrideCount = [...overrides.values()].length
  return (
    <Section
      className="responsiveSection"
      title="模型权限"
      meta={models === null ? undefined : `${models.length} 个组织模型 · ${overrideCount} 条例外`}
    >
      <div className="sectionBody">
        <p className="muted">角色默认与计价在「模型」频道维护；此处只管理该用户的逐模型例外。例外立即生效。</p>
        <ErrorBanner message={error} />
      </div>
      {loading ? <LoadingState label="正在加载模型权限" /> : models === null || models.length === 0 ? (
        <EmptyState title="还没有组织模型" detail="完整模型目录由组织 Provider 配置统一维护。" />
      ) : (
        <>
          <div className="tableWrap desktopOnly">
            <table className="dataTable">
              <thead>
                <tr><th>模型</th><th>该账号角色默认</th><th>此用户例外</th><th>生效</th></tr>
              </thead>
              <tbody>
                {models.map(row => {
                  const key = modelKey(row)
                  const override = overrides.get(key)
                  const available = effective.get(key) ?? defaultAllowed
                  const roleAllowed = role === 'admin' ? row.adminAllowed : row.userAllowed
                  return (
                    <tr key={key}>
                      <td><ModelIdentity row={row} /></td>
                      <td><StatusBadge tone={roleAllowed ? 'success' : 'neutral'}>{roleAllowed ? '允许' : '拒绝'}</StatusBadge></td>
                      <td>
                        <OverrideSelect
                          label={`此用户例外`}
                          disabled={pendingKey !== ''}
                          value={override}
                          onChange={value => { void changeOverride(row, value) }}
                        />
                      </td>
                      <td><StatusBadge tone={available ? 'success' : 'danger'}>{available ? '可用' : '拒绝'}</StatusBadge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mobileList">
            {models.map(row => {
              const key = modelKey(row)
              const override = overrides.get(key)
              const available = effective.get(key) ?? defaultAllowed
              const roleAllowed = role === 'admin' ? row.adminAllowed : row.userAllowed
              return (
                <article className="mobileItem" key={key}>
                  <div className="mobileItemHeader">
                    <ModelIdentity row={row} />
                    <StatusBadge tone={available ? 'success' : 'danger'}>{available ? '可用' : '拒绝'}</StatusBadge>
                  </div>
                  <div className="mobileItemBody">
                    <div className="mobileStatusRow">
                      <span className="fieldLabel">角色默认</span>
                      <StatusBadge tone={roleAllowed ? 'success' : 'neutral'}>{roleAllowed ? '允许' : '拒绝'}</StatusBadge>
                    </div>
                    <div>
                      <span className="fieldLabel">此用户例外</span>
                      <OverrideSelect
                        label="此用户例外"
                        disabled={pendingKey !== ''}
                        value={override}
                        onChange={value => { void changeOverride(row, value) }}
                      />
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      )}
    </Section>
  )
}

function UserMemberships({ userId, role }: { userId: number; role: UserRole }) {
  const [memberships, setMemberships] = useState<UserMembership[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingKey, setPendingKey] = useState('')
  const [error, setError] = useState('')
  const [addProjectId, setAddProjectId] = useState('')
  const [addMode, setAddMode] = useState<GrantMode>('rw')
  const [removeTarget, setRemoveTarget] = useState<UserMembership | null>(null)

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const [membershipResult, projectRows] = await Promise.all([listUserMemberships(userId), listProjects()])
      setMemberships(membershipResult.memberships)
      setProjects(projectRows)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  const memberIds = useMemo(() => new Set((memberships ?? []).map(row => row.projectId)), [memberships])
  const joinable = useMemo(() => projects.filter(project => !memberIds.has(project.id)), [projects, memberIds])

  async function changeMode(membership: UserMembership, mode: GrantMode) {
    if (mode === membership.mode) return
    setPendingKey(`member:${membership.projectId}`)
    try {
      await setMember(membership.projectId, userId, mode)
      await load(false)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPendingKey('')
    }
  }

  async function onRemove() {
    if (removeTarget === null) return
    setPendingKey(`member:${removeTarget.projectId}`)
    try {
      await removeMember(removeTarget.projectId, userId)
      setRemoveTarget(null)
      await load(false)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPendingKey('')
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault()
    const projectId = Number(addProjectId)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return
    setPendingKey('member:add')
    try {
      await setMember(projectId, userId, addMode)
      setAddProjectId('')
      setAddMode('rw')
      await load(false)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setPendingKey('')
    }
  }

  return (
    <Section
      className="responsiveSection"
      title="项目成员"
      meta={memberships === null ? undefined : `${memberships.length} 个项目`}
    >
      <div className="sectionBody">
        <p className="muted">
          {role === 'admin'
            ? '管理员角色对所有项目拥有隐式全权；成员行只为审计与成员列表记录明确授权。'
            : '成员行决定该用户在各项目中的目录权限；项目的模型授权在项目详情页管理。'}
        </p>
        <ErrorBanner message={error} />
      </div>
      {loading ? <LoadingState label="正在加载项目成员" /> : (
        <>
          {memberships === null || memberships.length === 0 ? (
            <EmptyState title="不属于任何项目" detail="使用下方表单将此用户加入项目。" />
          ) : (
            <>
              <div className="tableWrap desktopOnly">
                <table className="dataTable">
                  <thead><tr><th>项目</th><th>路径</th><th>目录权限</th><th aria-label="操作" /></tr></thead>
                  <tbody>
                    {memberships.map(row => (
                      <tr key={row.projectId}>
                        <td><Link className="projectLink" to={`/projects/${row.projectId}`}>{row.name}</Link></td>
                        <td><span className="codeText">{row.path}</span></td>
                        <td>
                          <select
                            className="select selectCompact"
                            aria-label={`${row.name} 目录权限`}
                            value={row.mode}
                            disabled={pendingKey !== ''}
                            onChange={event => { void changeMode(row, event.target.value as GrantMode) }}
                          >
                            <option value="rw">读写</option>
                            <option value="ro">只读</option>
                          </select>
                        </td>
                        <td><div className="rowActions"><IconButton label={`移出 ${row.name}`} icon={Trash2} variant="danger" onClick={() => setRemoveTarget(row)} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mobileList">
                {memberships.map(row => (
                  <article className="mobileItem" key={row.projectId}>
                    <div className="mobileItemHeader">
                      <Link className="projectLink" to={`/projects/${row.projectId}`}><strong>{row.name}</strong></Link>
                      <IconButton label={`移出 ${row.name}`} icon={Trash2} variant="danger" onClick={() => setRemoveTarget(row)} />
                    </div>
                    <div className="mobileItemBody">
                      <span className="codeText">{row.path}</span>
                      <div>
                        <span className="fieldLabel">目录权限</span>
                        <select
                          className="select"
                          aria-label={`${row.name} 目录权限`}
                          value={row.mode}
                          disabled={pendingKey !== ''}
                          onChange={event => { void changeMode(row, event.target.value as GrantMode) }}
                        >
                          <option value="rw">读写</option>
                          <option value="ro">只读</option>
                        </select>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          <div className="sectionBody">
            <form className="memberAddRow" onSubmit={event => void onAdd(event)}>
              <select className="select" aria-label="要加入的项目" value={addProjectId} disabled={pendingKey !== ''} onChange={event => setAddProjectId(event.target.value)}>
                <option value="">选择项目</option>
                {joinable.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <select className="select selectCompact" aria-label="目录权限" value={addMode} disabled={pendingKey !== ''} onChange={event => setAddMode(event.target.value as GrantMode)}>
                <option value="rw">读写</option>
                <option value="ro">只读</option>
              </select>
              <Button type="submit" variant="secondary" loading={pendingKey === 'member:add'} disabled={addProjectId === ''}>加入项目</Button>
            </form>
          </div>
        </>
      )}
      <ConfirmDialog
        open={removeTarget !== null}
        title="移出项目"
        description={`将 ${removeTarget?.name ?? ''} 的成员关系移除此用户；该用户在该项目的私有会话保留但不再可访问。`}
        confirmLabel="确认移出"
        pending={pendingKey.startsWith('member:')}
        onClose={() => { if (!pendingKey.startsWith('member:')) setRemoveTarget(null) }}
        onConfirm={() => void onRemove()}
      />
    </Section>
  )
}

function UserQuota({ userId }: { userId: number }) {
  const [quota, setQuotaView] = useState<UserQuotaView | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tokenMode, setTokenMode] = useState<UserQuotaMode>('inherit')
  const [costMode, setCostMode] = useState<UserQuotaMode>('inherit')
  const [tokenLimit, setTokenLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const value = await getUserQuota(userId)
      setQuotaView(value)
      setTokenMode(value.tokenMode)
      setCostMode(value.companyCostMode)
      setTokenLimit(value.tokenLimit === null ? '' : String(value.tokenLimit))
      setCostLimit(value.companyCostMicrosLimit === null ? '' : String(value.companyCostMicrosLimit / 1_000_000))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const parsedToken = Number(tokenLimit)
      const parsedCost = Number(costLimit)
      if (tokenMode === 'custom' && (!Number.isSafeInteger(parsedToken) || parsedToken < 0)) {
        throw new Error('Token 额度必须是非负整数')
      }
      const costMicros = Math.round(parsedCost * 1_000_000)
      if (costMode === 'custom' && (!Number.isFinite(parsedCost) || parsedCost < 0 || !Number.isSafeInteger(costMicros))) {
        throw new Error('成本额度必须是有效的非负数')
      }
      const nextTokenLimit: number | null | 'inherit' = tokenMode === 'inherit' ? 'inherit' : tokenMode === 'unlimited' ? null : parsedToken
      const nextCostLimit: number | null | 'inherit' = costMode === 'inherit' ? 'inherit' : costMode === 'unlimited' ? null : costMicros
      await setQuota({
        subjectType: 'user',
        subjectId: String(userId),
        tokenLimit: nextTokenLimit,
        companyCostMicrosLimit: nextCostLimit,
      })
      await load(false)
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setSaving(false)
    }
  }

  const quotaSummary = quota === null ? '' : [
    quota.tokenMode === 'inherit' ? 'Token 继承角色' : quota.tokenMode === 'unlimited' ? 'Token 不限' : `Token ${quota.tokenLimit?.toLocaleString() ?? ''}`,
    quota.companyCostMode === 'inherit' ? '成本继承角色' : quota.companyCostMode === 'unlimited' ? '成本不限' : `成本 元 ${((quota.companyCostMicrosLimit ?? 0) / 1_000_000).toLocaleString()}`,
  ].join(' · ')

  return (
    <Section title="配额" meta={quota === null ? undefined : quotaSummary}>
      <div className="sectionBody">
        <p className="muted">额度按自然月统计，在 80% 和 100% 产生告警，但不会阻断模型调用。继承表示跟随其角色的月度额度。</p>
        <ErrorBanner message={error} />
        {loading ? <LoadingState label="正在加载配额" /> : (
          <form className="userQuotaForm" onSubmit={event => void save(event)}>
            <QuotaMetricEditor
              label="Token 额度"
              mode={tokenMode}
              value={tokenLimit}
              inputLabel="每月 Token"
              inputMode="numeric"
              onMode={setTokenMode}
              onValue={setTokenLimit}
            />
            <QuotaMetricEditor
              label="公司成本额度"
              mode={costMode}
              value={costLimit}
              inputLabel="每月人民币元"
              inputMode="decimal"
              onMode={setCostMode}
              onValue={setCostLimit}
            />
            <div className="quotaSaveRow">
              <Button type="submit" variant="primary" loading={saving}>保存配额</Button>
            </div>
          </form>
        )}
      </div>
    </Section>
  )
}

function QuotaMetricEditor({ label, mode, value, inputLabel, inputMode, onMode, onValue }: {
  label: string
  mode: UserQuotaMode
  value: string
  inputLabel: string
  inputMode: 'numeric' | 'decimal'
  onMode: (mode: UserQuotaMode) => void
  onValue: (value: string) => void
}) {
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label="额度模式">
        <select className="select" value={mode} onChange={event => onMode(event.target.value as UserQuotaMode)}>
          <option value="inherit">继承角色额度</option>
          <option value="unlimited">无限制</option>
          <option value="custom">自定义</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : (
        <div className="quotaModeNote">{mode === 'inherit' ? '跟随其角色的月度额度。' : '不设置月度上限。'}</div>
      )}
    </fieldset>
  )
}
