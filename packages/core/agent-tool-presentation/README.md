# dsh-agent-tool-presentation

English | [中文](README.zh.md)

The row an [agent preset](../../preset/agent-presets/README.md) carries to say which form of its tools the model sees: `native` (every schema), `ptc` (only `run_code` plus a generated TypeScript SDK), or `both`; `code` remains an accepted compatibility alias.

## Summary

Use `dsh-agent-tool-presentation` in an [agent preset](../../preset/agent-presets/README.md) to fix whether models see every native tool schema, only `run_code` with a generated SDK, or both forms. Each preset can choose independently, so native and PTC agents can share one process without sharing tool catalogs. Selecting `ptc` or `both` requires a compatible PTC runtime; a deployment without one rejects the preset at mount time before its first prompt. The `mode` field is required when this package is present, while omitting the package keeps the deployment default.

## Why a row rather than a registry

The tool registry cannot move into a preset. Its consumers are all host-plane — [`dsh-agent-loop`](../agent-loop/README.md) reads its scheduler, [`dsh-apiproxy`](../../host/apiproxy/README.md) reads its presenters to render tool cards, and every tool plugin registers into it — and a service only moves down when all of its consumers move with it.

What a preset can own is the **presentation** of that registry. `ctx.tools.presentAs()` declares it for the mounting agent alone, so a PTC mode session runs beside native ones in one process, each seeing its own catalog. The deployment's `mode` on the [`dsh-tools`](../tools/README.md) row remains the default that agents declaring nothing get.

## What it does

`native` applies immediately. A PTC mode instead waits for `ctx.ptcRuntime`, which is a host-plane service ([`dsh-ptc-runtime-node`](../../ptc-runtime/ptc-runtime-node/README.md)): a preset selecting PTC mode against a deployment composing no runtime then holds this row pending, and `dsh-agent-presets` refuses the mount naming this id. The alternative — applying optimistically — moves the failure to the session's first request, where the operator can act on neither the preset nor the composition.

`mode` is required rather than defaulted, because a preset without this row already gets the deployment default; an omitted value would mean the row was composed for nothing.

One agent declares one presentation. A second declaration in the same composition is refused rather than merged: two answers to "which form does the model see" is a contradiction, not an override.

## Model Experience

Indirectly, through the tool presentation it selects in `dsh-tools` — the row only chooses between the two projections `dsh-tools` owns and registers no prompt, schema, or result of its own.

#### KV Cache effect

No direct invalidation; the presentation is fixed when the agent is composed, so its request prefix is stable for the session's life.

## Known Limitations and Deferred Work

- **The runtime stays host-plane** — a preset can select PTC mode but cannot supply the TypeScript runtime it needs; a deployment that composes none can compose no ptc preset.
