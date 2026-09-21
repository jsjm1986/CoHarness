/** Workbench-sidebar display preferences: a stacked variant of the general display row. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from '../locales.ts'
import {
  CHAT_CONTENT_WIDTH_RANGE, CHAT_FONT_SIZE_RANGE,
} from '../../submission-settings.ts'
import { noticeOf, RangeInput, type DisplaySettingsRowInjected } from './DisplaySettingsRow.tsx'
import css from './WorkbenchDisplayRow.module.css'

/** Full props for the sidebar workbench display-settings seat. */
export type WorkbenchDisplayRowProps =
  PropsRuntime<'conversation.workbench.display'>
  & PropsLocale<'conversation'>
  & InjectFace<DisplaySettingsRowInjected>

/**
 * Render the display preferences stacked for the sidebar width.
 * @param props - composed slot props with the shared display-settings face.
 * @returns the workbench display controls.
 */
export function WorkbenchDisplayRow({ useDisplaySettings, setWidth, setFullWidth, setFontSize, t }: WorkbenchDisplayRowProps) {
  const snapshot = useDisplaySettings(value => value)
  const disabled = snapshot.settings.status !== 'ready'
    || !snapshot.settings.writable
    || snapshot.settings.write.status === 'saving'
  const notice = noticeOf(snapshot.settings, t)
  const fontLabel: ConversationKey = 'settings.display.fontSize'
  const widthLabel: ConversationKey = 'settings.display.width'
  /* jscpd:ignore-start -- parallel settings-row/workbench display surfaces
   * share the same font-size control markup by design; each surface owns its
   * own css module layout (DisplaySettingsRow carries the same RangeInput). */
  return (
    <div className={css.controls}>
      {notice === undefined ? null : (
        <p className={css.notice} role={snapshot.settings.write.status === 'error' ? 'alert' : 'status'}>
          {notice}
        </p>
      )}
      <label className={css.control}>
        <span className={css.controlLabel}>{t(fontLabel)}</span>
        <span className={css.controlRow}>
          <RangeInput
            label={t(fontLabel)}
            min={CHAT_FONT_SIZE_RANGE.min}
            max={CHAT_FONT_SIZE_RANGE.max}
            value={snapshot.chatFontSize}
            disabled={disabled}
            onChange={setFontSize}
          />
          <output>{t('settings.display.fontSizeValue', { value: snapshot.chatFontSize })}</output>
        </span>
      </label>
      <label className={css.control}>
        <span className={css.controlLabel}>{t(widthLabel)}</span>
        <span className={css.controlRow}>
          <RangeInput
            label={t(widthLabel)}
            min={CHAT_CONTENT_WIDTH_RANGE.min}
            max={CHAT_CONTENT_WIDTH_RANGE.max}
            value={snapshot.chatContentWidth}
            disabled={disabled || snapshot.chatFullWidth}
            onChange={setWidth}
          />
          <output>{snapshot.chatFullWidth ? t('settings.display.fill') : t('settings.display.widthValue', { value: snapshot.chatContentWidth })}</output>
        </span>
      </label>
      <label className={css.fillToggle}>
        <input
          type="checkbox"
          checked={snapshot.chatFullWidth}
          disabled={disabled}
          aria-label={t('settings.display.fill')}
          onChange={(event) => { setFullWidth(event.currentTarget.checked) }}
        />
        {t('settings.display.fill')}
      </label>
    </div>
  )
  /* jscpd:ignore-end */
}
