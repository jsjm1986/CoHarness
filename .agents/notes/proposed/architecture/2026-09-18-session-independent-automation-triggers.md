# Agent Note: Session-independent durable automation triggers

Status: proposed

## Problem

`packages/schedule/schedule/src/types.ts:111` pins `ScheduleDeliveryMode` to `'session-local'` — the comment states "Fixed v1 delivery boundary: the original session must be live." A reminder created inside a conversation dies with that conversation. That is correct for "remind me in twenty minutes while I keep working" and fatal for automation, which by definition has to outlive the conversation that defined it.

The binding is not incidental. Four facts from the source:

1. `schedule/src/index.ts:51` constructs `ScheduleRuntime` only from `agent/created`, and only for root agents (`ctx.agents.roots().includes(agent)`).
2. `schedule/src/runtime.ts:93-94` holds the `Agent` instance; `:161-162` gates every drive on `isLive()` (`agents.get(id) === agent` and still root).
3. The timer is a process-internal `setTimeout` (`runtime.ts:79`, bounded by `MAX_TIMER_DELAY_MS` at `:22`). There is no persistent timer anywhere in the repository. After a restart the schedule is re-derived only because the agent is rebuilt and `start()` re-folds the session log (`:242`, `:209`).
4. The only delivery exit is `runtime.ts:273` `agent.followup(message)`, which opens a model turn. There is no delivery path that bypasses `Agent`.

Point 4 is the real constraint. "Run one agent turn without an agent" has no existing path:

- `ReactLoopAgent` requires a session (`agent-loop/src/agent.ts:91-97`); the launch chain `send/followup` (`:126`, `:143`) → `wakeDriver:200` → `turn:287` → `step:386` → `llm.stream:400` depends on the agent throughout.
- ACP also creates agents (`acp/src/index.ts:60`; `session.ts:128` `agents.create`, `:149` `agents.resume`).
- The only agent-less model call in the tree is a direct `ctx.llm.stream` (`session-title-llm/src/index.ts:273`, `compaction-basic/src/summarizer.ts:161`). It has no turn, no step, and no tools — not an agent turn.

So the gap is not "add a delivery mode". It is that nothing stands behind a trigger.

## Proposal

Split `schedule` along the line the source already draws: reuse the domain, replace the runtime.

**Reuse, unchanged.** `foldScheduleEvents` (`domain.ts:628-644`), `resolveEveryOccurrence` (`:520-552`), the `ScheduleChange` v1 union (`types.ts:105`), and the eleven stable error codes. The missed-occurrence policy is already settled and should be inherited verbatim: fixed-rate rules skip missed occurrences (`:537-538` takes only the latest due one), while one-shot reminders stay overdue and fire after recovery (`runtime.ts:43-47`).

**New: a standing trigger owner.** A resident, non-agent-scoped plugin whose `inject` includes `agents`, `sessions`, `llm`, `tools`, `sessionPersistence`. On fire it replays the sequence `packages/bundle/headless/src/index.ts:170-215` already proves works — `agents.create` (`:185`) → `agent.followup` (`:200`) → `await agent.whenIdle()` (`:204`) → `sessions.flush` (`:208`) — then disposes the handle instead of exiting the process. `AgentRegistry.resume()` (`core/agent/src/index.ts:415`) is the primitive for attaching to an existing session; agent id must equal session id (`core/agent/src/index.ts:465`).

**New: a trigger store at project scope.** This is the part with no precedent. `collaboration-gateway` holds no local project-scoped data structure: project semantics come entirely from remote principal claims (`context/collaboration-gateway/src/index.ts:107-121`) forwarded over HTTP, and `GatewayRuntime` carries only `sessionCreations: Map<SessionId, ...>` (`gateway-runtime/src/index.ts:412`), keyed by session, not project. Follow the shape `gateway/deploy/postgres/migrations/012_document_catalog.sql` already establishes for tenant-scoped data: `organization_id` + `scope_kind (personal|project)` + a lineage column + an append-only operation trail.

**Budget.** Reuse the existing three-subject quota model — `role_quotas` (`001_initial.sql:198`), `user_quotas` (`:206`, `inherit|unlimited|custom`), `project_quotas` (`003_project_collaboration.sql:116`), measured in `token_limit` and `company_cost_limit`, with `project_usage_alerts` (`:122`) at 80/100. Add `automation` as a fourth subject. Do not invent a parallel budget system.

## Trigger records are not session events

Stated explicitly because it brushes the model-visible ⟺ logged rule. A trigger record is platform scheduling state, not content the model sees; it never enters `request.messages`. It therefore lives outside the session log. The *run* it starts remains fully logged in the session it creates. The invariant we actually care about — that everything the model saw is reconstructible — is untouched.

## Alternatives considered

**Teach `ScheduleRuntime` to survive its agent.** Rejected: the runtime is constructed from `agent/created` and gated on `isLive()` at every drive. Keeping it alive past its agent means either holding a disposed `Agent` or rebuilding the ownership model. Cheaper to leave it as the session-local case.

**Extend `JobRegistry`.** Rejected on scope, not design. `JobRegistry` (`jobs/jobs/src/index.ts:62`) is deliberately owner-relative and its local implementation is process-local, with no durable record of runs. It is the handle for work already started, not a scheduler. It is a good *consumer* of this proposal, not a substitute for it.

**Deliver without an agent turn, via direct `ctx.llm.stream`.** Rejected: no turn, no step, no tools. An automation that cannot call a tool is not automation.

**Fork `schedule` wholesale.** Rejected: it doubles the surface that must later re-align with upstream. The domain split keeps the diff to a new runtime plus a new store.

## Acceptance criteria

- A trigger created with `session-independent` delivery fires after the creating process has exited, verified by a test that creates one, tears the runtime down, and observes the delivery from a fresh process.
- `resolveEveryOccurrence` behaviour is unchanged: fixed-rate rules skip missed occurrences, one-shot triggers fire once after recovery.
- Trigger records live outside the session log; every run they start is a normal session recoverable from its own log.
- Automation draws on the same quota path as users, roles, and projects, with `automation` as an added subject.
- `ScheduleDeliveryMode` gains `'session-independent'`; `'session-local'` stays the default and its behaviour is unchanged.
- The at-least-once gap below is closed in the same change.

## Risks

**The at-least-once gap already exists.** `runtime.ts:273` calls `agent.followup()` to open the turn and only then, at `:282`, appends the dispatch record. A crash between the two loses the bookkeeping while the delivery has already happened; the record stays active and a one-shot reminder is delivered again after recovery. Fixed-rate rules are unaffected because they skip missed occurrences. Any new delivery path must order these the other way — record the dispatch, then deliver — and the existing runtime needs the same fix, not just the new one.

**A standing owner is a new failure domain.** It holds timers, opens turns, and spends budget with no human in the loop. It needs the guards any long-running surface needs: a restart policy, a concurrency bound, and an observable view of what is pending right now.

**Project-scoped storage is genuinely new.** Unlike the delivery path, there is no template for it in the tree. Expect the schema to be the most-reviewed part of this change.

**Upstream surface.** `schedule` is a harness package and upstream may move it. The domain/runtime split means what we reuse is what is most likely to stay stable, and the new runtime is ours — but register the sovereignty of any new package in `scripts/upstream-sync.json` before it lands.
