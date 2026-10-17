# Space-scoped agent memory

English | [中文](memory.zh.md)

Types shared by the durable memory service and its agent-plane consumers (`dsh-memory-context`, `dsh-tool-memory`). The [space-scoped agent memory design note](../../.agents/notes/proposed/feature/2026-10-17-space-scoped-agent-memory.md) owns the space and writer-model decisions; this page records the exact fields and variants from [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts).

## Scopes and entries

A `MemoryScope` is one addressing unit for entries. `personal` covers facts about the user that apply in every workspace; `workspace` covers facts specific to one working directory on one execution target (`directory` is the session header's `cwd`, `sshTarget` its managed SSH target id when present); `project` is the shared scope of a managed project runtime.

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

`MemoryKey` is a [branded id](core.md#branded-ids) (lowercase letters, digits, single hyphens, at most 64 characters); `MemoryRevision` is an opaque write-generation token minted on every write.

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

## Writes and refusals

```ts type-equiv
/**
 * Who is writing. `agent` writes through the model tools under the
 * `memory` execution authorization; `member` writes through the browser
 * Remote methods under the captured collaboration participant — an absent
 * participant means a runtime with no collaboration provider, which keeps
 * owner semantics. `signal` is the agent operation's cancellation carried
 * into the project authorization call. Host-only vocabulary: it names the
 * `Agent` runtime type, so it is exported from the service entry rather
 * than the client-safe `./types`.
 */
type MemoryWriter =
  | { readonly kind: 'agent'; readonly agent: Agent; readonly signal?: AbortSignal }
  | { readonly kind: 'member'; readonly participant?: CollaborationParticipant }
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
  | { readonly ok: false; readonly code: MemoryRefusalCode; readonly reason?: MemoryInvalidReason }
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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

Durable per-scope memory. Read paths (`scopesFor`, `read`, `list`, `search`) are lock-free; writes serialize on a single chain inside the service so create/duplicate, revision, and full checks stay atomic.

The `memory/*` Remote methods serve the browser surface: reads are member-wide inside a project runtime, while member writes capture the request's collaboration participant and require `rw` project membership — a runtime with no collaboration provider keeps owner semantics. The `memory` settings section switches the whole feature off: scopes vanish for agents and every write refuses `scope-unavailable`, while stored entries stay readable for the owner.

```ts cordis-catalog
/**
 * The scopes this space offers a session. `personal` space returns the
 * personal scope plus, when the session header carries `cwd`, the workspace
 * scope keyed by `(cwd, sshTarget)`; `project` space returns the shared
 * project scope only. A disabled `memory` section offers nothing, which
 * empties the injected catalog and refuses every agent write.
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
 * @param writer - Who is writing (agent or member).
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

/**
 * The member-facing scope catalog. In `personal` space it lists the
 * personal scope plus every workspace scope that holds entries; in
 * `project` space the shared project scope alone. Each view answers
 * whether the calling member may write it, so the browser only offers
 * edit controls the caller is entitled to.
 * @returns the scope catalog plus the `memory` section's enabled flag.
 */
@Remote('scopes') async memberScopes(): Promise<MemoryScopeCatalog>

/**
 * Read one scope's entries for the member browser surface. Reads are
 * member-wide inside a project runtime; a scope the space does not offer
 * simply has no records, so the answer is an empty list rather than a
 * refusal.
 * @param request - the scope to list.
 * @returns every stored entry, content included, in catalog order.
 */
@Remote('list') async memberList(request: MemoryScopeRequest): Promise<MemoryEntry[]>

/**
 * Read one entry's full body for the member browser surface.
 * @param request - the scope and raw key to read.
 * @returns the stored entry, or undefined for a missing or out-of-space key.
 */
@Remote('read') async memberRead(request: MemoryReadRequest): Promise<MemoryEntry | undefined>

/**
 * Create or replace one entry as the calling member. The service
 * captures the request's collaboration participant itself: `rw` project
 * membership is required for the project scope, and a runtime with no
 * collaboration provider keeps owner semantics. Validation, revision,
 * and capacity refusals return in the ordinary write result; a missing
 * principal or read-only membership rejects with the shared
 * `collaboration-forbidden` refusal.
 * @param request - the save input.
 * @returns the committed entry and the replaced record, or a refusal.
 */
@Remote('save') async memberSave(request: MemorySaveRequest): Promise<MemoryWriteResult>

/**
 * Remove one entry as the calling member, under the same participant
 * rules as {@link memberSave}.
 * @param request - the delete input.
 * @returns the removed entry, or a refusal.
 */
@Remote('delete') async memberDelete(request: MemoryDeleteRequest): Promise<MemoryWriteResult>
```

Types: [Agent](core.md)

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
'memory/changed'(scope: string, key: string): void
```

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)
<!-- END GENERATED cordis-surface -->
