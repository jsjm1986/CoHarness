import css from './MobileSheetBackdrop.module.css'

/**
 * Dismissal surface shared by phone sheets rendered in place or through a
 * portal. The component is visually disabled above the compact breakpoint so
 * desktop presenters do not need a second render branch.
 * @param props.onClose - close the owning sheet.
 * @returns the phone-only backdrop element.
 */
export function MobileSheetBackdrop({ onClose }: { onClose: () => void }) {
  return (
    <div
      className={css.root}
      aria-hidden="true"
      onPointerDown={(event) => {
        event.stopPropagation()
        onClose()
      }}
    />
  )
}
