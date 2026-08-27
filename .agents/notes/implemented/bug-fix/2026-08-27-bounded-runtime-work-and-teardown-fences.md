# Agent Note: Bounded runtime work and teardown fences

Status: implemented

English | [中文](2026-08-27-bounded-runtime-work-and-teardown-fences.zh.md)

## Problem

Gateway and SDK transports, provider streams, persistence writers, and document brokers could retain work in memory for as long as an untrusted peer or a slow upstream continued producing it. Several asynchronous owners also admitted new work while their fibers, runtimes, or loader entries were being disposed. A late completion could therefore leak a child process, remount a dynamic package, or keep a request alive after its owner had gone away.

## Decision

Every untrusted or externally paced stream now has an owning positive budget at the point that accepts it. JSON-RPC bounds input-line bytes, pending requests, concurrent inbound handlers, output buffering, sessions, prompt blocks, and prompt bytes. DeepSeek bounds provider error bodies, incomplete SSE frames, generated text, and streamed tool arguments. Code Mode, session persistence, and document transfer bound retained queues, plans, and response bodies. Gateway proxy operations have configurable timeout and response-byte limits.

Runtime work holds an operation reference from authorization through the final response byte, so idle reaping cannot stop a process underneath an active request. Readiness is an HMAC challenge tied to the launch token, nonce, and exact runtime identity. Settings registrations, client session scopes, dynamic Host/Client runners, and subprocess owners close admission before teardown and await already-started work; late loader entries and process-tree children receive explicit cleanup. Revision-aware model projections refresh before use and retry asynchronously, so a committed database change is not reported as a failed transaction merely because its file projection was temporarily unavailable.

Runtime lease admission, activity touches, and idle reaping share one per-runtime serialization queue. A stop that wins before a new lease returns a retryable refusal; proxy callers start a fresh generation, while document and archive brokers fail without forwarding a stale port. Timer-backed Gateway and SDK settings reject values above Node's maximum delay.

Filesystem and document lifecycle paths re-check real-path containment and symlink ownership at each destructive or publication step. User documents have a provider-owned trash lifecycle with bounded metadata pages and retention-based purge. These checks complement the focused decisions for [Gateway readiness](2026-08-26-document-scope-runtime-readiness.md), [session write batching](../architecture/2026-08-08-bounded-session-persistence-write-batching.md), and [subprocess exit cleanup](2026-08-11-synchronous-subprocess-exit-cleanup.md).

DeepSeek wire translation validates chunk objects, usage counters, and bounded tool-call metadata before mutating state. Host document consumers stream and cap runtime JSON responses, PostgreSQL overview filters and pages in SQL, and systemd units render argv fields with explicit escaping. SDK ancestry and per-session lock maps release completed entries; permanent administrator document purge requires confirmation, and document-catalog user references are organization-qualified.

## Alternatives considered

**Rely on one process-wide timeout.** Rejected because transport framing, provider parsing, durable writes, and streamed document bodies have different progress and ownership semantics; a single deadline either leaves a queue unbounded or aborts valid slow work without releasing its owner.

**Let garbage collection or Cordis disposal discover late work.** Rejected because neither mechanism proves that a child process, loader fiber, watcher callback, or response body has stopped. Admission fences and explicit joins make the owner responsible for quiescence.

**Apply limits only at the browser or SDK edge.** Rejected because Gateway, runtime, provider, and persistence endpoints are independently callable; each accepting boundary must reject oversized or excessive work before it is retained.

## Consequences

Excess work fails with a stable local error or transport closure instead of growing memory without a bound. Deployments can tune the documented positive limits, while protocol constants and security invariants remain fixed. A response that exceeds its budget may terminate after headers have been sent, and a cancelled stream may leave an external side effect that the owning protocol explicitly does not roll back.

Teardown waits for accepted work, so disposal can take as long as a cooperative child or watcher needs within its configured grace. Uncooperative process trees still use the local provider's synchronous exit fallback. Existing focused notes remain the authority for their wire formats and domain-specific recovery rules.

## Verification

Focused tests cover Code Mode scheduler failure and queue admission, settings watcher quiescence and secret redaction, dynamic runner timeouts and late-entry removal, local process-tree termination, Gateway readiness and response budgets, serialized instance leases, document transfer leases and trash retention, JSON-RPC and SDK queue/timeout limits, DeepSeek stream and wire-shape budgets, persistence write limits, and revision-aware model governance. TypeScript typecheck, contract lint, and the corresponding package suites run against the latest source tree.
