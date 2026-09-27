// @vitest-environment jsdom
/**
 * The way back into a hidden panel: the header's corner button exists exactly
 * while the panel is collapsed, asks for it to expand, and renders nothing
 * while the panel is shown.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ExpandButton, BlankExpandButton } from '../src/client/shell/ExpandButton.tsx'
import type { ExpandButtonProps } from '../src/client/shell/ExpandButton.tsx'
import { createSidebarRightStore } from '../src/client/stores.ts'

const SESSION = 's-test' as SessionId

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/**
 * Mount the button over a real store instance. It reads four of its props; the
 * rest of the standard kit is framework-injected and never touched here, so one
 * documented cast keeps the harness to what is actually exercised.
 */
function mountButton() {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const props = {
    sessionId: SESSION,
    focus: vi.fn(),
    useStore: hookOf(instance),
    actions: instance.actions,
    // Copy is the dictionary's contract; the key stands in for the translation.
    t: (key: string) => key,
  } as unknown as ExpandButtonProps
  const view = render(<ExpandButton {...props} />)
  const control = (): HTMLElement | null => view.container.querySelector('[data-sidebar-right-expand]')
  return { instance, view, control }
}

describe('ExpandButton', () => {
  it('offers the way in while the session has no surface yet, and asks the panel to expand', () => {
    const { instance, view, control } = mountButton()
    const button = control()
    if (button === null) throw new Error('expected the expand control')
    expect(button.getAttribute('aria-label')).toBe('chrome.expandAria')
    fireEvent.click(button)
    expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(true)
    // Shown: the seat is empty, so the header lays out without it.
    expect(view.container.childElementCount).toBe(0)
    cleanup()
  })

  it('comes back when the panel collapses again', () => {
    const { instance, control } = mountButton()
    act(() => { instance.actions.setExpanded(SESSION, true) })
    expect(control()).toBeNull()
    act(() => { instance.actions.setExpanded(SESSION, false) })
    expect(control()).not.toBeNull()
    cleanup()
  })
})

it('exposes the blank-session composer entry and removes it when header chrome becomes available', () => {
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
  const focus = vi.fn()
  let blank = true
  const props = { sessionId: SESSION, focus, useStore: hookOf(instance), actions: instance.actions,
    t: (key: string) => key, useSession: (select: (state: { blank: boolean; composerPhase: string }) => unknown) => select({ blank, composerPhase: 'blank' }),
  } as unknown as ExpandButtonProps
  const view = render(<BlankExpandButton {...props} />)
  fireEvent.click(view.getByRole('button'))
  expect(focus).toHaveBeenCalledOnce()
  expect(instance.getSnapshot().bySession[SESSION]?.layout.expanded).toBe(true)
  blank = false
  view.rerender(<BlankExpandButton {...props} />)
  expect(view.container.childElementCount).toBe(0)
  cleanup()
})
