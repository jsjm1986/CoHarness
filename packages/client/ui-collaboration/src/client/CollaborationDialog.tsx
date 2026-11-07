import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  focusWithoutRing, IconChevronLeftOutline14, IconCloseOutline16, Modal, Tooltip, useMediaQuery,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './CollaborationDialog.module.css'

/**
 * Render project dialog chrome while Modal owns focus, dismissal, and the portal.
 * @param props - Dialog content, navigation, and pending mutation state.
 * @returns A desktop dialog or full-screen phone page.
 */
export function CollaborationDialog({
  open, title, description, closeLabel, onClose, children, footer, wide = false,
  backLabel, onBack, busy = false, bodyClassName,
}: {
  open: boolean
  title: string
  description?: string | undefined
  closeLabel: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  backLabel?: string | undefined
  onBack?: (() => void) | undefined
  busy?: boolean
  bodyClassName?: string | undefined
}) {
  const compact = useMediaQuery('(max-width: 767px)')
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const previousTitle = useRef(title)
  useLayoutEffect(() => {
    if (open && previousTitle.current !== title && heading.current !== null) focusWithoutRing(heading.current)
    previousTitle.current = title
  }, [open, title])
  return (
    <Modal open={open} title={title} onClose={() => { if (!busy) onClose() }} headless mobilePresentation="page"
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing
          || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || onBack === undefined
          || document.querySelector('[role="menu"], [role="listbox"]') !== null) return
        event.preventDefault()
        event.stopPropagation()
        if (!busy) onBack()
      }}
      className={clsx(css.dialog, css.mobilePage, wide && css.wide)}>
      <header className={css.header}>
        {onBack !== undefined && (
          <Tooltip label={backLabel ?? ''} side="bottom" portal disabled={compact}>
            <button type="button" className={css.iconButton} aria-label={backLabel}
              disabled={busy} onClick={onBack} data-modal-autofocus>
              <IconChevronLeftOutline14 size={16} />
            </button>
          </Tooltip>
        )}
        <div className={css.heading}>
          <h2 ref={heading} id={titleId} tabIndex={-1}>{title}</h2>
          {description !== undefined && description !== '' && <p>{description}</p>}
        </div>
        <Tooltip label={closeLabel} side="bottom" portal disabled={compact}>
          <button type="button" className={css.iconButton} aria-label={closeLabel}
            disabled={busy} onClick={onClose} data-modal-autofocus={onBack === undefined ? '' : undefined}>
            <IconCloseOutline16 size={16} />
          </button>
        </Tooltip>
      </header>
      <div className={clsx(css.body, bodyClassName)} aria-labelledby={titleId}>{children}</div>
      {footer !== undefined && <footer className={css.footer}>{footer}</footer>}
    </Modal>
  )
}
