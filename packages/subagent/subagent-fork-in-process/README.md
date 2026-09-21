# @deepseek-ai/dsh-subagent-fork-in-process

English | [中文](README.zh.md)

The fork provider creates an in-process child seeded with the parent's completed conversation turns. It shares all run mechanics with spawn; the session seed is the only behavioral difference.

## Summary

`dsh-subagent-fork-in-process` is an in-process subagent backend that seeds each child with the parent's completed conversation turns: the child sees every finished turn and none of the in-flight one, so follow-up work builds on the conversation without duplicating it. A delegation tool reaches it under the `fork` provider name, and its behavior matches the spawn backend except for the session seed. Choose it when a subtask continues this conversation; choose spawn when the child must stand alone. The seed is a one-time snapshot taken at fork time: later parent turns never reach the child.

## Seed boundary

The parent's current tool-calling turn is still open when a subagent starts: its log contains the assistant tool call but not the matching tool result or `turn/end`. Copying that raw log would give the child an invalid, unbalanced session.

Fork therefore computes the contiguous prefix ending at the last `turn/end`. The child sees all completed parent turns and none of the in-flight turn. If the parent has not completed a turn yet, the seed is empty and the child behaves like a fresh spawn.

The seed transfers conversation history only. The child still receives a fresh flat registration scope; it does not inherit the parent's tool restrictions or authority.

## Start and capabilities

`start(request)` passes the completed-turn seed to [`startInProcessRun`](../subagent-in-process-driver/README.md) and awaits child publication. The shared driver owns cancellation, depth, customization, result reading, and disposal.

Fork advertises `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`, identical to spawn.

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `fork`). |
See [`dsh-subagent-spawn-in-process`](../subagent-spawn-in-process/README.md) for the run lifecycle, model inheritance, and depth tracking — all shared.

## Model Experience

### Child-agent history and envelope

#### What the model sees

The child receives the parent's balanced completed-turn prefix, then the new task content verbatim. A configured persona shadows prompt text in the child's fresh scope; a tool restriction filters its global wire schemas, executable lookup, and PTC mode SDK bindings but not standalone guidance. The parent's tool view and authority are not inherited; an optional structured-output request adds a child-only contract; the parent's current in-flight turn is excluded.

#### Token effect

Forking duplicates retained completed history into the child's request, which then accumulates its own tokens independently. A persona changes repeated prompt cost; filtering changes schema or generated SDK cost; a first-turn fork has no inherited history.

#### KV Cache effect

The child may reuse the inherited byte-identical prefix under the same provider and model. Persona, tool-filter, generated-SDK, or route changes may invalidate reuse before inherited history; later child history is append-only. Continuable messaging adds no child-only system-prompt section or tool schema; the parent id and return guidance follow inherited history in the initial user task ([cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md)).

### Parent tool result, indirectly

#### What the model sees

The parent receives only the child's own final output through `dsh-tool-subagent`, not the inherited prefix or intermediate work.

#### Token effect

Parent input grows by one data-dependent final result retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The seed is a one-time snapshot** — the child sees the parent's completed turns as of the fork and nothing the parent logs afterwards; there is no live context sharing.
- **Fork lifecycle policy differs by composition** — the base bundle and the ACP/headless examples bind the fork delegation tool to `backgroundMode: one-shot`, while the Web app agent presets (`ptc`, `cordis`, `standard`) select `continuable`. Both keep the inherited prefix eligible for reuse because parent and child messaging definitions match byte for byte; explicit persona, tool filtering, generated-SDK, or route changes can still break equality. Rationale: [the cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md).
