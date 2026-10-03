import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Render the Session Header export capsule and its shared result dialog.
 * A two-step confirmation guards against accidental downloads: the first
 * click arms the button (`Confirm download?`), the second within the
 * confirmation window triggers the actual export.
 * @param props - Session runtime, download controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, compact = false, t } = props
  if (compact) return null
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current) }, [])

  const arm = (): void => {
    setConfirming(true)
    timerRef.current = setTimeout(() => { setConfirming(false) }, 4_000)
  }
  const trigger = (): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    setConfirming(false)
    void request(sessionId)
  }
  const click = (): void => {
    if (confirming) trigger()
    else arm()
  }

  return (
    <>
      <button
        type="button"
        className={confirming ? `${css.sessionLogButton} ${css.sessionLogConfirming}` : css.sessionLogButton}
        disabled={busy}
        aria-busy={busy}
        aria-label={confirming ? t('button.confirmDownload') : t('button.desktop')}
        title={confirming ? t('button.confirmDownload') : t('button.desktop')}
        onClick={click}
      >
        <span>{confirming ? t('button.confirmDownload') : t('button.desktop')}</span>
        <IconDownloadOutline16 size={14} />
      </button>
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
