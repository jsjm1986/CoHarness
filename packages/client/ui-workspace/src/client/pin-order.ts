/**
 * The complete account memberships a Pin order write reconciles against,
 * derived from the same Host snapshots the browser orders by, so the
 * inject-face pin callback can complete the write without the browser in
 * the loop.
 */
import type {
  SessionId, SessionListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { FLAT_SESSION_ORDER_KEY } from './stores.ts'
import {
  orderByRecency, owningGroupKey, sessionMemberIds, type SessionRowState, UNGROUPED_KEY,
} from './tree.ts'

/** What `pinSessionOrder` reconciles a pinned Session's accounts against. */
export interface PinOrderSource {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Every account's complete membership in its natural order: each Workspace in
 * Host member order, Ungrouped in catalog order, and the flat list in recency
 * order — the same baselines the browser reconciles against, so a pin write
 * lands on the same ordering an unsaved account would show.
 * @param workspaces - current Host Workspaces.
 * @param list - current Session list snapshot.
 * @param rowState - registry-global pin and archive sets.
 * @returns the order source for one pin write.
 */
export function pinOrderSource(
  workspaces: readonly WorkspaceView[],
  list: SessionListState,
  rowState: PinOrderSource['rowState'],
): PinOrderSource {
  const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
  return {
    members: Object.fromEntries([
      ...workspaces.map(workspace => [workspace.workspaceId, workspace.sessionIds] as const),
      [UNGROUPED_KEY, list.ids.filter(id => list.byId[id] !== undefined && !accounted.has(id))],
      [FLAT_SESSION_ORDER_KEY, orderByRecency(sessionMemberIds(list), list.byId)],
    ]),
    summaries: list.byId,
    rowState,
  }
}

/**
 * The accounts a pinned Session leads: its group (or Ungrouped) and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param sessionId - the Session being pinned.
 * @returns the account keys `pinSessionOrder` fronts.
 */
export function pinOrderAccounts(workspaces: readonly WorkspaceView[], sessionId: SessionId): readonly string[] {
  return [owningGroupKey(workspaces, sessionId), FLAT_SESSION_ORDER_KEY]
}
