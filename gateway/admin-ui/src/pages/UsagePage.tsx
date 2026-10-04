import { Gauge, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { getUsageHealth, listUsageOverview, listUsers, setQuota, type AdminUser, type UsageHealth, type UsageOverview } from '../api.ts'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingState,
  PageHeader,
  Section,
} from '../components/ui.tsx'
import { formatCompact, formatMoney, MeteringState, Metric, PricingState, QuotaSummary } from '../components/usage.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { en as usagePageEn, zh as usagePageZh } from './usage-page.copy.ts'

type QuotaMode = 'inherit' | 'unlimited' | 'custom'

export function UsagePage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  const [month, setMonth] = useState('')
  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [health, setHealth] = useState<UsageHealth | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [subjectType, setSubjectType] = useState<'role' | 'user'>('role')
  const [subjectId, setSubjectId] = useState('user')
  const [tokenMode, setTokenMode] = useState<QuotaMode>('unlimited')
  const [costMode, setCostMode] = useState<QuotaMode>('unlimited')
  const [tokenLimit, setTokenLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const [nextOverview, nextUsers, nextHealth] = await Promise.all([
        listUsageOverview(month || undefined), listUsers(), getUsageHealth(month || undefined),
      ])
      setOverview(nextOverview)
      setHealth(nextHealth)
      if (month === '') setMonth(current => current === '' ? nextOverview.month : current)
      setUsers(nextUsers)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [month])

  useEffect(() => { void reload(true) }, [reload])

  const rows = overview?.users ?? []
  const totals = useMemo(() => ({
    personalCalls: overview?.personal.calls ?? 0,
    personalTokens: overview?.personal.totalTokens ?? 0,
    projectTokens: overview?.projects.totalTokens ?? 0,
    unattributedTokens: overview?.unattributedProjects.totalTokens ?? 0,
    companyCost: overview?.personal.companyCostMicros ?? 0,
    alerts: rows.reduce((sum, row) => sum + row.personal.alerts.length, 0),
  }), [overview, rows])

  function changeSubjectType(next: 'role' | 'user') {
    setSubjectType(next)
    if (next === 'role') {
      setSubjectId('user')
      if (tokenMode === 'inherit') setTokenMode('unlimited')
      if (costMode === 'inherit') setCostMode('unlimited')
    } else {
      setSubjectId(String(users[0]?.id ?? ''))
      setTokenMode('inherit')
      setCostMode('inherit')
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setQuotaSaving(true)
    try {
      const parsedToken = Number(tokenLimit)
      const parsedCost = Number(costLimit)
      const costMicros = Math.round(parsedCost * 1_000_000)
      if (tokenMode === 'custom' && (!Number.isSafeInteger(parsedToken) || parsedToken < 0)) throw new Error(t('quotaTokenInvalid'))
      if (costMode === 'custom' && (!Number.isFinite(parsedCost) || parsedCost < 0 || !Number.isSafeInteger(costMicros))) throw new Error(t('quotaCostInvalid'))
      await setQuota({
        subjectType,
        subjectId,
        tokenLimit: tokenMode === 'inherit' ? 'inherit' : tokenMode === 'unlimited' ? null : parsedToken,
        companyCostMicrosLimit: costMode === 'inherit' ? 'inherit' : costMode === 'unlimited' ? null : costMicros,
      })
      setQuotaOpen(false)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setQuotaSaving(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={(
          <div className="pageToolbar">
            <label className="monthPicker"><span>{t('monthLabel')}</span><input className="input" type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
            <Button icon={Settings2} onClick={() => setQuotaOpen(true)}>{t('configureQuota')}</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      <div className="metricGrid usageOverviewMetrics" aria-label={t('summaryAria')}>
        <Metric label={t('metricPersonalCalls')} value={totals.personalCalls.toLocaleString()} />
        <Metric label={t('metricPersonalTokens')} value={formatCompact(totals.personalTokens)} />
        <Metric label={t('metricProjectTokens')} value={formatCompact(totals.projectTokens)} />
        <Metric label={t('metricProjectCost')} value={formatMoney(overview?.projects.companyCostMicros ?? 0, 2)} />
        <Metric label={t('metricUnattributedTokens')} value={formatCompact(totals.unattributedTokens)} tone={totals.unattributedTokens > 0 ? 'warning' : undefined} />
        <Metric label={t('metricPersonalCost')} value={formatMoney(totals.companyCost, 2)} />
        <Metric label={t('metricQuotaAlerts')} value={totals.alerts.toLocaleString()} tone={totals.alerts > 0 ? 'warning' : undefined} />
      </div>
      <Section className="responsiveSection" title={t('usersTitle')} meta={loading ? undefined : t('usersMeta', { count: String(rows.length), timeZone: overview?.timeZone ?? '' })}>
        {loading ? <LoadingState label={t('loadingUsage')} /> : rows.length === 0 ? (
          <EmptyState icon={Gauge} title={t('emptyTitle')} detail={t('emptyDetail')} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable usageTable">
                <thead>
                  <tr><th>{t('columnUser')}</th><th>{t('metricPersonalCalls')}</th><th>{t('metricPersonalTokens')}</th><th>{t('columnContribution')}</th><th>{t('metricPersonalCost')}</th><th>{t('columnPricing')}</th><th>{t('columnMeteringQuota')}</th></tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.userId}>
                      <td><UsageIdentity row={row} /></td>
                      <td>{row.personal.calls.toLocaleString()}</td>
                      <td><TokenBreakdown summary={row.personal} /></td>
                      <td><ContributionValue value={row.projectContribution.totalTokens} calls={row.projectContribution.calls} /></td>
                      <td>{formatMoney(row.personal.companyCostMicros)}</td>
                      <td><PricingState pricing={row.personal.pricing} /></td>
                      <td><div className="usageStatusStack"><MeteringState missing={row.personal.missingUsageCalls} /><QuotaSummary summary={row.personal} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {rows.map(row => (
                <article className="mobileItem" key={row.userId}>
                  <div className="mobileItemHeader"><UsageIdentity row={row} /><MeteringState missing={row.personal.missingUsageCalls} /></div>
                  <div className="mobileItemBody">
                    <dl className="definitionGrid">
                      <Definition label={t('metricPersonalCalls')}>{row.personal.calls.toLocaleString()}</Definition>
                      <Definition label={t('metricPersonalTokens')}>{row.personal.totalTokens.toLocaleString()}</Definition>
                      <Definition label={t('columnContribution')}>{t('contributionValue', { tokens: row.projectContribution.totalTokens.toLocaleString(), calls: row.projectContribution.calls.toLocaleString() })}</Definition>
                      <Definition label={t('metricPersonalCost')}>{formatMoney(row.personal.companyCostMicros)}</Definition>
                      <Definition label={t('columnPricing')}><PricingState pricing={row.personal.pricing} /></Definition>
                    </dl>
                    <QuotaSummary summary={row.personal} />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>
      <Section className="responsiveSection" title={t('healthTitle')} meta={health?.timeZone}>
        {health === null ? <LoadingState label={t('loadingHealth')} /> : (
          <div className="usageHealthMetrics" aria-label={t('healthAria')}>
            <Metric
              label={t('healthMissing')}
              value={t('callsValue', { count: health.missingUsageCalls.toLocaleString() })}
              tone={health.missingUsageCalls > 0 ? 'warning' : undefined}
            />
            <Metric
              label={t('healthUnattributedCalls')}
              value={t('callsValue', { count: health.unattributedProjectCalls.toLocaleString() })}
              tone={health.unattributedProjectCalls > 0 ? 'warning' : undefined}
            />
            <Metric
              label={t('metricUnattributedTokens')}
              value={health.unattributedProjectTokens.toLocaleString()}
              tone={health.unattributedProjectTokens > 0 ? 'warning' : undefined}
            />
            <Metric
              label={t('healthUnpriced')}
              value={t('callsValue', { count: health.unpricedCalls.toLocaleString() })}
              tone={health.unpricedCalls > 0 ? 'warning' : undefined}
            />
            <Metric label={t('healthHistoricalUnknown')} value={t('callsValue', { count: health.historicalUnknownCalls.toLocaleString() })} />
            <Metric label={t('healthMaxLag')} value={t('lagValue', { value: (health.maxIntakeLagMs / 1000).toFixed(1) })} />
          </div>
        )}
      </Section>

      <Dialog
        open={quotaOpen}
        title={t('quotaDialogTitle')}
        description={t('quotaDialogDescription')}
        onClose={() => { if (!quotaSaving) setQuotaOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={quotaSaving} onClick={() => setQuotaOpen(false)}>{t('cancel')}</Button>
            <Button type="submit" form="quota-form" variant="primary" loading={quotaSaving}>{t('saveQuota')}</Button>
          </>
        )}
      >
        <form id="quota-form" onSubmit={event => void save(event)}>
          <div className="formGrid">
            <Field label={t('subjectField')}>
              <select className="select" value={subjectType} onChange={event => changeSubjectType(event.target.value as 'role' | 'user')}>
                <option value="role">{t('subjectRole')}</option>
                <option value="user">{t('subjectUser')}</option>
              </select>
            </Field>
            <Field label={subjectType === 'role' ? t('fieldRole') : t('fieldUser')}>
              {subjectType === 'role' ? (
                <select className="select" value={subjectId} onChange={event => setSubjectId(event.target.value)}>
                  <option value="user">{t('roleUser')}</option><option value="admin">{t('roleAdmin')}</option>
                </select>
              ) : (
                <select className="select" required value={subjectId} onChange={event => setSubjectId(event.target.value)}>
                  {users.length === 0 ? <option value="">{t('noUsers')}</option> : users.map(user => <option key={user.id} value={user.id}>{t('userOption', { name: user.username, id: String(user.id) })}</option>)}
                </select>
              )}
            </Field>
          </div>
          <div className="formDivider" />
          <div className="quotaEditorGrid">
            <QuotaEditor
              label={t('tokenQuotaLabel')}
              mode={tokenMode}
              subjectType={subjectType}
              value={tokenLimit}
              inputLabel={t('monthlyTokensLabel')}
              inputMode="numeric"
              onMode={setTokenMode}
              onValue={setTokenLimit}
            />
            <QuotaEditor
              label={t('costQuotaLabel')}
              mode={costMode}
              subjectType={subjectType}
              value={costLimit}
              inputLabel={t('monthlyCostLabel')}
              inputMode="decimal"
              onMode={setCostMode}
              onValue={setCostLimit}
            />
          </div>
        </form>
      </Dialog>
    </div>
  )
}

type UsageOverviewUser = UsageOverview['users'][number]

function UsageIdentity({ row }: { row: UsageOverviewUser }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{row.username.slice(0, 1)}</span>
      <span className="identityText"><strong>{row.username}</strong><span>ID {row.userId} · {row.archived ? t('identityArchived') : t('identityPersonal')}</span></span>
    </div>
  )
}

function TokenBreakdown({ summary }: { summary: UsageOverviewUser['personal'] }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  return <div className="stackedValue"><strong>{summary.totalTokens.toLocaleString()}</strong><span className="muted">{t('tokenBreakdown', { input: formatCompact(summary.inputTokens), output: formatCompact(summary.outputTokens) })}</span></div>
}

function ContributionValue({ value, calls }: { value: number; calls: number }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  return <div className="stackedValue"><strong>{value.toLocaleString()}</strong><span className="muted">{t('contributionNote', { count: calls.toLocaleString() })}</span></div>
}

function QuotaEditor({ label, mode, subjectType, value, inputLabel, inputMode, onMode, onValue }: {
  label: string
  mode: QuotaMode
  subjectType: 'role' | 'user'
  value: string
  inputLabel: string
  inputMode: 'numeric' | 'decimal'
  onMode: (mode: QuotaMode) => void
  onValue: (value: string) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label={t('quotaModeLabel')}>
        <select className="select" value={mode} onChange={event => onMode(event.target.value as QuotaMode)}>
          {subjectType === 'user' ? <option value="inherit">{t('quotaModeInherit')}</option> : null}
          <option value="unlimited">{t('quotaModeUnlimited')}</option>
          <option value="custom">{t('quotaModeCustom')}</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : <div className="quotaModeNote">{mode === 'inherit' ? t('quotaInheritNote') : t('quotaUnlimitedNote')}</div>}
    </fieldset>
  )
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
