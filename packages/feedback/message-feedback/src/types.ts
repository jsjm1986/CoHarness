/**
 * Public request, value, and failure vocabulary for per-message feedback.
 * This module contains types only so generated Remote clients can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-message-feedback/types
 */

import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { FeedbackCategory, MessageFeedbackItem, MessageFeedbackRating, MessageFeedbackVersion, SessionId } from '@deepseek-ai/dsh-session/types'

// The `feedback/message-put`/`feedback/message-delete` events and the item
// vocabulary are durable Session-log types declared in
// `@deepseek-ai/dsh-session/types`; re-exported here so Remote clients consume
// one package.
export type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageFeedbackVersion,
} from '@deepseek-ai/dsh-session/types'

/** A material creation or edit, retaining its complete current value. */
export interface MessageFeedbackPut {
  /** Owning Session; inherited feedback in a fork belongs to its parent. */
  readonly sessionId: SessionId
  /** Value after this mutation, including the original creation time. */
  readonly item: MessageFeedbackItem
}

/** A material deletion of one current feedback item. */
export interface MessageFeedbackDelete {
  /** Session that owns the deleted feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback was removed. */
  readonly messageId: MessageId
  /** Version of the removed item. */
  readonly version: string
}

/** Read all message feedback belonging to one persisted Session lifecycle. */
export interface MessageFeedbackListRequest {
  /** Session whose feedback events should be read. */
  readonly sessionId: SessionId
}

/** Current feedback values for one Session, in first-creation order. */
export interface MessageFeedbackListValue {
  /** Fresh immutable item snapshots. */
  readonly items: readonly MessageFeedbackItem[]
}

/** Create or replace feedback for one assistant message. */
export interface MessageFeedbackPutRequest {
  /** Persisted Session that owns the target message. */
  readonly sessionId: SessionId
  /** Target assistant-message identity. */
  readonly messageId: MessageId
  /** Desired overall judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional non-blank explanation. */
  readonly note?: string
  /** Optional category; absent keeps the item uncategorized. */
  readonly category?: FeedbackCategory
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}

/** Delete feedback for one message after observing its current version. */
export interface MessageFeedbackDeleteRequest {
  /** Session that owns the feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback should be absent after this operation. */
  readonly messageId: MessageId
  /** Observed item version; ignored when the item is already absent. */
  readonly ifVersion: MessageFeedbackVersion
}

/** Idempotent deletion acknowledgement. */
export interface MessageFeedbackDeleteValue {
  /** Stable postcondition shared by the first deletion and every retry. */
  readonly absent: true
}

/** No persisted Session header exists for the requested id. */
export interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}

/** The id does not name a derived, append-origin assistant message. */
export interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}

/** A material mutation did not match the addressed item's current version. */
export interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** Authoritative current item, or `null` when it does not exist. */
  readonly current: MessageFeedbackItem | null
}

/** A supplied note contains no non-whitespace character. */
export interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}

/** A supplied note exceeds the configured UTF-8 byte limit. */
export interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}

/** Failures shared by the public message-feedback operations. */
export type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge

/** Successful public operation result. */
export interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Rejected public operation result with a stable business failure. */
export interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}

/** Result returned by the message-feedback `list` operation. */
export type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>

/** Result returned by the message-feedback `put` operation. */
export type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >

/** Result returned by the message-feedback `delete` operation. */
export type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>
