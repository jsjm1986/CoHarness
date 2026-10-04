import { useMemo } from 'react'
import type { UsagePricingView, UsageSummary } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { StatusBadge } from './ui.tsx'
import { en as usageEn, zh as usageZh } from './usage.copy.ts'

export function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return <div className={`metric ${tone === undefined ? '' : `metric-${tone}`}`.trim()}><span>{label}</span><strong>{value}</strong></div>
}

export function MeteringState({ missing }: { missing: number }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usageZh, en: usageEn }), [])
  return missing === 0
    ? <StatusBadge tone="success">{t('meteringComplete')}</StatusBadge>
    : <StatusBadge tone="warning">{t('meteringMissing', { count: String(missing) })}</StatusBadge>
}

export function PricingState({ pricing }: { pricing?: UsagePricingView }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usageZh, en: usageEn }), [])
  if (pricing === undefined || pricing.status === 'none') return <StatusBadge tone="neutral">{t('pricingNone')}</StatusBadge>
  if (pricing.status === 'priced') return <StatusBadge tone="success">{t('pricingPriced')}</StatusBadge>
  if (pricing.status === 'configured-zero') return <StatusBadge tone="warning">{t('pricingZero')}</StatusBadge>
  if (pricing.status === 'unpriced') return <StatusBadge tone="warning">{t('pricingUnpriced')}</StatusBadge>
  if (pricing.status === 'historical-unknown') return <StatusBadge tone="neutral">{t('pricingHistoricalUnknown')}</StatusBadge>
  return <StatusBadge tone="warning">{t('pricingPartial')}</StatusBadge>
}

export function QuotaSummary({ summary }: { summary: UsageSummary }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usageZh, en: usageEn }), [])
  return (
    <div className="quotaBlock">
      <QuotaLine label="Token" used={summary.totalTokens} limit={summary.tokenLimit} format={value => formatCompact(value)} />
      <QuotaLine label={t('quotaCost')} used={summary.companyCostMicros} limit={summary.companyCostMicrosLimit} format={value => formatMoney(value, 2)} />
      {summary.alerts.length === 0 ? null : (
        <div className="alertList">
          {summary.alerts.map(alert => (
            <StatusBadge key={`${alert.metric}:${alert.threshold}`} tone={alert.threshold === 100 ? 'danger' : 'warning'}>
              {t(alert.metric === 'tokens' ? 'alertTokens' : 'alertCost')} {alert.threshold}%
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
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: usageZh, en: usageEn }), [])
  const percent = limit === null || limit === 0 ? 0 : Math.round((used / limit) * 100)
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div className="quotaLine">
      <span>{label}</span>
      <span className="quotaTrack" data-warning={percent >= 80}><span style={{ width: `${width}%` }} /></span>
      <span>{limit === null ? t('quotaNoLimit') : `${format(used)} / ${format(limit)}`}</span>
    </div>
  )
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatMoney(micros: number, digits = 4): string {
  return `¥${(micros / 1_000_000).toFixed(digits)}`
}
