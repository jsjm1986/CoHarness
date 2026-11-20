// @vitest-environment jsdom
/** Named disclosure controls leave nested interactive summaries independent. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DisclosureRow } from '../src/DisclosureRow.tsx'

afterEach(cleanup)

it('names the icon-only disclosure with its visible title', () => {
  const toggle = vi.fn()
  render(<DisclosureRow title="Read file" icon={<svg />} open={false} expandable onToggle={toggle} />)
  fireEvent.click(screen.getByRole('button', { name: 'Read file' }))
  expect(toggle).toHaveBeenCalledOnce()
})

it('keeps nested controls and IME keys from toggling the whole row', () => {
  const toggle = vi.fn()
  const openFile = vi.fn()
  render(<DisclosureRow title="Read file" icon={<svg />} open={false} expandable expandOnRowClick onToggle={toggle}
    collapsedContent={<button type="button" onClick={openFile}>Open file</button>} />)
  const nested = screen.getByRole('button', { name: 'Open file' })
  fireEvent.keyDown(nested, { key: 'Enter' })
  fireEvent.click(nested)
  expect(openFile).toHaveBeenCalledOnce()
  expect(toggle).not.toHaveBeenCalled()
  const row = document.querySelector('[data-disclosure-row]')!
  fireEvent.keyDown(row, { key: 'Enter', isComposing: true })
  expect(toggle).not.toHaveBeenCalled()
  fireEvent.keyDown(row, { key: 'Enter' })
  expect(toggle).toHaveBeenCalledOnce()
})
