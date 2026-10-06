import { Gauge, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  getRoleQuota,
  getUsageHealth,
  getUserQuota,
  listUsageOverview,
  listUsers,
  setQuota,
  type AdminUser,
  type UsageHealth,
  type UsageOverview,
} from '../api.ts'
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
import { formatCostInput, parseCostInput } from '../money.ts'
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
  const [quotaReadyFor, setQuotaReadyFor] = useState('')
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [quotaLoadError, setQuotaLoadError] = useState('')
  const [quotaSaveError, setQuotaSaveError] = useState('')
  const [quotaRetry, setQuotaRetry] = useState(0)
  const [tokenMode, setTokenMode] = useState<QuotaMode>('unlimited')
  const [costMode, setCostMode] = useState<QuotaMode>('unlimited')
  const [tokenLimit, setTokenLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')

  const monthRef = useRef('')
  const requestGeneration = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const reload = useCallback(async (showLoading = false) => {
    const requestMonth = monthRef.current
    const generation = ++requestGeneration.current
    if (showLoading) setLoading(true)
    try {
      const [nextOverview, nextUsers, nextHealth] = await Promise.all([
        listUsageOverview(requestMonth || undefined), listUsers(), getUsageHealth(requestMonth || undefined),
      ])
      if (!alive.current || requestGeneration.current !== generation) return
      setOverview(nextOverview)
      setHealth(nextHealth)
      if (requestMonth === '') setMonth(current => current === '' ? nextOverview.month : current)
      setUsers(nextUsers)
      setError('')
    } catch (cause) {
      if (alive.current && requestGeneration.current === generation) setError(messageFrom(cause))
    } finally {
      // The latest read always settles the spinner; a stale read touches nothing.
      if (alive.current && requestGeneration.current === generation) setLoading(false)
    }
  }, [])

  useEffect(() => {
    monthRef.current = month
    void reload(true)
    return () => { requestGeneration.current += 1 }
  }, [month, reload])

  const subjectKey = `${subjectType}:${subjectId}`

  // The user list only repairs an invalid selection; a still-valid id and the
  // draft survive unrelated list refreshes.
  useEffect(() => {
    if (subjectType !== 'user') return
    if (users.some(row => row.id === Number(subjectId))) return
    const first = users[0]
    setSubjectId(first === undefined ? '' : String(first.id))
    setQuotaReadyFor('')
  }, [users, subjectType, subjectId])

  // Quota reads run only on open, subject, or retry changes — never on an
  // unrelated overview/users refresh.
  useEffect(() => {
    if (!quotaOpen) return
    setQuotaReadyFor('')
    setQuotaLoadError('')
    setQuotaSaveError('')
    const numericId = Number(subjectId)
    if (subjectType === 'user' && !(Number.isSafeInteger(numericId) && numericId > 0)) {
      setQuotaLoading(false)
      return
    }
    const key = `${subjectType}:${subjectId}`
    let cancelled = false
    setQuotaLoading(true)
    const settled = (view: { token: QuotaMode; tokenValue: string; cost: QuotaMode; costValue: string }) => {
      setTokenMode(view.token)
      setTokenLimit(view.tokenValue)
      setCostMode(view.cost)
      setCostLimit(view.costValue)
      setQuotaReadyFor(key)
      setQuotaLoadError('')
    }
    const failed = (cause: unknown) => { if (!cancelled) setQuotaLoadError(messageFrom(cause)) }
    const finished = () => { if (!cancelled) setQuotaLoading(false) }
    const request = subjectType === 'role'
      ? getRoleQuota(subjectId === 'admin' ? 'admin' : 'user').then(view => ({
        token: (view.tokenLimit === null ? 'unlimited' : 'custom') as QuotaMode,
        tokenValue: view.tokenLimit === null ? '' : String(view.tokenLimit),
        cost: (view.companyCostMicrosLimit === null ? 'unlimited' : 'custom') as QuotaMode,
        costValue: view.companyCostMicrosLimit === null ? '' : formatCostInput(view.companyCostMicrosLimit),
      }))
      : getUserQuota(numericId).then(view => ({
        token: view.tokenMode,
        tokenValue: view.tokenLimit === null ? '' : String(view.tokenLimit),
        cost: view.companyCostMode,
        costValue: view.companyCostMicrosLimit === null ? '' : formatCostInput(view.companyCostMicrosLimit),
      }))
    void request.then(view => { if (!cancelled) settled(view) }).catch(failed).finally(finished)
    return () => { cancelled = true }
  }, [quotaOpen, subjectType, subjectId, quotaRetry])

  function openQuotaDialog() {
    // A reopen must not inherit the previous read's ready marker.
    setQuotaReadyFor('')
    setQuotaSaveError('')
    setQuotaOpen(true)
  }

  function changeSubjectType(next: 'role' | 'user') {
    if (next === subjectType) return
    setSubjectType(next)
    setQuotaReadyFor('')
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

  function changeSubjectId(next: string) {
    // Only an actual subject change invalidates quota readiness.
    if (next === subjectId) return
    setSubjectId(next)
    setQuotaReadyFor('')
  }

  const rows = overview?.users ?? []
  const totals = useMemo(() => ({
    personalCalls: overview?.personal.calls ?? 0,
    personalTokens: overview?.personal.totalTokens ?? 0,
    projectTokens: overview?.projects.totalTokens ?? 0,
    unattributedTokens: overview?.unattributedProjects.totalTokens ?? 0,
    companyCost: overview?.personal.companyCostMicros ?? 0,
    alerts: rows.reduce((sum, row) => sum + row.personal.alerts.length, 0),
  }), [overview, rows])

  async function save(event: FormEvent) {
    event.preventDefault()
    // Only the loaded subject may write: pending or mismatched reads never POST.
    if (quotaSaving || quotaLoading || quotaReadyFor !== subjectKey) return
    setQuotaSaveError('')
    setQuotaSaving(true)
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
      await setQuota({
        subjectType,
        subjectId,
        tokenLimit: tokenMode === 'inherit' ? 'inherit' : tokenMode === 'unlimited' ? null : parsedToken,
        companyCostMicrosLimit: costMode === 'inherit' ? 'inherit' : costMode === 'unlimited' ? null : costMicros,
      })
      if (!alive.current) return
      setQuotaOpen(false)
      void reload()
    } catch (cause) {
      if (alive.current) setQuotaSaveError(messageFrom(cause))
    } finally {
      if (alive.current) setQuotaSaving(false)
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
            <Button icon={Settings2} onClick={openQuotaDialog}>{t('configureQuota')}</Button>
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
            <Button type="submit" form="quota-form" variant="primary" loading={quotaSaving}
              disabled={quotaSaving || quotaLoading || quotaReadyFor !== subjectKey}>{t('saveQuota')}</Button>
          </>
        )}
      >
        <form id="quota-form" onSubmit={event => void save(event)}>
          {quotaLoading ? <LoadingState label={t('quotaLoading')} /> : null}
          {quotaLoadError === '' ? null : (
            <div className="stackedValue">
              <ErrorBanner message={quotaLoadError} />
              <Button type="button" disabled={quotaLoading} onClick={() => { setQuotaReadyFor(''); setQuotaRetry(n => n + 1) }}>{t('retry')}</Button>
            </div>
          )}
          <ErrorBanner message={quotaSaveError} />
          <div className="formGrid">
            <Field label={t('subjectField')}>
              <select className="select" value={subjectType} disabled={quotaSaving} onChange={event => changeSubjectType(event.target.value as 'role' | 'user')}>
                <option value="role">{t('subjectRole')}</option>
                <option value="user">{t('subjectUser')}</option>
              </select>
            </Field>
            <Field label={subjectType === 'role' ? t('fieldRole') : t('fieldUser')}>
              {subjectType === 'role' ? (
                <select className="select" value={subjectId} disabled={quotaSaving} onChange={event => changeSubjectId(event.target.value)}>
                  <option value="user">{t('roleUser')}</option><option value="admin">{t('roleAdmin')}</option>
                </select>
              ) : (
                <select className="select" required value={subjectId} disabled={quotaSaving} onChange={event => changeSubjectId(event.target.value)}>
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
              disabled={quotaReadyFor !== subjectKey || quotaSaving}
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
              disabled={quotaReadyFor !== subjectKey || quotaSaving}
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

function QuotaEditor({ label, mode, subjectType, value, inputLabel, inputMode, disabled, onMode, onValue }: {
  label: string
  mode: QuotaMode
  subjectType: 'role' | 'user'
  value: string
  inputLabel: string
  inputMode: 'numeric' | 'decimal'
  disabled: boolean
  onMode: (mode: QuotaMode) => void
  onValue: (value: string) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usagePageZh, en: usagePageEn }), [])
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label={t('quotaModeLabel')}>
        <select className="select" value={mode} disabled={disabled} onChange={event => onMode(event.target.value as QuotaMode)}>
          {subjectType === 'user' ? <option value="inherit">{t('quotaModeInherit')}</option> : null}
          <option value="unlimited">{t('quotaModeUnlimited')}</option>
          <option value="custom">{t('quotaModeCustom')}</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} disabled={disabled} value={value} onChange={event => onValue(event.target.value)} />
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
