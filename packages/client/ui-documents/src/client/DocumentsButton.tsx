import { useCallback } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { IconBrowseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserDocRef, UserDocScope } from './documents-client.ts'
import { NS } from './locales.ts'
import css from './DocumentsButton.module.css'

/** Business callback supplied by the host composition for existing documents. */
export interface DocumentsButtonInjected {
  hooks: { deployment: HostObservable<import('@deepseek-ai/dsh-client-runtime/client').DeploymentContextSnapshot> }
  /** Runtime owning documents attached to one captured conversation. */
  documentScopeFor?: ((sessionId: SessionId) => UserDocScope | undefined) | undefined
  /** Bind private resource navigation to the verified account. */
  privateResourceUrl?: ((url: string) => string) | undefined
  /** Add a durable document to the current conversation composer. */
  attachDocument?: ((document: UserDocRef, sessionId?: SessionId) => boolean) | undefined
  /** Recheck the captured composer's live admission state before any transfer. */
  canAttachDocument?: ((sessionId: SessionId) => boolean) | undefined
}

export type DocumentsButtonProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & InjectFace<DocumentsButtonInjected>

/**
 * Render the sidebar Documents trigger.
 * @param props.t - localized documents dictionary.
 * @param props.wide - when true, the expanded sidebar shows the Documents label beside the icon.
 * @returns the footer trigger that opens the overlay-hosted document manager.
 */
export function DocumentsButton({ t, wide, useSessions }: DocumentsButtonProps) {
  const currentSessionId = useSessions(snapshot => snapshot.current)
  const handleOpen = useCallback(() => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('dsh-documents-open-picker', {
      detail: { mode: 'manage', sessionId: currentSessionId },
    }))
  }, [currentSessionId])

  return (
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
  )
}
