# @deepseek-ai/dsh-subagent-spawn-in-process

English | [中文](README.zh.md)

The spawn provider creates a fresh child `Agent` in the current process. The child has its own session, sees no parent conversation history, and reuses the host's agent factory and LLM/tool services.

## Summary

`dsh-subagent-spawn-in-process` is an in-process subagent backend: it runs each delegated task in a fresh child agent that shares this process and its agent factory, LLM, and tool services. The child starts with an empty conversation, so a task prompt must stand alone; it inherits the parent's working directory, session lineage, provider, model, reasoning effort, and output-token limit unless `request.agentOptions` overrides them. A delegation tool or API call reaches it under the `spawn` provider name. Choose it for the cheapest delegation transport; choose the fork backend when the child must build on the parent's completed conversation turns.

## Behavior

`start(request)` delegates to [`startInProcessRun`](../subagent-in-process-driver/README.md) with no seed and awaits publication before returning. The child receives parent working-directory/session lineage and inherits the parent's latest logged provider/model route unless overridden; it falls back to the parent's creation options before the first request is logged, but starts with an empty conversation.

The shared driver owns depth checking, persona and tool-filter setup, structured output, required-signal cancellation, one-shot execution, result reading, and quiescent disposal. A startup rejection leaves no published child; provider unload after fulfillment does not revoke the holder-owned run.

## Capabilities

Spawn advertises `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }` because it controls the child's creation window and can enforce all four features.

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |

## Model Experience

### Child-agent request

#### What the model sees

The fresh child receives the task content verbatim as its only user message in a new empty conversation, with the parent provider, model, reasoning effort, output-token limit, and working directory by default. A configured persona shadows global prompt text in the child's scope; a tool filter removes named global tools from its schemas, executable lookup, and PTC mode SDK bindings while leaving independently registered guidance. No parent conversation message is included; the filter is composition, not an inherited authority grant.

#### Token effect

The child pays for a new independent context and history, and no parent-history token is duplicated. A persona changes the child's repeated prompt cost; a tool filter changes its schema or generated SDK cost.

#### KV Cache effect

The child's request cache is independent of the parent's. Child history grows append-only, while persona, tool-filter, generated-SDK, provider, or model changes establish a different child prefix.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final output or an errored result for a non-completed stop reason; intermediate child work never reaches it.

#### Token effect

Parent input grows by one data-dependent result, retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Fresh means no parent transcript** — the child inherits cwd, lineage, the latest logged route, and explicitly configured persona/tool restrictions, but none of the parent's conversation; use the fork provider when completed-turn context is required.

## Invariants

**Runtime invariant:** No companion is published. The child Agent is created and disposed within the call by the shared driver; the provider owns no post-run state.
