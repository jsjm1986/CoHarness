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

type QuotaMode = 'inherit' | 'unlimited' | 'custom'

export function UsagePage() {
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
      if (tokenMode === 'custom' && (!Number.isSafeInteger(parsedToken) || parsedToken < 0)) throw new Error('Token 额度必须是非负整数')
      if (costMode === 'custom' && (!Number.isFinite(parsedCost) || parsedCost < 0)) throw new Error('成本额度必须是非负数')
      await setQuota({
        subjectType,
        subjectId,
        tokenLimit: tokenMode === 'inherit' ? 'inherit' : tokenMode === 'unlimited' ? null : parsedToken,
        companyCostMicrosLimit: costMode === 'inherit' ? 'inherit' : costMode === 'unlimited' ? null : Math.round(parsedCost * 1_000_000),
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
        title="模型用量"
        description="个人用量用于额度与账务；项目贡献用于活动分析，不与项目总量重复相加。"
        actions={(
          <div className="pageToolbar">
            <label className="monthPicker"><span>月份</span><input className="input" type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
            <Button icon={Settings2} onClick={() => setQuotaOpen(true)}>配置额度</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      <div className="metricGrid usageOverviewMetrics" aria-label="用量汇总">
        <Metric label="个人调用" value={totals.personalCalls.toLocaleString()} />
        <Metric label="个人 Token" value={formatCompact(totals.personalTokens)} />
        <Metric label="项目 Token" value={formatCompact(totals.projectTokens)} />
        <Metric label="项目公司成本" value={formatMoney(overview?.projects.companyCostMicros ?? 0, 2)} />
        <Metric label="未归属项目 Token" value={formatCompact(totals.unattributedTokens)} tone={totals.unattributedTokens > 0 ? 'warning' : undefined} />
        <Metric label="个人公司成本" value={formatMoney(totals.companyCost, 2)} />
        <Metric label="额度告警" value={totals.alerts.toLocaleString()} tone={totals.alerts > 0 ? 'warning' : undefined} />
      </div>
      <Section className="responsiveSection" title="用户用量" meta={loading ? undefined : `${rows.length} 位用户 · ${overview?.timeZone ?? ''}`}>
        {loading ? <LoadingState label="正在加载用量" /> : rows.length === 0 ? (
          <EmptyState icon={Gauge} title="本月暂无用量" detail="所选月份还没有收到模型调用计量记录。" />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable usageTable">
                <thead>
                  <tr><th>用户</th><th>个人调用</th><th>个人 Token</th><th>项目贡献</th><th>个人公司成本</th><th>价格</th><th>计量与额度</th></tr>
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
                      <Definition label="个人调用">{row.personal.calls.toLocaleString()}</Definition>
                      <Definition label="个人 Token">{row.personal.totalTokens.toLocaleString()}</Definition>
                      <Definition label="项目贡献">{row.projectContribution.totalTokens.toLocaleString()}（{row.projectContribution.calls.toLocaleString()} 次）</Definition>
                      <Definition label="个人公司成本">{formatMoney(row.personal.companyCostMicros)}</Definition>
                      <Definition label="价格"><PricingState pricing={row.personal.pricing} /></Definition>
                    </dl>
                    <QuotaSummary summary={row.personal} />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>
      <Section className="responsiveSection" title="计量健康" meta={health?.timeZone}>
        {health === null ? <LoadingState label="正在加载计量健康" /> : (
          <div className="usageHealthMetrics" aria-label="计量健康指标">
            <Metric
              label="缺失计量"
              value={`${health.missingUsageCalls.toLocaleString()} 次`}
              tone={health.missingUsageCalls > 0 ? 'warning' : undefined}
            />
            <Metric
              label="未归属项目调用"
              value={`${health.unattributedProjectCalls.toLocaleString()} 次`}
              tone={health.unattributedProjectCalls > 0 ? 'warning' : undefined}
            />
            <Metric
              label="未归属项目 Token"
              value={health.unattributedProjectTokens.toLocaleString()}
              tone={health.unattributedProjectTokens > 0 ? 'warning' : undefined}
            />
            <Metric
              label="未配置价格"
              value={`${health.unpricedCalls.toLocaleString()} 次`}
              tone={health.unpricedCalls > 0 ? 'warning' : undefined}
            />
            <Metric label="历史价格未知" value={`${health.historicalUnknownCalls.toLocaleString()} 次`} />
            <Metric label="最大上报延迟" value={`${(health.maxIntakeLagMs / 1000).toFixed(1)} 秒`} />
          </div>
        )}
      </Section>

      <Dialog
        open={quotaOpen}
        title="配置月度额度"
        description="额度在 80% 和 100% 产生告警，但不会阻断模型调用。"
        onClose={() => { if (!quotaSaving) setQuotaOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={quotaSaving} onClick={() => setQuotaOpen(false)}>取消</Button>
            <Button type="submit" form="quota-form" variant="primary" loading={quotaSaving}>保存额度</Button>
          </>
        )}
      >
        <form id="quota-form" onSubmit={event => void save(event)}>
          <div className="formGrid">
            <Field label="配置对象">
              <select className="select" value={subjectType} onChange={event => changeSubjectType(event.target.value as 'role' | 'user')}>
                <option value="role">角色默认</option>
                <option value="user">指定用户</option>
              </select>
            </Field>
            <Field label={subjectType === 'role' ? '角色' : '用户'}>
              {subjectType === 'role' ? (
                <select className="select" value={subjectId} onChange={event => setSubjectId(event.target.value)}>
                  <option value="user">普通用户</option><option value="admin">管理员</option>
                </select>
              ) : (
                <select className="select" required value={subjectId} onChange={event => setSubjectId(event.target.value)}>
                  {users.length === 0 ? <option value="">暂无用户</option> : users.map(user => <option key={user.id} value={user.id}>{user.username}（ID {user.id}）</option>)}
                </select>
              )}
            </Field>
          </div>
          <div className="formDivider" />
          <div className="quotaEditorGrid">
            <QuotaEditor
              label="Token 额度"
              mode={tokenMode}
              subjectType={subjectType}
              value={tokenLimit}
              inputLabel="每月 Token"
              inputMode="numeric"
              onMode={setTokenMode}
              onValue={setTokenLimit}
            />
            <QuotaEditor
              label="公司成本额度"
              mode={costMode}
              subjectType={subjectType}
              value={costLimit}
              inputLabel="每月人民币元"
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
  return (
    <div className="userIdentity">
      <span className="avatar" aria-hidden="true">{row.username.slice(0, 1)}</span>
      <span className="identityText"><strong>{row.username}</strong><span>ID {row.userId} · {row.archived ? '已归档历史' : '个人账务'}</span></span>
    </div>
  )
}

function TokenBreakdown({ summary }: { summary: UsageOverviewUser['personal'] }) {
  return <div className="stackedValue"><strong>{summary.totalTokens.toLocaleString()}</strong><span className="muted">输入 {formatCompact(summary.inputTokens)} · 输出 {formatCompact(summary.outputTokens)}</span></div>
}

function ContributionValue({ value, calls }: { value: number; calls: number }) {
  return <div className="stackedValue"><strong>{value.toLocaleString()}</strong><span className="muted">{calls.toLocaleString()} 次 · 不计入个人额度</span></div>
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
  return (
    <fieldset className="quotaEditor">
      <legend>{label}</legend>
      <Field label="额度模式">
        <select className="select" value={mode} onChange={event => onMode(event.target.value as QuotaMode)}>
          {subjectType === 'user' ? <option value="inherit">继承角色</option> : null}
          <option value="unlimited">无限制</option>
          <option value="custom">自定义</option>
        </select>
      </Field>
      {mode === 'custom' ? (
        <Field label={inputLabel}>
          <input className="input" required min="0" inputMode={inputMode} value={value} onChange={event => onValue(event.target.value)} />
        </Field>
      ) : <div className="quotaModeNote">{mode === 'inherit' ? '使用该用户所属角色的额度。' : '不设置月度上限。'}</div>}
    </fieldset>
  )
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
