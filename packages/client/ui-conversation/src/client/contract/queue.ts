/** Queue contracts derived from the runtime session face and snapshot. */
import type {
  ConversationSnapshot, ObservableSnapshot, SessionFace,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One address accepted by the runtime session's queue mutation verb. */
export type QueueItemId = Parameters<SessionFace['updateQueue']>[0]

/** One mutation accepted by the runtime session's queue mutation verb. */
export type QueueAction = Parameters<SessionFace['updateQueue']>[1]

/** One row projected by the runtime session's authoritative queue snapshot. */
export type QueueRow = ConversationSnapshot['queue'][number]

/**
 * Project a session's authoritative inbox rows as a read-only observable.
 * @param session - resident session face.
 * @returns queue read face with reference-stable snapshots.
 */
export function queueReadFaceOf(session: SessionFace): ObservableSnapshot<readonly QueueRow[]> {
  return {
    getSnapshot: () => session.getSnapshot().queue,
    subscribe: listener => session.subscribe(listener),
  }
}
