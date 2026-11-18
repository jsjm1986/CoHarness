---
description: "Enable team collaboration, tools, and the Web roster and task board with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-profile` enables [Agent Teams](../agent-team/README.md) collaboration, tools, and Web UI with one bundle. Teammates are ordinary named continuable subagents created by the shipped `subagent` tools; Team mode adds a shared task board and a Web panel that toggles mode, lists members, and opens teammate sessions. The bundle ships with dsh switched off. Enable it from the Plugins page or add it to an initialized profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

Add the package to an initialized profile, then run a task that asks the Lead to delegate work:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile
dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services and provider rows this layer consumes. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` removes the bundle from the profile's ordered layer list.

Enable Agent Teams on the Web or Desktop Plugins page to activate both tools and UI. For a CLI Web profile, use:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
```

Keep `@deepseek-ai/dsh-experimental-agent-team-profile` in `dsh.profile.bundles`. User patches targeting `ui-agent-team` still apply.

### What you get

The layer adds the Agent Teams domain, the four conditional `team_task_*` tools, and the Web Team action. Delegation, naming, messaging, resumption, and interruption all ride the base profile's ordinary subagent tools — `subagent`, `subagent_fork`, `list_agents`, `send_message`, and `interrupt_agent` stay enabled, and Workflow keeps its `spawn` provider. Once Team mode is on for a root Session, the task tools and policy section appear for every member of that tree.

In Web and Desktop conversations, the [Team UI](../client-ui-agent-team/README.md) displays the member roster and shared task board and opens teammate sessions. The same bundle switch controls the tools and browser UI. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, the patch inserts the Team service, task tools, and UI beside the base subagent stack without disabling any base tool. The UI plugin has an inert Host entry; only the Web Client loader mounts its browser entry, so headless needs no Web server.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Agent Teams service](../agent-team/README.md) — durable roster and task board, plus direct messaging.
- [Agent Teams tools](../tool-agent-team/README.md) — the Team-scoped model tool surface.
- [Agent Teams browser UI](../client-ui-agent-team/README.md) — roster, task board, and teammate session navigation.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The Team policy and schemas belong to [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.md). This bundle changes composition only: the base `list_agents`, `send_message`, `interrupt_agent`, `subagent`, and `subagent_fork` tools keep their global registrations, and the four `team_task_*` tools appear while Team mode is on. Workflow’s `agent()` calls create fresh one-shot children; their prompts must contain the context needed for their tasks.

#### Token effect

The bundle adds the Team policy and tool schemas described by `@deepseek-ai/dsh-experimental-tool-agent-team`; it adds no prompt text of its own.

#### KV Cache effect

The shared system prompt and tool schemas remain prefix-stable while the bundle patch and configured tool schemas remain unchanged. Team identity is appended through runtime-context snapshots; [Team tools](../tool-agent-team/README.md#model-experience) define snapshot reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Workflow child tools** — the [Team tool visibility limitation](../tool-agent-team/README.md#known-limitations-and-deferred-work) also applies to workflow children.
- **Shared checkout** — every teammate observes the same working directory; this bundle adds no worktree isolation or filesystem locking.
- **Preset-scoped child controls** — Web presets can still mount continuable Subagent controls in their own scope; this top-level bundle does not replace those registrations.
- **Base profile required** — the patch depends on row ids and Subagent providers supplied by `dsh-base`; it is not a standalone profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
