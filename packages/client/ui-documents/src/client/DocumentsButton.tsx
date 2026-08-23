import { useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBrowseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentsModal } from './DocumentsModal.tsx'
import type { UserDocRef } from './documents-client.ts'
import { NS } from './locales.ts'
import css from './DocumentsButton.module.css'

/** Business callback supplied by the host composition for existing documents. */
export interface DocumentsButtonInjected {
  /** Add a durable document to the current conversation composer. */
  attachDocument?: ((document: UserDocRef) => boolean) | undefined
}

export type DocumentsButtonProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & DocumentsButtonInjected

/**
 * Render the sidebar Documents trigger and its manager modal.
 * @param props.t - localized documents dictionary.
 * @param props.wide - when true, the expanded sidebar shows the Documents label beside the icon.
 * @returns the footer trigger and, while open, the document manager dialog.
 */
export function DocumentsButton({
  t, wide, attachDocument,
}: DocumentsButtonProps) {
  const [open, setOpen] = useState(false)
  const handleOpen = useCallback(() => { setOpen(true) }, [])
  const handleClose = useCallback(() => { setOpen(false) }, [])

  return (
    <>
      <Tooltip label={t('button.label')} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={wide ? css.trigger : `${css.trigger} ${css.rail}`}
          aria-label={t('button.label')}
          onClick={handleOpen}
        >
          <IconBrowseOutline16 size={16} />
          {wide && <span className={css.label}>{t('button.label')}</span>}
        </button>
      </Tooltip>
      {open && <DocumentsModal open onClose={handleClose} t={t} onAttachDocument={attachDocument} />}
    </>
  )
}
