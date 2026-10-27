// @vitest-environment jsdom
/** The outside-pointer dismissal primitive as observable popover behavior. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { Menu } from '../src/Menu.tsx'

afterEach(cleanup)

function Popover({ portaled }: { portaled: boolean }) {
  const [open, setOpen] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen, portaled ? panelRef : undefined)
  return (
    <div ref={rootRef} data-testid="root">
      <button type="button">trigger</button>
      {open && !portaled && <div data-testid="surface">surface</div>}
      {open && portaled && createPortal(<div ref={panelRef} data-testid="surface">surface</div>, document.body)}
    </div>
  )
}

function MenuPopover() {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal onClose={() => { setOpen(false) }} items={[{ id: 'one', label: 'Owner action' }]}
    anchor={<button type="button" onClick={() => { setOpen(true) }}>Open owner menu</button>} />
}

describe('useDismissOnOutsidePointer', () => {
  it('dismisses a portaled Menu when its owner hides and preserves the new keyboard focus', async () => {
    const tree = (hidden: boolean) => <><section hidden={hidden}><MenuPopover /></section><button type="button">Other pane</button></>
    const view = render(tree(false))
    fireEvent.click(view.getByRole('button', { name: 'Open owner menu' }))
    expect(view.getByRole('menuitem', { name: 'Owner action' })).toBeTruthy()
    const other = view.getByRole('button', { name: 'Other pane' })
    other.focus()
    view.rerender(tree(true))
    await waitFor(() => { expect(view.queryByRole('menuitem')).toBeNull() })
    expect(document.activeElement).toBe(other)
  })
  it('closes a portaled surface when its owning region is hidden without a pointer event', async () => {
    const view = render(<section><Popover portaled /></section>)
    const trigger = view.getByRole('button', { name: 'trigger' })
    expect(view.getByTestId('surface')).toBeTruthy()
    view.rerender(<section hidden><Popover portaled /></section>)
    await waitFor(() => { expect(view.queryByTestId('surface')).toBeNull() })
    view.rerender(<section><Popover portaled /></section>)
    expect(view.getByRole('button', { name: 'trigger' })).toBe(trigger)
    expect(view.queryByTestId('surface')).toBeNull()
  })
  it('closes on an outside pointerdown but not on one inside the root', () => {
    const view = render(<Popover portaled={false} />)
    fireEvent.pointerDown(view.getByTestId('root'))
    expect(view.queryByTestId('surface')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByTestId('surface')).toBeNull()
  })

  it('counts the portaled surface as inside while still closing outside it', () => {
    const view = render(<Popover portaled />)
    fireEvent.pointerDown(view.getByTestId('surface'))
    expect(view.queryByTestId('surface')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByTestId('surface')).toBeNull()
  })
})
