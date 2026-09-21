# dsh-persona

English | [中文](README.zh.md)

The agent persona as a composable row. It can either shadow the deployment persona or own the complete system prompt.

[`dsh-system-prompt`](../../core/system-prompt/README.md) owns the deployment persona as its own config and registers that section unconditionally, so a process has exactly one. An [agent preset](../agent-presets/README.md) cannot mount the prompt registry itself — without a row of its own, a preset could change an agent's tools but never its identity. This package is that row.

## Summary

`dsh-persona` gives one agent its own persona: a preset mounts this composable row to register persona prefix and suffix sections, shadowing the deployment-wide defaults for that session. It can also make the prefix the session's complete system prompt, suppressing every other section, and can turn off dynamic runtime-context snapshots for the session. Mount it inside a preset composition — mounting it globally collides with the prompt registry's own persona registration and fails loud. Without this row, a preset could change an agent's tools but never its identity.

## Scope-only

Mounting this row outside an agent scope collides with the registry's own `deployment:persona-prefix` registration and fails loud. That is not a limitation to work around: the deployment persona already has an owner, and the whole point of this row is to shadow it for one agent. Mount it inside a preset composition, where the preset mount supplies the agent scope.

## Config

| Field | Default | Meaning |
|---|---|---|
| `text` | required | Persona prose rendered as the `deployment:persona-prefix` section |
| `complete` | `false` | Restore this persona after assembly as the only system-prompt section |
| `includeRuntimeContext` | `true` | Include dynamic runtime-context snapshots for this agent scope; false suppresses every context contribution without disabling its owning services |

`text` is a template, like any prompt section: complete `{{…}}` groups resolve strictly against registered prompt variables when the prompt renders, not when it assembles. Empty text still occupies the slot, so it shadows the deployment persona away entirely and then disappears at render. With `complete: true`, assembly still resolves contexts, tools, variables, and cooperative listeners, then the prompt registry restores this exact persona as the sole section; no identity, tool guidance, or listener can append prompt text. With `includeRuntimeContext: false`, context providers are not evaluated for this scope and contexts added by assembly listeners are discarded.

## Invariants

**Runtime invariant:** No companion is published. The package contributes one declarative composition row; the resolved prompt is owned by preset composition.

## Model Experience

### The persona section

#### What the model sees

The `deployment:persona-prefix` section at order `0` carries this row's `prefix`; `deployment:persona-suffix` at order `10200` carries its `suffix`, after first-party guidance. Both replace their deployment defaults and resolve prompt variables. In complete mode, the model sees only the rendered prefix section as its system prompt. Runtime context remains enabled by default; when disabled, a fresh agent receives no runtime-context snapshot from sandbox policy, approval policy, delegation, or another system-prompt context provider.

#### Token effect

Fixed for a given preset: the persona prefix and suffix tokens on every request that agent makes, and none for any other agent. Empty text contributes nothing. Complete mode removes every other system-prompt token for that agent.

#### KV Cache effect

Prefix-stable while the rendered template variables and text are unchanged. Suffix changes leave preceding instructions unchanged when the model, prefix, and tools match. Prefix changes affect the early prefix; provider cache sharing is not guaranteed.

## Known Limitations and Deferred Work

- **No global mount** — the prompt registry owns the unscoped persona slot, so this row is usable only from a scoped composition. A deployment-wide persona change belongs in the `system-prompt` row's own config.
