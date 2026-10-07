# Agent Note: Projection-cache writes drop superseded cuts

Status: implemented

English | [中文](2026-10-07-projcache-write-epoch-guard.zh.md)

## Problem

`SessionProjectionCache.write()` suspended mid-flight could publish a stale cut over a fresher record. The write snapshots the registry checkpoint synchronously, then awaits `sessions.flush` before `put` — so a `session/created` write parked inside a slow flush lets a later `turn/end` write checkpoint, flush, and put a newer document, after which the resumed older write lands last and replaces it. The durable row then showed the pre-event state (`val: null` rows) forever: the dirty timer had already been cleared by the newer write's `markClean`, so no later trigger republished. The `archived version recovery` suite surfaced it on the Windows `native complete` lane, where runner IO contention stretched the create-write's flush past the entire test append sequence.

## Decision

`write()` stamps each call with a per-Session epoch (`WeakMap<Session, number>`) and skips `put` when a newer epoch exists after the flush await — the latest-triggered write always wins the session's durable row. Epochs key on the Session object, so nothing accumulates after disposal. The suspended write still completes its durability flush; only its publish step is dropped. This is the same "a settled chain tail removes itself only while still current" rule the [shared persistence write coordinator](../architecture/2026-06-18-shared-persistence-write-coordinator.md) applies per id, now enforced at the projection-cache layer.

## Alternatives considered

Serializing `write()` calls per session through a tail-chained promise also fixes ordering, but each queued write still performs a full flush and put — more IO under the contention that triggered the bug — and delays each cut to the queue tail. The epoch check keeps the concurrent flush (the durability barrier still runs) and drops only the stale publish, which is the sole incorrect outcome.

## Consequences

Stale overwrites are impossible through `write()`; callers that flush concurrently no longer need external coordination. `cache.spec.ts` reproduces the race deterministically by parking a write inside `sessions.flush`, publishing a fresher cut, and asserting the resumed write emits no `domain/changed` put. The `coldSnapshot` write-back is unguarded by design: it refreshes a detached session's record from its complete final log, so its content cannot be older than any live write for that session.
