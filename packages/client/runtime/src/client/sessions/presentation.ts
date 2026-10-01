/** Browser identity on a Session face, with all operations held by the original runtime. */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFace } from '../contract/session.ts'

/** Bind a browser key without modifying history, projections, or wire arguments.
 * @param session - runtime-owned Session.
 * @param sessionId - runtime-qualified browser identity.
 * @param key - map a same-runtime address carried by the subagent view.
 * @returns face whose methods stay bound to the original Session.
 */
export function sessionPresentation(session: SessionFace, sessionId: SessionId, key: (id: SessionId) => SessionId): SessionFace {
  let original: ReturnType<SessionFace['getSnapshot']> | undefined
  let projected: ReturnType<SessionFace['getSnapshot']> | undefined
  return {
    sessionId,
    projections: session.projections,
    getSnapshot: () => {
      const next = session.getSnapshot()
      if (next !== original) {
        original = next
        projected = next.subagent === null ? { ...next, sessionId } : { ...next, sessionId, subagent: {
          ...next.subagent, address: { ...next.subagent.address,
            parentSessionId: key(next.subagent.address.parentSessionId), childSessionId: key(next.subagent.address.childSessionId),
          },
        } }
      }
      return projected ?? next
    },
    subscribe: listener => session.subscribe(listener),
    ...(session.beginSubmission === undefined ? {} : { beginSubmission: session.beginSubmission.bind(session) }),
    readCallHistory: session.readCallHistory.bind(session),
    prompt: session.prompt.bind(session),
    readAttachment: session.readAttachment.bind(session),
    updateQueue: session.updateQueue.bind(session),
    cancel: session.cancel.bind(session),
    rename: session.rename.bind(session),
    loadOlder: session.loadOlder.bind(session),
    ...(session.loadHistoryUntil === undefined ? {} : { loadHistoryUntil: session.loadHistoryUntil.bind(session) }),
    ensureHistoryDetail: session.ensureHistoryDetail.bind(session),
    command: session.command.bind(session),
  }
}
