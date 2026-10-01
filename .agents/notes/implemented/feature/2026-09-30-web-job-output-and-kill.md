# Agent Note: Web job output and human kill — cursor reads over `session/jobs`, never a second roster

Status: implemented

English | [中文](2026-09-30-web-job-output-and-kill.zh.md)

## Problem

The [web job display note](2026-08-08-web-background-job-display.md) shipped the header list read-only: a live row showed a status word and a ticking duration, and a settled row showed its terminal `detail`, but no reader could see what a task printed and no hand could stop one. The model already had both — `job_output` consumes the ring cursor and `job_kill` cancels through `ctx.jobs` — while the browser's only wire was the `session/jobs` roster frame, a lifecycle projection that deliberately carries no bytes.

Two gaps had to close without undoing that frame's contract: a per-job output channel that does not consume the model's read cursor (a browser read of `ctx.jobs.read` would silently take bytes the model's next `job_output` never sees), and a kill admission that does not claim the terminal notice the producer's settlement still owes the model.

## Decision

### Two unary RPCs on the existing carrier

`jobs.output({ sessionId?, jobId, from? })` and `jobs.kill({ sessionId, jobId })` land on the API proxy beside the other domain contracts in [`packages/host/apiproxy/src/api/jobs.ts`](../../../../packages/host/apiproxy/src/api/jobs.ts). No streaming RPC and no second roster: `session/jobs` frames stay the only roster channel, and both methods are plain request/response over the same client transport.

- `jobs.output` is a **non-consuming read**: it calls the registry's `readAt`, not `read`, so the model-facing cursor never moves. `from` is an absolute byte offset; the response carries the fresh `JobView`, the ring's `output` coordinates (`total`, `earliest`, optional `spillPaths`), the retained chunks overlapping `[from, total)`, the resume cursor `next`, and `lossy: true` when `from` landed below `earliest`. A `from` inside a retained chunk returns the whole chunk, whose `at` may precede `from`; the caller deduplicates by absolute offset, not by identity. A `sessionId` fences the read to that session's own jobs through `authorizeSession(sessionId, 'read')`; an unfenced read sees only unowned jobs through `captureCollaboration('read')`, matching `list(caller)` visibility. Unknown and foreign ids collapse to one `job-not-found` refusal so the wire never discloses which of the two failed.
- `jobs.kill` requires `sessionId` and passes `authorizeSession(sessionId, 'write')` before the registry's owner fence runs, so a browser can only stop a job its session could list as owned. The response is the admission — `requested` or `already-finished` — never the settlement; the row converges through the next `session/jobs` frame (`stopping`, then the terminal status), because the unary response and the mux frames have no cross-carrier ordering and only the authoritative frame proves the transition. The host forwards the reason `'cancelled by the user'`, which the registry merges into a `killed` settlement's `detail`; a job that outruns its kill keeps the producer detail alone.
- **The kill claims no delivery.** `JobRegistry.kill` records the reason and nothing else; the settlement notice still travels the producer's completion path, so the model is told its task was stopped rather than left to infer it. This satisfies the model-facing requirement the roster note recorded as the reason the control could not ship on the older contract.
- `JobView` gained `output: { total, earliest, spillPaths? }` — the ring's absolute coordinates — so a settled row's expandability (`total > 0`) is roster data, not a probe read. The frame drops `ownerSession`, `reported`, and `outputLimitBytes` exactly as before.

### Client observation: a ref-counted poll, not a stream

`SessionManager.observeJob(sessionId, jobId)` returns a release closure; `observedJobs` on the list snapshot carries one `ObservedJob` per observed id (`text`, `gapBefore`, `streaming`, optional `error`). Observers of the same job share one loop keyed by job id, so two expanded viewers never double the reads; the loop runs once per `JOB_OBSERVE_POLL_MS` and ends when the last viewer releases, when the job settles with its output drained (`next >= output.total`), or when the read returns a business refusal. Transport failures retry on the next tick — the cursor makes a re-read idempotent — while `job-not-found` is terminal. The accumulated text is bounded at 128 KiB with surrogate-safe truncation, and every truncation path — ring eviction, `lossy`, a chunk's `gapBefore`, the render bound — folds into one `gapBefore` flag the panel renders as a retention notice. `killJob` is a plain passthrough returning whether the registry admitted the request; the sessions service and runtime pool expose both methods and route them to the session's owning runtime.

### The list control

`JobListAction` renders an observable row — a live job, or a settled one with retained output — as expandable into a `TerminalBlock` panel; the row's state dot stays the status source, the panel draws none of its own, copies the command rather than the output, and shows gap and read-failure notices above the terminal. A running row carries a two-press stop control: the first press arms it, the confirming press inside three seconds issues `killJob`, an admitted press stays pending until the roster frame removes the row from the killable set, and a refused press shows a brief failure hint. The settled section folds behind its count while live work exists and clears client-side; below 768px the whole list rides the shared mobile sheet.

## Alternatives considered

- **A streamed `job.follow` channel** — the upstream answer — was rejected here because this composition keeps the roster on `session/jobs` frames and has no per-job push transport; a second streamed channel would duplicate the mux's subscription lifecycle for a reader that polls at human glance cadence anyway. The cursor pull is lossy-tolerant: a missed window is a `gapBefore` marker, not a protocol violation.
- **Consuming reads through `ctx.jobs.read`** — rejected outright: it would move the model-facing cursor and silently starve `job_output`, an invisible failure at the call site.
- **A `notify: boolean` on kill** — rejected on the upstream note's argument, which still holds: the registry cannot promise a notice, so the only honest contract is "a kill claims no delivery" and the reason rides `detail`.
- **A separate `stopByUser()`** — rejected for the same reason upstream gives: one cancellation path with an unambiguous caller beats two methods differing by a flag.

## Testing

`api-proxy-jobs.spec.ts` pins the wire contract end to end through a real composed context: baseline and lifecycle frames carry `output` coordinates, `jobs.output` reads an owned ring without touching the model cursor (a `ctx.jobs.read` spy stays uncalled), unfenced reads see only unowned jobs, foreign and unknown ids refuse identically, `from` resumes at chunk granularity, and a ring past its retention window answers `lossy`; `jobs.kill` admits a live job into `stopping`, reports `already-finished` on a settled one, and refuses foreign and unknown ids. `rpc-schemas.spec.ts` pins both request/value schema pairs plus the `job-not-found` error payload. `manager.client.spec.ts` pins the observation loop — first read, cursor progression, accumulation, terminal drain, business-refusal surfacing, release teardown, and ref-shared polling — against deferred fake responses and fake timers. The `ui-jobs` spec pins the two-press control, expansion lifecycle, gap and failure notices, folding, and clearing.

## Consequences

- Output lag is bounded by the 1s poll plus one round trip; that is the price of not growing a push channel for a glance surface.
- A settled job's panel is exactly what the ring retained — output evicted before the first read exists only as spill files the model can still name, and the panel says so through the gap marker.
- `JobView.output` makes every roster frame a few bytes heavier and makes `output` a required wire field; every `JobView` producer (the proxy mapper, test fixtures) supplies it.
- Killing a subagent's own job from its own session list is allowed by the registry's owner fence alone; no second ownership fence exists at this layer.
