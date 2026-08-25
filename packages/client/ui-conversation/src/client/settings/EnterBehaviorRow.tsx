/** General Settings row for the Composer's busy-state Enter preference. */
import { useEffect, useState } from 'react'
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BusyEnterBehavior } from '../contract/composer-submission.ts'
import type { ConversationKey } from '../locales.ts'
import css from './EnterBehaviorRow.module.css'

/** Registration-side preference face. */
export interface EnterBehaviorRowInjected {
  hooks: {
    /** Persisted busy-state preference bound as useBusyEnter. */
    busyEnter: SnapshotStore<BusyEnterBehavior>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the busy-state plain-Enter behavior. */
  setBusyEnter: (behavior: BusyEnterBehavior) => void
}

/** Full Settings-row props. */
export type EnterBehaviorRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<EnterBehaviorRowInjected>

const OPTIONS: readonly {
  id: BusyEnterBehavior
  label: ConversationKey
}[] = [
  { id: 'queue', label: 'settings.enter.queue' },
  { id: 'steer', label: 'settings.enter.steer' },
]

/**
 * Render the busy-state Enter behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function EnterBehaviorRow({ useBusyEnter, useSettings, setBusyEnter, t }: EnterBehaviorRowProps) {
  const behavior = useBusyEnter(value => value)
  const settings = useSettings(value => value)
  const [open, setOpen] = useState(false)
  const selectedLabel = behavior === 'queue' ? 'settings.enter.queue' : 'settings.enter.steer'
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  const notice = settings.write.status === 'error'
    ? t('settings.enter.saveFailed')
    : settings.write.status === 'saving'
      ? t('settings.enter.saving')
      : blocked === 'loading' || settings.status === 'loading'
        ? t('settings.enter.loading')
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? t('settings.enter.unavailable')
          : blocked === 'project' || settings.writableReason === 'project'
            ? t('settings.enter.projectReadOnly')
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? t('settings.enter.providerReadOnly')
              : undefined

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.enter.title')}</div>
        <div className={css.desc}>{t('settings.enter.description')}</div>
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
        selectedId={behavior}
        onSelect={(id) => {
          setOpen(false)
          setBusyEnter(id as BusyEnterBehavior)
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
            {t(selectedLabel)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
