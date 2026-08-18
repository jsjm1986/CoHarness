import { useCallback, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DocumentsModal } from './DocumentsModal.tsx'
import { NS } from './locales.ts'

export type DocumentsButtonProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>

export function DocumentsButton({
  t,
}: DocumentsButtonProps) {
  const [open, setOpen] = useState(false)
  const handleOpen = useCallback(() => { setOpen(true) }, [])
  const handleClose = useCallback(() => { setOpen(false) }, [])

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={t('button.label')}
        title={t('button.label')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </button>
      {open && <DocumentsModal open onClose={handleClose} t={t} />}
    </>
  )
}
