# Agent Note: Agent Teams same-lineage merge (rc.3)

Status: implemented

English | [中文](2026-11-25-agent-team-same-lineage-merge.zh.md)

## Problem

Upstream rc.3 promotes Agent Teams into `packages/team/{agent-team,tool-agent-team}` as a leaner rewrite built on version-2 durable events: `ProjectionHandle`-backed state, a `team/mode` session flag replacing membership gating, subagent-catalog assignee resolution, and Agent-inbox messaging that retires the durable mailbox/roster events as historical. The fork's `packages/experimental/agent-team` is a deliberate divergence — durable roster/mailbox/fold on version-1 events, member phases, model routes, activity waiting, and write-scope warnings — so wholesale file replacement would delete fork-owned semantics. The task was a same-lineage merge: port upstream improvements that survive translation, record the rest.

## Decision

Two upstream improvements port cleanly and were adopted:

- **Durable `ownerName` attribution.** Upstream persists the member name on the task snapshot at assignment instead of resolving it at view time. `TeamTaskSnapshot` gains optional `ownerName`; `claim` writes the caller's membership name, `reassign` writes the resolved assignee name, `release`/`reopen`/unassign strip it through `withoutOwner`, the fold's strict `team/task` schema accepts the additive field, and `taskView` prefers the persisted name while still falling back to the live member map for pre-field tasks. Attribution now survives any future roster pruning and matches upstream's Remote-visible snapshot semantics.
- **Caller cancellation on board mutations.** Upstream threads `AbortSignal` through `create`/`update` so a disconnecting caller cannot commit an append. The fork now accepts `signal?: AbortSignal` on `TeamService.createTask`/`updateTask`, the `remoteCreateTask`/`remoteUpdateTask` Remote methods (Typert binds client cancellation to the trailing signal parameter), and `TaskBoard.create`/`update`, which check `signal.throwIfAborted()` inside the transaction before state read and before append. `tool-agent-team` passes `exec.signal` so model-driven task calls cancel with the tool call.

## Consequences

- `TeamTaskSnapshot` carries an additive optional `ownerName`; pre-field tasks still view-resolve through the member map, so no migration or version bump is needed.
- `createTask`/`updateTask` (service and Remote) and `TaskBoard.create`/`update` accept a trailing optional `AbortSignal`; existing callers keep working unchanged.
- The upstream v2 team rewrite (ProjectionHandle state, `team/mode`, descendant-catalog membership, inbox messaging) stays deferred under `packages/team/*` in the alignment matrix; adopting it requires an explicit version-1→2 durable-event migration decision.

## Alternatives considered

- **Adopt the upstream v2 rewrite wholesale** — rejected: it replaces the fork's durable roster (member phases, model-route persistence, `resolveActiveMember`), mailbox queue, activity waiting, write-scope warnings, and version-1 event schema with a leaner descendant-catalog/ProjectionHandle design. Immutable released Session JSONL also makes the version-1→2 event migration an explicit fork decision, not a merge.
- **Port `resolveAssignee` via `listDescendants`** — rejected: upstream admits any continuable descendant as an assignee; the fork's roster membership is the stricter, intended model.
- **Port the `state.enabled`/`team/mode` guard** — rejected: `roster.membership` already rejects non-members with `TEAM_NOT_MEMBER`; the flag exists for upstream's no-membership model.
- **Port `rootOf(caller)` queue rooting** — rejected: the local `journal.transact` already selects the queue by `root.id` under `reserveUse` admission; the caller never owns the queue.

## Verification

- `pnpm exec vitest run packages/experimental/{agent-team,tool-agent-team,agent-team-profile,client-ui-agent-team}` — 117 tests pass, including two new cases: durable `ownerName` written at claim/reassign and stripped at release (asserted on `foldTeam` output), and aborted signals rejecting `createTask`/`updateTask` before append.
- `pnpm exec tsc -b packages/experimental/agent-team packages/experimental/tool-agent-team` — clean; `oxlint` — clean.
