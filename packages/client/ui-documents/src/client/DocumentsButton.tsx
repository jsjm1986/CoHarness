import { useCallback, useEffect, useState } from 'react'
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
  const [mode, setMode] = useState<'manage' | 'select'>('manage')
  const handleOpen = useCallback(() => {
    setMode('manage')
    setOpen(true)
  }, [])
  const handleClose = useCallback(() => { setOpen(false) }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const openPicker = (event: Event): void => {
      const detail = event instanceof CustomEvent && typeof event.detail === 'object' && event.detail !== null
        ? event.detail as { mode?: unknown }
        : undefined
      setMode(detail?.mode === 'select' ? 'select' : 'manage')
      setOpen(true)
    }
    window.addEventListener('dsh-documents-open-picker', openPicker)
    return () => { window.removeEventListener('dsh-documents-open-picker', openPicker) }
  }, [])

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
      <DocumentsModal
        open={open}
        onClose={handleClose}
        t={t}
        mode={mode}
        {...(attachDocument === undefined ? {} : { onAttachDocument: attachDocument })}
      />
    </>
  )
}
