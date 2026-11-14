---
description: "Expose one external subagent tool that selects a configured runtime for each task."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-subagent-oar

English | [中文](README.zh.md)

## Summary

Use one `subagent_oar` tool to choose a configured external agent for each standalone text task. Configuration fixes the available runtime aliases and their providers; the model selects an alias without changing native arguments or permissions. Each task uses independent context and returns the child's name, then runs as a `subagent` background job whose settlement notice reaches the parent.

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

Mount this tool beside configured external providers, such as [OAR provider instances](../subagent-oar/README.md). Declare the tool and provider packages as dependencies of your composition.

### When to choose it

Choose this tool when one model-facing entry should select among independent, one-shot providers. It rejects providers that inherit the parent conversation or support continuation. Use the [shared subagent tool](../../subagent/tool-subagent/README.md) for continuable child agents or broader child configuration.

### Minimal configuration

With `oar-codex` and `oar-claude` already registered, mount this row in the composition:

```yaml
- name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

| Field | Default | Meaning |
|---|---|---|
| `providers` | required | Nonempty map from model-visible runtime aliases to registered provider names |
| `toolName` | `subagent_oar` | Tool name; every mounted instance needs a distinct name |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-subagent-oar) owns accepted fields and validation. A call requires `runtime`, `description`, and `prompt`. Optional `name` reserves a child name among the names this tool has given that parent: 1–32 lower-case letters, digits, or hyphens starting with a letter, and never `lead`; omission selects `agent-1`, `agent-2`, and so on. Optional `cwd` selects the child directory, with relative paths resolved from the parent's current directory. The prompt must contain the context the child needs. Native installation, authentication, model settings, and permissions belong to the selected provider.

The composition must also provide a `ctx.jobs` implementation such as [`@deepseek-ai/dsh-jobs-local`](../../jobs/jobs-local/README.md); the tool fails calls without one. [`@deepseek-ai/dsh-tool-jobs`](../../jobs/tool-jobs/README.md) supplies the model-facing `job_output`, `job_list`, and `job_kill` controls plus the completion notices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) builds the runtime enum from the configured aliases and registers one tool. Each call reserves a name against the names this tool has given the caller, resolves its provider, and awaits the shared subagent service's one-shot start, which owns admission, capability checks, child-directory resolution, catalog recording, and caller cancellation until the run is published. The published run is then registered as a `subagent` job owned by the caller: the job owns termination requests and the terminal record, and [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md) delivers settlement as the parent's completion notice. A disposal that fails inside settlement is handed back to the subagent service for retry by the same parent. The tool's call card uses the task description and submitted arguments. The result records `{ kind: 'activation', name }` as presentation metadata. Disposing the plugin removes its tool registration; published runs and their jobs keep their owners.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent service](../../subagent/subagent/README.md) — provider registration and activation ownership.
- [OAR provider](../subagent-oar/README.md) — native runtime setup and permission configuration.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — parent completion notices and retained results.

-----

<a id="model-experience"></a>
## Model Experience

### External delegation tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-subagent-oar) owns the description and argument schema. The `runtime` enum contains the configured aliases. After acceptance, the tool returns `started subagent <name>` with the name reserved for that child, such as `reviewer`. When the run settles, [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md) delivers a completion notice naming the child's job, and `job_output` returns its final answer or failure detail.

#### Token effect

Each mounted instance adds one tool schema, including the optional `name` field. The acknowledgement and completion notice append to the parent context; the provider owns the child's independent context and token use.

#### KV Cache effect

Changing the configured aliases, tool name, or registration changes the tool schema in later requests. Acknowledgements and completion notices append after the reusable parent prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The tool's choices and execution capabilities are fixed by its configured providers.

- **One-shot providers only:** child context is independent, and the tool exposes no follow-up, resume, structured output, or per-call native permission override.
- **Provider availability:** a selected provider that is absent or unloaded fails at call time; its configured alias remains in the schema until this tool's configuration changes.
- **Parent delivery requires jobs:** a call fails when no `ctx.jobs` implementation is mounted; model-facing collection and completion notices additionally need `dsh-tool-jobs`.
- **Provider-owned work:** runtime setup, startup cancellation, process cleanup, and answer selection follow the selected provider's documented behavior. Removing this tool does not revoke published runs or their jobs.
- **Tool-scoped names:** reserved names are unique only among the children this tool gave the same parent; names another delegation path claims are not checked.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
