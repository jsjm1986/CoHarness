/** General Settings row for performance and usage detail. */
import { useEffect, useState } from 'react'
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  PERFORMANCE_USAGE_MODES, type PerformanceUsageMode,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import css from './PerformanceUsageRow.module.css'

/** Registration-side preference face. */
export interface PerformanceUsageRowInjected {
  hooks: {
    /** Persisted performance detail preference bound as usePerformanceUsage. */
    performanceUsage: SnapshotStore<PerformanceUsageMode>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the performance and usage detail. */
  setPerformanceUsage: (mode: PerformanceUsageMode) => void
}

/** Full Settings-row props. */
export type PerformanceUsageRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<PerformanceUsageRowInjected>

const OPTION_LABELS: Record<PerformanceUsageMode, ConversationKey> = {
  compact: 'settings.performance.compact',
  detailed: 'settings.performance.detailed',
}

const OPTIONS: readonly {
  id: PerformanceUsageMode
  label: ConversationKey
}[] = PERFORMANCE_USAGE_MODES.map(id => ({
  id,
  label: OPTION_LABELS[id],
}))

/**
 * Render the performance and usage detail selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function PerformanceUsageRow({ usePerformanceUsage, useSettings, setPerformanceUsage, t }: PerformanceUsageRowProps) {
  const mode = usePerformanceUsage(value => value)
  const settings = useSettings(value => value)
  const [open, setOpen] = useState(false)
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  /* jscpd:ignore-start -- parallel settings-row surface variants share the
   * notice chain and row layout by design. */
  const notice = settings.write.status === 'error'
    ? t('settings.performance.saveFailed')
    : settings.write.status === 'saving'
      ? t('settings.performance.saving')
      : blocked === 'loading' || settings.status === 'loading'
        ? t('settings.performance.loading')
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? t('settings.performance.unavailable')
          : blocked === 'project' || settings.writableReason === 'project'
            ? t('settings.performance.projectReadOnly')
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? t('settings.performance.providerReadOnly')
              : blocked === 'account' || settings.writableReason === 'account'
                ? t('settings.performance.accountReadOnly')
                : blocked === 'organization' || settings.writableReason === 'organization'
                  ? t('settings.performance.organizationReadOnly')
                  : blocked === 'deployment' || settings.writableReason === 'deployment'
                    ? t('settings.performance.deploymentReadOnly')
                    : undefined

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.performance.title')}</div>
        <div className={css.desc}>{t('settings.performance.description')}</div>
        {notice === undefined ? null : (
          <div className={css.notice} role={settings.write.status === 'error' ? 'alert' : 'status'}>
            {notice}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={mode}
        onSelect={(id) => {
          setOpen(false)
          setPerformanceUsage(id as PerformanceUsageMode)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(`settings.performance.${mode}` as const)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
  /* jscpd:ignore-end */
}
