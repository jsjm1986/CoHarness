/** General Settings row for work-details presentation. */
import { useEffect, useState } from 'react'
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  TRANSCRIPT_VIEW_MODES, type TranscriptViewMode,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import css from './TranscriptViewRow.module.css'

/** Registration-side preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted work-details preference bound as useTranscriptView. */
    transcriptView: SnapshotStore<TranscriptViewMode>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the work-details presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<TranscriptViewRowInjected>

const OPTION_LABELS: Record<TranscriptViewMode, ConversationKey> = {
  compact: 'settings.transcript.compact',
  standard: 'settings.transcript.standard',
  detailed: 'settings.transcript.detailed',
  verbose: 'settings.transcript.verbose',
}

const OPTIONS: readonly {
  id: TranscriptViewMode
  label: ConversationKey
}[] = TRANSCRIPT_VIEW_MODES.map(id => ({
  id,
  label: OPTION_LABELS[id],
}))

/**
 * Render the work-details mode selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({ useTranscriptView, useSettings, setTranscriptView, t }: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const settings = useSettings(value => value)
  const [open, setOpen] = useState(false)
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  /* jscpd:ignore-start -- parallel settings-row surface variants share the
   * notice chain and row layout by design (locale's LanguageRow renders the
   * same structure; plugin packages may not import each other's internals). */
  const notice = settings.write.status === 'error'
    ? t('settings.transcript.saveFailed')
    : settings.write.status === 'saving'
      ? t('settings.transcript.saving')
      : blocked === 'loading' || settings.status === 'loading'
        ? t('settings.transcript.loading')
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? t('settings.transcript.unavailable')
          : blocked === 'project' || settings.writableReason === 'project'
            ? t('settings.transcript.projectReadOnly')
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? t('settings.transcript.providerReadOnly')
              : blocked === 'account' || settings.writableReason === 'account'
                ? t('settings.transcript.accountReadOnly')
                : blocked === 'organization' || settings.writableReason === 'organization'
                  ? t('settings.transcript.organizationReadOnly')
                  : blocked === 'deployment' || settings.writableReason === 'deployment'
                    ? t('settings.transcript.deploymentReadOnly')
                    : undefined

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.transcript.title')}</div>
        <div className={css.desc}>{t('settings.transcript.description')}</div>
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
          setTranscriptView(id as TranscriptViewMode)
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
            {t(`settings.transcript.${mode}` as const)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
  /* jscpd:ignore-end */
}
