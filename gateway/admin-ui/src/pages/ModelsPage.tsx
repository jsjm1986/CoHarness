import { ClipboardList, Filter, Pencil, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  getModelAccess,
  listModelRegistrations,
  listModels,
  listUsers,
  saveModel,
  setModelAccess,
  type AdminUser,
  type ModelGovernanceRow,
  type ModelRegistrationAction,
  type ModelRegistrationReport,
} from '../api.ts'
import { OrganizationModelsEditor } from '../components/OrganizationModelsEditor.tsx'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
  Switch,
} from '../components/ui.tsx'

type ModelsView = 'catalog' | 'governance' | 'personal'

type RegistrationFilters = {
  user: string
  provider: string
  model: string
  action: ModelRegistrationAction | ''
  from: string
  to: string
}

const EMPTY_REGISTRATION_FILTERS: RegistrationFilters = {
  user: '', provider: '', model: '', action: '', from: '', to: '',
}

const PRICE_LABELS = ['输入', '输出', '缓存读取', '缓存写入'] as const

function yuanToMicros(value: string): number {
  const yuan = Number(value)
  if (!Number.isFinite(yuan) || yuan < 0) throw new Error('单价必须是非负数')
  return Math.round(yuan * 1_000_000)
}

function microsToYuan(value: number): string {
  return (value / 1_000_000).toFixed(4)
}

export function ModelsPage() {
  const [view, setView] = useState<ModelsView>('catalog')
  const [models, setModels] = useState<ModelGovernanceRow[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [accessLoading, setAccessLoading] = useState(false)
  const [error, setError] = useState('')

  const [editingModel, setEditingModel] = useState<ModelGovernanceRow | null>(null)
  const [modelDraft, setModelDraft] = useState<ModelGovernanceRow | null>(null)
  const [prices, setPrices] = useState(['0', '0', '0', '0'])
  const [modelSaving, setModelSaving] = useState(false)

  const [selectedUser, setSelectedUser] = useState('')
  const [overrides, setOverrides] = useState(new Map<string, boolean>())
  const [overridePending, setOverridePending] = useState('')
  const [registrationReport, setRegistrationReport] = useState<ModelRegistrationReport | null>(null)
  const [registrationLoading, setRegistrationLoading] = useState(false)
  const [registrationDraft, setRegistrationDraft] = useState<RegistrationFilters>(EMPTY_REGISTRATION_FILTERS)
  const [registrationFilters, setRegistrationFilters] = useState<RegistrationFilters>(EMPTY_REGISTRATION_FILTERS)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const [nextModels, nextUsers] = await Promise.all([listModels(), listUsers()])
      setModels(nextModels)
      setUsers(nextUsers)
      setSelectedUser(current => current === '' || !nextUsers.some(user => String(user.id) === current)
        ? String(nextUsers[0]?.id ?? '')
        : current)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void reload(true) }, [reload])

  const reloadRegistrations = useCallback(async () => {
    setRegistrationLoading(true)
    try {
      const next = await listModelRegistrations({
        ...registrationFilters.user === '' ? {} : { userId: Number(registrationFilters.user) },
        ...registrationFilters.provider.trim() === '' ? {} : { provider: registrationFilters.provider.trim() },
        ...registrationFilters.model.trim() === '' ? {} : { model: registrationFilters.model.trim() },
        ...registrationFilters.action === '' ? {} : { action: registrationFilters.action },
        ...registrationFilters.from === '' ? {} : { from: Date.parse(`${registrationFilters.from}T00:00:00`) },
        ...registrationFilters.to === '' ? {} : { to: Date.parse(`${registrationFilters.to}T23:59:59.999`) + 1 },
        limit: 200,
      })
      setRegistrationReport(next)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setRegistrationLoading(false)
    }
  }, [registrationFilters])

  useEffect(() => {
    if (view === 'personal') void reloadRegistrations()
  }, [reloadRegistrations, view])

  useEffect(() => {
    let active = true
    if (selectedUser === '') {
      setOverrides(new Map())
      setAccessLoading(false)
      return () => { active = false }
    }
    setAccessLoading(true)
    void getModelAccess(Number(selectedUser)).then(access => {
      if (!active) return
      setOverrides(new Map(access.overrides.map(row => [modelKey(row), row.allowed])))
      setError('')
    }).catch(cause => {
      if (active) setError(messageFrom(cause))
    }).finally(() => {
      if (active) setAccessLoading(false)
    })
    return () => { active = false }
  }, [selectedUser])

  const selected = useMemo(() => users.find(user => String(user.id) === selectedUser), [selectedUser, users])
  const modelSettingsChanged = useCallback(() => { void reload() }, [reload])

  function applyRegistrationFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setRegistrationFilters(registrationDraft)
  }

  function resetRegistrationFilters(): void {
    setRegistrationDraft(EMPTY_REGISTRATION_FILTERS)
    setRegistrationFilters(EMPTY_REGISTRATION_FILTERS)
  }

  function openGovernanceEditor(model: ModelGovernanceRow) {
    setEditingModel(model)
    setModelDraft({ ...model })
    setPrices([
      microsToYuan(model.inputMicrosPerMillion),
      microsToYuan(model.outputMicrosPerMillion),
      microsToYuan(model.cacheReadMicrosPerMillion),
      microsToYuan(model.cacheWriteMicrosPerMillion),
    ])
  }

  async function submitGovernance(event: FormEvent) {
    event.preventDefault()
    if (modelDraft === null) return
    setModelSaving(true)
    try {
      await saveModel({
        ...modelDraft,
        inputMicrosPerMillion: yuanToMicros(prices[0] ?? '0'),
        outputMicrosPerMillion: yuanToMicros(prices[1] ?? '0'),
        cacheReadMicrosPerMillion: yuanToMicros(prices[2] ?? '0'),
        cacheWriteMicrosPerMillion: yuanToMicros(prices[3] ?? '0'),
      })
      setEditingModel(null)
      setModelDraft(null)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setModelSaving(false)
    }
  }

  async function changeOverride(row: ModelGovernanceRow, value: string) {
    if (selectedUser === '') return
    const key = modelKey(row)
    setOverridePending(key)
    try {
      const allowed = value === 'inherit' ? null : value === 'allow'
      await setModelAccess(Number(selectedUser), row.provider, row.model, allowed)
      const access = await getModelAccess(Number(selectedUser))
      setOverrides(new Map(access.overrides.map(item => [modelKey(item), item.allowed])))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setOverridePending('')
    }
  }

  const actions = (
    <div className="pageToolbar modelPageToolbar">
      <div className="segmented modelViewTabs" role="group" aria-label="模型治理视图">
        <button type="button" aria-pressed={view === 'catalog'} onClick={() => setView('catalog')}>组织模型</button>
        <button type="button" aria-pressed={view === 'governance'} onClick={() => setView('governance')}>权限与计价</button>
        <button type="button" aria-pressed={view === 'personal'} onClick={() => setView('personal')}>个人登记</button>
      </div>
    </div>
  )

  return (
    <div className="page">
      <PageHeader
        title="模型治理"
        description="统一管理组织 Provider 与模型目录、访问权限和计价；个人 BYOK 仅在个人运行时可用，新项目默认跟随组织模型目录。"
        meta={loading ? undefined : `${models.length} 个组织模型`}
        actions={actions}
      />
      <ErrorBanner message={error} />
      {view === 'catalog'
        ? <OrganizationModelsEditor onChanged={modelSettingsChanged} />
        : view === 'governance' ? (
          <ModelDirectory
            loading={loading}
            models={models}
            users={users}
            selectedUser={selectedUser}
            selected={selected}
            accessLoading={accessLoading}
            overrides={overrides}
            overridePending={overridePending}
            onSelectUser={setSelectedUser}
            onEdit={openGovernanceEditor}
            onOverride={changeOverride}
          />
        ) : (
          <PersonalRegistrationAudit
            users={users}
            report={registrationReport}
            loading={registrationLoading}
            draft={registrationDraft}
            onDraft={setRegistrationDraft}
            onApply={applyRegistrationFilters}
            onReset={resetRegistrationFilters}
            onRefresh={() => { void reloadRegistrations() }}
          />
        )}

      <Dialog
        open={editingModel !== null && modelDraft !== null}
        title="配置模型治理"
        description="Provider 和模型身份由组织模型插件维护；此处只配置运行权限和计价。"
        onClose={() => {
          if (modelSaving) return
          setEditingModel(null)
          setModelDraft(null)
        }}
        footer={(
          <>
            <Button type="button" disabled={modelSaving} onClick={() => {
              setEditingModel(null)
              setModelDraft(null)
            }}>取消</Button>
            <Button type="submit" form="model-governance-form" variant="primary" loading={modelSaving}>保存治理配置</Button>
          </>
        )}
      >
        {modelDraft === null ? null : (
          <form id="model-governance-form" onSubmit={event => void submitGovernance(event)}>
            <div className="modelGovernanceIdentity">
              <strong>{modelDraft.displayName}</strong>
              <span className="codeText">{modelDraft.provider}/{modelDraft.model}</span>
            </div>
            <div className="formDivider" />
            <div className="toggleGrid">
              <Switch label="启用模型" checked={modelDraft.enabled} onChange={enabled => setModelDraft({ ...modelDraft, enabled })} />
              <Switch label="管理员默认允许" checked={modelDraft.adminAllowed} onChange={adminAllowed => setModelDraft({ ...modelDraft, adminAllowed })} />
              <Switch label="普通用户默认允许" checked={modelDraft.userAllowed} onChange={userAllowed => setModelDraft({ ...modelDraft, userAllowed })} />
            </div>
            <div className="formDivider" />
            <span className="fieldLabel">单价（人民币元 / 百万 Token）</span>
            <div className="priceGrid formSectionSpacing">
              {PRICE_LABELS.map((label, index) => (
                <Field key={label} label={label}>
                  <input
                    className="input"
                    required
                    min="0"
                    step="0.0001"
                    inputMode="decimal"
                    value={prices[index]}
                    onChange={event => setPrices(prices.map((value, current) => current === index ? event.target.value : value))}
                  />
                </Field>
              ))}
            </div>
          </form>
        )}
      </Dialog>
    </div>
  )
}

function PersonalRegistrationAudit({
  users,
  report,
  loading,
  draft,
  onDraft,
  onApply,
  onReset,
  onRefresh,
}: {
  users: AdminUser[]
  report: ModelRegistrationReport | null
  loading: boolean
  draft: RegistrationFilters
  onDraft: (value: RegistrationFilters) => void
  onApply: (event: FormEvent<HTMLFormElement>) => void
  onReset: () => void
  onRefresh: () => void
}) {
  const summary = report?.summary
  return (
    <Section
      className="responsiveSection"
      title="个人 Provider 与模型登记"
      meta={summary === undefined ? undefined : `${summary.providerCount} 个 Provider · ${summary.modelCount} 个模型`}
      actions={<Button type="button" icon={RefreshCw} onClick={onRefresh}>刷新</Button>}
    >
      <p className="inlineNotice">个人可以自由添加和管理 Provider 与模型；此页仅记录登记变化，不参与审批或权限限制。</p>
      <form className="registrationFilterPanel" onSubmit={onApply} aria-label="个人登记筛选">
        <div className="registrationFilters">
          <Field label="用户">
            <select className="select" value={draft.user} onChange={event => onDraft({ ...draft, user: event.target.value })} aria-label="筛选用户">
              <option value="">全部用户</option>
              {users.map(item => <option key={item.id} value={item.id}>{item.username}</option>)}
            </select>
          </Field>
          <Field label="Provider">
            <input className="input" value={draft.provider} onChange={event => onDraft({ ...draft, provider: event.target.value })} placeholder="按 Provider 筛选" aria-label="筛选 Provider" />
          </Field>
          <Field label="模型">
            <input className="input" value={draft.model} onChange={event => onDraft({ ...draft, model: event.target.value })} placeholder="按模型筛选" aria-label="筛选模型" />
          </Field>
          <Field label="开始日期">
            <input className="input" type="date" value={draft.from} onChange={event => onDraft({ ...draft, from: event.target.value })} aria-label="开始日期" />
          </Field>
          <Field label="结束日期">
            <input className="input" type="date" value={draft.to} onChange={event => onDraft({ ...draft, to: event.target.value })} aria-label="结束日期" />
          </Field>
          <Field label="动作">
            <select className="select" value={draft.action} onChange={event => onDraft({ ...draft, action: event.target.value as ModelRegistrationAction | '' })} aria-label="筛选动作">
              <option value="">全部动作</option>
              {Object.entries(REGISTRATION_ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="filterActions registrationFilterActions">
          <Button type="button" icon={RotateCcw} onClick={onReset}>重置</Button>
          <Button type="submit" variant="primary" icon={Filter}>应用筛选</Button>
        </div>
      </form>
      {loading ? <LoadingState label="正在加载个人登记记录" /> : report === null || report.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="暂无个人登记记录" detail="个人新增 Provider 或模型后，记录会显示在这里。" />
      ) : (
        <>
          <div className="roleDefaults registrationSummary">
            <span>事件 {summary?.eventCount ?? 0}</span>
            <span className="allowed">新增 {summary?.createdCount ?? 0}</span>
            <span>修改 {summary?.modifiedCount ?? 0}</span>
            <span className="denied">删除 {summary?.deletedCount ?? 0}</span>
          </div>
          <div className="tableWrap desktopOnly">
            <table className="dataTable modelTable">
              <thead><tr><th>时间</th><th>用户</th><th>Provider</th><th>模型</th><th>动作</th></tr></thead>
              <tbody>{report.rows.map(row => <RegistrationRow key={row.eventId} row={row} users={users} />)}</tbody>
            </table>
          </div>
          <div className="mobileList">
            {report.rows.map(row => (
              <article className="mobileItem" key={row.eventId}>
                <div className="mobileItemHeader"><strong>{REGISTRATION_ACTION_LABELS[row.action]}</strong><span>{formatRegistrationTime(row.occurredAt)}</span></div>
                <div className="mobileItemBody"><span>{userName(row.userId, users)}</span><span className="codeText">{row.provider}{row.model === null ? '' : `/${row.model}`}</span></div>
              </article>
            ))}
          </div>
        </>
      )}
    </Section>
  )
}

function RegistrationRow({ row, users }: { row: ModelRegistrationReport['rows'][number]; users: AdminUser[] }) {
  return (
    <tr>
      <td>{formatRegistrationTime(row.occurredAt)}</td>
      <td>{userName(row.userId, users)}</td>
      <td className="codeText">{row.provider}</td>
      <td className="codeText">{row.model ?? '—'}</td>
      <td><StatusBadge tone={row.action.endsWith('deleted') ? 'danger' : row.action.endsWith('created') ? 'success' : 'neutral'}>{REGISTRATION_ACTION_LABELS[row.action]}</StatusBadge></td>
    </tr>
  )
}

const REGISTRATION_ACTION_LABELS: Record<ModelRegistrationAction, string> = {
  'provider-created': '新增 Provider',
  'provider-modified': '修改 Provider',
  'provider-deleted': '删除 Provider',
  'model-created': '新增模型',
  'model-modified': '修改模型',
  'model-deleted': '删除模型',
}

function userName(id: number, users: AdminUser[]): string {
  return users.find(user => user.id === id)?.username ?? `用户 ${String(id)}`
}

function formatRegistrationTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

function ModelDirectory({
  loading,
  models,
  users,
  selectedUser,
  selected,
  accessLoading,
  overrides,
  overridePending,
  onSelectUser,
  onEdit,
  onOverride,
}: {
  loading: boolean
  models: ModelGovernanceRow[]
  users: AdminUser[]
  selectedUser: string
  selected: AdminUser | undefined
  accessLoading: boolean
  overrides: Map<string, boolean>
  overridePending: string
  onSelectUser: (userId: string) => void
  onEdit: (model: ModelGovernanceRow) => void
  onOverride: (model: ModelGovernanceRow, value: string) => Promise<void>
}) {
  return (
    <Section
      className="responsiveSection"
      title="组织模型权限与计价"
      meta={loading ? undefined : `${models.length} 个模型`}
      actions={users.length === 0 ? undefined : (
        <div className="modelUserPicker">
          <span>用户例外</span>
          <select className="select selectCompact" value={selectedUser} onChange={event => onSelectUser(event.target.value)} aria-label="用户例外">
            {users.map(user => <option key={user.id} value={user.id}>{user.username}（{user.role === 'admin' ? '管理员' : '用户'}）</option>)}
          </select>
        </div>
      )}
    >
      {loading ? <LoadingState label="正在加载模型治理配置" /> : models.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="还没有组织模型"
          detail="完整模型目录由组织 Provider 配置统一维护。"
        />
      ) : (
        <>
          {users.length === 0 ? <div className="inlineNotice">暂无用户；角色默认与计价仍可配置。</div> : null}
          <div className="tableWrap desktopOnly">
            <table className="dataTable modelTable">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>状态</th>
                  <th>角色默认</th>
                  <th>{selected === undefined ? '用户例外' : `${selected.username} 的例外`}</th>
                  <th>价格（元 / 百万 Token）</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {models.map(row => {
                  const key = modelKey(row)
                  const override = overrides.get(key)
                  return (
                    <tr key={key}>
                      <td><ModelIdentity row={row} /></td>
                      <td><StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? '已启用' : '已停用'}</StatusBadge></td>
                      <td><RoleDefaults row={row} /></td>
                      <td>
                        <OverrideSelect
                          label={selected === undefined ? '用户例外' : `${selected.username} 的例外`}
                          disabled={selectedUser === '' || accessLoading || overridePending === key}
                          value={override}
                          onChange={value => { void onOverride(row, value) }}
                        />
                      </td>
                      <td><PriceSummary row={row} /></td>
                      <td><div className="rowActions"><IconButton label="配置模型治理" icon={Pencil} onClick={() => onEdit(row)} /></div></td>
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
              return (
                <article className="mobileItem" key={key}>
                  <div className="mobileItemHeader">
                    <ModelIdentity row={row} />
                    <IconButton label="配置模型治理" icon={Pencil} onClick={() => onEdit(row)} />
                  </div>
                  <div className="mobileItemBody">
                    <div className="mobileStatusRow">
                      <StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? '已启用' : '已停用'}</StatusBadge>
                      <RoleDefaults row={row} />
                    </div>
                    <div>
                      <span className="fieldLabel">{selected === undefined ? '用户例外' : `${selected.username} 的例外`}</span>
                      <OverrideSelect
                        label={selected === undefined ? '用户例外' : `${selected.username} 的例外`}
                        disabled={selectedUser === '' || accessLoading || overridePending === key}
                        value={override}
                        onChange={value => { void onOverride(row, value) }}
                      />
                    </div>
                    <div><span className="fieldLabel">价格（元 / 百万 Token）</span><PriceSummary row={row} /></div>
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

function ModelIdentity({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="modelIdentity">
      <span className="itemIcon"><Sparkles aria-hidden="true" /></span>
      <span className="modelIdentityText"><strong>{row.displayName}</strong><span className="codeText">{row.provider}/{row.model}</span></span>
    </div>
  )
}

function RoleDefaults({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="roleDefaults">
      <span className={row.adminAllowed ? 'allowed' : 'denied'}>管理员 {row.adminAllowed ? '允许' : '拒绝'}</span>
      <span className={row.userAllowed ? 'allowed' : 'denied'}>用户 {row.userAllowed ? '允许' : '拒绝'}</span>
    </div>
  )
}

function OverrideSelect({ label, value, disabled, onChange }: {
  label: string
  value: boolean | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <select aria-label={label} className="select selectCompact overrideSelect" disabled={disabled} value={value === undefined ? 'inherit' : value ? 'allow' : 'deny'} onChange={event => onChange(event.target.value)}>
      <option value="inherit">继承角色</option>
      <option value="allow">允许</option>
      <option value="deny">拒绝</option>
    </select>
  )
}

function PriceSummary({ row }: { row: ModelGovernanceRow }) {
  const values = [row.inputMicrosPerMillion, row.outputMicrosPerMillion, row.cacheReadMicrosPerMillion, row.cacheWriteMicrosPerMillion]
  return (
    <div className="priceSummary">
      {PRICE_LABELS.map((label, index) => <span key={label}><b>{label}</b><span>{microsToYuan(values[index] ?? 0)}</span></span>)}
    </div>
  )
}

function modelKey(row: { provider: string; model: string }): string {
  return `${row.provider}\0${row.model}`
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
