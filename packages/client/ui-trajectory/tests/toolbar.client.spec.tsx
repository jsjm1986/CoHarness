// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrajectoryToolbar } from '../src/client/TrajectoryToolbar.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function mount() {
  const callbacks = {
    onActualDurationChange: vi.fn(),
    onActualTimeChange: vi.fn(),
    onToggleAllTurns: vi.fn(),
    onToggleAllAssistants: vi.fn(),
    onSearchQueryChange: vi.fn(),
  }
  render(
    <TrajectoryToolbar
      compact
      actualDuration={false}
      onActualDurationChange={callbacks.onActualDurationChange}
      actualTime={false}
      onActualTimeChange={callbacks.onActualTimeChange}
      allTurnsCollapsed={false}
      onToggleAllTurns={callbacks.onToggleAllTurns}
      allAssistantsCollapsed={false}
      onToggleAllAssistants={callbacks.onToggleAllAssistants}
      searchQuery=""
      onSearchQueryChange={callbacks.onSearchQueryChange}
      t={key => zh[key as keyof typeof zh] ?? key}
    />,
  )
  return callbacks
}

describe('compact TrajectoryToolbar', () => {
  it('opens an inline search field without adding a second toolbar row', () => {
    const callbacks = mount()
    fireEvent.click(screen.getByRole('button', { name: zh['toolbar.search'] }))
    expect(screen.getByRole('searchbox', { name: zh['toolbar.search'] })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: zh['toolbar.search'] }), {
      target: { value: 'bash' },
    })
    expect(callbacks.onSearchQueryChange).toHaveBeenCalledWith('bash')
    fireEvent.click(screen.getByRole('button', { name: zh['toolbar.closeSearch'] }))
    expect(callbacks.onSearchQueryChange).toHaveBeenCalledWith('')
  })

  it('puts fold and timing controls in the overflow menu', () => {
    const callbacks = mount()
    fireEvent.click(screen.getByRole('button', { name: zh['toolbar.more'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['toolbar.collapseTurns'] }))
    expect(callbacks.onToggleAllTurns).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['toolbar.more'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['toolbar.actualTime'] }))
    expect(callbacks.onActualTimeChange).toHaveBeenCalledWith(true)
  })
})
