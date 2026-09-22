# Agent Note: Session observation leases

Status: implemented

English | [中文](2026-09-20-session-observation-leases.zh.md)

## Problem

Consumers such as the headless `--session-id` adoption path need one point observation of a Session — its header, event prefix, resumption cursor, and mounted projection snapshots — without forcing the Session live and without re-reading the persisted log on every call. The existing corpus reads clone a complete detached log per call, which is correct for one-shot answers but wasteful for repeated observation of an unchanged persisted Session, and they offer no retained handle whose projections stay consistent with one observed cut.

## Decision

`ctx.sessionQuery.observeSession(sessionId, signal?)` returns a retained `SessionObservation` lease (`src/observation.ts`). A live observation fixes its cut at the current log length and materializes `events` on first read; because the log only appends, a late first read still yields exactly that prefix. The cold path stats the stored Session first, then consults a bounded prepared-Session cache keyed by the persistence instance and the `stat` revision: an unchanged revision reuses the restored unpublished Session without re-reading the log, while a changed revision or a replaced persistence instance reloads through the handle seam. The cache holds `preparedSessionCacheSize` entries with least-recently-used eviction, active leases pin their entry, and a session that goes live mid-read retries the live path. `cold-read.ts` supplies the handle-based cold log read; a writer that crashed mid-turn is balanced in memory with `interruptedTurnClosers` and persistence is never mutated by a read. `hydrate` on `ctx.sessionProjection` and `hydratePrepared` on the projection cache attach mounted projection snapshots to the observation without entering the Session into the live store.

## Alternatives considered

**Reuse `readSession` per observation.** Rejected because every call would re-read and re-validate the full log and could not share prepared Sessions or projection snapshots across repeated observations of an unchanged record.

**Enter the Session into the live store to share its projections.** Rejected because observation must not turn a persisted record into a live Session; the lease keeps the restored Session unpublished while still serving projection-consistent views.

## Consequences

Headless session adoption and any later observation consumer read one consistent cut with projection snapshots attached, and repeated cold observations of an unchanged Session cost one `stat` call. The cache adds one config knob (`preparedSessionCacheSize`) and requires callers to dispose the returned lease.

## Testing

`packages/session-query/session-query/tests/observation.spec.ts` covers live and cold observation, exact headers and `inheritedEventCount`, cancellation, projection snapshots, cache reuse across revisions and instances, lease pinning, and in-memory interrupted-turn balancing.
