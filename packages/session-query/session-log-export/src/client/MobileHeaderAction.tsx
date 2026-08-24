import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import { SessionLogDownloadDialog } from './Dialog.tsx'
import { NS } from './locales.ts'
import css from './HeaderAction.module.css'

/** Mobile AppFrame topbar action props. */
export type SessionLogDownloadMobileHeaderActionProps =
  PropsRuntime<'shell.mobile.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Render the compact icon-only Session export action and its shared dialog.
 * @param props - Session runtime, download controller, and localized copy.
 * @returns the topbar action and Session-scoped dialog.
 */
export function SessionLogDownloadMobileHeaderAction(
  props: SessionLogDownloadMobileHeaderActionProps,
): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'

  return (
    <>
      <button
        type="button"
        className={css.mobileSessionLogButton}
        disabled={busy}
        aria-busy={busy}
        aria-label={t('button.mobile')}
        title={t('button.mobile')}
        onClick={() => { void request(sessionId) }}
      >
        <span className={css.mobileLabel}>{t('button.mobile')}</span>
        <IconDownloadOutline16 size={16} aria-hidden="true" />
      </button>
      <SessionLogDownloadDialog {...(props)} />
    </>
  )
}
