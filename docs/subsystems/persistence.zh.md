# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.zh.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.zh.md)中逐项列举。

该 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)：一个抽象服务（[dsh-session-persistence](../../packages/session/session-persistence)，`ctx.sessionPersistence`）在现有 `SessionEvent` 上定义 locate/create/append、可复用的 Session 准备流程、逻辑 load/inspect、有界页面与轮次索引读取、物理后缀读取，以及轻量的 list/snapshot 观察——**没有平行的持久化事件类型**——以及三个实现同一约定的可互换提供方。见 [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.zh.md)。

## flush 检查点

`session/event` 是一个*同步*通知；持久化插件会将事件复制到逐会话控制器，而不阻塞生产方。第一个待处理事件会开启固定批处理窗口，后续事件会加入但不会重置截止时间。窗口到期后会启动一个持久化批次；该次写入期间接纳的事件会获得自己的截止时间，并形成后续批次。`session/flush` 会取消等待并排空至完全停稳，因此循环仍将其用作在领取下一个普通轮次之前的顺序与错误观察检查点。后台写入被拒绝时会保留对应事件并暂停自动重试；新事件会开启新的固定窗口，而显式 flush 会立即重试，并通过 `agent/error` 和 logger 报告失败，绝不会把失败记录成已关闭轮次之后的会话事件。dispose（资源释放）会执行同样的最终排空。配置的最大值只限制有意的批处理等待，不限制事件循环调度或后端完成持久化的延迟（[决策](../../.agents/notes/implemented/architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)）。

## 崩溃恢复保留被中断的轮次

后端重新加载一个在轮次中途崩溃的日志时，会发现一个已打开的 `turn/start` 却没有 `turn/end`。它**不会**截断日志：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。后端改为用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关闭这个遗留轮次，在不改变其前后任何独立事件的情况下配平被中断的执行。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.zh.md#why-a-turn-ended-turnendreasonmap)）。

修复仅适用于冷会话。对于活跃 id，`SessionPersistence.load(id)` 会等待权威内存快照完成持久化，并且只在日志平衡时返回；若活跃轮次仍未闭合，则拒绝操作，而不是添加合成的中断边界。HMR（热模块替换）会接管活跃前缀，而不会关闭其中正在进行的轮次。

`SessionPersistence.inspect(id)` 会构造一个不可变的逻辑 Session，但不发布它，也不写入恢复内容。冷检查会在内存中配平中断的轮次，同时保持撕裂的物理尾部不变；检查已处于活跃状态的 Session 则借用其当前不可变快照，因此可能包含未闭合的轮次。使用协调器的实现会在有界 LRU 中保留这个精确的冷未发布 Session，因此重复历史读取与后续 `prepare(id)` 可复用同一次读取、解压、验证、冻结及 Session 构造。`prepare(id)` 会预留该 Session、提交待处理修复并返回可 dispose 的发布句柄；`load(id)` 使用相同机制提交修复，但不会发布 Session。该生命周期由 [Session 准备阶段决策](../../.agents/notes/implemented/architecture/2026-08-05-session-preparation.zh.md)定义。

## `SessionLocation`——可选的逐会话产物目标

`SessionPersistence.locate(meta)` 会同步解析一个归后端所有的独立产物，而不会读取、创建或 flush 它。JSONL 返回其项目/会话目录内 transcript（文本记录）的绝对路径；SQLite 因各会话共享一个数据库而返回 `undefined`。因此，返回的路径可能指向尚不存在的文件，或指向还不包含当前尚未 flush 轮次的文件；它是位置提示，不是授权或新鲜度保证。

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

## `SessionHeader`：日志旁的元数据

每个会话的元数据与事件日志**分开**存储：header 携带格式版本、cwd 与 `isSeeded` 谱系 bit，含正文的存储值则在其旁边单独携带精确 inherited cut。二者都不进入 `SessionEventMap`，也不会到达 `deriveMessages()`。logical header 通过 `session.header` 附加，Session 则以 `inheritedEventCount` 暴露其 cut。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

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

## 格式拒绝：本构建无法可靠读取的日志

后端用 `SessionFormatUnsupportedError` 拒绝无法可靠解读的日志，它与 `SessionPersistenceCorruptionError` 区分，因为数据没有损坏。header 的 `version` 比 `SESSION_FORMAT_VERSION` 新时，消息说明方向（"由更新的 harness 写入，请升级 harness 后打开"）。受支持的 v0/v1 header 和事件会先通过相邻 migration catalog，再构造当前 Session；缺少迁移边或目标记录格式错误时会明确拒绝。迁移后，本构建生成词汇表（`KNOWN_SESSION_EVENT_TYPES`，由 `gen-persistence-catalog` 生成）之外的事件类型同样被拒绝，除非该事件的信封带 `ignorable: true`。JSONL provider 会在保留源文件的同时发布迁移后的当前 generation；SQLite 继续使用单调递增的 `SCHEMA_VERSION` 检查整个文件结构。

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时会接收 `seed`（初始回放或 fork 历史）、可选的精确 `inheritedEventCount` 与 `meta`（store 整合进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并为 `createdAt` 提供默认值；调用方可以提供已校验的绝对 `cwd`、`parentSession` 谱系、`isSeeded` 谱系标记、可选的粗粒度 `origin`、`delegationDepth`、用于组装该 agent（智能体）的 `agentPreset` 以及已有的 `createdAt`。seeded 创建必须同时显式提供 seed 与精确 cut，因为继承前缀之后还可能存在 child-owned setup event。`origin: 'subagent'` 让产品导航能够隐藏重复的 child 行；它不证明描述符有效，也不证明 child 可以恢复。

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

因此，普通回放的调用方式为 `ctx.sessions.create(id, { seed: seedEvents })`；fork 还会提供 `inheritedEventCount` 与 `meta.isSeeded: true`。将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## `SessionStorageMetadata`：逻辑 header 与继承 cut

每个读取 Session 正文的持久化结果都携带 `SessionStorageMetadata`：当前逻辑 header，以及单独校验的继承事件 cut。仅 header 的列表操作有意只返回 `SessionHeader`。

```ts type-equiv
/** Logical Session header paired with its exact inherited cut for body-bearing storage operations. */
interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}
```

## `SessionRawArtifact`——逐字存储工件文本

后端为单个会话自持的工件文本，与其持久化写入的字节逐字一致（按物理编码解码）。`readRaw` 返回它而不从解析后事件重建，因此后端特定的序列化（chunk 打包、键序、换行）得以保留。Consumer 须先检查 `supportsRawArtifacts`：`false` 表示后端不提供此能力（如 SQLite），而 `readRaw(...) === undefined` 表示受支持的后端没有该会话的已实体化工件。

```ts type-equiv
/** A backend's own raw artifact text for one session, verbatim. */
interface SessionRawArtifact extends SessionStorageMetadata {
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}
```

## 准备与恢复所有权

`SessionStore.prepare()` 接收普通创建选项，或通过 `RestoredSessionOptions` 转移所有权的全新的持久化对象图。恢复分支会就地验证并冻结转移来的 header 与事件，因此调用方不得保留可变别名。`SessionPreparation` 随后持有该精确的未发布 Session，直至发布或回滚；dispose 是同步且幂等的。持久化检查只暴露 `SessionInspection`，即从同一个已准备 Session 借用的不可变逻辑视图。

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

## 分离的持久日志后缀

`readFrom` 返回以请求的 `fromSeq` 为锚点、与其他状态分离的 `SessionEventSuffix`。其事件列表可能从非零位置开始，也可能为空，因此它不是完整的 `SessionInspection`，不得作为完整 Session 恢复。

```ts type-equiv
/** Detached logical suffix returned by one explicit stored-log offset read. */
interface SessionEventSuffix extends SessionStorageMetadata {
  /** First requested log offset; {@link events} contains only seqs at or after it. */
  readonly fromSeq: SessionLogOffset
  /** Valid contiguous stored events at or after {@link fromSeq}; not a complete Session log when the offset is nonzero. */
  readonly events: readonly SessionEvent[]
}
```

## 轻量源修订号

派生状态的消费方会在加载完整事件日志之前比较一个低开销的不透明修订号。其表示由持久化后端拥有，并随 append 或会修改数据的 load 修复以事务方式改变；调用方仅比较修订号是否相等。

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

## 后端

两者都实现同一个抽象 `SessionPersistence`（在 `SessionEvent` 上执行 locate/create/append/prepare/load/inspect/readFrom/list/listSnapshots，观察方法可选支持取消），并通过共享的 `runPersistenceContract` 套件：

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)**——逐会话仅追加的逻辑 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；支持崩溃安全的原子写入、被中断轮次的恢复以及读取/回放路径。
- **[dsh-session-persistence-sqlite](../../packages/session/session-persistence-sqlite)**：一个可选启用的 `node:sqlite` 后端，使用 schema 17 把同一分片块中字段完全匹配的 delta 连续段存为有界物理 `text-chunks`、`reasoning-chunks` 与 `tool-call-chunks` 行。它在返回前重建完整逻辑事件流，只打包新增的持久批次，并拒绝旧 schema，而不是执行迁移。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.zh.md) · [SessionEvent](session.zh.md) · [SessionId](core.zh.md) · [SessionLogOffset](session.zh.md)

Source: [`packages/session/session-persistence/src/index.ts`](../../packages/session/session-persistence/src/index.ts)
<!-- END GENERATED cordis-surface -->
