// @vitest-environment jsdom
/**
 * Menu keyboard-focus timing: the opening control is captured before the menu
 * publishes its own focus move (autoFocus), and the post-selection restore
 * lands on a microtask — never synchronously inside the click handler — so a
 * focus moved by the owner itself is left alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { Menu } from '../src/Menu.tsx'

afterEach(cleanup)

const ITEMS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
]

/** Owner-driven menu: a real open state, optional keep-open selection. */
function Host({ autoFocus = false, keepOpen = false, onSelect = vi.fn(), onClose = vi.fn() }: {
  readonly autoFocus?: boolean
  readonly keepOpen?: boolean
  readonly onSelect?: (id: string) => void
  readonly onClose?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      autoFocus={autoFocus}
      anchor={<button type="button" onClick={() => { setOpen(true) }}>trigger</button>}
      items={ITEMS}
      onSelect={(id) => { onSelect(id); if (!keepOpen) setOpen(false) }}
      onClose={() => { onClose(); setOpen(false) }}
    />
  )
}

describe('Menu focus capture and restore', () => {
  it('captures the trigger before autoFocus moves the keyboard, and restores it a microtask after selection closes', async () => {
    render(<Host autoFocus />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    // autoFocus published its own move: the first row holds the keyboard.
    const first = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(first)
    // The captured trigger — not the row — is the restore destination.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
    // The list is gone and its row is unfocused, but the restore has not run
    // yet: it is scheduled on a microtask, not synchronous in the click.
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(document.activeElement).not.toBe(trigger)
    await act(() => Promise.resolve())
    expect(document.activeElement).toBe(trigger)
  })

  it('restores a focus left behind on the closing list, but leaves an owner-moved focus alone', async () => {
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    try {
      // Case 1: the keyboard died with the list — it comes back to the trigger.
      const first = render(<Host />)
      const trigger = screen.getByRole('button', { name: 'trigger' })
      trigger.focus()
      fireEvent.click(trigger)
      const beta = screen.getByRole('menuitem', { name: 'Beta' })
      beta.focus()
      fireEvent.click(beta)
      await act(() => Promise.resolve())
      expect(document.activeElement).toBe(trigger)
      first.unmount()

      // Case 2: the owner moved focus itself during selection — the restore
      // leaves that destination alone instead of stealing the keyboard back.
      render(<Host onSelect={() => { elsewhere.focus() }} />)
      const trigger2 = screen.getByRole('button', { name: 'trigger' })
      trigger2.focus()
      fireEvent.click(trigger2)
      const beta2 = screen.getByRole('menuitem', { name: 'Beta' })
      beta2.focus()
      fireEvent.click(beta2)
      await act(() => Promise.resolve())
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      elsewhere.remove()
    }
  })

  it('does not restore while the owner keeps the menu open after a selection', async () => {
    render(<Host keepOpen />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    const beta = screen.getByRole('menuitem', { name: 'Beta' })
    beta.focus()
    fireEvent.click(beta)
    await act(() => Promise.resolve())
    // The menu stayed open: the keyboard remains on the selected row.
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeTruthy()
    expect(document.activeElement).toBe(beta)
  })

  it('returns the keyboard to the trigger on Escape, captured before any row focus', () => {
    const onClose = vi.fn()
    render(<Host autoFocus onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    const first = screen.getByRole('menuitem', { name: 'Alpha' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
  })

  it('does not move the keyboard on open without autoFocus — no focus-driven scroll', () => {
    render(<Host />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    // The menu opened without taking the keyboard, so opening cannot scroll a
    // focused control into view; the keyboard stays where the reader left it.
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
  })
})
