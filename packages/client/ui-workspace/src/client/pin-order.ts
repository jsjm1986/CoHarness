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
  orderByRecency, owningGroupKey, sessionKnownIds, sessionMemberIds, sessionSummaries, type SessionRowState,
  UNGROUPED_KEY,
} from './tree.ts'

/**
 * Qualify browser-local order accounts while retaining Host Workspace identities.
 * @param key - Workspace, loose-session or flat-list account.
 * @param runtimeId - exact personal Runtime when computers are grouped.
 * @returns a per-Runtime viewing key for browser-local accounts.
 */
export function runtimeAccountKey(key: string, runtimeId?: string): string {
  return runtimeId === undefined || key !== UNGROUPED_KEY && key !== FLAT_SESSION_ORDER_KEY
    ? key : `runtime:${runtimeId}:${key}`
}

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
 * @param runtimeId - personal Runtime for browser-local order accounts.
 * @returns the order source for one pin write.
 */
export function pinOrderSource(
  workspaces: readonly WorkspaceView[],
  list: SessionListState,
  rowState: PinOrderSource['rowState'],
  runtimeId?: string,
): PinOrderSource {
  if (runtimeId !== undefined) {
    const belongs = (rows: SessionListState['byId']) => Object.fromEntries(Object.entries(rows)
      .filter(([, row]) => row.runtime?.runtimeId === runtimeId)) as SessionListState['byId']
    const byId = belongs(list.byId)
    list = { ...list, byId, ids: list.ids.filter(id => byId[id] !== undefined), archivedById: belongs(list.archivedById) }
  }
  const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
  const summaries = sessionSummaries(list)
  return {
    members: Object.fromEntries([
      ...workspaces.map(workspace => [workspace.workspaceId, workspace.sessionIds] as const),
      [runtimeAccountKey(UNGROUPED_KEY, runtimeId), sessionKnownIds(list).filter(id => summaries[id] !== undefined && !accounted.has(id))],
      [runtimeAccountKey(FLAT_SESSION_ORDER_KEY, runtimeId), orderByRecency(sessionMemberIds(list), summaries)],
    ]),
    summaries,
    rowState,
  }
}

/**
 * The accounts a pinned Session leads: its group (or Ungrouped) and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param sessionId - the Session being pinned.
 * @param runtimeId - personal Runtime for browser-local order accounts.
 * @returns the account keys `pinSessionOrder` fronts.
 */
export function pinOrderAccounts(workspaces: readonly WorkspaceView[], sessionId: SessionId, runtimeId?: string): readonly string[] {
  return [owningGroupKey(workspaces, sessionId), FLAT_SESSION_ORDER_KEY].map(key => runtimeAccountKey(key, runtimeId))
}
