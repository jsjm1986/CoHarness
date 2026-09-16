/** Session-persistence helpers shared by the subagent test suites. */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Read one stored session's header and complete committed event log. */
export async function loadStoredSession(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ meta: SessionHeader; inheritedEventCount: SessionLogOffset; events: readonly SessionEvent[] }> {
  const loaded = await persistence.load(id)
  return {
    meta: loaded.meta,
    inheritedEventCount: loaded.inheritedEventCount,
    events: loaded.events,
  }
}
