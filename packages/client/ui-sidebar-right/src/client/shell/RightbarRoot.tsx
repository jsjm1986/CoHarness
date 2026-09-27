/** Root-scoped controller for the right Sidebar's Session content. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Render the Session-bound Sidebar only while the Conversation is selected.
 * @param props - frame geometry, panel selection, and the authorized Session renderer.
 * @returns the current Session's right Sidebar, or no content for a global panel.
 */
export function RightbarRoot({
  SessionProvider, renderSlot, width, viewportWidth, canShow, targetSessionId,
}: PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'>) {
  return (
    <SessionProvider {...(targetSessionId === undefined ? {} : { sessionId: targetSessionId })}>
      {() => renderSlot('rightbar.session', { width, viewportWidth, canShow })}
    </SessionProvider>
  )
}
