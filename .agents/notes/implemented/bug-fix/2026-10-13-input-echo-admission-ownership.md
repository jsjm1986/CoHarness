# Agent Note: Input echo admission ownership — queue/durable dedup, deferred failure, Assistant retention

Status: implemented

English | [中文](2026-10-13-input-echo-admission-ownership.zh.md)

## Problem

Four related defects in the client conversation path, all confirmed by upstream source comparison:

1. Submission echoes carried no queue-position tracking, so a queue publication that dropped a not-yet-admitted echo either failed it too early or left it pending forever, and a `canceled` inbox splice could not be attributed to the removed identity.
2. A replacement follow baseline could not distinguish "the Host still owns this input" from "this echo never arrived", because queue observations were not reconciled against the baseline's `asOfSeq` watermark.
3. `beginSubmission` took a caller-computed `placement` derived from a possibly stale snapshot, so an echo could mount on the wrong surface when the running bit moved between snapshot read and submission.
4. `ClientAssistantStream` removed an attempt's transient rows the moment its stream ended, so a successful final answer disappeared for the window between stream end and `step/end`, and staged durable settlements published only at stream end even when they were already complete.

## Decision

1. Port upstream `820824edd74`: track each echo's `queueTarget`/`queueIndex`/`queueSeq` receipt across `session/queue` frames, `queuedInbox` projections, and `agent/inbox/spliced` events; retire a queued-placement echo on queue acceptance, hold transcript/steering echoes until durable admission plus queue-row departure, fail a removed echo at once on a `canceled` splice, and fail a departed unadmitted echo at the next `request/context` or `turn/end` boundary whose seq follows the removal observation.
2. Same commit: seed-time reconciliation accepts every queue-observed identity at or before `projections.asOfSeq` as observed — even when the durable admission sits outside the loaded window — and `ProjectionValueStore.seqOf` exposes the per-key watermark used for that comparison.
3. Same commit: `BeginSubmissionInput` carries `mode` and Session derives placement from its live `running` state, matching upstream and removing the stale-snapshot race.
4. Port upstream `08c0e8e71b6`: admitted local identities suppress their still-published queue rows (ChatView steering rows and QueueDock transcript rows keyed by `rpcId`) until the queue publication drops them; the render-side dedupe hides an echo only once a durable node owns its `rpcId`, never on queue presence.
5. Port upstream `1b55f5bea3a`: a successful `assistant/message` settlement publishes immediately at stream end while its transient rows stay mounted until the matching `step/end` (`retireAttemptId` on the step publication); interrupted messages and failed attempts still settle at stream end, and a new attempt arriving while a retained settlement waits requests a rebaseline. Assistant nodes anchor a successful message at its first visible sequence so later tool/preparation rows do not reorder it.
6. The first transcript echo renders before an open Turn control when that control owns no visible input, mirroring the upstream hoist so the opening control does not leapfrog the echo.

## Alternatives considered

**Retire admitted echoes immediately regardless of queue state (upstream rule).** Rejected for CoHarness: our queue arrives as whole `session/queue` snapshots and `queuedInbox` projections rather than an inbox seq stream, so holding the registered echo until the row actually disappears keeps the UI suppression exact and can never let a stale row resurface; disposal still bounds a wedged row.

**Map queue absence directly to failure without a splice.** Rejected: removal is ambiguous until either a splice supplies its outcome or a durable boundary passes it, so absence only parks the echo in the removed-unconfirmed state.

**Port the upstream Playwright e2e (`idle-submission-handoff.e2e.ts`).** Deferred: our wire surface differs (`session/queue` frames and `queuedInbox` projections versus upstream's `session/control`/`session/follow` streams), so the gate needs a rewrite rather than a copy; unit coverage now exercises every settlement path.

## Consequences

Queue and durable observations of one identity dedupe through the settlement latch, so neither path can retire an echo twice or out of order. A submission whose queue row vanishes without admission fails exactly once — at the owning splice or the next durable boundary — instead of flickering or leaking. Reconnect baselines accept Host-confirmed inputs instead of re-showing them as drafts. Successful Assistant answers publish the moment the model settles while preparation/tool rows complete behind them.

## Verification

`client-runtime` 105 focused specs cover departed-echo boundaries, canceled and moving splices, queue-held admission, steering persistence, baseline acceptance, and disposal; `ui-conversation` specs cover transcript-row suppression in QueueDock, queue-held echo mounting, and steering-row dedup in ChatView; package typecheck and lint pass on every touched file.

## Related

- [Session reliability fixes](2026-10-12-session-reliability-fixes.md) — same alpha.2 alignment campaign.
- Upstream commits: `820824edd74`, `08c0e8e71b6`, `1b55f5bea3a`.
