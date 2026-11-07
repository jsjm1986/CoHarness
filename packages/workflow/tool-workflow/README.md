---
description: "The model-facing workflow tool: run a JavaScript orchestration script that fans out subagents, for users and maintainers choosing or configuring model-driven orchestration."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workflow

English | [中文](README.zh.md)

## Summary

`dsh-tool-workflow` lets a model run JavaScript orchestration that delegates to many subagents and returns a final JSON value. Use it only when the user explicitly requests a workflow or large multi-agent orchestration; prefer plain subagent calls for one or two delegations. Foreground execution waits for all work; cancellation or abnormal completion returns an error rather than partial success. `run_in_background: true` returns an owned job id immediately and exposes live output. Deployments can rename the tool with `toolName` and cap rendered results with `maxResultChars`.

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

The `workflow` tool runs a model-authored orchestration script that fans work out across many subagents and returns the script's final JSON value. Use it only when the user explicitly asks for a workflow or for large multi-agent orchestration — an audit over many files, a migration, multi-angle research; for one or two delegations, prefer plain subagent calls.

### Calling the tool

The model submits three parameters plus one flag: `meta` (required identity data: `name`, `description`, and optional `whenToUse` and `phases`), `script` (required plain JavaScript body — no `export const meta` statement; its parameter description carries the body rules and the tool description carries the hook contract), `args` (optional JSON object exposed to the script as the `args` global; wrap a bare list in a field so the wire schema stays honest), and `run_in_background` (optional; present only while `enableRunInBackground` holds).

A foreground success returns the envelope `{ kind: 'foreground', runId, agentsStarted, result }`, rendered to the model as `workflow "<name>" completed (<count> agent<optional-s>).` followed by `Return value:` and the pretty-printed JSON. A workflow that cannot start — a script parse or meta validation failure — returns an error the model can correct from. Cancellation and execution failures return `Error: workflow run was cancelled` or `Error: workflow run failed: <error>`; partial output is never reported as success.

### What to expect during a run

The foreground call enters the original engine’s `withForeground()` before startup and retains collection, disposal and failure transfer through engine or PTC subagent-runtime withdrawal. Its combined cancellation signal is bridged to the run. A cleanup rejection returns an error and transfers unfinished child cleanup to its original runtime. A later child start for the exact parent retries it before allocation; the original durable run ending follows confirmed cleanup. Recovery never replays the script or prompt. The model sees one final outcome, never intermediate child messages; the children's own work stays out of the parent conversation.

### Background runs

`run_in_background: true` returns `{ kind: 'background', jobId, runId }` immediately: the run is registered on `ctx.jobs` as an owned `workflow` job, so the session-header job list streams its `phase()`, `log()`, and member lifecycle lines live from the job's output ring, and the row's progress line tracks the current phase. No tool-step signal reaches the run — `job_kill`, the list's stop control, and owner teardown are what cancel it. Settlement is the job's settlement: a completed run carries the same rendered return value as the job's result (the completion notice announces it, the model's first `job_output` after settlement carries it once), a cancelled run settles `killed` with the kill reason, and a failed run settles `failed` with the script's failure message. Without a live job registry and a controller serving the caller the call fails, naming the missing composition pieces.

The job registry retains the creating tool call and its root in the owning Session, including nested workflow calls.

Unconfirmed cleanup keeps the Job live with a cleanup notice. Request termination again to retry; confirmed recovery settles the Job as failed and withholds the script value.

### Config

| Field | Default | Meaning |
|---|---|---|
| `toolName` | `workflow` | The model-facing tool name to register. |
| `maxResultChars` | `50000` | Rendered-result ceiling; longer JSON is truncated with a notice. |
| `enableRunInBackground` | `true` | Expose `run_in_background`; disabled calls are also rejected. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-workflow) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the consumer is split from the engine and how the run lifecycle and records work; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The consumer owns the model-facing schema, the `tool:<toolName>` system-prompt guidance, and the result envelope; script parsing, execution, caps, and cancellation live behind `ctx.workflowEngine`, while the PTC engine shares Node process confinement with `run_code`. Usage guidance ships with the tool plugin as a prompt section, never in the deployment persona.

### Run lifecycle

`execute` starts the run and awaits `run.result` inside a `try/finally` that always disposes the run. `exec.signal` is bridged to `run.cancel()`, including the already-aborted-before-start case. A non-`completed` stop reason maps to an `isError` result reporting the reason; completion renders `{ kind, runId, agentsStarted, result }`, with the Native renderer truncating only that projection at `maxResultChars`.

### Background lifecycle

A background call registers the run through `jobs.start` inside the job starter, so a synchronous engine rejection registers nothing and admission preflight runs before the engine spawns. The job remains live until disposal confirms cleanup. A failure stops the progress mirror, publishes an unconfirmed-cleanup notice and waits for another termination request to retry; its owner remains busy. After cleanup succeeds, a run with any cleanup failure settles as a failed job without publishing its partial value. Run-end and job settlement remain pending until then. Each ring mirror (`src/record.ts`) routes only its run’s `workflow/phase`, `workflow/log` and member events into the original `JobHandle`. Its subscriptions belong to the original parent scope and survive tool replacement. Parent teardown retains them until cleanup or its failure notice stops the mirror; stop immediately rejects later events and releases the subscriptions without cancelling the Job.

### Durable session records

For a root transport execution (`exec.parent` absent), the tool projects the run into the calling Agent's Session with four log-only events: run-start after `start()` returns, member starts and endings filtered by `run.id`, then run-end only after the result is available and disposal reaches quiescence. Nested transport calls execute normally but write no record. The first failed Session append disables later recording for that run with one warning, leaving either no record or a legal continuous prefix without changing the tool result or cleanup.

Each accepted record owns its event subscriptions in the exact parent Agent’s scope. Tool definition withdrawal preserves those subscriptions and their idle-release veto until the record finishes or is abandoned. Parent scope teardown waits for a background Job’s final record without taking over its cancellation controls; an ended foreground parent scope drops its unfinished record, so late callbacks cannot write through that retired owner.

The engine's `workflow/phase` and `workflow/log` events have no per-line durable surface from this tool: the session log deliberately records run and member lifecycle only, and the Web transcript derives from those records. A background run's lines reach a human through the job observation record instead, which is transient by design.

### Render intent

Decided up front per the [render-intent Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md): a `generic` card titled `workflow: <meta.name>`, read directly from `args.meta.name` — presentation is a pure function of args — with the script text carried as `rawInput`. The result keeps the generic card.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, run lifecycle, background job registration, recorder wiring |
| [`src/record.ts`](src/record.ts) | Background runs' live-progress mirror into the job's output ring |
| [`src/types.ts`](src/types.ts) | The four log-only record event payloads and their `SessionEventMap` declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the tool-level contract is not enough. They move from the shared workflow model to the engine and the comparable delegation tool.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam contract, start request, and event payloads.
- [Workflow seam](../workflow/README.md) — the run and result vocabulary behind the tool.
- [PTC workflow engine](../workflow-ptc/README.md) — the engine that executes the scripts.
- [subagent tool](../../subagent/tool-subagent/README.md) — the plain-delegation alternative for one or two children.
- [Group map](../README.md) — the workflow capability family and its packages.
- [historical Dynamic workflows Agent Note](../../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) — the seam design and its decisions.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the workflow guidance below. A scoped tool restriction can hide the schema without removing this independently registered guidance.

##### Workflow guidance

```markdown
Use the <toolName> tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

When visible, the generated default [`workflow` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workflow) carries the complete JavaScript hook and metadata contract; `toolName` can rename the definition, and the model submits script, metadata, and optional args.

#### Token effect

Substantial fixed schema cost on each request where the tool is visible.

#### KV Cache effect

Prefix-stable while `toolName`, definition, and visibility are unchanged. Renaming, plugin lifecycle, or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The full model-written script, metadata, and args remain in the assistant tool call. A foreground success is exactly `workflow "<name>" completed (<count> agent<optional-s>).`, newline, `Return value:`, newline, and pretty-printed data-dependent JSON; a cap adds `… [truncated: <omitted> more characters]` on a new line. A background acceptance is exactly `workflow "<name>" started in the background as job <jobId>. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`, and the same rendered value later reaches the model through the job's completion notice and `job_output`. Failures are exactly `Error: workflow run was cancelled`, optionally suffixed ` (<error>)`, `Error: workflow run failed: <error-or-unknown error>`, or defensively `Error: workflow run ended abnormally (<reason>)`; a call without an owning agent becomes `Error: workflow tool requires a calling agent (exec.agent was undefined)`. Intermediate child messages are omitted.

#### Token effect

Call tokens can be large and remain until compaction. Result rendering is capped by `maxResultChars`; child-model tokens are separate from the parent's retained context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tool does not yet support. They are current constraints, not a task backlog.

- **A background run reports no intermediate value to the model** — `job_output` before settlement returns status only; the return value arrives whole at completion, and cancellation still discards partial output.
- **`args` must be an object and Native result text is bounded** — callers wrap top-level arrays and scalars in a field; the canonical workflow result stays complete, while JSON beyond `maxResultChars` is truncated in the model-facing projection rather than stored behind a retrieval handle.
- **Workflow policy is fixed per tool registration** — provider selection, caps, and tool name are deployment config, not model-call arguments.
- **Unconfirmed cleanup retains the owner** — persistent cleanup failure can keep owner or service teardown waiting until a termination retry succeeds.
- **Durable records are top-level and observational** — nested PTC mode dispatches are not recorded, and a recording failure intentionally degrades to an incomplete prefix rather than changing execution.
- **No recorded-session scenario replays a background run yet** — unit and real-engine composition suites cover the path; the snapshot tree pins only the schema and prompt text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

Open directions: storing truncated JSON behind a retrieval handle instead of clipping the projection; recording nested dispatches beyond the top level; a recorded-session scenario for the background path.

</details>
