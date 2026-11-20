/** Secondary views for model access, pricing, and personal registration history. */
import { ClipboardList, Filter, Pencil, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { decimalToMicros, microsToDecimal } from '../../../src/money.ts'
import {
  saveModel, setDigestModel,
  type AdminUser, type DigestModelSettings, type ModelGovernanceRow, type ModelRegistrationAction, type ModelRegistrationReport,
} from '../api.ts'
import { ModelIdentity, modelKey, OverrideSelect, RoleDefaults } from '../components/models.tsx'
import { Button, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState, Section, StatusBadge, Switch } from '../components/ui.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { modelsPageT, type ModelsPageCopyKey } from './models-page.copy.ts'

/** Search fields for the personal registration view. */
export type RegistrationFilters = {
  user: string
  provider: string
  model: string
  action: ModelRegistrationAction | ''
  from: string
  to: string
}

/** Outcome of the digest settings read started when the governance tab opens. */
export type DigestModelRead = { ok: true; settings: DigestModelSettings } | { ok: false; message: string }

const PRICE_LABEL_KEYS = ['priceInput', 'priceOutput', 'priceCacheRead', 'priceCacheWrite'] as const

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

type GovernanceDetailsProps = Omit<Parameters<typeof ModelDirectory>[0], 'onEdit'> & {
  error: string
  onError: (message: string) => void
  reload: () => Promise<void>
  digestRead: DigestModelRead | undefined
}

/**
 * Show access, pricing, and digest preferences for the available models.
 * @param props - directory data, the current digest read outcome, edit actions and the parent model-list refresh.
 * @returns the governance content and its draft-protected edit dialog.
 */
export function ModelsGovernanceDetails({ error, onError: setError, reload, digestRead, ...directory }: GovernanceDetailsProps) {
  const t = useMemo(() => modelsPageT(), [])
  const [modelDraft, setModelDraft] = useState<ModelGovernanceRow | null>(null)
  const [prices, setPrices] = useState(['0', '0', '0', '0'])
  const [modelSaving, setModelSaving] = useState(false)
  usePendingEdits(modelSaving || modelDraft !== null)

  function openGovernanceEditor(model: ModelGovernanceRow) {
    setError('')
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
      setModelDraft(null)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setModelSaving(false)
    }
  }

  return (
    <>
      <Section title={t('digestTitle')} className="formSectionSpacing">
        {digestRead?.ok ? <DigestModelForm initialSettings={digestRead.settings} /> : (
          <>
            <ErrorBanner message={digestRead?.message ?? ''} />
            <LoadingState />
          </>
        )}
      </Section>
      <ModelDirectory {...directory} onEdit={openGovernanceEditor} />
      <Dialog
        open={modelDraft !== null}
        title={t('editGovernance')}
        description={t('governanceDialogDescription')}
        onClose={() => {
          if (modelSaving) return
          setModelDraft(null)
        }}
        footer={(
          <>
            <Button type="button" disabled={modelSaving} onClick={() => {
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
    </>
  )
}

/**
 * Show personal registration history and the page-owned report filters.
 * @param props - user choices, report state and filter actions.
 * @returns the registration form and results.
 */
export function PersonalRegistrationAudit({
  users,
  report,
  loading,
  failed,
  draft,
  onDraft,
  onApply,
  onReset,
  onRefresh,
}: {
  users: AdminUser[]
  report: ModelRegistrationReport | null
  loading: boolean
  failed: boolean
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
      flush
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
      {loading ? <LoadingState label={t('personalLoading')} /> : failed && report === null ? null : report === null || report.rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t('personalEmptyTitle')} detail={t('personalEmptyDetail')} />
      ) : (
        <>
          <div className="roleDefaults registrationSummary">
            <span>{t('summaryEvents', { count: String(summary?.eventCount ?? 0) })}</span>
            <span className="allowed">{t('summaryCreated', { count: String(summary?.createdCount ?? 0) })}</span>
            <span>{t('summaryModified', { count: String(summary?.modifiedCount ?? 0) })}</span>
            <span className="denied">{t('summaryDeleted', { count: String(summary?.deletedCount ?? 0) })}</span>
          </div>
          <div className="tableWrap desktopOnly" role="region" aria-label={t('personalTitle')} tabIndex={0}>
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
  failed,
  models,
  users,
  usersLoaded,
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
  failed: boolean
  models: ModelGovernanceRow[]
  users: AdminUser[]
  usersLoaded: boolean
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
      flush
      className="responsiveSection"
      title={t('directoryTitle')}
      meta={loading || (failed && models.length === 0) ? undefined : t('directoryMeta', { count: String(models.length) })}
      actions={users.length === 0 ? undefined : (
        <div className="modelUserPicker">
          <span>{t('userException')}</span>
          <select className="select selectCompact" value={selectedUser} onChange={event => onSelectUser(event.target.value)} aria-label={t('userException')}>
            {users.map(user => <option key={user.id} value={user.id}>{t(user.role === 'admin' ? 'userOptionAdmin' : 'userOptionUser', { name: user.username })}</option>)}
          </select>
        </div>
      )}
    >
      {loading ? <LoadingState label={t('directoryLoading')} /> : failed && models.length === 0 ? null : models.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={t('directoryEmptyTitle')}
          detail={t('directoryEmptyDetail')}
        />
      ) : (
        <>
          {usersLoaded && users.length === 0 ? <div className="inlineNotice">{t('noUsersNotice')}</div> : null}
          <div className="tableWrap desktopOnly" role="region" aria-label={t('directoryTitle')} tabIndex={0}>
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

function DigestModelForm({ initialSettings }: { initialSettings: DigestModelSettings }) {
  const t = useMemo(() => modelsPageT(), [])
  const [settings, setSettings] = useState(initialSettings)
  const [draft, setDraft] = useState(initialSettings.model ?? '')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sectionError, setSectionError] = useState('')
  usePendingEdits(saving || draft !== (settings.model ?? ''))

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const result = await setDigestModel(draft === '' ? null : draft)
      setSettings(result)
      setDraft(result.model ?? '')
      setSaved(true)
      setSectionError('')
    } catch (cause) {
      setSectionError(messageFrom(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <ErrorBanner message={sectionError} />
      <div className="formSectionSpacing">
        <Field label={t('digestModelLabel')} hint={t('digestModelHint')}>
          <select className="select" value={draft} onChange={event => { setDraft(event.target.value); setSaved(false) }}>
            <option value="">{t('digestModelAuto')}</option>
            {settings.candidates.map(candidate => {
              const route = `${candidate.provider}/${candidate.model}`
              return <option key={route} value={route}>{route}</option>
            })}
          </select>
        </Field>
        <Button type="button" variant="primary" loading={saving} disabled={draft === (settings.model ?? '')} onClick={() => { void save() }}>
          {saved ? t('digestModelSaved') : t('digestModelSave')}
        </Button>
      </div>
    </>
  )
}
