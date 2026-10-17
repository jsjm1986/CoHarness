# 按空间划分作用域的代理记忆

[English](memory.md) | 中文

持久记忆服务与其代理侧消费者（`dsh-memory-context`、`dsh-tool-memory`）共享的类型。[按空间划分作用域的代理记忆设计说明](../../.agents/notes/proposed/feature/2026-10-17-space-scoped-agent-memory.zh.md)负责空间与写入者模型的决策；本页记录 [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts) 中的确切字段与变体。

## 作用域与条目

`MemoryScope` 是条目的一个寻址单元。`personal` 覆盖适用于所有工作区的用户事实；`workspace` 覆盖某个执行目标上某个工作目录特有的事实（`directory` 是会话头的 `cwd`，`sshTarget` 是存在时的受管 SSH 目标 id）；`project` 是受管项目运行时的共享作用域。

```ts type-equiv
/**
 * One addressing unit for memory entries. `personal` covers facts about the
 * user that apply in every workspace; `workspace` covers facts specific to
 * one working directory on one execution target (`directory` is the session
 * header's `cwd`, `sshTarget` its managed SSH target id when present, so an
 * SSH directory never aliases a host directory); `project` is the shared
 * scope of a managed project runtime.
 */
type MemoryScope =
  | { readonly kind: 'personal' }
  | { readonly kind: 'workspace'; readonly directory: string; readonly sshTarget?: number }
  | { readonly kind: 'project' }
```

```ts type-equiv
/**
 * The closed fact classification. `profile` records who the user or team is;
 * `guidance` records how the agent should work, with the reason; `background`
 * records goals, constraints, decisions, and deadlines the code does not
 * show; `resource` records where outside information lives.
 */
type MemoryKind = 'profile' | 'guidance' | 'background' | 'resource'
```

`MemoryKey` 是[品牌 id](core.zh.md#branded-ids)（小写字母、数字、单个连字符，至多 64 字符）；`MemoryRevision` 是每次写入铸造的不透明写世代令牌。

```ts type-equiv
/**
 * Who produced one entry version. `sessionId` records the writing Session
 * when the runtime knows it; `userId` records the public user id the
 * execution authority attested on an authorized project write; `at` is the
 * ISO-8601 UTC instant at millisecond precision.
 */
interface MemoryAttribution {
  readonly source: 'agent' | 'extraction' | 'consolidation' | 'member'
  readonly sessionId?: SessionId
  readonly userId?: number
  readonly at: string
}
```

```ts type-equiv
/** One durable memory entry: the catalog row plus its full Markdown body and change metadata. */
interface MemoryEntry {
  readonly scope: MemoryScope
  readonly key: MemoryKey
  readonly kind: MemoryKind
  readonly summary: string
  readonly content: string
  readonly revision: MemoryRevision
  readonly created: MemoryAttribution
  readonly updated: MemoryAttribution
}
```

```ts type-equiv
/** A catalog row: the entry without its body. */
type MemoryEntrySummary = Omit<MemoryEntry, 'content'>
```

```ts type-equiv
/** One ranked search result: the catalog row, a bounded content excerpt, and the relevance score. */
interface MemorySearchHit {
  readonly entry: MemoryEntrySummary
  readonly excerpt: string
  readonly score: number
}
```

## 写入与拒绝

```ts type-equiv
/**
 * Who is writing. The union is open for later writer kinds (members editing
 * in the browser); only `agent` exists today. `signal` is the operation's
 * cancellation carried into the project authorization call.
 */
type MemoryWriter = { readonly kind: 'agent'; readonly agent: Agent; readonly signal?: AbortSignal }
```

```ts type-equiv
/** Validated save input. `expectedRevision` absent means create-only; present means replace-only. */
interface MemorySaveRequest {
  scope: MemoryScope
  key: string
  kind: MemoryKind
  summary: string
  content: string
  expectedRevision?: MemoryRevision
}
```

```ts type-equiv
/** Validated delete input; `expectedRevision` guards against removing a newer change. */
interface MemoryDeleteRequest {
  scope: MemoryScope
  key: string
  expectedRevision?: MemoryRevision
}
```

```ts type-equiv
/**
 * The write outcome. `operation` distinguishes create from replace for save
 * and carries the removed record for delete; `previous` holds the replaced
 * record on update only. Refusals carry the failure class; `reason` is set
 * only for `memory_invalid`.
 */
type MemoryWriteResult =
  | { readonly ok: true; readonly operation: 'create' | 'update' | 'delete'; readonly entry: MemoryEntry; readonly previous?: MemoryEntry }
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason: MemoryInvalidReason | undefined }
```

```ts type-equiv
/** Stable machine-routable refusal classes returned by {@link MemoryWriteResult}; never parse messages. */
type MemoryRefusalCode = 'memory_exists' | 'memory_not_found' | 'memory_stale' | 'memory_full' | 'memory_invalid'
```

```ts type-equiv
/** Which write rule rejected a `memory_invalid` request; set only for that code. */
type MemoryInvalidReason = 'key' | 'summary' | 'content' | 'query' | 'scope-unavailable' | 'workspace-mismatch'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

Durable per-scope memory. Read paths (`scopesFor`, `read`, `list`, `search`) are lock-free; writes serialize on a single chain inside the service so create/duplicate, revision, and full checks stay atomic.

```ts cordis-catalog
/**
 * The scopes this space offers a session. `personal` space returns the
 * personal scope plus, when the session header carries `cwd`, the workspace
 * scope keyed by `(cwd, sshTarget)`; `project` space returns the shared
 * project scope only.
 * @param agent - The session's agent.
 * @returns scopes in catalog order.
 */
scopesFor(agent: Agent): readonly MemoryScope[]

/**
 * Look up one entry by scope and raw key. A malformed key simply cannot
 * exist, so this resolves `undefined` rather than raising.
 * @param scope - The scope to read.
 * @param key - Raw key text.
 * @returns the stored entry, if any.
 */
async read(scope: MemoryScope, key: string): Promise<MemoryEntry | undefined>

/**
 * Catalog rows of one scope in catalog order: kind (guidance, profile,
 * background, resource), then `updated.at` desc, then key asc.
 * @param scope - The scope to list.
 * @returns the ordered catalog rows (entries without bodies).
 */
async list(scope: MemoryScope): Promise<MemoryEntrySummary[]>

/**
 * Bounded term search across scopes. Scores every entry (key ×3, summary
 * ×2, content ×1; whole-query containment `+10×w`, per contained term
 * `+w×(1+min(occurrences,5))`), keeps score > 0, orders score desc,
 * `updated.at` desc, key asc, caps at `searchMaxResults`.
 * @param scopes - Scopes to search (typically {@link scopesFor}).
 * @param query - Raw query; NFKC-folded and lowercased.
 * @returns ranked hits, or a `memory_invalid`/`query` refusal on empty input.
 */
async search( scopes: readonly MemoryScope[], query: string, ): Promise<MemorySearchHit[] | { ok: false; code: 'memory_invalid'; reason: 'query' }>

/**
 * Create or replace an entry. Without `expectedRevision` the write is
 * create-only (`memory_exists` when the key is used); with it the write is
 * replace-only (`memory_not_found`, `memory_stale`). Replaces are immune to
 * the scope cap; creates refuse `memory_full` at it.
 * @param request - The save input.
 * @param writer - Who is writing (agent today).
 * @returns the committed entry and the replaced record, or a refusal.
 */
save(request: MemorySaveRequest, writer: MemoryWriter): Promise<MemoryWriteResult>

/**
 * Remove an entry. `expectedRevision` absent deletes unconditionally;
 * present deletes only on a match (`memory_stale` otherwise). A missing key
 * is always `memory_not_found`.
 * @param request - The delete input.
 * @param writer - Who is deleting.
 * @returns the removed entry, or a refusal.
 */
delete(request: MemoryDeleteRequest, writer: MemoryWriter): Promise<MemoryWriteResult>
```

Types: [Agent](core.zh.md)

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

<a id="memory-events"></a>

### `memory/*` events

<a id="memorychanged--emit"></a>

#### `memory/changed` — emit

Emitted after a memory write commits. Consumers re-read through the service; the payload names the touched scope id and key only.

```ts cordis-catalog
/**
 * Emitted after a memory write commits. Consumers re-read through the
 * service; the payload names the touched scope id and key only.
 * @mode emit
 * @param scope - The scope id of the written entry.
 * @param key - The entry key.
 */
'memory/changed'(this: Context, scope: string, key: string): void
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
