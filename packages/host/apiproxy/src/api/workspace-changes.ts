/** Authorized historical workspace comparisons; no snapshot storage paths cross the wire. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Public per-turn summary, excluding internal cwd and Git object identifiers. */
export type WorkspaceReviewSummary = Pick<WorkspaceChangesSummary, 'turn' | 'files' | 'total' | 'added' | 'deleted'>

/** Read historical snapshots without starting an Agent or reading current file contents. */
export interface WorkspaceChangesApi {
  /** Read the summary announced by a Session event.
   * @param request - exact Session and workspace/changes event sequence.
   * @param signal - caller cancellation.
   * @returns summary, or null when its recorder is no longer available.
   */
  summary(request: RpcRequest<{ sessionId: SessionId; seq: number }>,
    signal?: AbortSignal): Promise<RpcResponse<WorkspaceReviewSummary | null>>
  /** Compare one file from the announced summary.
   * @param request - exact Session, announcement sequence, and original file index.
   * @param signal - caller cancellation.
   * @returns historical comparison, or null when its snapshot is unavailable.
   */
  diff(request: RpcRequest<{ sessionId: SessionId; seq: number; index: number }>,
    signal?: AbortSignal): Promise<RpcResponse<WorkspaceFileDiff | null>>
}
