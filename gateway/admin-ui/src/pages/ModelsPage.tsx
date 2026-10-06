import { ClipboardList, Filter, Pencil, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { decimalToMicros, microsToDecimal } from '../../../src/money.ts'
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
import { ModelIdentity, modelKey, OverrideSelect, RoleDefaults } from '../components/models.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { en as modelsPageEn, zh as modelsPageZh, type ModelsPageCopyKey } from './models-page.copy.ts'
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

const PRICE_LABEL_KEYS = ['priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite'] as const
const REGISTRATION_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function modelsPageT() {
  return translateCopy(adminLanguage(), { zh: modelsPageZh, en: modelsPageEn })
}

function yuanToMicros(value: string): number {
  const t = modelsPageT()
  const yuan = Number(value)
  if (!Number.isFinite(yuan) || yuan < 0) throw new Error(t('priceNotNegative'))
  const text = value.trim()
  const micros = /^\d+(?:\.\d+)?$/u.test(text) ? decimalToMicros(text) : Math.round(yuan * 1_000_000)
  if (!Number.isSafeInteger(micros)) throw new Error(t('priceTooLarge'))
  return micros
}

function microsToYuan(value: number): string {
  return microsToDecimal(value)
}

function registrationDate(value: string, endOfDay: boolean): number | undefined {
  if (value === '') return undefined
  const parts = REGISTRATION_DATE_PATTERN.exec(value)
  if (parts === null) throw new Error(modelsPageT()('dateFormatInvalid'))
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    throw new Error(modelsPageT()('dateInvalid'))
  }
  return endOfDay ? date.getTime() + 1 : date.getTime()
}

export function ModelsPage() {
  const t = useMemo(() => modelsPageT(), [])
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
        ...registrationFilters.from === '' ? {} : { from: registrationDate(registrationFilters.from, false) },
        ...registrationFilters.to === '' ? {} : { to: registrationDate(registrationFilters.to, true) },
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
    setError('')
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
      <div className="segmented modelViewTabs" role="group" aria-label={t('viewTabsAria')}>
        <button type="button" aria-pressed={view === 'catalog'} onClick={() => setView('catalog')}>{t('tabCatalog')}</button>
        <button type="button" aria-pressed={view === 'governance'} onClick={() => setView('governance')}>{t('tabGovernance')}</button>
        <button type="button" aria-pressed={view === 'personal'} onClick={() => setView('personal')}>{t('tabPersonal')}</button>
      </div>
    </div>
  )

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading ? undefined : t('pageMeta', { count: String(models.length) })}
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
        title={t('editGovernance')}
        description={t('governanceDialogDescription')}
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
            }}>{t('cancel')}</Button>
            <Button type="submit" form="model-governance-form" variant="primary" loading={modelSaving}>{t('saveGovernance')}</Button>
          </>
        )}
      >
        {modelDraft === null ? null : (
          <form id="model-governance-form" onSubmit={event => void submitGovernance(event)}>
            <ErrorBanner message={error} />
            <div className="modelGovernanceIdentity">
              <strong>{modelDraft.displayName}</strong>
              <span className="codeText">{modelDraft.provider}/{modelDraft.model}</span>
            </div>
            <div className="formDivider" />
            <div className="toggleGrid">
              <Switch label={t('switchEnabled')} checked={modelDraft.enabled} onChange={enabled => setModelDraft({ ...modelDraft, enabled })} />
              <Switch label={t('switchAdminDefault')} checked={modelDraft.adminAllowed} onChange={adminAllowed => setModelDraft({ ...modelDraft, adminAllowed })} />
              <Switch label={t('switchUserDefault')} checked={modelDraft.userAllowed} onChange={userAllowed => setModelDraft({ ...modelDraft, userAllowed })} />
            </div>
            <div className="formDivider" />
            <span className="fieldLabel">{t('priceLabel')}</span>
            <div className="priceGrid formSectionSpacing">
              {PRICE_LABEL_KEYS.map((labelKey, index) => (
                <Field key={labelKey} label={t(labelKey)}>
                  <input
                    className="input"
                    required
                    min="0"
                    step="0.000001"
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
  const t = useMemo(() => modelsPageT(), [])
  const summary = report?.summary
  return (
    <Section
      className="responsiveSection"
      title={t('personalTitle')}
      meta={summary === undefined ? undefined : t('personalMeta', { providerCount: String(summary.providerCount), modelCount: String(summary.modelCount) })}
      actions={<Button type="button" icon={RefreshCw} onClick={onRefresh}>{t('refresh')}</Button>}
    >
      <p className="inlineNotice">{t('personalNotice')}</p>
      <form className="registrationFilterPanel" onSubmit={onApply} aria-label={t('filterAria')}>
        <div className="registrationFilters">
          <Field label={t('filterUser')}>
            <select className="select" value={draft.user} onChange={event => onDraft({ ...draft, user: event.target.value })} aria-label={t('filterUserAria')}>
              <option value="">{t('filterAllUsers')}</option>
              {users.map(item => <option key={item.id} value={item.id}>{item.username}</option>)}
            </select>
          </Field>
          <Field label={t('filterProvider')}>
            <input className="input" value={draft.provider} onChange={event => onDraft({ ...draft, provider: event.target.value })} placeholder={t('filterProviderPlaceholder')} aria-label={t('filterProviderAria')} />
          </Field>
          <Field label={t('filterModel')}>
            <input className="input" value={draft.model} onChange={event => onDraft({ ...draft, model: event.target.value })} placeholder={t('filterModelPlaceholder')} aria-label={t('filterModelAria')} />
          </Field>
          <Field label={t('filterFrom')}>
            <input className="input" type="text" inputMode="numeric" maxLength={10} value={draft.from} onChange={event => onDraft({ ...draft, from: event.target.value })} placeholder="YYYY-MM-DD" aria-label={t('filterFrom')} />
          </Field>
          <Field label={t('filterTo')}>
            <input className="input" type="text" inputMode="numeric" maxLength={10} value={draft.to} onChange={event => onDraft({ ...draft, to: event.target.value })} placeholder="YYYY-MM-DD" aria-label={t('filterTo')} />
          </Field>
          <Field label={t('filterAction')}>
            <select className="select" value={draft.action} onChange={event => onDraft({ ...draft, action: event.target.value as ModelRegistrationAction | '' })} aria-label={t('filterActionAria')}>
              <option value="">{t('filterAllActions')}</option>
              {(Object.keys(REGISTRATION_ACTION_KEYS) as ModelRegistrationAction[]).map(action => <option key={action} value={action}>{t(REGISTRATION_ACTION_KEYS[action])}</option>)}
            </select>
          </Field>
        </div>
        <div className="filterActions registrationFilterActions">
          <Button type="button" icon={RotateCcw} onClick={onReset}>{t('filterReset')}</Button>
          <Button type="submit" variant="primary" icon={Filter}>{t('filterApply')}</Button>
        </div>
      </form>
      {loading ? <LoadingState label={t('personalLoading')} /> : report === null || report.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t('personalEmptyTitle')} detail={t('personalEmptyDetail')} />
      ) : (
        <>
          <div className="roleDefaults registrationSummary">
            <span>{t('summaryEvents', { count: String(summary?.eventCount ?? 0) })}</span>
            <span className="allowed">{t('summaryCreated', { count: String(summary?.createdCount ?? 0) })}</span>
            <span>{t('summaryModified', { count: String(summary?.modifiedCount ?? 0) })}</span>
            <span className="denied">{t('summaryDeleted', { count: String(summary?.deletedCount ?? 0) })}</span>
          </div>
          <div className="tableWrap desktopOnly">
            <table className="dataTable modelTable">
              <thead><tr><th>{t('columnTime')}</th><th>{t('columnUser')}</th><th>{t('columnProvider')}</th><th>{t('columnModel')}</th><th>{t('columnAction')}</th></tr></thead>
              <tbody>{report.rows.map(row => <RegistrationRow key={row.eventId} row={row} users={users} />)}</tbody>
            </table>
          </div>
          <div className="mobileList">
            {report.rows.map(row => (
              <article className="mobileItem" key={row.eventId}>
                <div className="mobileItemHeader"><strong>{t(REGISTRATION_ACTION_KEYS[row.action])}</strong><span>{formatRegistrationTime(row.occurredAt)}</span></div>
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
  const t = useMemo(() => modelsPageT(), [])
  return (
    <tr>
      <td>{formatRegistrationTime(row.occurredAt)}</td>
      <td>{userName(row.userId, users)}</td>
      <td className="codeText">{row.provider}</td>
      <td className="codeText">{row.model ?? '—'}</td>
      <td><StatusBadge tone={row.action.endsWith('deleted') ? 'danger' : row.action.endsWith('created') ? 'success' : 'neutral'}>{t(REGISTRATION_ACTION_KEYS[row.action])}</StatusBadge></td>
    </tr>
  )
}

const REGISTRATION_ACTION_KEYS: Record<ModelRegistrationAction, ModelsPageCopyKey> = {
  'provider-created': 'actionProviderCreated',
  'provider-modified': 'actionProviderModified',
  'provider-deleted': 'actionProviderDeleted',
  'model-created': 'actionModelCreated',
  'model-modified': 'actionModelModified',
  'model-deleted': 'actionModelDeleted',
}

function userName(id: number, users: AdminUser[]): string {
  return users.find(user => user.id === id)?.username ?? modelsPageT()('userFallback', { id: String(id) })
}

function formatRegistrationTime(value: number): string {
  return new Intl.DateTimeFormat(modelsPageT()('dateLocale'), { dateStyle: 'short', timeStyle: 'short' }).format(value)
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
  const t = useMemo(() => modelsPageT(), [])
  return (
    <Section
      className="responsiveSection"
      title={t('directoryTitle')}
      meta={loading ? undefined : t('directoryMeta', { count: String(models.length) })}
      actions={users.length === 0 ? undefined : (
        <div className="modelUserPicker">
          <span>{t('userException')}</span>
          <select className="select selectCompact" value={selectedUser} onChange={event => onSelectUser(event.target.value)} aria-label={t('userException')}>
            {users.map(user => <option key={user.id} value={user.id}>{t(user.role === 'admin' ? 'userOptionAdmin' : 'userOptionUser', { name: user.username })}</option>)}
          </select>
        </div>
      )}
    >
      {loading ? <LoadingState label={t('directoryLoading')} /> : models.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={t('directoryEmptyTitle')}
          detail={t('directoryEmptyDetail')}
        />
      ) : (
        <>
          {users.length === 0 ? <div className="inlineNotice">{t('noUsersNotice')}</div> : null}
          <div className="tableWrap desktopOnly">
            <table className="dataTable modelTable">
              <thead>
                <tr>
                  <th>{t('columnModel')}</th>
                  <th>{t('columnStatus')}</th>
                  <th>{t('columnRoleDefaults')}</th>
                  <th>{selected === undefined ? t('userException') : t('userExceptionFor', { name: selected.username })}</th>
                  <th>{t('columnPrice')}</th>
                  <th aria-label={t('columnActionsAria')} />
                </tr>
              </thead>
              <tbody>
                {models.map(row => {
                  const key = modelKey(row)
                  const override = overrides.get(key)
                  return (
                    <tr key={key}>
                      <td><ModelIdentity row={row} /></td>
                      <td><StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? t('statusEnabled') : t('statusDisabled')}</StatusBadge></td>
                      <td><RoleDefaults row={row} /></td>
                      <td>
                        <OverrideSelect
                          label={selected === undefined ? t('userException') : t('userExceptionFor', { name: selected.username })}
                          disabled={selectedUser === '' || accessLoading || overridePending === key}
                          value={override}
                          onChange={value => { void onOverride(row, value) }}
                        />
                      </td>
                      <td><PriceSummary row={row} /></td>
                      <td><div className="rowActions"><IconButton label={t('editGovernance')} icon={Pencil} onClick={() => onEdit(row)} /></div></td>
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
                    <IconButton label={t('editGovernance')} icon={Pencil} onClick={() => onEdit(row)} />
                  </div>
                  <div className="mobileItemBody">
                    <div className="mobileStatusRow">
                      <StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? t('statusEnabled') : t('statusDisabled')}</StatusBadge>
                      <RoleDefaults row={row} />
                    </div>
                    <div>
                      <span className="fieldLabel">{selected === undefined ? t('userException') : t('userExceptionFor', { name: selected.username })}</span>
                      <OverrideSelect
                        label={selected === undefined ? t('userException') : t('userExceptionFor', { name: selected.username })}
                        disabled={selectedUser === '' || accessLoading || overridePending === key}
                        value={override}
                        onChange={value => { void onOverride(row, value) }}
                      />
                    </div>
                    <div><span className="fieldLabel">{t('columnPrice')}</span><PriceSummary row={row} /></div>
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

function PriceSummary({ row }: { row: ModelGovernanceRow }) {
  const t = useMemo(() => modelsPageT(), [])
  const values = [row.inputMicrosPerMillion, row.outputMicrosPerMillion, row.cacheReadMicrosPerMillion, row.cacheWriteMicrosPerMillion]
  return (
    <div className="priceSummary">
      {PRICE_LABEL_KEYS.map((labelKey, index) => <span key={labelKey}><b>{t(labelKey)}</b><span>{microsToYuan(values[index] ?? 0)}</span></span>)}
    </div>
  )
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
