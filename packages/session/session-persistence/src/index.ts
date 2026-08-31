/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { hasConversationContent, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionDraftId, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from './revision.ts'

export {
  SessionPersistencePageTooLargeError,
  SessionPersistenceReadError,
  SessionPersistenceReadCursor,
  decodeSessionPersistenceCursor,
  encodeSessionPersistenceCursor,
  cursorSessionId,
  normalizeSessionPersistencePageRequest,
  selectSessionPersistencePage,
} from './page.ts'
export type {
  SessionPersistenceCursorPayload,
  SessionPersistencePage,
  SessionPersistencePageDirection,
  SessionPersistencePageRequest,
  SessionPersistenceReadErrorCode,
  SelectedSessionPersistencePage,
} from './page.ts'
import {
  SessionPersistenceReadError,
  decodeSessionPersistenceCursor,
  encodeSessionPersistenceCursor,
  normalizeSessionPersistencePageRequest,
  selectSessionPersistencePage,
} from './page.ts'
import type {
  SessionPersistencePage,
  SessionPersistencePageRequest,
} from './page.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'

/** Durable content facts returned by a backend that can answer cold listings authoritatively. */
export interface SessionContentMetadata {
  readonly blank: boolean
  readonly visibleContentSeq: number | null
  readonly lastPromptAt: number | null
}

/**
 * Fold authoritative cold-list content facts from one complete event prefix.
 * @param events - contiguous session events in sequence order.
 * @returns blankness, the latest visible-content sequence, and latest human prompt time.
 */
export function sessionContentMetadata(events: readonly SessionEvent[]): SessionContentMetadata {
  let visibleContentSeq: number | null = null
  let lastPromptAt: number | null = null
  for (const event of events) {
    if (hasConversationContent(event)) visibleContentSeq = Math.max(visibleContentSeq ?? -1, event.seq)
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      lastPromptAt = Math.max(lastPromptAt ?? 0, event.time)
    }
  }
  return { blank: visibleContentSeq === null, visibleContentSeq, lastPromptAt }
}

/** Browser draft reservation request; only ids and UI-independent metadata cross the host boundary. */
export interface SessionDraftReservationRequest {
  readonly draftId: SessionDraftId
  readonly sessionId: SessionId
  readonly cwd: string
  readonly visibility?: 'personal' | 'project' | 'private'
  readonly agentPreset?: string
}

/** Canonical identity returned by a draft reservation provider. */
export interface SessionDraftReservation {
  readonly sessionId: SessionId
  readonly leaseExpiresAt: number
}

/** Lightweight immutable source identity returned without loading a full log. */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
  /** Optional backend-authoritative content metadata for cold list projections. */
  content?: SessionContentMetadata
}

/** Immutable logical session prepared from persistence or a live owner. */
export interface SessionInspection {
  /** Validated immutable session metadata. */
  readonly meta: SessionHeader
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}

/** Default maximum uncompressed bytes returned by one persistence page. */
export const DEFAULT_SESSION_PAGE_MAX_BYTES = 512 * 1024
/** Default maximum logical events returned by one persistence page. */
export const DEFAULT_SESSION_PAGE_MAX_EVENTS = 2_000
/** Default message-group hint used by seek-capable persistence providers. */
export const DEFAULT_SESSION_PAGE_MAX_GROUPS = 50

/** A backend's own raw artifact text for one session, verbatim. */
export interface SessionRawArtifact {
  /** The session header parsed from the artifact's own first line. */
  readonly meta: SessionHeader
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}

// The backend-agnostic write-path orchestration first-party backends compose.
export {
  DEFAULT_MAX_PENDING_BYTES_PER_SESSION,
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_MAX_PENDING_EVENTS_PER_SESSION,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  sessionFormatVersionRefusal,
} from './coordinator.ts'
export type {
  PersistenceBackend,
  PersistenceCoordinatorOptions,
  StoredPrefix,
  StoredSuffix,
} from './coordinator.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
export interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}

/**
 * Durable append-only session storage. Implementations preserve contiguous,
 * losslessly JSON-serializable events; {@link append} resolves only after
 * durability, and {@link load} balances a complete interrupted tail without
 * rewriting committed events.
 */
export abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Resolve this backend's independent local artifact for a session without
   * reading, creating, flushing, or otherwise materializing it. Backends such
   * as SQLite that do not own one artifact per session return `undefined`.
   * @param meta - the immutable session header whose artifact is requested.
   * @returns the backend-specific absolute location, when one exists.
   */
  abstract locate(meta: SessionHeader): SessionLocation | undefined

  /**
   * Whether this backend exposes one verbatim raw artifact per session.
   * A backend that declares `true` must override {@link readRaw}.
   */
  abstract readonly supportsRawArtifacts: boolean

  /**
   * Read a session's backend-owned artifact text verbatim — the exact durable
   * bytes the backend wrote (decoded from its physical encoding, e.g. a
   * decompressed JSONL). The returned `content` is the raw text, not a
   * reconstruction from parsed events, so it preserves backend-specific
   * serialization (chunk packing, key order, line breaks). Callers first test
   * {@link supportsRawArtifacts}; `undefined` then means only that the requested
   * session has no materialized artifact.
   * @param _id - the persisted session to read (unused by the default: no
   * per-session artifact).
   * @param signal - optional cancellation for backend read work.
   * @returns the raw artifact plus its parsed header, or `undefined` when the
   * session is absent.
   * @throws when this backend does not expose per-session raw artifacts.
   */
  readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    return Promise.reject(new Error('this session persistence backend does not expose raw artifacts'))
  }

  /**
   * Register a new session's metadata. A backend MAY defer the physical write
   * until the first {@link append} (lazy materialization), in which case a
   * created-but-never-appended session is absent from {@link list}
   * — abandoned sessions leave nothing behind.
   * @param meta - the immutable header (id, version, cwd, lineage) to record.
   */
  abstract create(meta: SessionHeader): Promise<void>

  /**
   * Durably materialize an empty live session without adding a synthetic event.
   * Ordinary creation stays lazy; lifecycle frontends use this when an empty
   * session must appear in durable listing and remain resumable.
   * @param _session - exact live session whose header is to be persisted.
   * @returns after the header-only artifact is durable.
   */
  ensureMaterialized(_session: Session): Promise<void> {
    return Promise.reject(new Error('this session persistence backend cannot materialize an empty session'))
  }

  /**
   * Durably persist a batch of events. Honors the append-only and contiguous-
   * seq contracts: the first event's `seq` MUST equal the stored next-seq
   * (after `load` has durably closed any interrupted turn). Rejects non-JSON-
   * serializable `event.data` with an error naming the offending event type.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order.
   */
  abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

  /**
   * Remove one complete persisted session tree when the deployment exposes a
   * destructive archive lifecycle. Backends that do not support deletion fail
   * explicitly so callers keep a pending purge instead of silently losing the
   * lifecycle acknowledgement.
   * @param _id - root or session id selected for removal.
   * @param signal - optional cancellation for backend work.
   * @returns after the backend has removed the addressed artifact.
   */
  remove(_id: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return Promise.reject(new Error('this session persistence backend does not support removal'))
  }

  /**
   * Prepare the exact unpublished Session used by resume. Implementations may
   * reuse object graphs retained by an earlier {@link inspect} after confirming
   * their durable revision is still current; disposal releases an unpublished
   * reservation. Revision retries require the durable log to remain unchanged
   * for one read/check round trip; continuous external writers may delay completion.
   * @param id - persisted session to prepare.
   * @param signal - optional cancellation for preparation work.
   * @returns one owned unpublished Session preparation.
   */
  async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted()
    const loaded = await this.load(id)
    signal?.throwIfAborted()
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) {
      throw new Error('cannot prepare a session: SessionStore is not configured')
    }
    return SessionPreparation.create(sessions.prepare(id, {
      seed: loaded.events.map(event => structuredClone(event)),
      meta: structuredClone(loaded.meta),
      seedSource: 'persistence',
    }))
  }

  /**
   * Load an immutable balanced logical view and commit any required cold
   * recovery. A complete interrupted final turn is preserved and durably
   * closed with missing tool errors plus any open step and turn boundaries;
   * only a torn final record is discarded. Unknown versions and corruption in
   * the committed prefix reject. Implementations MUST NOT crash-repair an
   * identity still bound to a live Session: a balanced live log may return as a
   * durable snapshot, while an open live turn rejects. Returned values may be
   * shared with immutable live or prepared state and must not be mutated.
   * Revision-based implementations may wait for one stable read/check round trip.
   * @param id - the persisted session to reload.
   * @returns the header and a log ending on a balanced `turn/end`.
   */
  abstract load(id: SessionId): Promise<SessionInspection>

  /**
   * Inspect an immutable logical session without committing recovery or
   * publishing it. A cold complete interrupted turn receives synthetic closers
   * in memory and a torn physical tail remains untouched. An already-live
   * Session instead yields its current immutable snapshot, which may contain an
   * open turn and its `session/end-seed` boundary. Coordinator-backed
   * implementations retain the exact cold unpublished Session for bounded
   * reuse by a later {@link prepare}. A stale ready source is reloaded; a source
   * already committing or reserved for resume remains exclusive, and inspection
   * may borrow its immutable view. Callers borrow only the immutable header and
   * log. Continuous external writers may delay revision convergence.
   * @param id - the persisted session to inspect.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns the validated header and current logical event log.
   */
  abstract inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

  /**
   * Read the stored events from `fromSeq` onward — the read-from-seq
   * primitive for read models that resume from a watermark (e.g. a persisted
   * projection cache folding only the tail past its checkpoint). Unlike
   * {@link inspect}, it is a detached physical suffix read: no preparation
   * cache, torn-tail truncation, synthetic closers, or coordinator-state
   * publication. Only events from the valid contiguous stored prefix are
   * returned, so a torn fragment never reaches the caller. `fromSeq` at or
   * beyond the stored prefix returns an empty event list (never an error).
   * Backends whose medium can seek by seq
   * (SQLite) read only the suffix; sequential media (JSONL, both encodings)
   * still parse the whole artifact and skip forward — the primitive bounds
   * what is RETURNED and refolded, not every backend's physical read.
   * @param id - the persisted session to read.
   * @param fromSeq - first event seq to include; a non-negative safe integer.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns the header and the stored events with `seq >= fromSeq`.
   */
  abstract readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal):
  Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /**
   * Read one session header without loading its event log. First-party
   * providers override this with an indexed lookup; the default filters the
   * lightweight snapshot list for third-party compatibility.
   * @param id - persisted session to observe.
   * @param signal - optional cancellation for backend lookup work.
   * @returns the immutable header, or undefined when the session is absent.
   */
  async readHeader(id: SessionId, signal?: AbortSignal): Promise<SessionHeader | undefined> {
    signal?.throwIfAborted()
    return (await this.listSnapshots(signal)).find(snapshot => snapshot.header.id === id)?.header
  }

  /**
   * Lightweight listing from metadata, without a full-log parse.
   * @param signal - optional cancellation for backend listing work.
   * @returns one header per materialized session.
   */
  abstract list(signal?: AbortSignal): Promise<SessionHeader[]>

  /**
   * Read one materialized session's opaque source revision without loading its event log.
   * First-party providers use their per-id storage lookup; the default preserves
   * third-party compatibility by filtering {@link listSnapshots}.
   * @param id - persisted session to observe.
   * @param signal - optional cancellation for backend lookup work.
   * @returns the current source-qualified revision, or undefined when absent.
   */
  async revision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    return (await this.listSnapshots(signal)).find(snapshot => snapshot.header.id === id)?.revision
  }

  /**
   * Read one lightweight source revision. This named alias keeps callers from
   * accidentally choosing a full-log operation when they only need freshness.
   * @param id - persisted session to observe.
   * @param signal - optional cancellation for backend lookup work.
   * @returns the current revision, or undefined when the session is absent.
   */
  async readRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    return this.revision(id, signal)
  }

  /**
   * Read a bounded event-log page. Third-party providers inherit a safe
   * compatibility fallback through {@link readFrom}; seek-capable providers
   * override this method so source acquisition remains bounded.
   * @param id - persisted session to read.
   * @param request - revision-aware page request.
   * @param signal - optional cancellation for backend read work.
   * @returns one immutable page and a continuation cursor.
   */
  async readPage(
    id: SessionId,
    request: SessionPersistencePageRequest = {},
    signal?: AbortSignal,
  ): Promise<SessionPersistencePage> {
    const normalized = normalizeSessionPersistencePageRequest(request, {
      maxBytes: DEFAULT_SESSION_PAGE_MAX_BYTES,
      maxEvents: DEFAULT_SESSION_PAGE_MAX_EVENTS,
      maxGroups: DEFAULT_SESSION_PAGE_MAX_GROUPS,
    })
    signal?.throwIfAborted()
    const revision = await this.readRevision(id, signal)
    if (revision === undefined) throw new Error(`session "${id}" not found`)
    let cursorAnchor: number | undefined
    if (normalized.cursor !== undefined) {
      const decoded = decodeSessionPersistenceCursor(normalized.cursor)
      if (decoded.sessionId !== id || decoded.revision !== String(revision)
        || decoded.direction !== normalized.direction) {
        throw new SessionPersistenceReadError('protocol', 'session persistence page cursor is stale or belongs to another request')
      }
      cursorAnchor = decoded.anchor
    }
    const loaded = await this.readFrom(id, normalized.direction === 'newer'
      ? cursorAnchor ?? normalized.fromSeq ?? 0
      : 0, signal)
    signal?.throwIfAborted()
    if (loaded.meta.id !== id) {
      throw new SessionPersistenceReadError('protocol', `session persistence returned metadata for "${id}"`)
    }
    let expectedSeq = normalized.direction === 'newer'
      ? cursorAnchor ?? normalized.fromSeq ?? 0
      : 0
    for (const event of loaded.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq !== expectedSeq) {
        throw new SessionPersistenceReadError('protocol', 'session persistence returned a non-contiguous event range')
      }
      try {
        const encoded: unknown = JSON.stringify(event)
        if (typeof encoded !== 'string') {
          throw new Error('event JSON is undefined')
        }
      } catch (error: unknown) {
        throw new SessionPersistenceReadError(
          'protocol',
          'session persistence returned a non-serializable event',
          { cause: error },
        )
      }
      expectedSeq++
    }
    const currentRevision = await this.readRevision(id, signal)
    if (currentRevision === undefined || String(currentRevision) !== String(revision)) {
      throw new SessionPersistenceReadError('dependency', 'session persistence revision changed during page read')
    }
    const all = loaded.events
    const anchor = cursorAnchor ?? (normalized.direction === 'older'
      ? normalized.beforeSeq ?? ((all.at(-1)?.seq ?? -1) + 1)
      : normalized.fromSeq ?? 0)
    const window = normalized.direction === 'older'
      ? all.filter(event => event.seq < anchor)
      : all.filter(event => event.seq >= anchor)
    const selected = selectSessionPersistencePage(
      window,
      normalized.direction,
      normalized.maxBytes,
      normalized.maxEvents,
      normalized.maxGroups,
    )
    const first = selected.events[0]
    const last = selected.events.at(-1)
    const hasMore = selected.hasMore
    const nextAnchor = normalized.direction === 'older'
      ? (first?.seq ?? 0)
      : (last?.seq ?? (anchor - 1)) + 1
    const nextCursor = hasMore
      ? encodeSessionPersistenceCursor({
        version: 1,
        sessionId: id,
        revision: String(revision),
        direction: normalized.direction,
        anchor: nextAnchor,
      })
      : undefined
    return {
      meta: loaded.meta,
      revision,
      events: selected.events,
      startSeq: first?.seq ?? null,
      endSeq: last?.seq ?? null,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      uncompressedBytes: selected.bytes,
    }
  }

  /**
   * List materialized sessions with cheap per-log change tokens.
   *
   * Repeated observations of an unchanged log return the same revision. A
   * successful mutating {@link load} repair changes the next listed revision.
   * Revisions also distinguish independently backed stores so backend-local
   * counters cannot compare equal across different persistence sources.
   * @param signal - optional cancellation for backend snapshot-listing work.
   * @returns one header and opaque revision per materialized session without loading full logs.
   */
  abstract listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>

  /**
   * Reserve a browser draft before an Agent is created. Local providers return
   * no value; Gateway providers may return a canonical Session id shared by
   * retries and other tabs carrying the same draft id.
   * @param _request - draft identity and scope metadata.
   * @returns the provider's canonical identity, or undefined when reservations are local-only.
   */
  reserveDraft(_request: SessionDraftReservationRequest): Promise<SessionDraftReservation | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * Renew a provider-owned draft lease. Missing leases are intentionally no-op.
   * @param _request - draft identity and scope metadata.
   */
  heartbeatDraft(_request: SessionDraftReservationRequest): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Release a provider-owned draft lease after materialization or abandonment.
   * @param _request - draft identity and scope metadata.
   */
  releaseDraft(_request: SessionDraftReservationRequest): Promise<void> {
    return Promise.resolve()
  }
}

export default SessionPersistence
