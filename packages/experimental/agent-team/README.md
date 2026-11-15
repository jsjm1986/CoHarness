---
description: "Agent Teams mode selection, projection, and shared task board over ctx.agentTeams"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

Agent Teams coordination domain. `ctx.agentTeams` owns each root Session's Team mode selection and a shared, revision-checked task board folded from the Lead Session log. Teammates are ordinary named continuable subagents — durable catalog names, sibling-unique, root-relative paths — so creation, messaging, resumption, and interruption all stay with the standard `ctx.subagents` capability. The [Agent Teams v2 migration note](../../../.agents/notes/implemented/architecture/2026-11-15-agent-teams-v2-migration.md) owns the event-version and migration decisions.

## Summary

`dsh-experimental-agent-team` turns one coding session into a small working team when Team mode is on: the root agent becomes the Lead, delegates to named teammate subagents, and coordinates shared work through a durable task board with compare-and-set updates. Team state lives in the `agentTeam` Session projection — mode selection and task snapshots replay deterministically from the Lead log, and version-1 records written by the earlier roster/mailbox generation remain readable without being rewritten. The package provides no tools of its own — mount `dsh-experimental-tool-agent-team` for the model-facing task tools and `dsh-tool-subagent-control` for teammate messaging. It is published under its experimental name, carries no stability promise, and needs durable session storage to activate.

## Table of Contents

- [Config](#config)
- [Team mode](#team-mode)
- [Members and names](#members-and-names)
- [Shared task board](#shared-task-board)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    maxTasks: 256
    defaultEnabled: false
```

`maxTasks` bounds non-deleted tasks per root and must be a positive safe integer. `defaultEnabled` selects Team mode for newly started root Sessions that carry no prior `team/mode` record; stored Sessions keep whatever their log selected. The roster/mailbox generation's configuration keys were retired and fail loud at load — teammate limits, inbox delivery, and lifecycle now belong to the subagent capability.

The service requires Agent, Session, Session persistence, Session projections, and subagent services. A composition without durable Session storage does not activate it.

<a id="team-mode"></a>
## Team mode

Team mode is a durable per-root selection, not a plugin presence. `agentTeams.setEnabled()` is the root-only Remote that appends `team/mode`; the selection takes effect before persistence finishes and applies to the caller's whole subagent tree. Task tools and the Team prompt section resolve availability at each step, so enabling or disabling mid-session changes the model's next turn without restarting children or deleting tasks. Retrying the same selection flushes without a duplicate event.

<a id="members-and-names"></a>
## Members and names

A teammate is a named continuable descendant in the root's subagent tree. Names follow the durable catalog rules — lowercase, sibling-unique, addressable by root-relative path — and `list_agents` renders the tree the Team sees. Task ownership records both the member's Session id and its committed name, so views stay stable across resumption. Team events from a different root are inert in this projection: a fork that becomes its own runtime root starts its own board instead of inheriting the parent's.

<a id="shared-task-board"></a>
## Shared task board

Tasks are complete versioned snapshots appended as `team/task` records. Every mutation carries `expectedRevision`; stale callers receive `TEAM_TASK_STALE_REVISION` instead of overwriting a newer value. Any member may create an unowned pending task; ready unowned tasks are claimed by members, and only the root reassigns an owner to itself or another continuable descendant. Numeric `task-<n>` ids require a safe-integer suffix.

Dependencies must name current non-deleted tasks and form a complete DAG with no self or duplicate edge; a pending task is ready only when every blocker is complete. Deleting a task with live dependents is rejected; deleted tasks remain tombstones for replay but consume no `maxTasks` budget and never appear in listings. `writeScopes` are normalized workspace-relative prefixes that warn on overlap with in-progress tasks — coordination hints, not filesystem locks.

<a id="model-experience"></a>
## Model Experience

### Team state

#### What the model sees

Nothing directly: mode selection and task snapshots are log-only records. The model-facing surface is the four task tools and the policy section from `dsh-experimental-tool-agent-team`, plus the standard subagent tools for teammates.

#### Token effect

No model tokens; durable records stay outside derived history.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **One process and one shared checkout** — members share cwd and observe edits immediately; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **No automatic ownership release** — inactivity, interruption, process exit, and failed work do not release a task owner.
- **No Team waiting primitive** — waiting is ordinary subagent delivery: settlement notices and `send_message`, not task-board edges.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
