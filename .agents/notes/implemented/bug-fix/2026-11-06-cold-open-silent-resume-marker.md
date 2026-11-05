# Agent Note: Startup reads no longer race the silent resume marker

Status: implemented

English | [中文](2026-11-06-cold-open-silent-resume-marker.zh.md)

## Problem

Opening a saved session issued `/api/session.history` twice: a detached prefetch read finished before the session attached, the `Session` constructor then appended `session/end-seed` — a durable event committed before store entry, so no `session/event` observer ever saw it — and the `session/subscribed` baseline reported `session.seq - 1` past the client's window tail, forcing `repairGap` to repull the identical page for one marker. The same open flow also resumed an Agent behind the user's back: `sessions.models` called `agentFor` merely to populate the picker, so a read-only directory load cold-resumed the session, appended the marker, and created the gap plus an unexpected live Agent.

## Decision

The mux `session/created` publish streams the constructor-silent suffix — every durable event at or after `session.firstLiveSeq` — as ordinary `session/event` frames BEFORE pushing the `session/subscribed` baseline. An open client window stitches the marker live (`tail + 1`), so the baseline lands already covered and no gap repair fires. For sessions that existed before the stream, the initial baseline already includes the marker; fresh sessions have no suffix to replay.

`sessions.models` serves a session whose Agent is neither live nor already resuming from its durable log instead of `agentFor`: `detachedSelection` folds the events through `modelSelectionProjectionDefinition` for the pending tier and `foldRequestHeader` for the recorded request header, mirroring `selectionFor`'s tiers including the adapter-defaulted reasoning-effort omission. The subagent-ownership fence runs before any branch, matching `agentFor`'s ordering; in-flight resumes are still joined.

## Alternatives considered

**Report a page-visible `lastSeq` in the baseline.** `session.seq` is the contiguous log length and every sequence is a real event — including the marker — so no "filtered" basis exists; under-reporting it would hide a durable append from projections.

**Defer the gap repair until live events arrive.** It papers over the symptom: the marker is still durable and still absent from the stream, so a reconnect or stage-activated open hits the same repull later.

**Keep `agentFor` for `sessions.models` and only replay the marker.** It fixes the history count but still resumes an Agent for a read the durable log can answer, violating the startup contract that opening a saved session creates no Agent.

## Consequences

The startup auto-selection end-to-end assertion `historyCalls === 1` now holds on slow CI ordering, and the same spec's `ctx.agents.get(id) === undefined` holds because opening a saved session no longer resumes an Agent for the model picker. Any other constructor-time silent append — not just `session/end-seed` — is replayed by the same loop, and genuinely missing history still repairs through `mergeTail` unchanged. `sessions.models` on a cold session no longer runs live SSH admission; authorization still gates the read.

## Verification

`api-proxy-collaboration.spec.ts` asserts the mux stream yields `session/event(session/end-seed, seq 1)` before `session/subscribed(lastSeq 1)` for a seeded restore. `api-proxy-models.spec.ts` and `api-proxy-cold.spec.ts` cover the detached selection tiers and the ownership fence (48 cases). The web end-to-end spec retains `historyCalls === 1` and the no-Agent assertion unchanged.

## Related

[The end-seed log boundary](../architecture/2026-07-30-session-end-seed-log-boundary.md) designs the marker this fix replays; [session history and event transport](../architecture/2026-08-18-session-history-and-event-transport.md) owns the baseline protocol this publish now completes.
