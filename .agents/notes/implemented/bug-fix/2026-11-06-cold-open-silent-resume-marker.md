# Agent Note: Startup reads no longer race the silent resume marker

Status: implemented

English | [中文](2026-11-06-cold-open-silent-resume-marker.zh.md)

## Problem

Opening a saved session issued `/api/session.history` twice: a detached prefetch read finished before the session attached, the `Session` constructor then appended `session/end-seed` — a durable event committed before store entry, so no `session/event` observer ever saw it — and the `session/subscribed` baseline reported `session.seq - 1` past the client's window tail, forcing `repairGap` to repull the identical page for one marker. The same open flow also resumed an Agent behind the user's back — twice over. `sessions.models` called `agentFor` merely to populate the picker, and the command input source's scope-birth `warm` hook fired `commands.list`, whose `agent` parameter resolves through `agentFor`; each read-only load cold-resumed the session, appended the marker, and created the gap plus an unexpected live Agent.

## Decision

The mux `subscribe()` streams the silent suffix — durable events at or after `session.firstLifecycleSeq` that never produced a `session/event` frame — ahead of the `session/subscribed` baseline. An open client window stitches the marker live (`tail + 1`), so the baseline lands already covered and no gap repair fires. The replay lives inside the shared `subscribe()` rather than the `session/created` listener because resume-time `session/event` emissions queue their own `subscribe(seq - 1)` publishes ahead of the created publish; sessions already attached when the stream opens take the same path through `initialSessions`, so every subscription route covers the silent window once. The `session/created` publish replays up to the attach-time `seq - 1` to include enter-window appends; every other route stops at `firstLiveSeq` — the constructor window — since post-construction events either reached an earlier stream generation or are covered by the client's history read, and replaying them would push a session's whole lifecycle onto each reconnect.

`sessions.models` serves a session whose Agent is neither live nor already resuming from its durable log instead of `agentFor`: `detachedSelection` folds the events through `modelSelectionProjectionDefinition` for the pending tier and `foldRequestHeader` for the recorded request header, mirroring `selectionFor`'s tiers including the adapter-defaulted reasoning-effort omission. The subagent-ownership fence runs before any branch, matching `agentFor`'s ordering; in-flight resumes are still joined.

The command source no longer registers a `warm` hook: anticipatory catalog warming resolves an `agent`-typed remote parameter and cannot run without activating the cold session it warms for. `CommandDirectory` already pulls lazily — the first `candidates`/`matchEnter`/`matchSpace` read calls `ensureReady` — so the catalog now loads on `/` intent, which is exactly when resuming the session's Agent is legitimate. `directory.warm()` had no remaining caller and is removed.

Removing `warm` also removed the open flow's only Agent resolution, so `session.activate` now carries the open-publishes-Agent contract: a typed RPC that authorizes write scope, rejects archived sessions, and resolves `agentFor`, which resumes idempotently. The conversation slot injects `activate` plus a registrant-private `hooks.activationReady` source — false while initial workspace selection is pending or a required execution authority lacks a verified account — and `ConversationSession` activates on the readiness flip. Mount alone is not the boundary: the slot body renders beneath the selection loading overlay, so the gate, not the effect's mount, decides when opening counts as presented.

## Alternatives considered

**Report a page-visible `lastSeq` in the baseline.** `session.seq` is the contiguous log length and every sequence is a real event — including the marker — so no "filtered" basis exists; under-reporting it would hide a durable append from projections.

**Defer the gap repair until live events arrive.** It papers over the symptom: the marker is still durable and still absent from the stream, so a reconnect or stage-activated open hits the same repull later.

**Keep `agentFor` for `sessions.models` and only replay the marker.** It fixes the history count but still resumes an Agent for a read the durable log can answer, violating the startup contract that opening a saved session creates no Agent.

**Keep `warm` but pull only when a live Agent exists.** Client snapshots expose no Agent-liveness fact, so the hook cannot tell a free warm from a cold resume; gating on heuristics like `running` misfires on live-at-rest Agents. `commands.list` could also gain a detached standing-scope catalog like `sessions.models`, but the standing composition's command view differs from the Agent's resolved view and the lazy path already satisfies every consumer.

**Fire `activate` from `sessions.open`.** Pool open is client-side navigation shared by ambient focus and restore paths, not a presented-conversation signal; the readiness gate distinguishes an opening shown to the user from one that merely exists.

## Consequences

The startup auto-selection end-to-end assertion `historyCalls === 1` now holds on slow CI ordering, and the same spec's `ctx.agents.get(id) === undefined` holds because neither the model picker nor the command catalog resumes an Agent during mount. Any constructor-time silent append — not just `session/end-seed` — is replayed by the same loop on every subscription path, and genuinely missing history still repairs through `mergeTail` unchanged. `sessions.models` on a cold session no longer runs live SSH admission; authorization still gates the read. Typing `/` in a cold session resumes its Agent — that is the intent-driven activation the contract reserves for. Opening a session once more publishes its live Agent through `session.activate`, restoring the explicit-open contract background-job, schedule, and plan-review flows assert, while the readiness gate keeps unsettled startups and unverified-authority openings cold.

## Verification

`api-proxy-collaboration.spec.ts` asserts the mux stream yields `session/event(session/end-seed, seq 1)` before `session/subscribed(lastSeq 1)` for a seeded restore. `api-proxy-models.spec.ts` and `api-proxy-cold.spec.ts` cover the detached selection tiers and the ownership fence (48 cases). `service.client.spec.ts` pins the contract: the `/` source registers no `warm` hook, and the first `candidates` pull fetches the session key once. The web end-to-end spec retains `historyCalls === 1` and the no-Agent assertion unchanged, and the suites that open a saved session and poll for a live Agent cover `session.activate` end-to-end.

## Related

[The end-seed log boundary](../architecture/2026-07-30-session-end-seed-log-boundary.md) designs the marker this fix replays; [session history and event transport](../architecture/2026-08-18-session-history-and-event-transport.md) owns the baseline protocol this publish now completes.
