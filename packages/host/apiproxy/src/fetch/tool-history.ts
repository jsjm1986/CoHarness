/** Exact Tool-call lookup over one immutable Session observation. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-tools/types'

/** Select the whole turn owning a root or nested Tool call.
 * @param events - one contiguous immutable Session cut.
 * @param callId - durable root or nested call identity.
 * @returns the enclosing turn, or an empty array when the call is absent.
 */
export function toolHistoryTurn(events: readonly SessionEvent[], callId: ToolCallId): readonly SessionEvent[] {
  const target = events.findIndex(event => event.type === 'tool/call'
    ? event.data.callId === callId
    : (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
      && event.data.subCallId === callId)
  if (target < 0) return []
  let start = target
  while (start > 0 && events[start]?.type !== 'turn/start') start--
  let end = target + 1
  while (end < events.length && events[end]?.type !== 'turn/start') end++
  return events.slice(start, end)
}
