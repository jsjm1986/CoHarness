import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { UsageAlertInjected, UsageView } from './index.ts'
import css from './UsageAlert.module.css'

export type UsageAlertProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<UsageAlertInjected>
  & PropsLocale<'usage.alert'>

/** Display gateway-generated quota crossings; the client never recomputes thresholds. */
export function UsageAlert({ loadUsage, t }: UsageAlertProps) {
  const [view, setView] = useState<UsageView | null>(null)
  useEffect(() => {
    let active = true
    void loadUsage().then((next) => { if (active) setView(next) })
    return () => { active = false }
  }, [loadUsage])
  if (view === null || view.alerts.length === 0) return null
  return <div className={css.stack} aria-live="polite">
    {view.alerts.map(alert => <div className={css.alert} key={`${alert.metric}-${alert.threshold}`} role="status">
      <strong>{t('alert.title', { threshold: alert.threshold })}</strong><br />
      {alert.metric === 'tokens' ? t('metric.tokens') : t('metric.companyCost')}
      {t('alert.reached', { threshold: alert.threshold })}
    </div>)}
  </div>
}
