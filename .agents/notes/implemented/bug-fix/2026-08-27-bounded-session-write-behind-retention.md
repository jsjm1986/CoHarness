# Agent Note: Bound session write-behind retention by events and bytes

Status: implemented

English | [中文](2026-08-27-bounded-session-write-behind-retention.zh.md)

## Problem

The write-behind controller retained failed batches and events arriving while a backend write was active. A slow or unavailable backend could therefore grow one live session's in-memory queue without a byte bound, even though the queue already had an event-count limit. Large event payloads could exhaust memory before the event count became meaningful.

## Decision

`SessionWriteBehind` enforces two admission limits across the pending queue and the active batch: `maxPendingEvents` and `maxPendingBytes`. The byte limit measures each retained event's UTF-8 JSON encoding, before the controller takes its persistence-owned structured clone. The defaults are 100,000 events and 64 MiB per live session.

The active batch remains counted until its durable write settles. A failed batch is restored before newer pending events and its event and byte totals remain counted, so retries cannot bypass either limit. An admission that would exceed either limit reports the failure and throws before changing the queue. The controller retains that failure so Session observer containment cannot hide a missing event; the [admission-failure decision](2026-10-23-write-behind-admission-failure.md) owns its terminal barrier behavior.

The shared [`PersistenceCoordinator`](../architecture/2026-06-18-shared-persistence-write-coordinator.md) owns the resolved limits and passes them to every live-session controller. SQLite and Gateway persistence providers expose both fields in their configuration schemas and forward them unchanged. JSONL uses its independent handle-based live routing. The limits apply to live write-behind retention only; they do not change the durable event log, storage format, or backend row count.

## Alternatives considered

**Keep only an event-count limit.** Rejected: event payload sizes vary substantially, so a count-only limit permits a small number of very large events to retain excessive memory.

**Measure JavaScript object size.** Rejected: object-size estimates are runtime-specific and do not match the bytes the persistence path must serialize. UTF-8 JSON bytes provide a deterministic admission unit shared by all first-party backends.

**Drop or compact failed batches when the limit is reached.** Rejected: the persistence contract requires ordered, lossless retry after a backend failure. Rejecting the new producer preserves the already-admitted prefix instead of silently losing events.

**Configure the limit separately in each backend.** Rejected: retention and retry are coordinator behavior, while JSONL, SQLite, and Gateway differ only in durable storage primitives. A shared coordinator option prevents policy drift.

## Verification

`packages/session/session-persistence/tests/write-behind.spec.ts` verifies byte-limit rejection, active-batch accounting, count-limit rejection, and failed-batch retention. The provider schemas and generated configuration catalog expose the same fields for SQLite and Gateway.

## Consequences

Each live session has a deterministic upper bound on queued write-behind event count and serialized payload bytes, including a batch waiting on a slow or failed backend. Admission errors remain explicit at direct controller calls and at every later durability barrier. A live Session whose observer could not retain an accepted event cannot recover that lifecycle by merely draining its controller; deployments must address the limit before accepting further work.

The controller serializes each admitted event once for its retained byte estimate in addition to the existing persistence-owned clone. The quota does not bound backend I/O duration, total durable history, or aggregate memory across sessions; deployments still need session and process-level capacity controls.
