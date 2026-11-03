---
description: "Workflow capability seam: ctx.workflowEngine service, run vocabulary, and workflow/* events"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow

English | [中文](README.zh.md)

The workflow seam (`ctx.workflowEngine`) executes a model-written orchestration script that can fan out subagents. The seam defines the script, run, result, error, and event contracts; an engine decides how to isolate and execute the script.

`@deepseek-ai/dsh-workflow-ptc` is the current engine and `@deepseek-ai/dsh-tool-workflow` is the model-facing consumer. A future process or sandbox engine can replace the implementation without changing the tool.

The package root is the Host face. The browser-safe `@deepseek-ai/dsh-workflow/types` subpath contains run identities, metadata, results, and observe-only lifecycle payloads without importing `Agent`, Cordis services, or Host context declarations; Host-only Foreground Consumers enter `engine.withForeground(parent, signal, operation)` before starting a run and keep startup, collection, disposal and failed cleanup transfer inside its callback. The callback receives cancellation combined with engine withdrawal. Withdrawal rejects new admission, cancels and joins accepted callbacks, and retains their exact parents until they finish. Providers also retain admission in dependencies that own child cleanup. Independent raw starts and background Jobs keep holder controls.

`WorkflowStartRequest` and `WorkflowRun` live behind the package root.

## Summary

Run a plain-JavaScript orchestration script that fans work out to subagents and returns the script's final JSON value. Scripts can use `agent()`, `parallel()`, `pipeline()`, `phase()`, and `log()`; models normally access them through the `workflow` tool. Each run belongs to its caller, attributes every child to the invoking agent, resolves failures and cancellation without rejecting its result, and awaits script and child cleanup during disposal. The caller must supply an execution engine, allowing the isolation strategy to change without altering visible behavior.

## Table of Contents

- [Service and run contract](#service-and-run-contract)
- [Events](#events)
- [Failure discipline](#failure-discipline)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-and-run-contract"></a>
## Service and run contract

`WorkflowEngine.start(request): WorkflowRun` validates enough synchronously to reject a malformed meta block, unparseable script, unavailable provider route, or unsupported per-run limit before a run exists. Once returned, `WorkflowRun.result` never rejects: execution failures resolve with `stopReason: 'error'`, and cancellation uses `stopReason: 'cancelled'`. Cleanup can retain the run beyond process termination.

A run is holder-owned. Engine-plugin unload prevents new starts but does not revoke accepted runs. The holder must call `dispose()` on every path. Concurrent calls share one cleanup attempt; a failed attempt rejects and retains unfinished cleanup for a later retry. Result settlement does not confirm physical cleanup. A foreground holder transfers rejected cleanup with `run.retainFailedCleanup()` before discarding the handle. Observe its confirmation asynchronously; awaiting it inside the failing call would prevent that caller from requesting recovery. Holder-owned background work keeps its retry controls.

`WorkflowStartRequest` contains `{ meta, script, args?, subagentProvider?, maxTotalAgents?, parent, signal? }`. `parent` attributes every child agent to the invoking agent. `subagentProvider` optionally routes every child in that run without exposing provider choice to the script; omission uses the engine's configured provider. `maxTotalAgents` optionally lowers the engine's deployment ceiling for one run and is likewise invisible to the script. An implementation rejects invalid routes and limits synchronously. `meta` and `args` are plain data, not script fragments.

`WorkflowRun` exposes `{ id, meta, result, cancel(reason?), dispose(), retainFailedCleanup() }`. `WorkflowResult` contains `{ value, stopReason, error?, agentsStarted }`; `value` is plain JSON data or `null`.

<a id="events"></a>
## Events

Workflow events are observe-only. They carry `WorkflowRunInfo` (`id` plus `meta`) rather than the live run, so listeners cannot acquire cancellation or disposal authority.

- `workflow/start` / `workflow/end` pair the run.
- `workflow/phase` and `workflow/log` expose script narration.
- `workflow/agent-start` / `workflow/agent-end` pair each child call by `seq`; a child whose async provider start rejects emits neither.

Same-process event payloads are borrowed immutable values. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peers or changing execution.

<a id="failure-discipline"></a>
## Failure discipline

`WorkflowError` carries a code and a `fatal` flag. Fatal errors always escape `parallel()` and `pipeline()` instead of becoming an ordinary per-item `null`:

- `SCRIPT_PARSE` / `META_INVALID` — the workflow cannot start.
- `INVALID_ARGUMENT` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_SCHEMA` — a hook call violates the engine contract.
- `AGENT_CAP` / `ITEM_CAP` — configured safety limits were exceeded.
- `AGENT_START` — the provider's async start rejected.
- `AGENT_RESULT` — a published child's result rejected with an infrastructure fault.
- `RESULT_UNSERIALIZABLE` — a script/worker value is not plain JSON data.
- `CANCELLED` — cancellation owns the run and pending/future hooks reject.

A child that resolves normally with a non-completed stop reason is not an infrastructure exception: `agent()` returns `null`, allowing the script to handle an ordinary child failure.

<a id="model-experience"></a>
## Model Experience

Indirectly, through its consumer `dsh-tool-workflow` and a workflow engine, which render the parent tool result and the child-agent requests.

#### KV Cache effect

No direct invalidation; the named consumer and engine own any request-prefix changes.

## Known Limitations and Deferred Work

- **No Job controls on the engine** — `start()` returns a holder-owned run; Consumers use the Job capability for background registration and collection.
- **No journaling or resume** — scripts, child progress, and intermediate values are not checkpointed, so a process restart cannot continue a run.
- **No saved or nested workflows** — the seam starts caller-supplied scripts only, and a workflow script receives no `workflow()` hook for recursive orchestration.
- **No token-budget vocabulary** — engines cap concurrency, items, and children, but neither the request nor result accounts for model tokens across children.
- **Independent handles require their holders** — raw `start()` calls remain untracked; foreground Consumers use `withForeground()` for withdrawal joins. Every holder must dispose its run.

See the [dynamic-workflows Agent Note](../../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) for the deferred workflow API.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
