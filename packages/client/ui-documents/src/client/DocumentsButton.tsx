import { useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBrowseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentsModal } from './DocumentsModal.tsx'
import { NS } from './locales.ts'
import css from './DocumentsButton.module.css'

export type DocumentsButtonProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>

/**
 * Render the sidebar Documents trigger and its manager modal.
 * @param props.t - localized documents dictionary.
 * @param props.wide - when true, the expanded sidebar shows the Documents label beside the icon.
 * @returns the footer trigger and, while open, the document manager dialog.
 */
export function DocumentsButton({
  t, wide,
}: DocumentsButtonProps) {
  const [open, setOpen] = useState(false)
  const handleOpen = useCallback(() => { setOpen(true) }, [])
  const handleClose = useCallback(() => { setOpen(false) }, [])

  return (
    <>
      <Tooltip label={t('button.label')} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('button.label')}
          onClick={handleOpen}
        >
          <IconBrowseOutline16 size={16} />
          {wide && <span className={css.label}>{t('button.label')}</span>}
        </button>
      </Tooltip>
      {open && <DocumentsModal open onClose={handleClose} t={t} />}
    </>
  )
}
