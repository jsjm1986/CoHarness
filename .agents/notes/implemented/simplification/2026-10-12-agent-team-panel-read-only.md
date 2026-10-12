# Agent Note: Agent Team panel stays read-only

Status: implemented

English | [中文](2026-10-12-agent-team-panel-read-only.zh.md)

## Problem

The Web Agent Teams header panel carried a hand-maintained mutation surface — task create/edit forms, an owner select, and complete/reopen/delete actions — on top of `agentTeams/createTask` and `agentTeams/updateTask` RPCs. Upstream DeepSeek Harness retired that surface in `dsh-v0.2.0-rc.1`, leaving a read-only roster and task board. Keeping the local mutation path meant owning compare-and-set revision handling, conflict recovery copy, and form state that upstream no longer maintains or validates.

## Decision

[client-ui-agent-team](../../../../packages/experimental/client-ui-agent-team/README.md) renders the read-only board: `TeamActionInjected` narrows to `load` and `openTeammate`, the task section shows identity, status, owner, blockers, readiness, write scopes, and warnings with description clamping, and the locale dictionaries and tests drop every mutation affordance. Task mutation remains available to agents through the Team tools in [agent-team](../../../../packages/experimental/agent-team/README.md); the RPC methods themselves are untouched, so no service, projection, or wire contract changes.

The panel anchors to the right edge of its header trigger (`right: 0`) and falls back to a fixed bottom sheet under 768px, so a right-side trigger can no longer push content past the viewport.

## Alternatives considered

**Keep the mutation UI behind the existing RPCs.** The service methods still work, but the form would diverge from upstream forever: every upstream panel change would need a manual merge against a surface upstream deleted, for a flow the Team tools already cover.

**Remove the RPC methods too.** Out of scope — other consumers may call `createTask`/`updateTask`, and contract removal is an [agent-team](../../../../packages/experimental/agent-team/README.md) decision, not a panel decision.

## Consequences

Human users lose manual task entry; they observe the board and navigate teammates, while agents keep full task control. The panel loses ~290 lines of form, revision, and conflict-recovery logic, and its tests now pin read-only rendering plus the load/refresh/navigation behavior that remains. The injected surface shrinks to two callbacks, which simplifies any future mount changes.
