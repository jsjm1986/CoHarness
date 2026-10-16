# Agent Note: User-owned goal pause exposes live activation

Status: implemented

English | [中文](2026-09-03-user-owned-goal-pause-activation.zh.md)

## Problem

A later human turn could use `update_goal resume` to lift a durable `paused` goal, so a user's manual pause stayed undoable by the model tool in the same turn. Remote clients also had no observation of process-local activation: only the durable `goal` projection traveled, so an active-but-disarmed goal was indistinguishable from an armed one off-host.

## Decision

`ctx.goals.get` is a read-only Remote method. `GoalService.setActivation` centralizes process-local activation edges: it emits `goal/activation-changed` only when the value actually changes, with `{ sessionId, goal: { id, revision, activation } }` or no goal after a clear, reading the exact current ref from the composed session projection or the local incremental cache when projections are absent. The `agent/created` disarm edge and durable `goal/change` reconciliation route through it; `disarm()` emits the edge without writing a durable revision. The API Remote allowlist forwards the JSON payload to clients as a `host/remote-event` frame.

The `update_goal resume` action rejects a durable paused goal with `GOAL_TOOL_RESUME_PAUSED` before calling the goal service. It still resumes an active-but-disarmed goal after session restore or fork and a blocked goal after human continuation. Pause authority remains in the goal domain and the human `/goal resume` command, which can still resume every resumable phase.

Web rendering of activation state — the upstream GoalBar activation source that distinguishes armed, disarmed, and paused goals — is scheduled separately; this change ships the runtime event and its forwarding without the display consumer.

## Alternatives considered

**Store activation in the durable `GoalSnapshot`.** Rejected: activation is process-local by the goal domain contract and must not survive restore or fork.

**Add activation to the persisted session projection.** Rejected: projection state is checkpointed; a cached `armed` value would incorrectly outlive the process that armed it.

**Forward the full scoped `goal/changed` event to clients.** Rejected: its `Agent` payload is not JSON wire data. The dedicated activation event carries only the session id, goal ref, and activation clients need.

**Let the model resume durable paused goals from natural-language turns.** Rejected: a manual pause is a user control, and prompt-only restraint leaves the same turn-level undo available to the model.

## Consequences

Clients can distinguish armed from disarmed goals without persisting activation. A durable paused goal is resumable only through `/goal resume` or another direct goal-service caller; model `update_goal resume` is limited to disarmed-active and blocked goals. The API surface gains one read and one forwarded live event; durable goal change payloads and projection state versions are unchanged. Until a display consumer ships, the emitted edges serve remote consumers and tests.

## Testing

Goal unit tests pin the activation event id and revision across create, session start, and resume, and the replay-failure path keeps `agent/created` disarm from throwing while the retained failure still surfaces on read. Tool tests pin rejection of a durable paused goal in a later human turn while restored disarmed-active goals still resume. The api-proxy test pins `host/remote-event` JSON forwarding.
