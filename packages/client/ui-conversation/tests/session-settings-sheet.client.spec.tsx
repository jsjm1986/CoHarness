// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionSettingsSheet } from '../src/client/skeleton/SessionSettingsSheet.tsx'

afterEach(cleanup)

it('keeps keyboard focus in session settings and returns it to the trigger on close', () => {
  const onClose = vi.fn()
  const props = {
    activeSection: 'model' as const,
    sections: [{ id: 'model' as const, label: 'Model', content: <div role="menu"><button type="button">Choose model</button></div> }],
    title: 'Session settings', closeLabel: 'Close session settings', onClose, onSectionChange: vi.fn(),
  }
  const view = render(<><button type="button">Open settings</button><SessionSettingsSheet {...props} open={false} /></>)
  const trigger = screen.getByRole('button', { name: 'Open settings' })
  trigger.focus()
  view.rerender(<><button type="button">Open settings</button><SessionSettingsSheet {...props} open /></>)
  const close = screen.getByRole('button', { name: 'Close session settings' })
  const option = screen.getByRole('button', { name: 'Choose model' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(option)
  fireEvent.keyDown(option, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  view.rerender(<><button type="button">Open settings</button><SessionSettingsSheet {...props} open={false} /></>)
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
})
