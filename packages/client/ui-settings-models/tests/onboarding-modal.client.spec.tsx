// @vitest-environment jsdom
/** Shared onboarding chrome preserves step focus and the surrounding application's inert state. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

it('focuses a non-form step title even before an application root is mounted', () => {
  render(<OnboardingModal title="Choose a workspace" focusTitle><p>Select a directory to continue.</p></OnboardingModal>)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Choose a workspace' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('keeps form focus until the next step requests title focus and restores application interactivity', () => {
  const root = document.createElement('div')
  root.id = 'root'
  root.inert = false
  document.body.append(root)
  const view = render(<OnboardingModal title="Set up a provider"><input aria-label="Provider name" autoFocus /></OnboardingModal>)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Provider name' }))
  expect(root.inert).toBe(true)
  expect(screen.getByRole('heading').hasAttribute('tabindex')).toBe(false)
  view.rerender(<OnboardingModal title="Setup complete" focusTitle><p>Ready.</p></OnboardingModal>)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Setup complete' }))
  view.unmount()
  expect(root.inert).toBe(false)
})
