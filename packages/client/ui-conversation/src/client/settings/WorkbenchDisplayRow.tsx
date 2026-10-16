/** Workbench-sidebar display preferences: a stacked variant of the general display row. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from '../locales.ts'
import { CHAT_FONT_SIZE_RANGE } from '../../submission-settings.ts'
import { noticeOf, type DisplaySettingsRowInjected } from './DisplaySettingsRow.tsx'
import css from './WorkbenchDisplayRow.module.css'

/** Full props for the sidebar workbench display-settings seat. */
export type WorkbenchDisplayRowProps =
  PropsRuntime<'conversation.workbench.display'>
  & PropsLocale<'conversation'>
  & InjectFace<DisplaySettingsRowInjected>

/** Named content-width presets exposed by the sidebar segmented control. */
const WIDTH_PRESETS: readonly { key: ConversationKey; value: number }[] = [
  { key: 'settings.display.widthPreset.compact', value: 640 },
  { key: 'settings.display.widthPreset.standard', value: 748 },
  { key: 'settings.display.widthPreset.relaxed', value: 960 },
]

/**
 * Render the display preferences stacked for the sidebar width: a font-size
 * stepper plus named width segments instead of continuous sliders.
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
  const fontSize = snapshot.chatFontSize
  const segmentedRef = useRef<HTMLSpanElement | null>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  // offsetLeft/offsetWidth read against the segmented box's padding edge —
  // the same origin an absolutely positioned thumb uses, so no conversion.
  // Re-measured after every render (labels settle, fonts swap, the active
  // segment's bold weight widens it) and whenever the box resizes.
  useLayoutEffect(() => {
    const host = segmentedRef.current
    if (host === null) return
    const measure = (): void => {
      const on = host.querySelector<HTMLElement>('[data-on]')
      const next = on === null || on.offsetWidth === 0 ? null : { left: on.offsetLeft, width: on.offsetWidth }
      setThumb(current => (
        current === next
        || (current !== null && next !== null && current.left === next.left && current.width === next.width)
          ? current
          : next
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => { observer.disconnect() }
  })
  return (
    <div className={css.controls}>
      {notice === undefined ? null : (
        <p className={css.notice} role={snapshot.settings.write.status === 'error' ? 'alert' : 'status'}>
          {notice}
        </p>
      )}
      <div className={css.control}>
        <span className={css.controlLabel}>{t(fontLabel)}</span>
        <span className={css.stepper}>
          <button
            type="button"
            className={css.stepButton}
            aria-label={t('settings.display.fontDecrease')}
            disabled={disabled || fontSize <= CHAT_FONT_SIZE_RANGE.min}
            onClick={() => { setFontSize(fontSize - 1) }}
          >
            −
          </button>
          <output className={css.stepValue}>{t('settings.display.fontSizeValue', { value: fontSize })}</output>
          <button
            type="button"
            className={css.stepButton}
            aria-label={t('settings.display.fontIncrease')}
            disabled={disabled || fontSize >= CHAT_FONT_SIZE_RANGE.max}
            onClick={() => { setFontSize(fontSize + 1) }}
          >
            +
          </button>
        </span>
      </div>
      <div className={css.control}>
        <span className={css.controlLabel}>{t(widthLabel)}</span>
        <span className={css.segmented} role="group" aria-label={t(widthLabel)} ref={segmentedRef}>
          {thumb !== null && (
            <span
              className={css.segmentThumb}
              style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
              aria-hidden
            />
          )}
          {WIDTH_PRESETS.map(preset => (
            <button
              key={preset.key}
              type="button"
              className={css.segment}
              data-on={!snapshot.chatFullWidth && snapshot.chatContentWidth === preset.value ? true : undefined}
              disabled={disabled}
              aria-pressed={!snapshot.chatFullWidth && snapshot.chatContentWidth === preset.value}
              onClick={() => { setWidth(preset.value); setFullWidth(false) }}
            >
              {t(preset.key)}
            </button>
          ))}
          <button
            type="button"
            className={css.segment}
            data-on={snapshot.chatFullWidth ? true : undefined}
            disabled={disabled}
            aria-pressed={snapshot.chatFullWidth}
            onClick={() => { setFullWidth(true) }}
          >
            {t('settings.display.fill')}
          </button>
        </span>
      </div>
    </div>
  )
}
