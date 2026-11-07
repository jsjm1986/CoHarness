# Agent Note: Reserve JSONL provider capacity before Session commit

Status: implemented

English | [中文](2026-10-23-jsonl-provider-retention-admission.zh.md)

## Problem

The JSONL live-write handle can retain failed writes and subsequent events across arbitrarily many Sessions. A batching deadline does not bound pending bytes when storage stalls. Rejecting an event only in `session/event` is too late: the Session has committed it and contains observer exceptions, so limiting persistence copies can leave an accepted event missing from storage.

## Decision

`SessionStore.registerAppendAdmission()` registers fiber-owned synchronous reservations over frozen candidates. Attached Sessions reserve before surface and dispatch validation, reject reentrance, and roll earlier reservations back in reverse order if acceptance fails. A committed reservation belongs to its post-commit event consumer. Detached construction remains independent of deployment admission.

JSONL shares `maxPendingEvents` and `maxPendingBytes` across all its provider's write handles, including reserved candidates, queued explicit appends and active writes. Defaults are 100,000 events and 64 MiB of complete UTF-8 JSON event bytes; both accept positive safe integers. Live queues borrow immutable accepted events and avoid additional payload clones. Explicit appends snapshot their caller-owned input before reserving and release partial reservations if a batch cannot fit. Failed writes retain capacity until successful retry or handle closure.

A live capacity refusal rejects the new candidate before its sequence commits and closes that writer to later candidates. Its flush drains the accepted prefix and still reports the refusal; close drains and releases ownership while reporting the refusal. Once the final close drain quiesces, further candidates are refused before the write lease starts releasing. Reopening the stored Session repairs an interrupted step or turn through the existing recovery path. This deliberately permits terminal bookkeeping to be refused rather than retaining an unbounded exceptional closing queue. A persistent I/O failure can still prevent pending events from reaching disk; closing reports that failure and releases the handle, and cannot promise that unflushed events survive. Capacity recovery and storage durability are separate outcomes.

The [shared write-behind admission decision](2026-10-23-write-behind-admission-failure.md) remains active for SQLite and Gateway, whose post-commit controllers retain terminal failures after rejecting an already-accepted event. This decision changes JSONL's independent routing and adds an optional core extension; it does not migrate other providers. The [event-and-byte retention decision](2026-08-27-bounded-session-write-behind-retention.md) retains the shared controller's per-Session scope and retry rationale. Neither note is fully superseded.

## Alternatives considered

- **Throw from the post-commit observer.** Observer containment preserves the live append and can hide a missing persisted sequence.
- **Keep rejected payloads outside the budget.** A failed disk would retain unbounded data under a different name.
- **Reserve arbitrary closing headroom.** Tool recovery results have variable sizes; an exceptional queue requires its own complete capacity and cannot guarantee every close fits.
- **Limit every Session separately.** Multiplying a per-Session allowance by concurrent Sessions does not bound one Host's persistence backlog. The provider-wide budget still requires independent node-wide resource governance across Host processes.
- **Re-read accepted events synchronously from the Session after overflow.** That adds a prohibited dependency on arbitrary resident history rather than reserving before acceptance.

## Consequences

One provider bounds its retained serialized event volume, not JavaScript heap, caller-owned explicit input, total durable history, or all Host processes. A capacity refusal requires draining and replacing that live writer; it does not silently resume after another Session frees capacity. No Session event, durable format version or successful SDK transcript changes. Consumers that depend on successful closing bookkeeping must handle explicit storage refusal and restore the accepted prefix.

## Verification

Core tests cover reverse rollback, rollback errors, surface and dispatch refusal, reentrance, detached Sessions, plugin records and contribution disposal. JSONL tests cover exact multibyte byte limits, active writes shared across Sessions, failed-drain retention, refusal without sequence growth, explicit flush failure and reopen recovery. A real Loader-composed loop refuses an oversized reply, reaches idle without repeated model calls, reports failed durability and disposal, releases its writer, repairs its interrupted turn and completes a later short reply. The shipped headless profile snapshot covers a visible refusal and resumes the unchanged durable prefix with a larger configured capacity.

An offline Node 25.8.1 comparison submits 2,001 immutable 4 KiB payload events after one simulated disk failure, using the same 64-event/256-KiB limits. The original handle accepts all 2,001 and retains 8,663,568 additional heap bytes after GC; the bounded handle accepts 62, refuses 1,939 and retains 103,080 bytes. Complete JSON envelopes reach the byte limit before 64 events. Admission times are 2.856 and 2.926 ms respectively. These single-process samples prove bounded acceptance and removed copies, not a throughput gain or production capacity.
