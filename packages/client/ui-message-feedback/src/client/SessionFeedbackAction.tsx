import type { ReactNode } from 'react'
import { IconLikeOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'

/** Session-header feedback entry: open the Session feedback draft without recording. */
export interface SessionFeedbackActionInjected {
  /** Open the existing Session feedback form without recording feedback. */
  openFeedback: () => void
}

/** Full props for the Session-header feedback button. */
export type SessionFeedbackActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'feedback'>
  & InjectFace<SessionFeedbackActionInjected>

/**
 * Render the Session Header feedback entry.
 * @param props - Session runtime, injected opener, and localized copy.
 * @returns the header icon button, or null inside the compact header.
 */
export function SessionFeedbackAction(props: SessionFeedbackActionProps): ReactNode {
  const { compact, t } = props
  if (compact === true) return null
  return (
    <Tooltip label={t('header.feedback')} side="bottom">
      <button type="button" aria-label={t('header.feedback')} onClick={() => { props.openFeedback() }}>
        <IconLikeOutline16 />
      </button>
    </Tooltip>
  )
}
