# Agent Note: Bounded runtime work and teardown fences

Status: implemented

English | [中文](2026-08-27-bounded-runtime-work-and-teardown-fences.zh.md)

## Problem

Gateway and SDK transports, provider streams, persistence writers, and document brokers could retain work in memory for as long as an untrusted peer or a slow upstream continued producing it. Several asynchronous owners also admitted new work while their fibers, runtimes, or loader entries were being disposed. A late completion could therefore leak a child process, remount a dynamic package, or keep a request alive after its owner had gone away.

## Decision

Every untrusted or externally paced stream now has an owning positive budget at the point that accepts it. JSON-RPC bounds input-line bytes, pending requests, concurrent inbound handlers, output buffering, sessions, prompt blocks, and prompt bytes; its TypeScript and Python readers retain fragmented lines without repeated prefix copies. DeepSeek bounds provider error bodies, incomplete SSE frames, generated text, and streamed tool arguments. Code Mode, session persistence, and document transfer bound retained queues, plans, and response bodies. Gateway proxy operations have configurable timeout and response-byte limits.

Runtime work holds an operation reference from authorization through the final response byte, so idle reaping cannot stop a process underneath an active request. Readiness is an HMAC challenge tied to the launch token, nonce, and exact runtime identity. Settings registrations, client session scopes, dynamic Host/Client runners, and subprocess owners close admission before teardown and await already-started work; late loader entries and process-tree children receive explicit cleanup. Revision-aware model projections refresh before use and retry asynchronously, so a committed database change is not reported as a failed transaction merely because its file projection was temporarily unavailable.

Runtime lease admission, activity touches, and idle reaping share one per-runtime serialization queue. A stop that wins before a new lease returns a retryable refusal; proxy callers start a fresh generation, while document and archive brokers fail without forwarding a stale port. Timer-backed Gateway and SDK settings reject values above Node's maximum delay.

Idle reaping rechecks each candidate through an indexed per-runtime predicate rather than rescanning the complete idle catalog for every candidate, and lease admission maintains O(1) per-runtime totals alongside generation-specific reference maps. Gateway shutdown stops local runtimes through a fixed worker pool instead of starting one teardown task per process at once.

JSONL metadata reads cap header bytes and bound revision-stability retries by both attempts and elapsed time. Zstandard raw, load, and recovery reads enforce a total decompressed-byte budget; header probing grows its input buffer geometrically instead of concatenating every chunk.

Workspace archive enumeration indexes persisted IDs, lineage roots, and retained placement before matching archived sessions. Runtime archive projection uses revision-stamped batches bounded by session IDs, search rows, search bytes, and per-row index text; a final root summary preserves aggregate message counts when one lineage spans batches without changing the transcript. Concurrent triggers collapse into one follow-up pass, command responses are paged and drained, and disposal aborts and joins the active request. A successful purge removes the deleted tree from the durable archive set before the follow-up projection, so stale IDs do not become permanent synchronization failures. Workspace and PostgreSQL archive mutations accept only non-negative safe-integer revisions and reject mutation at `Number.MAX_SAFE_INTEGER` instead of publishing a repeated value. The personal archive reader caches titles during synchronization so a later request can pass its per-session sequence floor to persistence instead of rereading every prefix. Gateway conversation loads read the header, revision, and events in one read-only `REPEATABLE READ` transaction.

The runtime archive synchronizer also retains bounded title, count, and search projections in a generation-fenced LRU; a contiguous live event extends a cached session in constant queue work, while a sequence gap, title event, or event racing an asynchronous read invalidates only that session and cannot publish stale cached data. Generation tokens leave with removed or evicted sessions instead of forming an unbounded companion map. Metadata-only transfer plans additionally carry process-, organization-, and actor-level count and serialized-byte budgets; expiry and commit consume the same indexed counters, so one actor cannot monopolize the process map with large document identifiers.

Detached conversation-tail cache validation calls `SessionPersistence.revision(id)` instead of listing every persisted session. First-party JSONL, SQLite, and Gateway providers delegate that service method to their per-id revision lookup; the Service Definition retains a `listSnapshots()` fallback for third-party providers. A cache hit therefore avoids a catalog scan without weakening the before/after revision check around a cold history read.

Continuable subagent materialization reserves configurable runtime-global and direct-parent Activation slots before Agent creation or resume. Pending materializations count with resident Activations, while rollback and final disposal release the exact slots; inactive durable child Sessions consume no slot. The [continuable-subagent decision](../feature/2026-07-28-continuable-subagent-conversations.md) owns the residency and capacity semantics.

Filesystem and document lifecycle paths re-check real-path containment and symlink ownership at each destructive or publication step. User documents have a provider-owned trash lifecycle with bounded metadata pages and retention-based purge. Browser resumable-upload metadata expires with its server session (with a bounded fallback lifetime for legacy records) and is capped by count and serialized bytes in both storage backends. Local request-image derivatives use access-time TTL/LRU cleanup with count and byte limits, and the DeepSeek adapter prepares them in fixed batches so completed projections cannot accumulate behind a slow first item. These checks complement the focused decisions for [Gateway readiness](2026-08-26-document-scope-runtime-readiness.md), [session write batching](../architecture/2026-08-08-bounded-session-persistence-write-batching.md), and [subprocess exit cleanup](2026-08-11-synchronous-subprocess-exit-cleanup.md).

DeepSeek wire translation validates chunk objects, usage counters, and bounded tool-call metadata before mutating state. Host document consumers stream and cap runtime JSON responses, PostgreSQL overview filters and pages in SQL, and systemd units render argv fields with explicit escaping. Archive runtime-read replacements are checked against the same descendant, event, and byte budgets as the SQL fallback before they can replace indexed data. SDK ancestry and per-session lock maps release completed entries; permanent administrator document purge requires confirmation, and document-catalog user references are organization-qualified. The display-only client lineage projection uses iterative traversal with fixed depth and expanded-node limits; summaries beyond either limit remain visible as root rows.

SDK notification subscriptions retain their bounded queue and waiter lists in head-indexed FIFO storage. Delivery and close semantics remain unchanged while repeated notification consumption no longer shifts the whole retained tail. Browser WebSocket downlinks use the same head-indexed approach with 1,024-frame and 8 MiB burst limits; an overfull downlink closes its socket so the connection generation can reconnect.

LLM text-thinking, the canonical BlockAssembler, and pi-ai ordering buffers retain append-only fragments and join them at classification or block close instead of repeatedly copying the accumulated prefix; the provider-neutral guard also checks pending thinking prefixes incrementally and refuses an ordering backlog above its fixed chunk and byte safety limits. Profile dependency discovery and Typert reachability walks use the same cursor pattern during large builds.

PostgreSQL document-catalog sync applies validated removal lists with one scoped update and history batch, avoiding one transaction per removed document while preserving the compatibility fallback for older providers.

PostgreSQL project-invitation listing returns the complete authorized row set in one joined query instead of issuing one detail query per invitation.

Startup reconciliation inserts missing project instance rows in one typed-array statement after the locked first-free port allocation, so project churn does not turn boot into one database round trip per runtime.

The E2B collect-mode output tail also uses a head-indexed chunk queue, so its existing byte bound remains exact without O(n²) `shift()` work under fragmented remote callbacks.

The shared `TextRetainer` uses the same cursor discipline for suffix text, keeping tail and head-tail retention bounded without repeated array-head movement on fragmented process or HTTP chunks.

ACP prompt reconstruction and spill-policy text flattening also retain text fragments and join once, so a prompt or tool result made of many small blocks does not repeatedly copy its accumulated prefix.

The line-oriented terminal sanitizer uses the same fragment accumulation for one PTY callback, preserving prompt-tail tracking without repeated string growth when escape sequences split the output.

The local attachment compression limiter also advances a FIFO cursor instead of shifting its waiting list, preserving the configured image-work concurrency under a large queued burst.

The worker-thread workflow engine advances queued concurrency waiters with a head cursor, preserving FIFO order without moving the retained tail on every released slot. Subagent cold listings cap admitted candidates at 10,000 and serialized session headers at 16 MiB before launching per-session inspections, returning a stable capacity error instead of retaining an unbounded cold-read queue. Local user-document cleanup intervals and job terminal-retention intervals reject values above Node's maximum timer delay, preventing configuration overflow from becoming a one-millisecond maintenance loop.

Gateway-runtime now supplies one byte-budgeted JSON reader for internal Consumers; archive, collaboration, and PostgreSQL persistence callers cancel chunked responses that cross their domain limits before JSON parsing. The Host SSE carrier retains fragmented frame text as append-only pieces and joins each complete frame once, while preserving its 8 MiB frame limit.

Web-search providers and the DeepSeek Files client apply the same strict byte accounting to success and error JSON bodies, so declared or chunked responses cannot grow past their configured limits before parsing. Each provider exposes its response budget through validated configuration.

The Host API fetch carrier applies a 16 MiB (or caller-selected) unary JSON budget before envelope and value schemas parse a response; its SSE frame budget remains independent. The private Gateway Admin browser API applies the same default budget to its direct JSON calls.

Gateway push senders cap FCM and JPush error bodies at 64 KiB before token classification, keeping provider failures from retaining unbounded diagnostics.

The model-policy projection version cache is capped at 10,000 recent subject/path entries; eviction is an optimization miss and triggers only a safe rewrite.

## Alternatives considered

**Rely on one process-wide timeout.** Rejected because transport framing, provider parsing, durable writes, and streamed document bodies have different progress and ownership semantics; a single deadline either leaves a queue unbounded or aborts valid slow work without releasing its owner.

**Let garbage collection or Cordis disposal discover late work.** Rejected because neither mechanism proves that a child process, loader fiber, watcher callback, or response body has stopped. Admission fences and explicit joins make the owner responsible for quiescence.

**Apply limits only at the browser or SDK edge.** Rejected because Gateway, runtime, provider, and persistence endpoints are independently callable; each accepting boundary must reject oversized or excessive work before it is retained.

**Send one complete archive projection after every archived event.** Rejected because the payload fails once the runtime crosses a fixed session or search limit, and a burst queues repeated full-log scans. Idempotent batches preserve one revision while bounded coalescing admits at most one follow-up pass.

**Validate one detached tail by listing every session snapshot.** Rejected because a cache hit would still scale with the entire persistence catalog. The storage providers already own a source-qualified per-id revision primitive, so the public lookup can preserve the same identity without unrelated discovery work.

**Let archive revisions continue as ordinary JavaScript numbers.** Rejected because addition stops being monotonic above the safe-integer range. Failing at the last exact value preserves comparison and acknowledgement semantics without adding an incompatible wire representation.

## Consequences

Excess work fails with a stable local error or transport closure instead of growing memory without a bound. Deployments can tune the documented positive limits, while protocol constants and security invariants remain fixed. A response that exceeds its budget may terminate after headers have been sent, and a cancelled stream may leave an external side effect that the owning protocol explicitly does not roll back. A failed multi-batch archive pass can leave an incomplete derived index until the same revision retries; each accepted batch is idempotent, and commands run only after the full pass succeeds.

Teardown waits for accepted work, so disposal can take as long as a cooperative child or watcher needs within its configured grace. Uncooperative process trees still use the local provider's synchronous exit fallback. Existing focused notes remain the authority for their wire formats and domain-specific recovery rules.

## Verification

Focused tests cover Code Mode scheduler failure and queue admission, settings watcher quiescence and secret redaction, dynamic runner timeouts and late-entry removal, local process-tree termination, Gateway readiness and response budgets, serialized instance leases, document transfer leases and trash retention, bounded browser upload metadata, JSON-RPC and SDK queue/timeout limits, DeepSeek stream and wire-shape budgets, persistence write limits and per-id revisions, revision-aware model governance, bounded client lineage traversal, detached history cache validation, safe-integer archive revision exhaustion, continuable Activation quota admission and release, batched archive synchronization and read floors, and repeatable-read conversation loads. TypeScript typecheck, contract lint, and the corresponding package suites run against the latest source tree.
