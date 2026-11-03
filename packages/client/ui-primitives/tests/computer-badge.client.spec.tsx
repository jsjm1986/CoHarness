// @vitest-environment jsdom
/** Computer cards retain the enclosing modal's accessibility and their captured resource actions. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputerBadge } from '../src/ComputerBadge.tsx'
import { Modal } from '../src/Modal.tsx'

afterEach(cleanup)

it('keeps a document-location menu in its owning dialog and returns focus on Escape', () => {
  const choose = vi.fn()
  const closeModal = vi.fn()
  render(<Modal open onClose={closeModal} title="Documents" closeLabel="Close"><ComputerBadge name="Computer B" label="Storage computer"
    details={[{ label: 'Conversation computer', value: 'Computer A' }]}
    actions={[{ id: 'choose', label: 'Choose B', run: choose }]} /></Modal>)
  const trigger = screen.getByRole('button', { name: 'Storage computer: Computer B' })
  trigger.focus(); fireEvent.click(trigger)
  expect(within(screen.getByRole('dialog')).getByRole('menu')).toBeTruthy()
  expect(screen.getByText('Conversation computer: Computer A')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Documents' })).toBeTruthy()
  expect(closeModal).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
  expect(choose).not.toHaveBeenCalled()
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Choose B' }))
  expect(choose).toHaveBeenCalledOnce()
})

it('yields an open computer menu to a newly presented modal without returning focus behind it', () => {
  const closeModal = vi.fn()
  const surface = (open: boolean) => <>
    <ComputerBadge name="Computer B" label="Work computer" details={[{ label: 'Runtime', value: 'runtime-B' }]} />
    <Modal open={open} onClose={closeModal} title="Configure models" closeLabel="Close"><input aria-label="API key" data-modal-autofocus /></Modal>
  </>
  const { rerender } = render(surface(false))
  const trigger = screen.getByRole('button', { name: 'Work computer: Computer B' })
  trigger.focus(); fireEvent.click(trigger)
  expect(screen.getByRole('menu')).toBeTruthy()
  rerender(surface(true))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'API key' }))
  expect(closeModal).not.toHaveBeenCalled()
})


it('shows a passive name without a card, menu or extra keyboard stop when no actions are provided', () => {
  render(<ComputerBadge name="Computer B" label="Execution computer" />)
  expect(screen.getByRole('group', { name: 'Execution computer' }).textContent).toBe('Computer B')
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
})
