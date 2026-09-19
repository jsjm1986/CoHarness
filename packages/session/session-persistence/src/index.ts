/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from './errors.ts'
import type { SessionLocation } from './errors.ts'
import { assertVersion, materializeCreateHeader } from './storage-contract.ts'
import { ContractSessionHandle } from './contract-handle.ts'
import type {
  SessionAccess as SessionAccessType,
  SessionHandle as SessionHandleType,
} from './handle.ts'
import { hasConversationContent, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionDraftId, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from './revision.ts'

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
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
}

/** Logical Session header paired with its exact inherited cut for body-bearing storage operations. */
export interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}

/** Immutable logical session prepared from persistence or a live owner. */
export interface SessionInspection extends SessionStorageMetadata {
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}

/** Detached logical suffix returned by one explicit stored-log offset read. */
export interface SessionEventSuffix extends SessionStorageMetadata {
  /** First requested log offset; {@link events} contains only seqs at or after it. */
  readonly fromSeq: SessionLogOffset
  /** Valid contiguous stored events at or after {@link fromSeq}; not a complete Session log when the offset is nonzero. */
  readonly events: readonly SessionEvent[]
}

/** Default maximum uncompressed bytes returned by one persistence page. */
export const DEFAULT_SESSION_PAGE_MAX_BYTES = 512 * 1024
/** Default maximum logical events returned by one persistence page. */
export const DEFAULT_SESSION_PAGE_MAX_EVENTS = 2_000
/** Default message-group hint used by seek-capable persistence providers. */
export const DEFAULT_SESSION_PAGE_MAX_GROUPS = 50

/** Maximum number of turn markers returned by one history-index read. */
export const DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS = 2_000

/** One bounded turn marker used by navigation surfaces. */
export interface SessionHistoryIndexItem {
  /** Durable turn number carried by the turn boundaries. */
  readonly turn: number
  /** First event sequence in the turn. */
  readonly startSeq: number
  /** Last event sequence in the turn. */
  readonly endSeq: number
  /** Short, optional prompt preview with no event payload. */
  readonly prompt?: string
  /** Short, optional response preview with no event payload. */
  readonly response?: string
}

/** Bounded, revision-aware turn index for a session's navigation rail. */
export interface SessionHistoryIndex {
  /** Source revision captured with the index. */
  readonly revision: SessionPersistenceRevision
  /** Last stored sequence reflected by this index, or -1 for an empty log. */
  readonly asOfSeq: number
  /** Total turn count before any sampling limit is applied. */
  readonly totalTurns: number
  /** Returned markers in ascending sequence order. */
  readonly items: readonly SessionHistoryIndexItem[]
  /** True when the provider sampled markers to stay within the item limit. */
  readonly truncated: boolean
}

/** A backend's own raw artifact text for one session, verbatim. */
export interface SessionRawArtifact extends SessionStorageMetadata {
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}

export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'

/** Access mode for one persistence-owned legacy SessionHandle. */
export type SessionHandleMode = 'read' | 'write'

/**
 * Explicit per-session persistence access. Handles are the additive seam used
 * by the v2 migration; legacy service methods remain available until callers
 * move to handle ownership.
 */
export interface LegacySessionHandle {
  readonly id: SessionId
  readonly mode: SessionHandleMode
  read(offset?: number): Promise<readonly SessionEvent[]>
  append(events: readonly SessionEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

class PersistenceSessionHandle implements LegacySessionHandle {
  private closed = false
  private readonly inner: Promise<SessionHandleType>

  constructor(
    private readonly owner: SessionPersistence,
    readonly id: SessionId,
    readonly mode: SessionHandleMode,
    inner: SessionHandleType | Promise<SessionHandleType>,
  ) {
    this.inner = Promise.resolve(inner)
  }

  async read(offset: number = 0): Promise<readonly SessionEvent[]> {
    this.assertOpen()
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('session handle offset must be non-negative')
    return (await (await this.inner).read(offset)).events
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.assertOpen()
    if (this.mode === 'read') throw new SessionReadOnlyError(this.id, 'append')
    await (await this.inner).append(events)
  }

  async flush(): Promise<void> {
    this.assertOpen()
    if (this.mode === 'read') return
    await (await this.inner).flush()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      const handle = await this.inner.catch(() => undefined)
      await handle?.close()
    } finally {
      this.owner.releaseHandle(this.id, this)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`session handle for "${this.id}" is closed`)
  }
}

// The backend-agnostic write-path orchestration first-party backends compose.
export {
  DEFAULT_MAX_PENDING_BYTES_PER_SESSION,
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_MAX_PENDING_EVENTS_PER_SESSION,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
} from './coordinator.ts'
export type {
  PersistenceBackend,
  PersistenceCoordinatorOptions,
  StoredPrefix,
  StoredSuffix,
} from './coordinator.ts'

/** Options for {@link SessionPersistence.create}. */
export interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/** Options for {@link SessionPersistence.open}. */
export interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.stat}. */
export interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.list}. */
export interface SessionPersistenceListOptions {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * Durable append-only session storage. Implementations preserve contiguous,
 * losslessly JSON-serializable events; {@link append} resolves only after
 * durability, and {@link load} balances a complete interrupted tail without
 * rewriting committed events.
 */
export abstract class SessionPersistence extends Service {
  private readonly writeHandles = new Map<SessionId, PersistenceSessionHandle | ContractSessionHandle>()
  /** Synchronously claimed write ids, held until the lazy `open` resolves. */
  private readonly syncWriteClaims = new Set<SessionId>()

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  // --- upstream handle contract (coordinator-adapted) ---

  /**
   * Create a new stored session and take its write ownership. The create is
   * lazy: the session is observable through `stat`/`list`/`open` in this
   * process immediately, but no durable artifact exists until the handle's
   * first `append` or `flush`.
   * @param header - the immutable header (id, version, cwd, lineage) to store.
   * @param options - optional cancellation and the exact fork-inherited cut.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandleType> {
    options?.signal?.throwIfAborted()
    assertVersion(header, this.locate(header))
    const inherited = options?.inheritedEventCount
    if (header.isSeeded && inherited === undefined) {
      throw new TypeError(`seeded session "${header.id}" requires an exact inheritedEventCount`)
    }
    if (!header.isSeeded && inherited !== undefined && inherited !== 0) {
      throw new TypeError(`unseeded session "${header.id}" must not carry inheritedEventCount`)
    }
    if (this.writeHandles.has(header.id)) throw new SessionAlreadyExistsError(header.id)
    if ((await this.stat(header.id, options)) !== undefined) {
      throw new SessionAlreadyExistsError(header.id)
    }
    const stored = materializeCreateHeader(header)
    // A Session registered through session/created already owns this id in the
    // coordinator; create then claims write ownership of that live state
    // instead of duplicating the registration.
    const live = await this.liveStorage(stored.id)
    if (live !== undefined) {
      const adopted = new ContractSessionHandle(this, stored.id, live.meta, live.inheritedEventCount, 'write')
      this.writeHandles.set(stored.id, adopted)
      return adopted
    }
    const handle = new ContractSessionHandle(this, stored.id, stored, inherited ?? (0 as SessionLogOffset), 'write')
    this.writeHandles.set(stored.id, handle)
    try {
      await this.createStored(stored, inherited)
    } catch (error: unknown) {
      this.writeHandles.delete(stored.id)
      // The coordinator's serialized createCore is the second dup gate for
      // concurrent creates racing past the stat check above.
      if (error instanceof Error && error.message.includes('already')) {
        throw new SessionAlreadyExistsError(header.id)
      }
      throw error
    }
    return handle
  }

  /**
   * Open an existing stored session. `read` never takes ownership and works
   * while another handle or process holds `write`; `write` atomically claims
   * single-writer ownership.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  async open(id: SessionId, access: SessionAccessType, options?: SessionPersistenceOpenOptions): Promise<SessionHandleType> {
    options?.signal?.throwIfAborted()
    if (access === 'write' && (this.writeHandles.has(id) || this.syncWriteClaims.has(id))) {
      throw new SessionAlreadyOwnedError(id)
    }
    return this.openInner(id, access, options)
  }

  /**
   * Open an existing stored session without the ownership pre-check; internal
   * path shared by {@link open} and the synchronously-claiming legacy
   * {@link openHandle}.
   */
  protected async openInner(id: SessionId, access: SessionAccessType, options?: SessionPersistenceOpenOptions): Promise<SessionHandleType> {
    const pending = this.listPending().find(storage => storage.meta.id === id)
    if (pending !== undefined) {
      const handle = new ContractSessionHandle(this, id, pending.meta, pending.inheritedEventCount, access)
      if (access === 'write') this.writeHandles.set(id, handle)
      return handle
    }
    const snapshot = await this.stat(id, options)
    if (snapshot === undefined) throw new SessionPersistenceNotFoundError(id)
    const inspection = await this.inspectStored(id, options?.signal)
    if (inspection === undefined) throw new SessionPersistenceNotFoundError(id)
    const handle = new ContractSessionHandle(this, id, inspection.meta, inspection.inheritedEventCount, access)
    if (access === 'write') this.writeHandles.set(id, handle)
    return handle
  }

  /**
   * Flush every active write handle owned by this service instance: pending
   * creates materialize and routed events drain durably. A handle closed
   * concurrently counts as flushed — close itself drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed.
   */
  async flush(): Promise<void> {
    const handles = [...this.writeHandles.values()]
      .filter((handle): handle is ContractSessionHandle => handle instanceof ContractSessionHandle)
    const errors: unknown[] = []
    for (const handle of handles) {
      try {
        await handle.flush()
      } catch (error: unknown) {
        // A handle whose close raced the barrier already drained durably.
        if (!(error instanceof SessionHandleClosedError)) errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `session persistence flush failed for ${errors.length} handle(s)`)
    }
  }

  /**
   * Observe one stored session without reading its event log or taking
   * ownership; pending creates count before they materialize.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const pending = this.listPending().find(storage => storage.meta.id === id)
    if (pending !== undefined) {
      return { header: pending.meta, revision: SessionPersistenceRevision(`pending:${id}`) }
    }
    return (await this.listSnapshots(options?.signal)).find(snapshot => snapshot.header.id === id)
  }

  /**
   * List every stored session visible to this process, in no promised order,
   * including pending creates that have not materialized yet.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const pending: SessionPersistenceSnapshot[] = this.listPending().map(storage => ({
      header: storage.meta,
      revision: SessionPersistenceRevision(`pending:${storage.meta.id}`),
    }))
    return [...pending, ...await this.listSnapshots(options?.signal)]
  }

  /**
   * Release one contract handle's write ownership at close.
   * @param id - the session whose write handle is released.
   * @param handle - the closing contract handle.
   */
  releaseContractHandle(id: SessionId, handle: ContractSessionHandle): void {
    if (this.writeHandles.get(id) === handle) this.writeHandles.delete(id)
  }

  /**
   * Durably materialize one detached pending session created through
   * {@link create}. Coordinator-backed backends implement; direct backends
   * materialize through their own write handles and never reach this hook.
   * @param _id - the pending session to materialize.
   * @returns after the artifact is durable.
   */
  materializeDetached(_id: SessionId): Promise<void> {
    return Promise.reject(new Error('this session persistence backend does not defer materialization'))
  }

  /**
   * Drop one detached pending create that never materialized, returning its
   * id to availability.
   * @param _id - the pending session to discard.
   * @returns after the reservation is released.
   */
  discardDetached(_id: SessionId): Promise<void> {
    return Promise.reject(new Error('this session persistence backend does not defer materialization'))
  }

  /**
   * Whether the id names a detached pending create (created through
   * {@link create} but not yet materialized). Backends with coordinator
   * pending-state override; a backend without deferred materialization never
   * holds a pending session.
   * @param id - the session to check.
   * @returns true while the session exists only as an in-process reservation.
   */
  isPending(id: SessionId): boolean {
    void id
    return false
  }

  /**
   * Storage metadata for a session already bound to a live Session through the
   * coordinator's `session/created` path, or `undefined`. Backends without
   * live-session tracking never override this hook.
   * @param _id - the session to look up.
   * @returns the tracked storage record while a live Session owns it.
   */
  liveStorage(_id: SessionId): Promise<SessionStorageMetadata | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * List this instance's detached pending creates.
   * @returns one storage metadata record per pending detached session.
   */
  listPending(): readonly SessionStorageMetadata[] {
    return []
  }

  /**
   * List all stored (materialized) sessions' metadata; the backend storage hook.
   * @param signal - optional cancellation for backend listing work.
   * @returns one header per materialized session.
   */
  listStored(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.list(signal === undefined ? undefined : { signal })
      .then(snapshots => snapshots.map(snapshot => snapshot.header))
  }

  /**
   * Header-only listing for consumers that predate the snapshot contract.
   * @param signal - optional cancellation for backend listing work.
   * @returns one header per materialized session.
   */
  listHeaders(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.listStored(signal)
  }

  /**
   * Read one stored session's storage metadata without ownership. The default
   * goes through {@link inspect}; backends may override with a cheaper lookup.
   * @param id - the stored session to inspect.
   * @param signal - optional cancellation.
   * @returns the storage metadata, or `undefined` when absent.
   */
  protected async inspectStored(id: SessionId, signal?: AbortSignal): Promise<SessionStorageMetadata | undefined> {
    try {
      const inspection = await this.inspect(id, signal)
      return { meta: inspection.meta, inheritedEventCount: inspection.inheritedEventCount }
    } catch (error: unknown) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined
      throw error
    }
  }

  /**
   * Create a new explicit write handle while retaining the legacy create API.
   * @param meta - immutable Session header to register.
   * @param inheritedEventCount - exact inherited prefix length for a seeded Session.
   * @returns an owned write handle.
   */
  async createHandle(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<LegacySessionHandle> {
    const handle = await this.create(meta, inheritedEventCount === undefined ? undefined : { inheritedEventCount })
    return new PersistenceSessionHandle(this, meta.id, 'write', handle)
  }

  /**
   * Open a handle and acquire any provider-specific cross-process lock.
   * @param id - persisted Session identity.
   * @param mode - read or write access.
   * @returns a handle whose close releases local and provider ownership.
   */
  async openHandleAsync(id: SessionId, mode: SessionHandleMode): Promise<LegacySessionHandle> {
    const handle = await this.open(id, mode)
    return new PersistenceSessionHandle(this, id, mode, handle)
  }

  /**
   * Open a read or write handle for an existing Session.
   * @param id - persisted Session identity.
   * @param mode - read allows inspection; write reserves the local writer.
   * @returns an explicit SessionHandle.
   */
  openHandle(id: SessionId, mode: SessionHandleMode ): LegacySessionHandle {
    if (mode === 'write' && (this.writeHandles.has(id) || this.syncWriteClaims.has(id))) {
      throw new SessionAlreadyOwnedError(id)
    }
    if (mode === 'write') this.syncWriteClaims.add(id)
    const opening = this.openInner(id, mode).catch((error: unknown) => {
      this.syncWriteClaims.delete(id)
      throw error
    })
    return new PersistenceSessionHandle(this, id, mode, opening)
  }

  /** Release a process-local writer reservation held by one handle.
   * @param id - session identity whose reservation is released.
   * @param handle - handle that owns the reservation.
   */
  releaseHandle(id: SessionId, handle: LegacySessionHandle): void {
    this.syncWriteClaims.delete(id)
    if (this.writeHandles.get(id) === handle) this.writeHandles.delete(id)
  }

  /**
   * Resolve this backend's independent local artifact for a session without
   * reading, creating, flushing, or otherwise materializing it. Backends such
   * as SQLite that do not own one artifact per session return `undefined`.
   * @param _meta - the immutable session header whose artifact is requested.
   * @returns the backend-specific absolute location, when one exists.
   */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  /**
   * Whether this backend exposes one verbatim raw artifact per session.
   * A backend that declares `true` must override {@link readRaw}.
   */
  readonly supportsRawArtifacts: boolean = false

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
   * @param inheritedEventCount - exact fork-inherited prefix length. Required
   * for a seeded header and omitted only for an unseeded header.
   */
  async createStored(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    const handle = await this.create(meta, inheritedEventCount === undefined ? undefined : { inheritedEventCount })
    try {
      await handle.flush()
    } finally {
      await handle.close()
    }
  }

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
   * A seeded session's first materializing batch must reach its complete
   * inherited prefix.
   * @param id - the session the batch belongs to.
   * @param events - the contiguous batch to persist, in seq order.
   */
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const owned = this.writeHandles.get(id)
    if (owned instanceof ContractSessionHandle) {
      await owned.append(events)
      return
    }
    const handle = await this.open(id, 'write')
    try {
      await handle.append(events)
    } finally {
      await handle.close()
    }
  }

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
      inheritedEventCount: SessionLogOffset(loaded.inheritedEventCount),
      eventState: 'detached',
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
  load(id: SessionId): Promise<SessionInspection> {
    return this.inspect(id)
  }

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
  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted()
    const handle = await this.open(id, 'read', signal === undefined ? undefined : { signal })
    try {
      const { events } = await handle.read(0, undefined, signal === undefined ? undefined : { signal })
      return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
    } finally {
      await handle.close()
    }
  }

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
   * @param fromSeq - first event offset to include.
   * @param signal - optional cancellation for queued and backend read work.
   * @returns storage metadata, the requested offset, and stored events with `seq >= fromSeq`.
   */
  async readFrom(id: SessionId, fromSeq: SessionLogOffset, signal?: AbortSignal):
  Promise<SessionEventSuffix> {
    signal?.throwIfAborted()
    const handle = await this.open(id, 'read', signal === undefined ? undefined : { signal })
    try {
      const { events } = await handle.read(fromSeq, undefined, signal === undefined ? undefined : { signal })
      return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, fromSeq, events }
    } finally {
      await handle.close()
    }
  }

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
      if (decoded.sessionId !== id || decoded.direction !== normalized.direction) {
        throw new SessionPersistenceReadError('protocol', 'session persistence page cursor belongs to another request')
      }
      // Same walk, moved log: the writer that invalidated the cursor is the
      // same transient condition as a revision change inside one page read,
      // so callers see the retryable category for both.
      if (decoded.revision !== String(revision)) {
        throw new SessionPersistenceReadError('dependency', 'session persistence revision changed since the page cursor was issued')
      }
      cursorAnchor = decoded.anchor
    }
    const loaded = await this.readFrom(id, SessionLogOffset(normalized.direction === 'newer'
      ? cursorAnchor ?? normalized.fromSeq ?? 0
      : 0), signal)
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
   * Read a bounded turn index without materializing the event log. Providers
   * with a searchable boundary index override this method; the default leaves
   * the optional navigation capability absent for compatibility providers.
   * @param _id - persisted session identity.
   * @param _maxItems - maximum marker count requested by the caller.
   * @param signal - optional cancellation for backend lookup work.
   * @returns the index, or undefined when this backend has no bounded index.
   */
  readHistoryIndex(
    _id: SessionId,
    _maxItems: number = DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS,
    signal?: AbortSignal,
  ): Promise<SessionHistoryIndex | undefined> {
    signal?.throwIfAborted()
    return Promise.resolve(undefined)
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
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return [...await this.list(signal === undefined ? undefined : { signal })]
  }

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
