/**
 * The tab and floating-panel actions menu. It accepts the kit's actions and
 * embedder items, with arrow-key traversal and focus return to its invoker.
 * Presentational — it renders what its props supply and dismisses itself on
 * outside presses or an unmodified Escape, returning menu focus to its tab.
 *
 * It renders in a portal, positioned against the control that opened it. The tab
 * strip clips its overflow on purpose (so it never becomes a scroll container
 * that claims a drag), and a menu drawn inside the strip would be clipped with
 * it; a portal puts it above every clipping ancestor. React still bubbles the
 * portal's synthetic events through the strip, which is why the press guards
 * below remain necessary.
 */
import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { focusWithoutRing, modalSelector, MenuSurface, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockLabels } from '../contract/adapter.ts'
import css from './dockkit.module.css'

/** Gap between the opening control and the menu, and the viewport margin kept clear. */
const MENU_GAP = 4

/** What the menu offers, where it anchors, and how it closes. */
export interface TabMenuProps {
  readonly labels: DockLabels
  /** The control that opened the menu; the menu hangs below its left edge. */
  readonly anchor: HTMLElement
  /** Close the tab; `undefined` removes the kit's item, leaving the extras only. */
  readonly onClose: (() => void) | undefined
  /** Dismiss without acting. */
  readonly onDismiss: () => void
  /** Embedder items, rendered after the kit's own; absent means none. */
  readonly extras: ReactNode
}

/** Where the menu sits, or `undefined` before the first measurement. */
function placeMenu(anchor: HTMLElement, menu: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  // Below the control, aligned to its left edge; flipped to its right edge when
  // that would run off the viewport, as it does for the last tab in a column
  // against the window's right side.
  const left = rect.left + width + MENU_GAP > window.innerWidth
    ? Math.max(MENU_GAP, rect.right - width)
    : rect.left
  const height = menu.offsetHeight
  const viewport = window.visualViewport
  const bottom = viewport == null ? window.innerHeight : viewport.offsetTop + viewport.height
  const top = Math.max(viewport?.offsetTop ?? MENU_GAP, Math.min(rect.bottom + MENU_GAP, bottom - height - MENU_GAP))
  return { top, left: Math.max(MENU_GAP, Math.min(left, window.innerWidth - width - MENU_GAP)) }
}

/** The actions menu body, anchored to the control that opened it. */
export function TabMenu({ labels, anchor, onClose, onDismiss, extras }: TabMenuProps): ReactNode {
  const self = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const hasItems = onClose !== undefined || Children.toArray(extras).some(item => item !== '')

  useLayoutEffect(() => {
    const menu = self.current
    if (menu === null) return
    const place = (): void => { setPosition(placeMenu(anchor, menu)) }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [anchor, hasItems])

  useEffect(() => {
    const menu = self.current
    /* v8 ignore next -- the ref is attached by effect time: the menu renders unconditionally. */
    if (menu === null) return undefined
    const document = menu.ownerDocument
    const composition = observeComposition(document)
    const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])')]
    focusWithoutRing(items()[0] ?? menu)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (composition.guards(event) || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      const top = [...document.querySelectorAll(modalSelector)].at(-1)
      if (top !== menu) return
      if (event.key === 'Tab') {
        dismiss.current()
        anchor.focus({ preventScroll: true })
        return
      }
      if (event.shiftKey) return
      const rows = items()
      const index = rows.findIndex(item => item === document.activeElement)
      const target = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1)
        : event.key === 'ArrowDown' ? rows[(index + 1) % rows.length]
          : event.key === 'ArrowUp' ? rows[(index - 1 + rows.length) % rows.length] : undefined
      if (target !== undefined) {
        event.preventDefault()
        target.focus()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (event.repeat) return
      const restoreFocus = menu.contains(document.activeElement)
      dismiss.current()
      if (restoreFocus) focusWithoutRing(anchor)
    }
    document.addEventListener('keydown', onKeyDown, true)
    // A press anywhere but inside the menu dismisses it; one with no element
    // target (dispatched to the window itself) counts as outside.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) return
      dismiss.current()
    }
    // Capture phase: a press on a tab chip starts a drag on its own handler,
    // so the menu must be gone before that handler runs.
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      composition.dispose()
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [anchor, hasItems])

  if (!hasItems) return null
  return createPortal(
    <MenuSurface
      className={css.menu}
      ref={self}
      role="menu"
      tabIndex={-1}
      data-dockkit-tab-menu
      // Unplaced for one layout pass: measured, then positioned.
      style={position ?? { visibility: 'hidden', top: 0, left: 0 }}
      // React bubbles a portal's events to its tab chip, so both halves of a
      // press must stop here: the press would otherwise start a tab drag and
      // capture the pointer, which retargets the release and swallows this
      // item's click; the click would otherwise also focus a tab the item may
      // have removed.
      onPointerDown={(event) => { event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation() }}
    >
      {onClose !== undefined && (
        <button type="button" role="menuitem" className={css.menuItem} data-dockkit-menu-close onClick={onClose}>
          {labels.closeTab}
        </button>
      )}
      {/* Embedder items last: the kit's own item is the same in every menu, so
          a reader looks for it in the same place every time. */}
      {extras}
    </MenuSurface>,
    document.body,
  )
}
