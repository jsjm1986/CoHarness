/**
 * Public vocabulary of Session-level feedback: the `feedback/record` event
 * payload, the fixed category taxonomy it shares with message feedback, and
 * the `sessionFeedback.record` Remote request and result types. Types only;
 * the runtime category tuple is exported by the package entry, and a browser
 * plugin imports types alone because its bundle may not carry Host values.
 * @module @deepseek-ai/dsh-command-feedback/types
 */

import type { FeedbackCategory, SessionId } from '@deepseek-ai/dsh-session/types'

// `feedback/record` and its payload types are durable Session-log vocabulary
// declared in `@deepseek-ai/dsh-session/types`; re-exported here so Remote
// clients consume one package.
export type { FeedbackCategory, FeedbackRecord } from '@deepseek-ai/dsh-session/types'

/** Record one Session-level remark through the Host Remote. */
export interface SessionFeedbackRecordRequest {
  /** Live Session the remark describes. */
  readonly sessionId: SessionId
  /** Free-text remark; blank text is recorded as absent. */
  readonly text?: string
  /** Category the human filed the remark under. */
  readonly category?: FeedbackCategory
}

/** Stable postcondition of a recorded remark. */
export interface SessionFeedbackRecordValue {
  /** The remark is appended to the Session log; flushing follows the Session's own schedule. */
  readonly recorded: true
}

/** No live Session carries the requested id. */
export interface SessionFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}

/** Result returned by the `sessionFeedback.record` operation. */
export type SessionFeedbackRecordResult =
  | { readonly ok: true; readonly value: SessionFeedbackRecordValue }
  | { readonly ok: false; readonly error: SessionFeedbackSessionNotFound }
