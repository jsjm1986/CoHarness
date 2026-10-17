---
description: "Background memory curation: a turn-end extraction pass that saves durable facts and an interval-gated whole-scope consolidation pass, both as restricted-tool purpose:memory auxiliary requests"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-curation

English | [中文](README.zh.md)

The background writer half of the memory subsystem: after a successfully completed turn it replays the conversation to an auxiliary model call that saves durable facts, and on a separate schedule it consolidates a whole scope's entries — both behind `memory` settings switches that default off.

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

Feature switches live in the `memory` settings namespace (`extraction`, `consolidation` — both default off); the fields below tune scheduling and write budgets.

| Field | Type | Default | Bounds |
|---|---|---|---|
| `extractionMaxWrites` | integer | `4` | 1–20 (`memory_save`/`memory_delete` commits per extraction pass) |
| `maxToolRounds` | integer | `8` | 1–24 (model requests inside one pass) |
| `consolidationMaxWrites` | integer | `8` | 1–40 (`memory_save`/`memory_delete` commits per consolidation run) |
| `consolidationMinChanges` | integer | `6` | 1–1000 (committed scope mutations that re-arm a run) |
| `consolidationIntervalMs` | integer | `86400000` | 60000–2592000000 (minimum spacing between a scope's runs) |

<a id="extraction"></a>
## Extraction

On a `turn/end` observed with `reason.kind === 'completed'`, the pass skips when:

- the `extraction` switch is off, the session is delegated (`delegationDepthOf(agent) > 0`), or the session cannot reach an agent;
- the turn's fold saw no human-authored `user/message`, or saw a `memory_save`/`memory_delete` `tool/call` — a turn that already curated itself needs no review;
- `ctx.memory.scopesFor(agent)` offers no writable scope, or — in `project` space — `authorize('memory')` denies, checked **before** the first model call;
- no `llm` service is present or no provider/model resolves (one warning per session);
- the session's durable extraction cursor already reached this `turn/end`'s seq — interrupted passes review the same slice again.

Otherwise the replayed prefix plus the verbatim extraction instruction (with the current catalog and the write cap interpolated) streams as one `purpose: 'memory'` request; the model drives the restricted tool loop below. The extraction cursor commits only after the loop completes, so a cancelled or failed pass re-reviews the same slice next time.

<a id="consolidation"></a>
## Consolidation

Each pass also evaluates every scope `scopesFor(agent)` offers against three gates — `lastRunAt` older than `consolidationIntervalMs`, `changedSince` at least `consolidationMinChanges` committed mutations (the service bumps this counter inside every committed write), and a sha256 content digest over the scope's `[key, summary, content]` tuples that differs from the last run's — and runs a whole-scope pass for each that qualifies. The consolidation request is a standalone message (no conversation replay) carrying the verbatim instruction and the scope's complete catalog; its writer source is `consolidation`. The cursor — `lastRunAt`, `lastDigest`, `changedSince: 0` — commits only after the run's writes land, so a repeated run over unchanged content does nothing and an interrupted run re-arms itself.

<a id="the-restricted-tool-loop"></a>
## The restricted tool loop

Both passes share one bounded loop: stream a request, execute `tool-call` blocks, feed results back, repeat until the model stops calling tools or `maxToolRounds` trips. Only `memory_search`, `memory_read`, `memory_save`, and `memory_delete` are executable — a call to anything else returns an error result to the model — and each save/delete counts against the pass's write budget. Writes go through `ctx.memory.save`/`delete` with `{ kind: 'agent', agent, source }`, so the service's validation, scope admission, project authorization, and serialized write chain all still apply; an `execution/forbidden` denial surfaces to the model as an error result rather than a thrown `RemoteError`. Cancellation aborts the stream, and the pass publishes no cursor after its signal fires.

<a id="cursors-and-attribution"></a>
## Cursors and attribution

Two durable cursor records live in the memory domain's `cursors` table (the service stays the sole write owner): `extraction-{sessionId}` holds `lastSeq`; `consolidation-{scopeId}` holds `lastRunAt`, `lastDigest`, and `changedSince`. Every write stamps `updated` attribution with `source` `extraction` or `consolidation`, the initiating session id, and — in project space — the authorized primary-actor user id carried on `executionIdentity`.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The pass derives entirely from committed session events, the session's surface projections, and durable memory-domain state; it keeps no private index an invariant could compare against.

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
- The lane map is one `AbortController` per session — session disposal and plugin unload both abort it; a `finally` in `drive` drains the pending capture so the queued turn's pass still runs.
- Writer `signal` rides on `MemoryWriter` so project authorization inside `save`/`delete` observes the same cancellation as the model stream.

</details>
