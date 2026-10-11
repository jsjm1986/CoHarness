/** Fixed V6 event vocabulary and namespaced historical opaque events. */

import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'

// This historical list must not inherit additions or removals from the current Session event list.
/* jscpd:ignore-start */
/** First-party event names understood by the released V6 reader, independent of the installed writer. */
export const RELEASED_V6_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'gateway/execution',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'userdoc/attached',
  'web/deepseek-search-llm-request',
  'workspace/changes',
])
/* jscpd:ignore-end */

/**
 * Event types genuine V6 writers could emit. `gateway/continuation` and
 * `gateway/scoped-execution` joined `SessionEventMap` during the V6 era;
 * event-map additions are not structural, so writers kept appending them to
 * V6 logs after the released vocabulary above froze. `developer/message` is
 * V7-native and stays foreign to V6 sources.
 */
export const ADMITTED_V6_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...RELEASED_V6_EVENT_TYPES,
  'gateway/continuation',
  'gateway/scoped-execution',
])

/**
 * Keep unknown ignorable events opaque after header promotion.
 * @param event - original V6 event; this incoming identity conversion is applied once.
 * @returns the same event or an ignorable namespaced event retaining its payload and coordinates.
 */
export function namespaceV6OpaqueEvent(event: SessionFormatEvent): SessionFormatEvent {
  return event['ignorable'] === true && !ADMITTED_V6_EVENT_TYPES.has(event.type)
    ? { ...event, type: `plugin:${event.type}`, ignorable: true }
    : event
}
