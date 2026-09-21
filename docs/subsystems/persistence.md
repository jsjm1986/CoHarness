# Session Persistence

English | [中文](persistence.zh.md)

The **durability seam** for the event log. [session.md](session.md) describes the in-memory `Session` — the append-only `SessionEvent` log that is the source of truth. This page describes how that log is made durable: the abstract `SessionPersistence` service, its backends, the flush checkpoint, crash recovery, and the metadata header that travels alongside the log. The event vocabulary the log carries is enumerated, member by member, in the generated [persistence log event catalog](../persistence-catalog.md).

The seam is a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): one abstract service ([dsh-session-persistence](../../packages/session/session-persistence), `ctx.sessionPersistence`) defining locate/create/append, reusable Session preparation, logical load/inspect, bounded page and turn-index reads, physical suffix reads, and lightweight list/snapshot observation over the existing `SessionEvent` — **no parallel persisted event type** — and three interchangeable providers implementing the same contract. See the [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md).

## The flush checkpoint

`session/event` is a *synchronous* notification; persistence plugins copy the event into a per-session controller without blocking the producer. The first pending event starts a fixed batching window, and later events join without resetting its deadline. Expiry starts one durable batch; events admitted during that write receive their own deadline and form a follow-up batch. `session/flush` cancels the wait and drains through quiescence, so the loop still uses it as the ordering and error-observation checkpoint before claiming the next ordinary turn. A rejected background write retains its events and pauses automatic retry; a new event starts a fresh window, while explicit flush retries immediately and reports failure through `agent/error` and the logger, never as a session event past the closed turn. Disposal performs the same final drain. The configured maximum bounds only intentional batching wait, not event-loop scheduling or backend durability latency ([decision](../../.agents/notes/implemented/architecture/2026-08-08-bounded-session-persistence-write-batching.md)).

## Crash recovery preserves an interrupted turn

A backend that reloads a log crashed mid-turn finds an open `turn/start` with no `turn/end`. It does **not** truncate — a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash. Instead it closes the orphaned turn with a synthetic `turn/end { reason: { kind: 'interrupted' } }`, keeping the interrupted execution balanced without changing any standalone events before or after it. `interrupted` is the one `TurnEndReason` no loop emits (see [session.md](session.md#why-a-turn-ended-turnendreasonmap)).

Repair applies only to cold sessions. For a live id, `SessionPersistence.load(id)` waits until the authoritative in-memory snapshot is durable and returns it only when balanced; an open live turn rejects rather than receiving synthetic interruption boundaries. HMR adopts a live prefix without closing its active turn.

`SessionPersistence.inspect(id)` constructs an immutable logical Session without publishing it or writing recovery. Cold inspection balances an interrupted turn in memory while leaving torn physical tails untouched; inspection of an already-live Session borrows its current immutable snapshot and may therefore contain an open turn. Coordinator-backed implementations retain the exact cold unpublished Session in a bounded LRU, so repeated history reads and a later `prepare(id)` share one read, decompression, validation, freeze, and Session construction. `prepare(id)` reserves the Session, commits pending repair, and returns a disposable publication handle; `load(id)` uses the same machinery to commit repair without publication. The [Session preparation decision](../../.agents/notes/implemented/architecture/2026-08-05-session-preparation.md) owns this lifecycle.

## `SessionLocation` — optional per-session artifact target

`SessionPersistence.locate(meta)` synchronously resolves a backend-owned independent artifact without reading, creating, or flushing it. JSONL returns the absolute transcript path inside its project/session directory; SQLite returns `undefined` because sessions share one database. A returned path can therefore name a file that does not yet exist or lacks the current unflushed turn; it is a location hint, not authorization or a freshness guarantee.

```ts type-equiv
/** One persistence event slice returned by {@link SessionHandle.read}. */
interface SessionHandleReadResult {
  /**
   * Whether event values are exclusively owned or shared only after deep
   * freezing. Slicing preserves the producer's state even when no events remain.
   */
  readonly eventState: SessionSeedEventState
  /** Event values in a caller-owned outer array. */
  readonly events: readonly SessionEvent[]
}
```

```ts type-equiv
/**
 * One open channel onto a stored session. A handle is single-owner state, not
 * a shared service: `read` never backtracks below what this handle already
 * observed, a `write` handle reads its own successful appends, and `close()`
 * is the one teardown (idempotent, uncancellable; `Symbol.asyncDispose`
 * delegates to it). Every operation on a closed handle rejects with
 * `SessionHandleClosedError`.
 *
 * Freshness across handles: once an `append` or `flush` resolves on a write
 * handle, every read STARTED afterwards on the same backend instance — on any
 * handle, or through `stat`/`list` — observes at least that prefix.
 * Reads concurrent with a mutation carry no ordering promise beyond the valid
 * contiguous prefix.
 */
interface SessionHandle extends AsyncDisposable {
  /** The stored session this handle addresses. */
  readonly id: SessionId
  /** The immutable stored header, fixed at `create`/`open`. */
  readonly header: SessionHeader
  /**
   * Exact fork-inherited prefix length stored with the log; `0` when
   * `header.isSeeded` is false. Storage metadata paired with the header for
   * every body read, never part of the replayable event log.
   */
  readonly inheritedEventCount: SessionLogOffset
  /** Whether this handle may mutate the log. */
  readonly access: SessionAccess

  /**
   * Read a slice of the valid contiguous logical log. The slice is a legal log
   * prefix segment: a torn physical tail is never returned, and repeated reads
   * on this handle never observe an older state than a prior read.
   * @param offset - first logical event seq to include; defaults to `0`.
   * @param length - maximum number of events to return; defaults to the rest
   *   of the log. An offset at or past the end returns an empty list.
   * @param options - optional cancellation.
   * @returns the caller-owned outer slice plus the ownership state of its event values.
   */
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>

  /**
   * Append a contiguous batch continuing the current logical end. The first
   * event's `seq` MUST equal the stored next-seq; committed events are never
   * rewritten. Persistence is best-effort: on resolution the batch is
   * accepted, ordered, and visible to reads on this backend instance, but
   * only a resolved {@link flush} promises it survives a crash — a backend
   * may buffer or batch physical writes behind append. Rejects with
   * `SessionReadOnlyError` on a read handle and `SessionOwnershipLostError`
   * when write ownership is gone.
   * @param events - the contiguous batch, in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>

  /**
   * The durability barrier — the one operation that promises storage: on
   * resolution every acknowledged append is durable and the session is
   * materialized for other processes; an empty created session becomes
   * durably listable here. Callers that must survive a crash flush; a backend
   * whose `append` already persists on resolution treats this as
   * materialize-if-needed. Rejects with `SessionReadOnlyError` on a read
   * handle.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void>

  /**
   * Release the handle: a read handle frees local resources; a write handle
   * completes pending durability and releases write ownership. Idempotent,
   * asynchronous, and deliberately not cancellable.
   */
  close(): Promise<void>
}
```

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. Carried only by
 * refusal diagnostics ({@link SessionFormatUnsupportedError}) so a user can
 * find the raw log a build refused to interpret; it is not a consumer-facing
 * query — log access goes through a session handle's `read`.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

<a id="sessionheader--metadata-beside-the-log"></a>

## `SessionHeader` — metadata beside the log

Per-session metadata travels **separately** from the event log: the header carries format version, cwd, and the `isSeeded` lineage bit, while body-bearing storage values carry the exact inherited cut beside it. Neither belongs to `SessionEventMap` or reaches `deriveMessages()`. The logical header is attached through `session.header`; the Session exposes its cut as `inheritedEventCount`.

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * Current logical format version, stamped from {@link SESSION_FORMAT_VERSION}.
   * Historical physical headers are translated before entering this interface.
   */
  readonly version: typeof SESSION_FORMAT_VERSION
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  readonly isSeeded: boolean
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
  /** True for a browser draft whose persistence is deferred until materialization. */
  readonly draft?: boolean
}
```

## Format refusal — logs a build cannot faithfully read

A backend refuses a log it cannot faithfully interpret with `SessionFormatUnsupportedError`, distinct from `SessionPersistenceCorruptionError` because nothing is damaged. A header `version` ahead of `SESSION_FORMAT_VERSION` names the direction ("written by a newer harness — upgrade the harness to open it"). Supported v0/v1 headers and events pass through the adjacent migration catalog before the current Session is constructed; a missing edge or malformed target refuses explicitly. After migration, an event type outside this build's generated vocabulary (`KNOWN_SESSION_EVENT_TYPES`, emitted by `gen-persistence-catalog`) refuses the same way unless the event's envelope carries `ignorable: true`. The JSONL provider publishes the migrated current generation beside the preserved source; SQLite keeps its monotonic `SCHEMA_VERSION` gate for whole-file structure.

## `CreateSessionOptions` — seeding and metadata

Creating a `Session` through the store takes a `seed` (initial replay or fork history), an optional exact `inheritedEventCount`, and `meta` (the storage-level fields the store folds into a `SessionHeader`). The store fills in `version`/`id` and defaults `createdAt`; the caller may supply the validated absolute `cwd`, `parentSession` lineage, `isSeeded` lineage bit, optional coarse `origin`, `delegationDepth`, `agentPreset`, and an existing `createdAt`. A seeded creation requires both an explicit seed and exact cut because child-owned setup events may follow the inherited prefix. `origin: 'subagent'` lets product navigation hide duplicate child rows; it does not prove that a descriptor is valid or that the child can resume.

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. A
   * constructor seed may also contain child-owned setup events after this cut.
   */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
    readonly draft?: boolean
  }
}
```

Plain replay is `ctx.sessions.create(id, { seed: seedEvents })`; a fork additionally supplies `inheritedEventCount` and `meta.isSeeded: true`. Resuming a *persisted* session into a live agent is `ctx.agents.resume({ resumeSessionId })`.

## `SessionStorageMetadata` — logical header and inherited cut

Every persistence result that reads a Session body carries `SessionStorageMetadata`: the current logical header plus the separately validated inherited-event cut. Header-only listing intentionally returns only `SessionHeader`.

```ts type-equiv
/** Logical Session header paired with its exact inherited cut for body-bearing storage operations. */
interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}
```

## `SessionRawArtifact` — verbatim stored artifact text

A backend's own artifact text for one session, byte-identical to what it durably wrote (decoded from its physical encoding). `readRaw` returns it without reconstructing from parsed events, so backend-specific serialization (chunk packing, key order, line breaks) survives. Consumers first test `supportsRawArtifacts`: `false` means the backend does not provide this capability (for example SQLite), while `readRaw(...) === undefined` means a supported backend has no materialized artifact for that session.

```ts type-equiv
/** A backend's own raw artifact text for one session, verbatim. */
interface SessionRawArtifact extends SessionStorageMetadata {
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}
```

## Preparation and restoration ownership

`SessionStore.prepare()` accepts ordinary creation options or fresh persistence graphs transferred through `RestoredSessionOptions`. The restoration branch validates and freezes the transferred header and events in place, so callers must retain no mutable aliases. `SessionPreparation` then owns the exact unpublished Session until publication or rollback; disposal is synchronous and idempotent. Persistence inspection exposes only `SessionInspection`, an immutable logical view borrowed from the same prepared Session.

```ts type-equiv
/**
 * Aliasing state of an adoptable Session seed. `shared-frozen` permits deeply
 * frozen aliases plus independently owned unfrozen values in the same seed.
 */
type SessionSeedEventState = 'detached' | 'shared-frozen'
```

```ts type-equiv
/**
 * Adoptable storage values transferred to {@link SessionStore.prepare}
 * without another serialization copy; the restore path validates and freezes
 * them in place.
 */
interface RestoredSessionOptions {
  /** Events that are independently owned or already deeply frozen. */
  readonly seed: SessionEvent[]
  /** Independently owned storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Exact number of fork-inherited leading events decoded from storage. */
  readonly inheritedEventCount: SessionLogOffset
  /** Aliasing state carried from the operation that produced the seed. */
  readonly eventState: SessionSeedEventState
}
```

```ts type-equiv
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly eventState?: undefined })
  | RestoredSessionOptions
```

```ts type-equiv
/** Options for a preparation whose provider retains unpublished state. */
interface SessionPreparationOptions {
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}
```

```ts public-api
/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * Disposal is synchronous and idempotent. Providers decide whether release
 * returns the Session to a cache or discards it; publication may consume that
 * state before disposal, making the callback a no-op.
 */
declare class SessionPreparation implements Disposable {
  /** The exact Session to use for setup and publication. */
  readonly session: Session;
  /**
     * Wrap an unpublished Session in one preparation lifetime.
     * @param session - exact unpublished Session.
     * @param options - optional provider release behavior.
     * @returns a preparation disposed after publication or rollback.
     */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation;
  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void;
}
```

```ts type-equiv
/** Immutable logical session prepared from persistence or a live owner. */
interface SessionInspection extends SessionStorageMetadata {
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}
```

## Detached stored-log suffixes

`readFrom` returns a detached `SessionEventSuffix` anchored by the requested `fromSeq`. Its event list may start above zero or be empty, so it is not a complete `SessionInspection` and must not be restored as a whole Session.

```ts type-equiv
/** Detached logical suffix returned by one explicit stored-log offset read. */
interface SessionEventSuffix extends SessionStorageMetadata {
  /** First requested log offset; {@link events} contains only seqs at or after it. */
  readonly fromSeq: SessionLogOffset
  /** Valid contiguous stored events at or after {@link fromSeq}; not a complete Session log when the offset is nonzero. */
  readonly events: readonly SessionEvent[]
}
```

## Lightweight source revisions

Consumers of derived state compare a cheap opaque revision before loading a full event log. The persistence backend owns its representation and changes it transactionally with append or mutating load repair; callers compare it only for equality.

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/** Lightweight immutable source identity returned without loading a full log. */
interface SessionPersistenceSnapshot {
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
```

## The backends

All implement the same abstract `SessionPersistence` (locate/create/append/prepare/load/inspect/readFrom/list/listSnapshots over `SessionEvent`, with optional cancellation on observation methods) and pass the shared `runPersistenceContract` suite:

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)** — an append-only logical JSONL log per session, stored as checksummed concatenated Zstandard frames by default or raw lines by configuration, with crash-safe atomic writes, interrupted-turn recovery, and a read/replay path.
- **[dsh-session-persistence-sqlite](../../packages/session/session-persistence-sqlite)** — an opt-in `node:sqlite` backend using schema 17 to store exact same-block delta runs in bounded physical `text-chunks`, `reasoning-chunks`, and `tool-call-chunks` rows. It reconstructs the complete logical event stream before returning it, packs only newly durable batches, and rejects older schemas rather than migrating them.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionpersistence--sessionpersistence-abstract-seam"></a>

### `ctx.sessionPersistence` — `SessionPersistence` (abstract seam)

Durable append-only session storage. Implementations preserve contiguous, losslessly JSON-serializable events; append resolves only after durability, and load balances a complete interrupted tail without rewriting committed events.

```ts cordis-catalog
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
async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandleType>

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
async open(id: SessionId, access: SessionAccessType, options?: SessionPersistenceOpenOptions): Promise<SessionHandleType>

/**
 * Flush every active write handle owned by this service instance: pending
 * creates materialize and routed events drain durably. A handle closed
 * concurrently counts as flushed — close itself drains durably.
 * @returns resolution once every write handle active at the call has flushed.
 * @throws {AggregateError} naming each session whose flush failed.
 */
async flush(): Promise<void>

/**
 * Observe one stored session without reading its event log or taking
 * ownership; pending creates count before they materialize.
 * @param id - the stored session to observe.
 * @param options - optional cancellation.
 * @returns the snapshot, or `undefined` when the session does not exist.
 */
async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

/**
 * List every stored session visible to this process, in no promised order,
 * including pending creates that have not materialized yet.
 * @param options - optional cancellation.
 * @returns one snapshot per stored session.
 */
async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>

/**
 * Release one contract handle's write ownership at close.
 * @param id - the session whose write handle is released.
 * @param handle - the closing contract handle.
 */
releaseContractHandle(id: SessionId, handle: ContractSessionHandle): void

/**
 * Durably materialize one detached pending session created through
 * {@link create}. Coordinator-backed backends implement; direct backends
 * materialize through their own write handles and never reach this hook.
 * @param _id - the pending session to materialize.
 * @returns after the artifact is durable.
 */
materializeDetached(_id: SessionId): Promise<void>

/**
 * Drop one detached pending create that never materialized, returning its
 * id to availability.
 * @param _id - the pending session to discard.
 * @returns after the reservation is released.
 */
discardDetached(_id: SessionId): Promise<void>

/**
 * Whether the id names a detached pending create (created through
 * {@link create} but not yet materialized). Backends with coordinator
 * pending-state override; a backend without deferred materialization never
 * holds a pending session.
 * @param id - the session to check.
 * @returns true while the session exists only as an in-process reservation.
 */
isPending(id: SessionId): boolean

/**
 * Storage metadata for a session already bound to a live Session through the
 * coordinator's `session/created` path, or `undefined`. Backends without
 * live-session tracking never override this hook.
 * @param _id - the session to look up.
 * @returns the tracked storage record while a live Session owns it.
 */
liveStorage(_id: SessionId): Promise<SessionStorageMetadata | undefined>

/**
 * List this instance's detached pending creates.
 * @returns one storage metadata record per pending detached session.
 */
listPending(): readonly SessionStorageMetadata[]

/**
 * List all stored (materialized) sessions' metadata; the backend storage hook.
 * @param signal - optional cancellation for backend listing work.
 * @returns one header per materialized session.
 */
listStored(signal?: AbortSignal): Promise<SessionHeader[]>

/**
 * Header-only listing for consumers that predate the snapshot contract.
 * @param signal - optional cancellation for backend listing work.
 * @returns one header per materialized session.
 */
listHeaders(signal?: AbortSignal): Promise<SessionHeader[]>

/**
 * Create a new explicit write handle while retaining the legacy create API.
 * @param meta - immutable Session header to register.
 * @param inheritedEventCount - exact inherited prefix length for a seeded Session.
 * @returns an owned write handle.
 */
async createHandle(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<LegacySessionHandle>

/**
 * Open a handle and acquire any provider-specific cross-process lock.
 * @param id - persisted Session identity.
 * @param mode - read or write access.
 * @returns a handle whose close releases local and provider ownership.
 */
async openHandleAsync(id: SessionId, mode: SessionHandleMode): Promise<LegacySessionHandle>

/**
 * Open a read or write handle for an existing Session.
 * @param id - persisted Session identity.
 * @param mode - read allows inspection; write reserves the local writer.
 * @returns an explicit SessionHandle.
 */
openHandle(id: SessionId, mode: SessionHandleMode ): LegacySessionHandle

/** Release a process-local writer reservation held by one handle.
 * @param id - session identity whose reservation is released.
 * @param handle - handle that owns the reservation.
 */
releaseHandle(id: SessionId, handle: LegacySessionHandle): void

/**
 * Resolve this backend's independent local artifact for a session without
 * reading, creating, flushing, or otherwise materializing it. Backends such
 * as SQLite that do not own one artifact per session return `undefined`.
 * @param _meta - the immutable session header whose artifact is requested.
 * @returns the backend-specific absolute location, when one exists.
 */
locate(_meta: SessionHeader): SessionLocation | undefined

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
readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined>

/**
 * Register a new session's metadata. A backend MAY defer the physical write
 * until the first {@link append} (lazy materialization), in which case a
 * created-but-never-appended session is absent from {@link list}
 * — abandoned sessions leave nothing behind.
 * @param meta - the immutable header (id, version, cwd, lineage) to record.
 * @param inheritedEventCount - exact fork-inherited prefix length. Required
 * for a seeded header and omitted only for an unseeded header.
 */
async createStored(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void>

/**
 * Durably materialize an empty live session without adding a synthetic event.
 * Ordinary creation stays lazy; lifecycle frontends use this when an empty
 * session must appear in durable listing and remain resumable.
 * @param _session - exact live session whose header is to be persisted.
 * @returns after the header-only artifact is durable.
 */
ensureMaterialized(_session: Session): Promise<void>

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
async append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

/**
 * Remove one complete persisted session tree when the deployment exposes a
 * destructive archive lifecycle. Backends that do not support deletion fail
 * explicitly so callers keep a pending purge instead of silently losing the
 * lifecycle acknowledgement.
 * @param _id - root or session id selected for removal.
 * @param signal - optional cancellation for backend work.
 * @returns after the backend has removed the addressed artifact.
 */
remove(_id: SessionId, signal?: AbortSignal): Promise<void>

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
async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>

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
load(id: SessionId): Promise<SessionInspection>

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
async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

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
async readFrom(id: SessionId, fromSeq: SessionLogOffset, signal?: AbortSignal): Promise<SessionEventSuffix>

/**
 * Read one session header without loading its event log. First-party
 * providers override this with an indexed lookup; the default filters the
 * lightweight snapshot list for third-party compatibility.
 * @param id - persisted session to observe.
 * @param signal - optional cancellation for backend lookup work.
 * @returns the immutable header, or undefined when the session is absent.
 */
async readHeader(id: SessionId, signal?: AbortSignal): Promise<SessionHeader | undefined>

/**
 * Read one materialized session's opaque source revision without loading its event log.
 * First-party providers use their per-id storage lookup; the default preserves
 * third-party compatibility by filtering {@link listSnapshots}.
 * @param id - persisted session to observe.
 * @param signal - optional cancellation for backend lookup work.
 * @returns the current source-qualified revision, or undefined when absent.
 */
async revision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined>

/**
 * Read one lightweight source revision. This named alias keeps callers from
 * accidentally choosing a full-log operation when they only need freshness.
 * @param id - persisted session to observe.
 * @param signal - optional cancellation for backend lookup work.
 * @returns the current revision, or undefined when the session is absent.
 */
async readRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined>

/**
 * Read a bounded event-log page. Third-party providers inherit a safe
 * compatibility fallback through {@link readFrom}; seek-capable providers
 * override this method so source acquisition remains bounded.
 * @param id - persisted session to read.
 * @param request - revision-aware page request.
 * @param signal - optional cancellation for backend read work.
 * @returns one immutable page and a continuation cursor.
 */
async readPage( id: SessionId, request: SessionPersistencePageRequest = {}, signal?: AbortSignal, ): Promise<SessionPersistencePage>

/**
 * Read a bounded turn index without materializing the event log. Providers
 * with a searchable boundary index override this method; the default leaves
 * the optional navigation capability absent for compatibility providers.
 * @param _id - persisted session identity.
 * @param _maxItems - maximum marker count requested by the caller.
 * @param signal - optional cancellation for backend lookup work.
 * @returns the index, or undefined when this backend has no bounded index.
 */
readHistoryIndex( _id: SessionId, _maxItems: number = DEFAULT_SESSION_HISTORY_INDEX_MAX_ITEMS, signal?: AbortSignal, ): Promise<SessionHistoryIndex | undefined>

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
async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>

/**
 * Reserve a browser draft before an Agent is created. Local providers return
 * no value; Gateway providers may return a canonical Session id shared by
 * retries and other tabs carrying the same draft id.
 * @param _request - draft identity and scope metadata.
 * @returns the provider's canonical identity, or undefined when reservations are local-only.
 */
reserveDraft(_request: SessionDraftReservationRequest): Promise<SessionDraftReservation | undefined>

/**
 * Renew a provider-owned draft lease. Missing leases are intentionally no-op.
 * @param _request - draft identity and scope metadata.
 */
heartbeatDraft(_request: SessionDraftReservationRequest): Promise<void>

/**
 * Release a provider-owned draft lease after materialization or abandonment.
 * @param _request - draft identity and scope metadata.
 */
releaseDraft(_request: SessionDraftReservationRequest): Promise<void>
```

Types: [Session](session.md) · [SessionEvent](session.md) · [SessionId](core.md) · [SessionLogOffset](session.md)

Source: [`packages/session/session-persistence/src/index.ts`](../../packages/session/session-persistence/src/index.ts)
<!-- END GENERATED cordis-surface -->
