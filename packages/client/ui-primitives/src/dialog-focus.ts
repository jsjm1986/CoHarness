/** Shared keyboard and focus-loop behavior for in-page dialogs. */

/**
 * Handle Escape and Tab for one dialog without consuming events from a nested
 * portal dialog.
 * @param event - document key event.
 * @param dialog - the dialog that owns the listener.
 * @param onClose - close action for Escape.
 */
export function handleDialogKeyDown(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
  onClose: () => void,
): void {
  if (dialog === null) return
  const targetDialog = event.target instanceof Element
    ? event.target.closest('[role="dialog"]')
    : null
  if (targetDialog !== null && targetDialog !== dialog) return
  // A document-level key event has no dialog target. Resolve ownership from
  // DOM order so an outer listener cannot prevent the nested portal dialog
  // from consuming Escape first.
  if (targetDialog === null) {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    if (dialogs.at(-1) !== dialog) return
  }
  if (event.defaultPrevented) return
  if (event.key === 'Escape') {
    event.preventDefault()
    onClose()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)
  if (first === undefined || last === undefined) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}
