/** Native range controls for the trajectory overview's pointer-independent actions. */
import { useId, useState } from 'react'
import { Button, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TrajectoryTranslate } from './locales.ts'
import { formatTimelineOffset, type TrajectoryTimeRange } from './timeline.ts'
import css from './TimelineControls.module.css'

interface TimelineControlsProps {
  t: TrajectoryTranslate
  bounds: TrajectoryTimeRange
  range: TrajectoryTimeRange | null
  sequence: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  zoomPercent: number
  onRangeChange: (range: TrajectoryTimeRange) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}

/**
 * Keep range endpoints, zoom and reset available through native touch and keyboard controls.
 * @param props - the overview's loaded bounds, selection and view actions.
 * @returns the visible adjustment trigger and its scrollable dialog.
 */
export function TimelineControls({ t, bounds, range, sequence, canZoomIn, canZoomOut, zoomPercent,
  onRangeChange, onZoomIn, onZoomOut, onReset }: TimelineControlsProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const duration = Math.max(1, bounds.end - bounds.start)
  const selection = range ?? bounds
  const percent = (value: number) => Math.min(100, Math.max(0, (value - bounds.start) / duration * 100))
  const start = percent(selection.start)
  const end = percent(selection.end)
  const label = (value: number) => sequence
    ? t('timeline.operationOffset', { value: Number((value - bounds.start).toFixed(2)) })
    : formatTimelineOffset(value - bounds.start, t)
  return <>
    <Button variant="ghost" size="sm" className={css.trigger}
      aria-label={t('timeline.controls')} aria-haspopup="dialog" aria-expanded={open}
      onClick={(event) => { focusWithoutRing(event.currentTarget); setOpen(true) }}>
      {t('timeline.adjust')}
    </Button>
    <Modal open={open} title={t('timeline.controls')} closeLabel={t('timeline.closeControls')}
      onClose={() => { setOpen(false) }}>
      <div className={css.controls}>
        <output className={css.zoomLevel}>{t('timeline.zoomLevel', { value: zoomPercent })}</output>
        <div className={css.actions}>
          <Button variant="outline" disabled={!canZoomIn} onClick={onZoomIn}>{t('timeline.zoomIn')}</Button>
          <Button variant="outline" disabled={!canZoomOut} onClick={onZoomOut}>{t('timeline.zoomOut')}</Button>
          <Button variant="ghost" onClick={onReset}>{t('timeline.reset')}</Button>
        </div>
        <p className={css.hint}>{t('timeline.rangeHint')}</p>
        <div className={css.field}>
          <label htmlFor={`${id}-start`}>{t('timeline.rangeStart')}</label>
          <span>{label(selection.start)}</span>
          <input id={`${id}-start`} type="range" min="0" max={end} step="any" value={start}
            aria-valuetext={label(selection.start)} onChange={(event) => {
              onRangeChange({ start: bounds.start + Number(event.currentTarget.value) / 100 * duration, end: selection.end })
            }} />
        </div>
        <div className={css.field}>
          <label htmlFor={`${id}-end`}>{t('timeline.rangeEnd')}</label>
          <span>{label(selection.end)}</span>
          <input id={`${id}-end`} type="range" min={start} max="100" step="any" value={end}
            aria-valuetext={label(selection.end)} onChange={(event) => {
              onRangeChange({ start: selection.start, end: bounds.start + Number(event.currentTarget.value) / 100 * duration })
            }} />
        </div>
      </div>
    </Modal>
  </>
}
