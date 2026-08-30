/** General settings row for transcript width and chat text size. */
import type { ChangeEvent } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationDisplaySettingsSnapshot } from '../display-settings.ts'
import {
  CHAT_CONTENT_WIDTH_RANGE, CHAT_FONT_SIZE_RANGE,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import css from './DisplaySettingsRow.module.css'

/** Registration-side display preference face. */
export interface DisplaySettingsRowInjected {
  hooks: {
    /** Current display values and settings write state. */
    displaySettings: ObservableSnapshot<ConversationDisplaySettingsSnapshot>
  }
  /** Persist a transcript width. */
  setWidth: (value: number) => void
  /** Persist a transcript font size. */
  setFontSize: (value: number) => void
}

/** Full settings-row props. */
export type DisplaySettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<DisplaySettingsRowInjected>

function inputValue(event: ChangeEvent<HTMLInputElement>): number {
  const value = Number(event.currentTarget.value)
  return Number.isFinite(value) ? value : 0
}

function noticeOf(
  state: ConversationDisplaySettingsSnapshot['settings'],
  t: DisplaySettingsRowProps['t'],
): string | undefined {
  const blocked = state.write.status === 'blocked' ? state.write.reason : undefined
  if (state.write.status === 'error') return t('settings.display.saveFailed')
  if (state.write.status === 'saving') return t('settings.display.saving')
  if (blocked === 'loading' || state.status === 'loading') return t('settings.display.loading')
  if (blocked === 'unavailable' || state.status === 'unavailable') return t('settings.display.unavailable')
  if (blocked === 'project' || state.writableReason === 'project') return t('settings.enter.projectReadOnly')
  if (blocked === 'provider' || state.writableReason === 'provider') return t('settings.enter.providerReadOnly')
  if (blocked === 'account' || state.writableReason === 'account') return t('settings.enter.accountReadOnly')
  if (blocked === 'organization' || state.writableReason === 'organization') return t('settings.enter.organizationReadOnly')
  if (blocked === 'deployment' || state.writableReason === 'deployment') return t('settings.enter.deploymentReadOnly')
  return undefined
}

/**
 * Render the display preference controls in General settings.
 * @param props - composed settings-row props.
 * @returns the display preference row.
 */
export function DisplaySettingsRow({ useDisplaySettings, setWidth, setFontSize, t }: DisplaySettingsRowProps) {
  const snapshot = useDisplaySettings(value => value)
  const disabled = snapshot.settings.status !== 'ready'
    || !snapshot.settings.writable
    || snapshot.settings.write.status === 'saving'
  const notice = noticeOf(snapshot.settings, t)
  const widthLabel: ConversationKey = 'settings.display.width'
  const fontLabel: ConversationKey = 'settings.display.fontSize'
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.display.title')}</div>
        <div className={css.desc}>{t('settings.display.description')}</div>
        {notice === undefined ? null : (
          <div className={css.notice} role={snapshot.settings.write.status === 'error' ? 'alert' : 'status'}>
            {notice}
          </div>
        )}
      </div>
      <div className={css.controls}>
        <label className={css.control}>
          <span className={css.controlLabel}>{t(widthLabel)}</span>
          <input
            type="range"
            min={CHAT_CONTENT_WIDTH_RANGE.min}
            max={CHAT_CONTENT_WIDTH_RANGE.max}
            step="1"
            value={snapshot.chatContentWidth}
            disabled={disabled}
            aria-label={t(widthLabel)}
            onChange={(event) => { setWidth(inputValue(event)) }}
          />
          <output>{t('settings.display.widthValue', { value: snapshot.chatContentWidth })}</output>
        </label>
        <label className={css.control}>
          <span className={css.controlLabel}>{t(fontLabel)}</span>
          <input
            type="range"
            min={CHAT_FONT_SIZE_RANGE.min}
            max={CHAT_FONT_SIZE_RANGE.max}
            step="1"
            value={snapshot.chatFontSize}
            disabled={disabled}
            aria-label={t(fontLabel)}
            onChange={(event) => { setFontSize(inputValue(event)) }}
          />
          <output>{t('settings.display.fontSizeValue', { value: snapshot.chatFontSize })}</output>
        </label>
      </div>
    </div>
  )
}
