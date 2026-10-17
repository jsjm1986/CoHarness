---
description: "Composition-authored deployment persona section for the DeepSeek Harness"
kind: "package-reference"
---

# dsh-persona

English | [中文](README.zh.md)

The agent persona as a composable row. It can either shadow the deployment persona or own the complete system prompt.

[`dsh-system-prompt`](../../core/system-prompt/README.md) owns the deployment persona as its own config and registers that section unconditionally, so a process has exactly one. An [agent preset](../agent-preset-registry/README.md) cannot mount the prompt registry itself — without a row of its own, a preset could change an agent's tools but never its identity. This package is that row.

## Summary

`dsh-persona` gives one agent its own persona: a preset mounts this composable row to register persona prefix and suffix sections, shadowing the deployment-wide defaults for that session. It can also make the prefix the session's complete system prompt, suppressing every other section, and can turn off optional runtime context for the session. Mount it inside a preset composition — mounting it globally collides with the prompt registry's own persona registration and fails loud. Without this row, a preset could change an agent's tools but never its identity.

## Table of Contents

- [Scope-only](#scope-only)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="scope-only"></a>
## Scope-only

Mounting this row outside an agent scope collides with the registry's own `deployment:persona-prefix` registration and fails loud. That is not a limitation to work around: the deployment persona already has an owner, and the whole point of this row is to shadow it for one agent. Mount it inside a preset composition, where the preset mount supplies the agent scope.

<a id="config"></a>
## Config

| Field | Default | Meaning |
|---|---|---|
| `text` | required | Persona prose rendered as the `deployment:persona-prefix` section |
| `complete` | `false` | Restore this persona after assembly as the only system-prompt section |
| `includeRuntimeContext` | `true` | Include optional runtime context for this agent scope; false suppresses optional contributions without disabling their owning services; required contributions remain |

`text` is a template, like any prompt section: complete `{{…}}` groups resolve strictly against registered prompt variables when the prompt renders, not when it assembles. Empty text still occupies the slot, so it shadows the deployment persona away entirely and then disappears at render. With `complete: true`, assembly still resolves contexts, tools, variables, and cooperative listeners, then the prompt registry restores this exact persona as the sole section; no identity, tool guidance, or listener can append prompt text. With `includeRuntimeContext: false`, optional context providers are not evaluated for this scope, and assembly-listener contributions are discarded unless registered as required. Required providers remain active at assembly and request admission.

<a id="model-experience"></a>
## Model Experience

### The persona section

#### What the model sees

The `deployment:persona-prefix` section at order `0` carries this row's `prefix`; `deployment:persona-suffix` at order `10200` carries its `suffix`, after first-party guidance. Both replace their deployment defaults and resolve prompt variables. In complete mode, the model sees only the rendered prefix section as its system prompt. Runtime context remains enabled by default. With `includeRuntimeContext: false`, the model still receives required context, such as the current working directory; optional context is omitted.

#### Token effect

Fixed for a given preset: the persona prefix and suffix tokens on every request that agent makes, and none for any other agent. Empty text contributes nothing. Complete mode removes every other system-prompt token for that agent. Required runtime context still contributes tokens when optional context is disabled.

#### KV Cache effect

Prefix-stable while the rendered template variables and text are unchanged. Suffix changes leave preceding instructions unchanged when the model, prefix, and tools match. Prefix changes affect the early prefix; provider cache sharing is not guaranteed.

## Known Limitations and Deferred Work

- **No global mount** — the prompt registry owns the unscoped persona slot, so this row is usable only from a scoped composition. A deployment-wide persona change belongs in the `system-prompt` row's own config.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
