# Agent Note: Resume commits cold recovery through load before reading the log

Status: implemented

English | [中文](2026-10-16-resume-load-before-closers.zh.md)

## Problem

`AgentLoop.resumeWith` repaired an interrupted tail turn itself: open a write handle, read the stored log, synthesize `interruptedTurnClosers`, and append them through that handle. On a coordinator-backed backend this runs the same recovery twice. `open` routes through `inspect`, which retains a ready preparation whose prepared view already carries the same deterministic closers. The next `append` on the id adopts the session: `commitPrepared` sees those pending closers and commits them through `commitRepair` before validating the caller's batch, so the identical caller-supplied closer batch collides with the already-advanced cursor — `append seq mismatch: expected N, got N-1`. Whether a stored log is left with an open turn at all is timing-dependent, so the collision surfaced as a Windows-only CI failure in the Agent Teams restart tests even though the mechanism is platform-neutral.

## Decision

`resumeWith` awaits `persistence.load(id)` between taking write ownership and reading the log. `load` is the committing cold-recovery contract: coordinator backends reserve the prepared source, commit torn-tail truncation and interrupted-turn closers exactly once, discard the reservation, and return the balanced view. The write-handle read that follows therefore observes the already-repaired durable log, `interruptedTurnClosers` produces an empty batch, and no second repair is attempted. Backends whose `load` is the abstract `inspect`-based default return the raw log unchanged, and the closer append path runs there exactly as before. Write ownership is still taken first so a concurrent resume of the same id keeps rejecting, and the call runs inside the existing abort-fusion envelope.

## Alternatives considered

**Deduplicate the closer batch inside the coordinator's append.** Rejected: append owns one obligation — contiguous sequence validation — and silently absorbing a stale duplicate batch would mask genuine double-writer races instead of reporting them.

**Move resume onto `persistence.prepare()`.** `prepare` returns the coordinator-reserved Session as the publication unit, but resume retains its write handle for the live session's durability route and seeds `SessionStore.prepare` with the handle's `eventState`; that rewires the publication boundary rather than the recovery ordering.

**Drop adoption-time repair in the coordinator.** Rejected: adopting an unknown state on first write must still settle a pending repair, or any other write path would observe an unrepaired cursor.

## Consequences

Resume of an open-turn session on a coordinator backend commits exactly one repair, and the `append seq mismatch` the Agent Teams persistence spec hit on Windows is closed. Each resume pays one extra `load` round trip on the same serialized per-id lane the repair itself uses. `resume.spec.ts` pins that `load` precedes the write-handle read and that the stored repair lands once; the Agent Teams restart suite covers the end-to-end path on both backends. The [session preparation note](../architecture/2026-08-05-session-preparation.md) keeps owning the prepare/inspect/load machinery this consumes.
