/** Foreground Session selection shared by automatic Sidebar seats. */
import type { ConversationViewportSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Check whether the current Session has the workbench's verified foreground identity.
 * @param viewport - current conversation layout and restored identity state.
 * @param current - Session selected by the Session model.
 * @returns whether a Sidebar seat may follow the current Session.
 */
export function followsCurrentSession(viewport: ConversationViewportSnapshot, current: SessionId | undefined): boolean {
  return viewport.mode !== 'workbench'
    || (viewport.pendingIdentity !== true && viewport.activePaneId === current)
}
