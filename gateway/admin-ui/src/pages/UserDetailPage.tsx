/** User-centric administration: account, qualifications, model overrides, memberships, and quota. */
import { ArrowLeft, KeyRound, Pencil, Power, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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
import { adminLanguage, translateCopy } from '../language.ts'
import { formatCostInput, parseCostInput } from '../money.ts'
import { zh as userDetailZh, en as userDetailEn } from './user-detail.copy.ts'

const messageFrom = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

export function UserDetailPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
  const params = useParams()
  const userId = Number(params.id)
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return (
      <div className="page">
        <Link className="backLink" to="/"><ArrowLeft aria-hidden="true" />{t('backToUsers')}</Link>
        <EmptyState icon={UserRound} title={t('notFoundTitle')} detail={t('notFoundDetail')} />
      </div>
    )
  }
  return <UserDetail key={params.id} userId={userId} />
}

function UserDetail({ userId }: { userId: number }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
  const navigate = useNavigate()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

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
      // A stale instance's committed write must not follow up on a remount.
      if (!alive.current) return true
      await reload()
      return true
    } catch (cause) {
      if (alive.current) setError(messageFrom(cause))
      return false
    } finally {
      if (alive.current) setPending('')
    }
  }

  async function onEdit(patch: { displayName?: string; role?: UserRole; autoReviewEligible?: boolean }) {
    const saved = await run(`edit:${userId}`, () => patchUser(userId, patch))
    if (saved && alive.current) setEditOpen(false)
  }

  async function onResetPassword(password: string) {
    const saved = await run(`password:${userId}`, () => resetPassword(userId, password))
    if (saved && alive.current) setPasswordOpen(false)
  }

  async function onDisable() {
    const saved = await run(`status:${userId}`, () => patchUser(userId, { status: 'disabled' }))
    if (saved && alive.current) setDisableOpen(false)
  }

  async function onDelete() {
    const saved = await run(`delete:${userId}`, () => deleteUser(userId))
    // A stale instance's delete cannot navigate away from a remounted detail.
    if (saved && alive.current) { setDeleteOpen(false); navigate('/') }
  }

  if (notFound) {
    return (
      <div className="page">
        <Link className="backLink" to="/"><ArrowLeft aria-hidden="true" />{t('backToUsers')}</Link>
        <EmptyState icon={UserRound} title={t('notFoundTitle')} detail={t('notFoundDetail')} />
      </div>
    )
  }

  return (
    <div className="page">
      <Link className="backLink" to="/"><ArrowLeft aria-hidden="true" />{t('backToUsers')}</Link>
      <PageHeader
        title={user === null ? t('pageTitle') : t('pageTitleUser', { name: user.displayName || user.username })}
        description={user === null ? undefined : t('pageDescription', { username: user.username, id: String(user.id), port: String(user.port) })}
        meta={user === null ? undefined : (
          <span className="pageBadges">
            <RoleBadge role={user.role} />
            <AccountBadge status={user.status} />
            <InstanceState state={user.instanceState} />
          </span>
        )}
        actions={user === null ? undefined : (
          <div className="rowActions">
            <Button icon={Pencil} onClick={() => setEditOpen(true)}>{t('editAccount')}</Button>
            <Button icon={KeyRound} onClick={() => setPasswordOpen(true)}>{t('resetPassword')}</Button>
            <Button
              variant={user.status === 'active' ? 'danger' : 'secondary'}
              icon={Power}
              loading={pending === `status:${userId}`}
              onClick={() => { if (user.status === 'active') setDisableOpen(true); else void run(`status:${userId}`, () => patchUser(userId, { status: 'active' })) }}
            >
              {user.status === 'active' ? t('disable') : t('enable')}
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>{t('deleteAction')}</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      {loading && user === null ? <LoadingState label={t('loadingUser')} /> : user === null ? null : (
        <>
          <Section title={t('sectionAccount')}>
            <div className="sectionBody">
              <dl className="definitionGrid">
                <Definition label={t('defUsername')}><span className="codeText">@{user.username}</span></Definition>
                <Definition label={t('defDisplayName')}>{user.displayName === '' ? t('notSet') : user.displayName}</Definition>
                <Definition label={t('defAutoReview')}><AutoReviewBadge eligible={user.autoReviewEligible} /></Definition>
                <Definition label={t('defInstance')}>
                  <div className="instanceBlock">
                    <InstanceState state={user.instanceState} />
                    <InstanceControls user={user} pending={pending} run={run} />
                  </div>
                </Definition>
                <Definition label={t('defPort')}><span className="codeText">{user.port}</span></Definition>
                <Definition label={t('defHomePath')}><span className="codeText">{user.homePath}</span></Definition>
              </dl>
            </div>
          </Section>

          <Section title={t('sectionQualifications')} className="responsiveSection">
            <div className="sectionBody">
              <p className="muted">{t('qualificationsHint')}</p>
              <div className="qualificationGrid">
                <UserQualificationCard
                  name="SSH"
                  description={t('qualSshDescription')}
                  userId={userId}
                  read={getSshPolicy}
                  write={setSshPolicy}
                />
                <UserQualificationCard
                  name={t('qualTerminalName')}
                  description={t('qualTerminalDescription')}
                  userId={userId}
                  read={getTerminalPolicy}
                  write={setTerminalPolicy}
                />
                <UserQualificationCard
                  name={t('qualDesktopName')}
                  description={t('qualDesktopDescription')}
                  userId={userId}
                  read={getDesktopPolicy}
                  write={setDesktopPolicy}
                />
                <UserQualificationCard
                  name={t('qualPluginName')}
                  description={t('qualPluginDescription')}
                  userId={userId}
                  read={getPluginPolicy}
                  write={setPluginPolicy}
                />
              </div>
            </div>
          </Section>

          <UserModelAccess key={`${userId}:${user.role}`} userId={userId} role={user.role} />

          <UserMemberships userId={userId} role={user.role} />

          <UserQuota key={userId} userId={userId} />
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
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
      title={t('sectionModels')}
      meta={models === null ? undefined : t('modelsMeta', { count: String(models.length), overrides: String(overrideCount) })}
    >
      <div className="sectionBody">
        <p className="muted">{t('modelsHint')}</p>
        <ErrorBanner message={error} />
      </div>
      {loading ? <LoadingState label={t('loadingModels')} /> : models === null || models.length === 0 ? (
        <EmptyState title={t('modelsEmptyTitle')} detail={t('modelsEmptyDetail')} />
      ) : (
        <>
          <div className="tableWrap desktopOnly">
            <table className="dataTable">
              <thead>
                <tr><th>{t('colModel')}</th><th>{t('colRoleDefault')}</th><th>{t('userOverride')}</th><th>{t('colEffective')}</th></tr>
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
                      <td><StatusBadge tone={roleAllowed ? 'success' : 'neutral'}>{roleAllowed ? t('allowed') : t('denied')}</StatusBadge></td>
                      <td>
                        <OverrideSelect
                          label={t('userOverride')}
                          disabled={pendingKey !== ''}
                          value={override}
                          onChange={value => { void changeOverride(row, value) }}
                        />
                      </td>
                      <td><StatusBadge tone={available ? 'success' : 'danger'}>{available ? t('available') : t('denied')}</StatusBadge></td>
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
                    <StatusBadge tone={available ? 'success' : 'danger'}>{available ? t('available') : t('denied')}</StatusBadge>
                  </div>
                  <div className="mobileItemBody">
                    <div className="mobileStatusRow">
                      <span className="fieldLabel">{t('roleDefault')}</span>
                      <StatusBadge tone={roleAllowed ? 'success' : 'neutral'}>{roleAllowed ? t('allowed') : t('denied')}</StatusBadge>
                    </div>
                    <div>
                      <span className="fieldLabel">{t('userOverride')}</span>
                      <OverrideSelect
                        label={t('userOverride')}
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
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
      title={t('sectionMemberships')}
      meta={memberships === null ? undefined : t('membershipsMeta', { count: String(memberships.length) })}
    >
      <div className="sectionBody">
        <p className="muted">
          {role === 'admin'
            ? t('membershipsHintAdmin')
            : t('membershipsHintUser')}
        </p>
        <ErrorBanner message={error} />
      </div>
      {loading ? <LoadingState label={t('loadingMemberships')} /> : (
        <>
          {memberships === null || memberships.length === 0 ? (
            <EmptyState title={t('membershipsEmptyTitle')} detail={t('membershipsEmptyDetail')} />
          ) : (
            <>
              <div className="tableWrap desktopOnly">
                <table className="dataTable">
                  <thead><tr><th>{t('colProject')}</th><th>{t('colPath')}</th><th>{t('permission')}</th><th aria-label={t('colActions')} /></tr></thead>
                  <tbody>
                    {memberships.map(row => (
                      <tr key={row.projectId}>
                        <td><Link className="projectLink" to={`/projects/${row.projectId}`}>{row.name}</Link></td>
                        <td><span className="codeText">{row.path}</span></td>
                        <td>
                          <select
                            className="select selectCompact"
                            aria-label={t('permissionAria', { name: row.name })}
                            value={row.mode}
                            disabled={pendingKey !== ''}
                            onChange={event => { void changeMode(row, event.target.value as GrantMode) }}
                          >
                            <option value="rw">{t('modeReadWrite')}</option>
                            <option value="ro">{t('modeReadOnly')}</option>
                          </select>
                        </td>
                        <td><div className="rowActions"><IconButton label={t('removeLabel', { name: row.name })} icon={Trash2} variant="danger" onClick={() => setRemoveTarget(row)} /></div></td>
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
                      <IconButton label={t('removeLabel', { name: row.name })} icon={Trash2} variant="danger" onClick={() => setRemoveTarget(row)} />
                    </div>
                    <div className="mobileItemBody">
                      <span className="codeText">{row.path}</span>
                      <div>
                        <span className="fieldLabel">{t('permission')}</span>
                        <select
                          className="select"
                          aria-label={t('permissionAria', { name: row.name })}
                          value={row.mode}
                          disabled={pendingKey !== ''}
                          onChange={event => { void changeMode(row, event.target.value as GrantMode) }}
                        >
                          <option value="rw">{t('modeReadWrite')}</option>
                          <option value="ro">{t('modeReadOnly')}</option>
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
              <select className="select" aria-label={t('joinProjectAria')} value={addProjectId} disabled={pendingKey !== ''} onChange={event => setAddProjectId(event.target.value)}>
                <option value="">{t('selectProject')}</option>
                {joinable.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <select className="select selectCompact" aria-label={t('permission')} value={addMode} disabled={pendingKey !== ''} onChange={event => setAddMode(event.target.value as GrantMode)}>
                <option value="rw">{t('modeReadWrite')}</option>
                <option value="ro">{t('modeReadOnly')}</option>
              </select>
              <Button type="submit" variant="secondary" loading={pendingKey === 'member:add'} disabled={addProjectId === ''}>{t('joinProject')}</Button>
            </form>
          </div>
        </>
      )}
      <ConfirmDialog
        open={removeTarget !== null}
        title={t('removeTitle')}
        description={t('removeDescription', { name: removeTarget?.name ?? '' })}
        confirmLabel={t('removeConfirm')}
        pending={pendingKey.startsWith('member:')}
        onClose={() => { if (!pendingKey.startsWith('member:')) setRemoveTarget(null) }}
        onConfirm={() => void onRemove()}
      />
    </Section>
  )
}

function UserQuota({ userId }: { userId: number }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
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
      setCostLimit(value.companyCostMicrosLimit === null ? '' : formatCostInput(value.companyCostMicrosLimit))
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
      if (tokenMode === 'custom' && (tokenLimit.trim() === '' || !Number.isSafeInteger(parsedToken) || parsedToken < 0)) {
        throw new Error(t('quotaTokenInvalid'))
      }
      let costMicros = 0
      if (costMode === 'custom') {
        try {
          costMicros = parseCostInput(costLimit)
        } catch {
          throw new Error(t('quotaCostInvalid'))
        }
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
    quota.tokenMode === 'inherit' ? t('quotaTokenInherit') : quota.tokenMode === 'unlimited' ? t('quotaTokenUnlimited') : t('quotaTokenCustom', { limit: quota.tokenLimit?.toLocaleString() ?? '' }),
    quota.companyCostMode === 'inherit' ? t('quotaCostInherit') : quota.companyCostMode === 'unlimited' ? t('quotaCostUnlimited') : t('quotaCostCustom', { amount: ((quota.companyCostMicrosLimit ?? 0) / 1_000_000).toLocaleString() }),
  ].join(' · ')

  return (
    <Section title={t('sectionQuota')} meta={quota === null ? undefined : quotaSummary}>
      <div className="sectionBody">
        <p className="muted">{t('quotaHint')}</p>
        <ErrorBanner message={error} />
        {loading ? <LoadingState label={t('loadingQuota')} /> : (
          <form className="userQuotaForm" onSubmit={event => void save(event)}>
            <QuotaMetricEditor
              label={t('quotaTokenLabel')}
              mode={tokenMode}
              value={tokenLimit}
              inputLabel={t('quotaTokenInput')}
              inputMode="numeric"
              onMode={setTokenMode}
              onValue={setTokenLimit}
            />
            <QuotaMetricEditor
              label={t('quotaCostLabel')}
              mode={costMode}
              value={costLimit}
              inputLabel={t('quotaCostInput')}
              inputMode="decimal"
              onMode={setCostMode}
              onValue={setCostLimit}
            />
            <div className="quotaSaveRow">
              <Button type="submit" variant="primary" loading={saving}>{t('quotaSave')}</Button>
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: userDetailZh, en: userDetailEn }), [])
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label={t('quotaMode')}>
        <select className="select" value={mode} onChange={event => onMode(event.target.value as UserQuotaMode)}>
          <option value="inherit">{t('quotaModeInherit')}</option>
          <option value="unlimited">{t('quotaModeUnlimited')}</option>
          <option value="custom">{t('quotaModeCustom')}</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : (
        <div className="quotaModeNote">{mode === 'inherit' ? t('quotaInheritNote') : t('quotaUnlimitedNote')}</div>
      )}
    </fieldset>
  )
}
