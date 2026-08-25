import type { ReactNode } from 'react'
import { IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DocumentsMobileSheet.module.css'

/**
 * A document-manager-owned sheet for compact controls.
 *
 * The sheet deliberately builds on `Modal` instead of the anchored `Menu`:
 * scope search, filter controls, and action descriptions need a scrollable
 * body and a titled dialog. `Modal` keeps the portal, focus loop, Escape, and
 * focus restoration behavior identical to the manager's existing dialogs.
 * @param props.open - whether the sheet is mounted.
 * @param props.title - visible and accessible sheet title.
 * @param props.closeLabel - accessible close-control label.
 * @param props.kind - stable semantic kind used by browser audits.
 * @param props.onClose - dismisses the sheet.
 * @param props.children - scrollable sheet content.
 * @returns the compact document sheet, or null while closed.
 */
export function DocumentsMobileSheet({
  open, title, closeLabel, kind, onClose, children,
}: {
  /** Whether the sheet is mounted. */
  open: boolean
  /** Visible and accessible sheet title. */
  title: string
  /** Accessible label for the close control. */
  closeLabel: string
  /** Stable semantic kind used by browser tests and visual audits. */
  kind: string
  /** Dismiss the sheet. */
  onClose: () => void
  /** Sheet body. */
  children: ReactNode
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} headless className={css.dialog as string}>
      <section className={css.surface} data-documents-sheet={kind}>
        <div className={css.handle} aria-hidden="true" />
        <header className={css.header}>
          <h2 className={css.title}>{title}</h2>
          <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
            <IconCloseOutline16 size={18} />
          </button>
        </header>
        <div className={css.body} data-documents-sheet-scrollport="">{children}</div>
      </section>
    </Modal>
  )
}
