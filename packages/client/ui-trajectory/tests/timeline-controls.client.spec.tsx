// @vitest-environment jsdom
/** Native range endpoint controls and the existing timeline's zoom/reset behavior. */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TimelineControls } from '../src/client/TimelineControls.tsx'
import { TrajectoryTimeline } from '../src/client/TrajectoryTimeline.tsx'
import type { TrajectoryTimeRange } from '../src/client/timeline.ts'
import { t } from './locale.client.ts'

afterEach(cleanup)

it('adjusts both named native endpoints, preserves their ordering and returns focus on dismissal', async () => {
  const changed = vi.fn()
  function Fixture() {
    const [range, setRange] = useState<TrajectoryTimeRange | null>(null)
    return <TimelineControls t={t} bounds={{ start: 1_000, end: 2_000 }} range={range} sequence={false}
      canZoomIn canZoomOut={false} zoomPercent={100} onZoomIn={vi.fn()} onZoomOut={vi.fn()}
      onReset={() => { setRange(null) }} onRangeChange={(next) => { changed(next); setRange(next) }} />
  }
  render(<Fixture />)
  const trigger = screen.getByRole('button', { name: 'Adjust timeline' })
  fireEvent.click(trigger)
  const start = screen.getByRole('slider', { name: 'Range start' })
  const end = screen.getByRole('slider', { name: 'Range end' })
  expect(start.getAttribute('type')).toBe('range')
  fireEvent.change(start, { target: { value: '20' } })
  fireEvent.change(end, { target: { value: '80' } })
  expect(changed).toHaveBeenLastCalledWith({ start: 1_200, end: 1_800 })
  expect(start.getAttribute('max')).toBe('80')
  expect(end.getAttribute('min')).toBe('20')
  expect(start.getAttribute('aria-valuetext')).toBe('200 ms')
  expect(end.getAttribute('aria-valuetext')).toBe('800 ms')
  fireEvent.click(screen.getByRole('button', { name: 'Reset timeline' }))
  expect(start.getAttribute('value')).toBe('0')
  expect(end.getAttribute('value')).toBe('100')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger) })
})

it('zooms the real overview with buttons and resets both viewport and range', () => {
  const onRangeChange = vi.fn()
  const view = render(<TrajectoryTimeline t={t} mode="sequence" range={{ start: 2, end: 8 }}
    onRangeChange={onRangeChange} turns={[{ turn: 1, groups: [{ title: 'Step 1', cells: Array.from({ length: 10 }, (_, index) => ({
      index, kind: 'tool' as const, text: `tool-${index}`, timeSeconds: 1,
    })) }] }]} />)
  const domain = view.container.querySelector<HTMLElement>('[data-timeline-domain]')
  fireEvent.click(screen.getByRole('button', { name: 'Adjust timeline' }))
  expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(domain?.style.getPropertyValue('--trajectory-domain-width')).toBe('200%')
  expect(screen.getByRole('status').textContent).toBe('Zoom 200%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(domain?.style.getPropertyValue('--trajectory-domain-width')).toBe('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset timeline' }))
  expect(domain?.style.getPropertyValue('--trajectory-domain-width')).toBe('100%')
  expect(onRangeChange).toHaveBeenLastCalledWith(null)
})
