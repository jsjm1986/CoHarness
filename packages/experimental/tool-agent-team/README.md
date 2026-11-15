---
description: "Conditional shared-task tools and policy for Agent Teams mode"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

Model-facing adapter for [`ctx.agentTeams`](../agent-team/README.md). It registers exactly four shared-task tools plus one system-prompt policy section, each conditional on the caller's root Session having Team mode enabled. Teammate creation, discovery, messaging, and interruption stay with the standard subagent tools (`subagent`, `subagent_fork`, `list_agents`, `send_message`, `interrupt_agent`); this package deliberately adds no Team-specific collaboration surface.

## Summary

This package lets the model coordinate delegated work through a shared, revision-checked task board: create tasks with dependency and advisory write-scope metadata, list and read the board, and apply compare-and-set transitions — claim, release, edit, set_dependencies, complete, reopen, reassign, and delete. The tools exist only while Team mode is enabled on the root Session, so the same composition serves ordinary and Team sessions without leaking task tools into either. The package is published under its experimental name and provides no stability guarantee.

## Table of Contents

- [Config](#config)
- [Tools and authority](#tools-and-authority)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

The plugin takes no configuration. The retired `interrupt`, `freshProvider`, and `forkProvider` keys fail at load with an explicit error; create teammates through a `subagent` tool provider and interrupt them through `interrupt_agent` instead.

<a id="tools-and-authority"></a>
## Tools and authority

The generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) owns exact schemas. The adapter supplies `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update`; every registration is conditional on `ctx.agentTeams.isEnabled(caller)`, so tool discovery and the policy section appear only in Team sessions.

`team_task_update` is compare-and-set: `expected_revision` must match the board's current revision or the call fails with `TEAM_TASK_STALE_REVISION`, which is how concurrent members avoid overwriting each other. `owner` arguments are agent names resolved through `ctx.subagents.resolveName` — the durable names `subagent` returns and `list_agents` shows, including root-relative paths. Reassign is root-only; the root may target itself or any continuable descendant. Other members claim only ready, unowned tasks and manage tasks they own. Task results replace the internal owner Session id with the member's agent name.

Readiness, blockers, and `writeScopeWarnings` are advisory coordination: `write_scopes` record intent for reviewers, not filesystem locks. Task changes never deliver messages or start idle agents — use `send_message` when another member must act.

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

When Team mode is enabled, one shared policy section explains the shared working directory, write-scope and dependency coordination, the claim-update-complete workflow, and that task changes do not wake anyone — the Lead must wait for required teammates before its final answer. Disabled sessions see no section and no tools. Task results arrive as compact JSON rows from the four `team_task_*` tools in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team); the board itself stays log-only and never enters derived history.

#### Token effect

The policy section and four schemas cost tokens on every Team-enabled request; other sessions pay nothing. Tool calls add small JSON results.

#### KV Cache effect

Enabling Team mode inserts the policy section and schemas into the system prefix, so a Session's first Team-mode request rebuilds the provider prefix; subsequent requests in the same mode reuse it. Teammate sessions under the same mode share the identical prefix.

## Known Limitations and Deferred Work

- **Advisory write scopes** — Bash, formatters, code generators, and external processes can bypass the overlap warning; Leads must review the final diff.
- **No Team-owned waiting primitive** — the Lead waits through `send_message` reports and settlement notices; task changes do not interrupt or wake any member.
- **Reassign is root-only** — teammates cannot hand owned tasks to peers; they release for re-claim instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
