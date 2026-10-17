---
description: "Space-scoped durable agent memory: facts an agent saves today that later conversations still see, split into a host-plane service, a per-session catalog publisher, model-facing tools, and opt-in curation passes."
kind: "package-group"
---

# memory/ — space-scoped durable agent memory

English | [中文](README.zh.md)

Space-scoped durable agent memory: facts the agent saves today and later conversations still see.

The subsystem reference — scope spaces, entry schema, write rules, catalog and tool frames — is [docs/subsystems/memory.md](../../docs/subsystems/memory.md).

## Summary

Every session starts with an empty context window. The memory group lets the agent keep small facts across sessions, scoped by *who* they belong to: `personal` (about the user, applies in every workspace), `workspace` (one working directory on one execution target), or `project` (shared across a managed project). Entries are durable records in the `memory` storage domain; a per-session catalog message tells the model what exists, four tools manage the entries, and opt-in passes extract memories from finished turns, consolidate each scope, and recall entries relevant to the latest question.

## Table of Contents

| Package | ctx key | Role |
|---|---|---|
| [`memory`](memory/README.md) | `ctx.memory` | Host-plane `MemoryService`: scope resolution, validation, serialized writes, project authorization, bounded search |
| [`memory-context`](memory-context/README.md) | — | `agent/pre-step` listener publishing the saved-memory catalog and opt-in per-question recall |
| [`memory-curation`](memory-curation/README.md) | — | Opt-in turn-end extraction and interval-gated whole-scope consolidation passes |
| [`tool-memory`](tool-memory/README.md) | — | Model-facing `memory_search` / `memory_read` / `memory_save` / `memory_delete` + `tool:memory` prompt guidance |

## Scope spaces

A composition selects the space via the service's `space` config:

- `personal` — local runtimes: the personal scope plus a per-directory workspace scope
- `project` — managed project runtimes (the Gateway project patch sets `space: project`): one shared scope whose writes require execution-authority approval

## Invariants

- Writes serialize inside `MemoryService`; create/duplicate/revision/full checks are atomic per scope.
- `memory_context` republishes the catalog only when its entry digest changes, when it goes empty after having entries, or when compaction shadows the visible catalog.
- Model-visible text lives in `tool-memory` and `memory-context` only; the host service has no model-facing output.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
