import type { UsagePricingView, UsageSummary } from '../api.ts'
import { StatusBadge } from './ui.tsx'

export function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return <div className={`metric ${tone === undefined ? '' : `metric-${tone}`}`.trim()}><span>{label}</span><strong>{value}</strong></div>
}

export function MeteringState({ missing }: { missing: number }) {
  return missing === 0
    ? <StatusBadge tone="success">完整</StatusBadge>
    : <StatusBadge tone="warning">缺失 {missing} 次</StatusBadge>
}

export function PricingState({ pricing }: { pricing?: UsagePricingView }) {
  if (pricing === undefined || pricing.status === 'none') return <StatusBadge tone="neutral">暂无价格数据</StatusBadge>
  if (pricing.status === 'priced') return <StatusBadge tone="success">价格已配置</StatusBadge>
  if (pricing.status === 'configured-zero') return <StatusBadge tone="warning">价格为 0</StatusBadge>
  if (pricing.status === 'unpriced') return <StatusBadge tone="warning">未配置价格</StatusBadge>
  if (pricing.status === 'historical-unknown') return <StatusBadge tone="neutral">历史价格未知</StatusBadge>
  return <StatusBadge tone="warning">价格部分缺失</StatusBadge>
}

export function QuotaSummary({ summary }: { summary: UsageSummary }) {
  return (
    <div className="quotaBlock">
      <QuotaLine label="Token" used={summary.totalTokens} limit={summary.tokenLimit} format={value => formatCompact(value)} />
      <QuotaLine label="成本" used={summary.companyCostMicros} limit={summary.companyCostMicrosLimit} format={value => formatMoney(value, 2)} />
      {summary.alerts.length === 0 ? null : (
        <div className="alertList">
          {summary.alerts.map(alert => (
            <StatusBadge key={`${alert.metric}:${alert.threshold}`} tone={alert.threshold === 100 ? 'danger' : 'warning'}>
              {alert.metric === 'tokens' ? 'Token' : '成本'} {alert.threshold}%
            </StatusBadge>
          ))}
        </div>
      )}
    </div>
  )
}

function QuotaLine({ label, used, limit, format }: {
  label: string
  used: number
  limit: number | null
  format: (value: number) => string
}) {
  const percent = limit === null || limit === 0 ? 0 : Math.round((used / limit) * 100)
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div className="quotaLine">
      <span>{label}</span>
      <span className="quotaTrack" data-warning={percent >= 80}><span style={{ width: `${width}%` }} /></span>
      <span>{limit === null ? '不限' : `${format(used)} / ${format(limit)}`}</span>
    </div>
  )
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatMoney(micros: number, digits = 4): string {
  return `¥${(micros / 1_000_000).toFixed(digits)}`
}
