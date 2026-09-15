/**
 * Durable Tool event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-tools/types
 */

import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Payload recorded when one nested PTC Tool dispatch starts. */
export interface PtcDispatchStartEventData {
  rootCallId: CallId
  parentCallId: CallId
  subCallId: CallId
  name: string
  arguments: unknown
}

/** Payload recorded when one nested PTC Tool dispatch settles. */
export interface PtcDispatchEventData extends PtcDispatchStartEventData {
  isError: boolean
  content: ContentBlock[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One sub-dispatch STARTING inside a `run_code` program: the parent
     * `run_code` call id, the deterministic sub-call id (`<parent>:ptc:<n>`,
     * numbered in submission order), and the tool `name` with its
     * JSON-normalized `arguments` — the exact value dispatched, normalized
     * BEFORE dispatch, so this append can never fail on payload shape.
     * Appended when the scheduler actually starts the call (not at
     * submission), so a start means the tool body pipeline was entered; a
     * call abandoned in the queue logs nothing. Log-only: `deriveMessages()`
     * ignores it; UIs use it for live per-sub-call running state and pair it
     * with `tool/ptc-dispatch` by `subCallId` (timing = the two events'
     * `time` fields).
     */
    'tool/ptc-dispatch-start': PtcDispatchStartEventData
    /**
     * One bridged sub-dispatch SETTLING: the pairing ids (matching the
     * `tool/ptc-dispatch-start` with the same `subCallId`), the tool `name`
     * with the same JSON-normalized `arguments`, and the sub-call's complete
     * model-facing outcome in `tool/result`'s own vocabulary
     * (`content` + `isError`), so UIs render a sub-call through the exact
     * code path that renders a native call. Every started sub-call settles
     * with exactly one of these (abort included: the aborted pipeline result
     * is an `isError` outcome).
     * Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter
     * model context; persistence and UIs get every call. Appended inside the
     * parent `run_code`'s execution (the bridge drains in-flight dispatches
     * before returning), so its execution-enclosure relation holds by
     * construction.
     */
    'tool/ptc-dispatch': PtcDispatchEventData
    /**
     * The pre-rename spelling of `tool/ptc-dispatch-start`, recorded by builds
     * before the PTC rename. Persistence accepts it on read and normalizes
     * the type to `tool/ptc-dispatch-start` before projection, so released
     * logs keep one downstream vocabulary.
     * @deprecated Write `tool/ptc-dispatch-start`.
     */
    'tool/code-dispatch-start': PtcDispatchStartEventData
    /**
     * The pre-rename spelling of `tool/ptc-dispatch`, recorded by builds
     * before the PTC rename. Persistence accepts it on read and normalizes
     * the type to `tool/ptc-dispatch` before projection, so released logs
     * keep one downstream vocabulary.
     * @deprecated Write `tool/ptc-dispatch`.
     */
    'tool/code-dispatch': PtcDispatchEventData
  }
}
