/**
 * Browser-safe subagent domain contract. Persisted transcript reads never
 * activate an Agent; catalog, prompt, and interrupt delivery ride the
 * generated `subagents` Remote surface.
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { HistoryDetail, HistoryEntry, HistoryOmittedSpan, SessionProjectionsBlock } from './sessions.ts'

/** Subagent-domain unary methods. */
export interface SubagentsApi {
  /**
   * Reads one healthy catalog child's transcript — the in-memory snapshot of
   * a live child, the persisted log of a cold one — with ordinary
   * message-aligned pagination and render intents, without Agent activation.
   * `detail` is the same download gear as `session.history`: omitted or
   * `'full'` keeps every event; `'conversation'` omits completed historical
   * chunk runs and reports `omittedSpans`. `toolCallId` uses the same independent
   * complete-turn lookup as session.history, preserving parent and child access checks.
   */
  history(
    request: RpcRequest<SubagentAddress & {
      toolCallId?: ToolCallId
      beforeSeq?: number
      maxMessages?: number
      detail?: HistoryDetail
    }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{
    events: HistoryEntry[]
    hasMore: boolean
    projections?: SessionProjectionsBlock
    omittedSpans?: readonly HistoryOmittedSpan[]
  }>>
}
