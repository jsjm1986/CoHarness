---
description: "Background memory curation: a turn-end extraction pass that saves durable facts and an interval-gated whole-scope consolidation pass, both as restricted-tool purpose:memory auxiliary requests"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-curation

English | [中文](README.zh.md)

The background writer half of the memory subsystem: after a successfully completed turn it replays the conversation to an auxiliary model call that saves durable facts, and on a separate schedule it consolidates a whole scope's entries — both behind `memory` settings switches that default off.

Queued or running curation passes veto automatic Host-process release through `runtime/idle-release-check` until their iterator cleanup and admitted writes settle. Finishing the main conversation turn does not make its background curation idle.

## Summary

`dsh-memory-curation` is a function plugin (`name = 'memory-curation'`, `inject = ['memory']`). A `session/event` listener folds each turn's facts; on a `completed` `turn/end` it snapshots the replay prefix and queues one coalesced pass per session — one running, at most one pending — that may run **extraction** (review the finished conversation for durable facts) and **consolidation** (merge a whole scope). Both run as `purpose: 'memory'` requests replaying the session prefix for KV-cache reuse, execute only the four memory tools through `ctx.memory` with a source-stamped writer, and persist progress cursors in the memory domain.

## Table of Contents

- [Configuration](#configuration)
- [Extraction](#extraction)
- [Consolidation](#consolidation)
- [The restricted tool loop](#the-restricted-tool-loop)
- [Cursors and attribution](#cursors-and-attribution)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

Feature switches live in the `memory` settings namespace (`extraction`, `consolidation` — both default off); the fields below tune model output, scheduling and write budgets.

| Field | Type | Default | Bounds |
|---|---|---|---|
| `maxOutputTokens` | integer | `5000` | positive safe integer (independent auxiliary model output cap) |
| `extractionMaxWrites` | integer | `4` | 1–20 (`memory_save`/`memory_delete` commits per extraction pass) |
| `maxToolRounds` | integer | `8` | 1–24 (model requests inside one pass) |
| `consolidationMaxWrites` | integer | `8` | 1–40 (`memory_save`/`memory_delete` commits per consolidation run) |
| `consolidationMinChanges` | integer | `6` | 1–1000 (admitted scope mutations that re-arm a run) |
| `consolidationIntervalMs` | integer | `86400000` | 60000–2592000000 (minimum spacing between a scope's runs) |

<a id="extraction"></a>
## Extraction

On a `turn/end` observed with `reason.kind === 'completed'`, the pass skips when:

- the `extraction` switch is off, the session is delegated (`delegationDepthOf(agent) > 0`), or the session cannot reach an agent;
- the turn's fold saw no human-authored `user/message` carrying at least three signal words (whitespace tokens plus one unit per Han ideograph — a one-word acknowledgement never reviews), or saw a `memory_save`/`memory_delete` `tool/call` — a turn that already curated itself needs no review;
- `ctx.memory.scopesFor(agent)` offers no writable scope, or — in `project` space — `authorize('memory')` denies during initial admission or a later authorization recheck;
- no `llm` service is present or no provider/model resolves (one warning per session);
- the session's durable extraction cursor already reached this `turn/end`'s seq — interrupted passes review the same slice again.

Otherwise the replayed prefix plus the verbatim extraction instruction (with the current catalog and the write cap interpolated) streams as one `purpose: 'memory'` request; the model drives the restricted tool loop below. The extraction cursor commits only after the loop completes, so a cancelled or failed pass re-reviews the same slice next time.

The pending slot retains the latest capture eligible for extraction. A later acknowledgement or turn that already performed a memory write cannot replace it: its replay prefix, cursor target, and triggering participant remain together. When no eligible capture is pending, later completed turns can replace the slot for consolidation evaluation.

<a id="consolidation"></a>
## Consolidation

Each pass also evaluates every scope `scopesFor(agent)` offers against three gates — `lastRunAt` older than `consolidationIntervalMs`, `changedSince` at least `consolidationMinChanges` admitted mutations (the service persists this conservative counter before each entry mutation), and a sha256 content digest over the scope's `[key, summary, content]` tuples that differs from the last run's — and runs a whole-scope pass for each that qualifies. The consolidation request is a standalone message (no conversation replay) carrying the verbatim instruction and the scope's complete catalog; its writer source is `consolidation`. The cursor — `lastRunAt`, `lastDigest`, `changedSince: 0` — commits after the run's writes land only if no unrelated mutation or newer review changed the observed cursor. A concurrent change remains eligible for a later review; unchanged content does not trigger another model call.

A curation plugin holds each scope from eligibility checks through model cleanup and conditional cursor commit. Concurrent Sessions addressing that scope coalesce into its active review; different directory and SSH-target scope identities remain independent. A failed or cancelled review releases the scope without advancing its progress, so a later completed turn can retry. Each scope decision rechecks the feature switches and the triggering execution provider. See the [scope scheduling decision](../../../.agents/notes/implemented/bug-fix/2026-10-31-memory-consolidation-coalescing.md).

Every consolidation tool is confined to that selected scope, including searches without a filter. An omitted scope selects the reviewed scope; an explicit different or unavailable scope returns an error before storage access. Extraction retains the scopes offered when its pass starts, intersected with the agent's current scopes. See the [scope decision](../../../.agents/notes/implemented/bug-fix/2026-10-28-memory-curation-scope.md).

<a id="the-restricted-tool-loop"></a>
## The restricted tool loop

Both passes share one bounded loop: stream a request, execute `tool-call` blocks, feed results back, repeat until the model stops calling tools or `maxToolRounds` trips. Every request rides the model's lowest advertised reasoning effort and the independent `maxOutputTokens` cap (default 5,000) — the auxiliary-call posture, never the conversation's tuned settings. Only `memory_search`, `memory_read`, `memory_save`, and `memory_delete` are executable — a call to anything else returns an error result to the model — and each save/delete counts against the pass's write budget. Writes go through `ctx.memory.save`/`delete` with `{ kind: 'agent', agent, source }`, so the service's validation, scope admission, project authorization, and serialized write chain all still apply; an `execution/forbidden` denial surfaces to the model as an error result rather than a thrown `RemoteError`. Cancellation aborts the stream and prevents subsequent tool, entry, and completion-cursor admission. The pass passes its signal into queued cursor writes; durable writes already admitted are not rolled back.

Every storage completion, prepared model call, tool result and completion-cursor admission checks current switches and offered scopes. Turning off `enabled` cancels both operations; turning off `extraction` or `consolidation` cancels only that operation. Its lane waits for cleanup before running another operation, retains queued turns, and leaves cancelled progress uncommitted. Owner reads and admitted durable writes remain available. See the [live operation decision](../../../.agents/notes/implemented/bug-fix/2026-10-31-memory-curation-live-availability.md).

Each round fixes its adapter and settings through `prepareCall()` and records `memory/curation-request` before dispatch, with the pass kind, zero-based round and exact immutable messages, tools, tool history and model settings. Requests explicitly retain their triggering Session execution origin through LLM resource admission. Logging failure prevents dispatch. These log-only events do not enter the primary conversation; extraction cursors still identify the reviewed completed turn. See the [request and lifetime decision](../../../.agents/notes/implemented/bug-fix/2026-10-24-memory-auxiliary-ownership.md).

Settings-provider replacement and composition fallback use the [memory service availability notification](../memory/README.md#events), so queued work also cancels when the new effective source disables its operation.

<a id="cursors-and-attribution"></a>
## Cursors and attribution

Two durable cursor records live in the memory domain's `cursors` table (the service stays the sole write owner): `extraction-{sessionId}` holds `lastSeq`; `consolidation-{scopeId}` holds `lastRunAt`, `lastDigest`, and `changedSince`. Every write stamps `updated` attribution with `source` `extraction` or `consolidation`, the initiating session id, and — in project space — the authorized primary-actor user id carried on `executionIdentity`.

Each queued pass captures the triggering turn's execution participants and issuing provider. It keeps those participants through asynchronous preparation, model admission, tools and cursor commits. Project curation rechecks `authorize('memory')` before each round, after its response and immediately before cursor persistence inside the write queue. Its `llm/pre-dispatch` listener also checks after capacity admission and before adapter-owned physical requests. A removed or replaced issuer refuses the captured work; the replacement cannot lend its actor or permission. These checks do not reserve or bill additional model requests. A capture failure skips background curation without failing the completed primary turn. See the [authorization decision](../../../.agents/notes/implemented/bug-fix/2026-11-01-memory-curation-authority.md).

Plugin unloading aborts the lanes and waits for every active pass, including cleanup already triggered by Session disposal. Each memory tool checks cancellation before execution, and the service checks again before admitting an entry or queued cursor. Admitted durable writes remain owned until they settle.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The pass derives entirely from committed session events, the session's surface projections, and durable memory-domain state; it keeps no private index an invariant could compare against.

Consolidation commits its cursor conditionally against the observed record plus the pass's own successful writes. A concurrent member edit, another review, or an empty-scope change keeps the newer counter and review metadata intact, so a pending pass can review the changed content.

<a id="model-experience"></a>
## Model Experience

### Extraction request

#### What the model sees

The session's own replayed prefix (system head, surface messages, header tools) plus one user-role instruction message: the verbatim extraction text, the `<saved_memory_catalog>` block listing current entries, the scope rule, and the write cap — ending with "one line listing the memory keys you wrote, or the line 'no memories saved'". The model answers and calls memory tools exactly as the conversation's tools taught it.

#### Token effect

One request plus up to `maxToolRounds` tool rounds per eligible completed turn, skipped entirely when the switch is off, the turn had no human input, the turn already wrote memory, or the cursor covers it; writes capped at `extractionMaxWrites`.

#### KV Cache effect

The request replays the session's last request prefix verbatim — derived messages plus the request header's tool list — so the provider's prefix cache hits on the shared head; only the appended instruction and tool rounds are new tokens. The replayed tool list stays the session's own for cache fidelity while the executable universe remains the four memory tools.

### Consolidation request

#### What the model sees

One standalone user-role message: the verbatim consolidation text naming the scope, the `<saved_memory_catalog>` block of the scope's complete entries, and the write cap — ending with per-action lines or "no changes". Tool visibility is restricted to the four memory schemas.

#### Token effect

One request plus tool rounds per qualifying scope, gated so quiet scopes cost nothing: below `consolidationMinChanges`, inside `consolidationIntervalMs`, or an unchanged content digest means zero calls.

#### KV Cache effect

The standalone prompt shares no prefix with the conversation, but repeats verbatim across runs until scope content changes — the catalog block order is deterministic, so an unchanged scope's request is byte-stable and cache-friendly across passes.

## Known Limitations and Deferred Work

- **Extraction reviews only the replayed surface** — compacted-away turns contribute nothing; the cursor still advances past them because the review can only see what survived.
- **One pass in flight per session** — a second completed turn queues behind the first and coalesces; rapid turns merge into one pending capture rather than one pass each.
- **The selector and writer are the same model** — extraction quality depends on the conversation model's judgment inside a bounded loop; there is no dedicated curation model or human review.
- **Consolidation waits for a session** — gates trip only when a pass runs; a scope nobody revisits is never consolidated even past its interval.
- **No cross-scope merging** — each consolidation pass sees exactly one scope; duplicates across personal/workspace scopes survive until a per-scope pass addresses them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- `session/event` is the fold source: turn facts arrive with committed events, so `turn/end` never scans history; the replay prefix reads `deriveMessages()`/`requestHeader()`/`toolHistory()` at trigger time.
- A session owns one lane controller; session disposal and plugin unload abort it. Plugin disposal waits for every active task, including tasks whose sessions have already been removed from the lane map.
- Writer `signal` rides on `MemoryWriter` so project authorization inside `save`/`delete` observes the same cancellation as the model stream.

</details>
