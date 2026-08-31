/** Bounded, revision-aware reads over a durable session event log. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from './revision.ts'

/** Provider-neutral direction for a bounded session page. */
export type SessionPersistencePageDirection = 'older' | 'newer'

/** Opaque continuation token for one bounded session page. */
export type SessionPersistenceReadCursor = Branded<'SessionPersistenceReadCursor'>
const MAX_SESSION_PERSISTENCE_CURSOR_LENGTH = 16 * 1024

/**
 * Brand one provider-owned opaque page cursor after it has been validated by its owner.
 * @param value - opaque cursor text.
 * @returns the branded cursor.
 */
export function SessionPersistenceReadCursor(value: string): SessionPersistenceReadCursor {
  if (typeof value !== 'string' || value === '' || value.length > MAX_SESSION_PERSISTENCE_CURSOR_LENGTH) {
    throw new TypeError(`session persistence page cursor must be a non-empty string no longer than ${String(MAX_SESSION_PERSISTENCE_CURSOR_LENGTH)} characters`)
  }
  return value as SessionPersistenceReadCursor
}

/** Request for a bounded, non-mutating event-log page. */
export interface SessionPersistencePageRequest {
  /** Opaque cursor returned by a previous page call. */
  readonly cursor?: SessionPersistenceReadCursor
  /** Exclusive upper seq for an older page. */
  readonly beforeSeq?: number
  /** Inclusive lower seq for a newer page. */
  readonly fromSeq?: number
  /** Page direction; omitted values are inferred from beforeSeq/fromSeq. */
  readonly direction?: SessionPersistencePageDirection
  /** Maximum uncompressed event JSON bytes returned by the page. */
  readonly maxBytes?: number
  /** Maximum number of logical events returned by the page. */
  readonly maxEvents?: number
  /** Maximum message groups used as a page hint by seek-capable providers. */
  readonly maxGroups?: number
}

/** One bounded page of the immutable logical event stream. */
export interface SessionPersistencePage {
  /** Immutable session metadata observed with this page. */
  readonly meta: SessionHeader
  /** Source-qualified revision for the page and its continuation cursor. */
  readonly revision: SessionPersistenceRevision
  /** Events in ascending sequence order. */
  readonly events: SessionEvent[]
  /** First returned sequence, or null for an empty page. */
  readonly startSeq: number | null
  /** Last returned sequence, or null for an empty page. */
  readonly endSeq: number | null
  /** Whether another page exists in the requested direction. */
  readonly hasMore: boolean
  /** Revision-bound continuation cursor when {@link hasMore} is true. */
  readonly nextCursor?: SessionPersistenceReadCursor
  /** Sum of the uncompressed serialized event bytes in this page. */
  readonly uncompressedBytes: number
}

/** Stable error categories for bounded persistence observations. */
export type SessionPersistenceReadErrorCode =
  | 'too-large'
  | 'aborted'
  | 'timeout'
  | 'dependency'
  | 'protocol'

/** Error raised when a bounded persistence observation cannot be completed. */
export class SessionPersistenceReadError extends Error {
  /**
   * @param code - stable operational category.
   * @param message - safe diagnostic text without event content.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: SessionPersistenceReadErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options)
    this.name = 'SessionPersistenceReadError'
  }
}

/** Raised when one indivisible event cannot fit inside a requested page budget. */
export class SessionPersistencePageTooLargeError extends SessionPersistenceReadError {
  /**
   * @param bytes - serialized bytes of the indivisible event.
   * @param limit - requested page byte limit.
   */
  constructor(readonly bytes: number, readonly limit: number) {
    super('too-large', `session persistence page event is ${String(bytes)} bytes, exceeding the ${String(limit)}-byte limit`)
    this.name = 'SessionPersistencePageTooLargeError'
  }
}

/** Internal cursor payload shared by the default coordinator page fallback. */
export interface SessionPersistenceCursorPayload {
  readonly version: 1
  readonly sessionId: string
  readonly revision: string
  readonly direction: SessionPersistencePageDirection
  /** Exclusive older boundary or inclusive newer boundary. */
  readonly anchor: number
}

/**
 * Encode a canonical revision-bound cursor.
 * @param payload - session, revision, direction, and sequence anchor.
 * @returns the opaque cursor accepted by the page request type.
 */
export function encodeSessionPersistenceCursor(payload: SessionPersistenceCursorPayload): SessionPersistenceReadCursor {
  if (payload.sessionId === '' || payload.revision === ''
    || !Number.isSafeInteger(payload.anchor) || payload.anchor < 0) {
    throw new SessionPersistenceReadError('protocol', 'session persistence page cursor fields are invalid')
  }
  return SessionPersistenceReadCursor(Buffer.from(JSON.stringify([
    payload.version,
    payload.sessionId,
    payload.revision,
    payload.direction,
    payload.anchor,
  ]), 'utf8').toString('base64url'))
}

/**
 * Decode and validate a canonical revision-bound cursor.
 * @param cursor - opaque cursor returned by a previous page.
 * @returns the validated cursor fields.
 */
export function decodeSessionPersistenceCursor(
  cursor: SessionPersistenceReadCursor,
): SessionPersistenceCursorPayload {
  try {
    if (typeof cursor !== 'string' || cursor === '' || cursor.length > MAX_SESSION_PERSISTENCE_CURSOR_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('invalid cursor encoding')
    }
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!isCursorTuple(decoded)) {
      throw new Error('invalid cursor fields')
    }
    const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    if (canonical !== cursor) throw new Error('non-canonical cursor')
    const [, sessionId, revision, direction, anchor] = decoded
    return { version: 1, sessionId, revision, direction, anchor }
  } catch (error: unknown) {
    throw new SessionPersistenceReadError('protocol', 'session persistence page cursor is invalid', { cause: error })
  }
}

function isCursorTuple(
  value: unknown,
): value is readonly [1, string, string, SessionPersistencePageDirection, number] {
  return Array.isArray(value) && value.length === 5
    && value[0] === 1
    && typeof value[1] === 'string' && value[1] !== ''
    && typeof value[2] === 'string' && value[2] !== ''
    && (value[3] === 'older' || value[3] === 'newer')
    && typeof value[4] === 'number' && Number.isSafeInteger(value[4]) && value[4] >= 0
}

/**
 * Resolve and validate one page request's defaults.
 * @param request - caller page request.
 * @param defaults - provider page limits.
 * @returns validated request fields with resolved limits and direction.
 */
export function normalizeSessionPersistencePageRequest(
  request: SessionPersistencePageRequest,
  defaults: {
    readonly maxBytes: number
    readonly maxEvents: number
    readonly maxGroups: number
  },
): Required<Pick<SessionPersistencePageRequest, 'direction' | 'maxBytes' | 'maxEvents' | 'maxGroups'>>
  & Pick<SessionPersistencePageRequest, 'cursor' | 'beforeSeq' | 'fromSeq'> {
  const cursorDirection = request.cursor === undefined
    ? undefined
    : decodeSessionPersistenceCursor(request.cursor).direction
  const directionValue: unknown = request.direction
    ?? cursorDirection
    ?? (request.beforeSeq !== undefined ? 'older' : request.fromSeq !== undefined ? 'newer' : 'older')
  if (directionValue !== 'older' && directionValue !== 'newer') {
    throw new SessionPersistenceReadError('protocol', 'session persistence page direction is invalid')
  }
  const direction = directionValue
  if (cursorDirection !== undefined && cursorDirection !== direction) {
    throw new SessionPersistenceReadError('protocol', 'session persistence page direction does not match its cursor')
  }
  if (request.cursor !== undefined && (request.beforeSeq !== undefined || request.fromSeq !== undefined)) {
    throw new SessionPersistenceReadError('protocol', 'session persistence page cursor cannot be combined with a sequence anchor')
  }
  if (direction === 'older' && request.fromSeq !== undefined) {
    throw new SessionPersistenceReadError('protocol', 'older session persistence pages cannot use fromSeq')
  }
  if (direction === 'newer' && request.beforeSeq !== undefined) {
    throw new SessionPersistenceReadError('protocol', 'newer session persistence pages cannot use beforeSeq')
  }
  for (const [name, value, fallback] of [
    ['maxBytes', request.maxBytes, defaults.maxBytes],
    ['maxEvents', request.maxEvents, defaults.maxEvents],
    ['maxGroups', request.maxGroups, defaults.maxGroups],
  ] as const) {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback) {
      throw new SessionPersistenceReadError(
        'protocol',
        `session persistence page ${name} must be a positive safe integer no greater than ${String(fallback)}`,
      )
    }
  }
  for (const [name, value] of [['beforeSeq', request.beforeSeq], ['fromSeq', request.fromSeq]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new SessionPersistenceReadError('protocol', `session persistence page ${name} must be a non-negative safe integer`)
    }
  }
  return {
    ...request,
    direction,
    maxBytes: request.maxBytes ?? defaults.maxBytes,
    maxEvents: request.maxEvents ?? defaults.maxEvents,
    maxGroups: request.maxGroups ?? defaults.maxGroups,
  }
}

/**
 * Resolve the session id used by a cursor without widening the public cursor API.
 * @param cursor - revision-bound page cursor.
 * @returns the session id encoded by the cursor.
 */
export function cursorSessionId(cursor: SessionPersistenceReadCursor): SessionId {
  return cursorSessionIdValue(decodeSessionPersistenceCursor(cursor).sessionId)
}

function cursorSessionIdValue(value: string): SessionId {
  return value as SessionId
}

/** Internal selected-page result used by the default coordinator fallback. */
export interface SelectedSessionPersistencePage {
  readonly events: SessionEvent[]
  readonly bytes: number
  readonly hasMore: boolean
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Return the logical page group for one event. Stream chunks do not carry
 * `sourceEventSeqs`, so grouping every chunk by its own sequence silently
 * reduced a page to a few dozen tokens. Turn/step coordinates keep all
 * chunks from one model step in one group while call ids keep tool lifecycles
 * independent.
 */
function eventGroupKey(event: SessionEvent): string {
  const candidate = event as SessionEvent & { sourceEventSeqs?: readonly number[] }
  const sources = candidate.sourceEventSeqs
  if (sources !== undefined && sources.length > 0) {
    let start = event.seq
    for (const seq of sources) if (seq < start) start = seq
    return `source:${String(start)}`
  }
  const data = event.data as { turn?: unknown; step?: unknown; callId?: unknown }
  const turn = eventNumber(data.turn)
  const step = eventNumber(data.step)
  if (event.type === 'user/message') return `message:${String(event.seq)}`
  if ((event.type === 'tool/call' || event.type === 'tool/result')
    && turn !== undefined && step !== undefined && typeof data.callId === 'string' && data.callId !== '') {
    return `call:${String(turn)}:${String(step)}:${data.callId}`
  }
  if (turn !== undefined && step !== undefined) return `step:${String(turn)}:${String(step)}`
  if (turn !== undefined) return `turn:${String(turn)}`
  if (event.type === 'assistant/message' || event.type === 'tool/result') return `message:${String(event.seq)}`
  return `event:${String(event.seq)}`
}

function eventBytes(event: SessionEvent): number {
  let encoded: unknown
  try {
    encoded = JSON.stringify(event)
  } catch (error: unknown) {
    throw new SessionPersistenceReadError(
      'protocol',
      'session persistence event is not JSON serializable',
      { cause: error },
    )
  }
  if (typeof encoded !== 'string') {
    throw new SessionPersistenceReadError('protocol', 'session persistence event is not JSON serializable')
  }
  return Buffer.byteLength(encoded, 'utf8')
}

/**
 * Select one bounded page from an already ordered event window. Older pages
 * are selected from the tail and returned in ascending sequence order.
 * @param window - contiguous event window in ascending sequence order.
 * @param direction - page traversal direction.
 * @param maxBytes - uncompressed event byte limit.
 * @param maxEvents - event count limit.
 * @param maxGroups - message-group hint.
 * @returns selected events, their bytes, and whether the window has a remainder.
 */
export function selectSessionPersistencePage(
  window: readonly SessionEvent[],
  direction: 'older' | 'newer',
  maxBytes: number,
  maxEvents: number,
  maxGroups: number,
): SelectedSessionPersistencePage {
  const indexes: number[] = []
  const groups = new Set<string>()
  let bytes = 0
  let cursor = direction === 'older' ? window.length - 1 : 0
  const step = direction === 'older' ? -1 : 1
  while (cursor >= 0 && cursor < window.length) {
    const event = window[cursor]
    /* v8 ignore next -- a cursor inside the validated window always resolves to an event. */
    if (event === undefined) break
    const size = eventBytes(event)
    if (size > maxBytes && indexes.length === 0) {
      throw new SessionPersistencePageTooLargeError(size, maxBytes)
    }
    const group = eventGroupKey(event)
    const addsGroup = !groups.has(group)
    if (indexes.length >= maxEvents || bytes + size > maxBytes || (addsGroup && groups.size >= maxGroups)) break
    indexes.push(cursor)
    groups.add(group)
    bytes += size
    cursor += step
  }
  indexes.sort((left, right) => left - right)
  return {
    events: indexes.flatMap((index) => {
      const event = window[index]
      /* v8 ignore next -- indexes are collected only from valid window positions. */
      return event === undefined ? [] : [event]
    }),
    bytes,
    hasMore: indexes.length < window.length,
  }
}
