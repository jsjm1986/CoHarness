// @vitest-environment jsdom
/** Seat-bound disclosure generation semantics: local toggles, one shared reset. */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindDisclosure, bindDisclosureReset, useDisclosure } from '../src/client/chat/use-disclosure.ts'
import type { UseDisclosure } from '../src/client/contract/slots.ts'

afterEach(cleanup)

function Row({ name, disclosure }: { name: string; disclosure: UseDisclosure }) {
  const { expanded, setExpanded, toggle } = disclosure()
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={toggle}
      onDoubleClick={() => { setExpanded(true) }}
    >
      {name}
    </button>
  )
}

describe('useDisclosure', () => {
  it('toggles and sets a standalone disclosure', () => {
    const view = render(<Row name="R" disclosure={() => useDisclosure()} />)
    const row = view.getByRole('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.doubleClick(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps each bound invocation independent while one reset collapses all', () => {
    const reset = createSnapshotStore(0)
    const disclosure = bindDisclosure(reset)
    const view = render(
      <>
        <Row name="First" disclosure={disclosure} />
        <Row name="Second" disclosure={disclosure} />
      </>,
    )
    const first = view.getByRole('button', { name: 'First' })
    const second = view.getByRole('button', { name: 'Second' })
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(second)

    act(() => { reset.set(1) })
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('false')

    // Re-expansion records the new generation and survives until the next bump.
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    act(() => { reset.set(2) })
    expect(first.getAttribute('aria-expanded')).toBe('false')
  })

  it('exposes the live generation through bindDisclosureReset', () => {
    const reset = createSnapshotStore(3)
    function Probe() {
      const version = bindDisclosureReset(reset)()
      return <span data-version={version} />
    }
    const view = render(<Probe />)
    expect(view.container.firstElementChild?.getAttribute('data-version')).toBe('3')
    act(() => { reset.set(4) })
    expect(view.container.firstElementChild?.getAttribute('data-version')).toBe('4')
  })
})
