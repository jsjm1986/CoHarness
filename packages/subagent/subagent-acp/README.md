---
description: "Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-acp

English | [中文](README.zh.md)

The ACP provider runs each subagent in a fresh subprocess and drives it as an Agent Client Protocol client. It is the out-of-process alternative to spawn and fork: the child has its own runtime, session, model configuration, and tools.

## Summary

Use this package to delegate a task to an ACP-compatible agent running in a fresh subprocess with its own runtime, session, model, and tools. Each run shares only the selected working directory, sends the task over ACP, and returns the child's final answer or a safe error; intermediate messages and tool traffic stay outside the parent conversation. Permission prompts are answered by configured policy without human interaction. Choose it when delegation needs process isolation or a non-Harness ACP agent, and choose an in-process backend when the child must share parent capabilities.

## Table of Contents

- [Start and ownership](#start-and-ownership)
- [Capabilities and context](#capabilities-and-context)
- [Configuration](#configuration)
- [Persistent members (`resume`)](#persistent-members-resume)
- [Stop-reason mapping](#stop-reason-mapping)
- [Process boundary](#process-boundary)
- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="start-and-ownership"></a>
## Start and ownership

`start(request)` resolves the child's working directory, then performs `spawn` → ACP `initialize` → `newSession` before it fulfills. Fulfillment therefore means a remote session is ready and ownership has transferred to the caller. A spawn, initialization, new-session, or pre-publication cancellation failure waits for subprocess cleanup before rejecting; cleanup failures remain in the rejection rather than claiming quiescence. A working-directory resolution failure rejects before anything is spawned.

The working directory is the configured `cwd` override when set, else the delegating parent session's cwd — never the server process's own cwd, because one server process serves sessions from many workspaces. The parent-derived value must be an absolute path naming a directory the harness can enter (search permission — what a subprocess cwd needs), and the same resolved path becomes both the subprocess cwd and the ACP `session/new` workspace.

The returned run id is minted in the parent namespace. The child server's session id remains private to ACP wire calls because ACP guarantees it only within that fresh child process; using it as the parent lifecycle id could collide with another remote run or a local agent.

After publication, the provider sends the prompt and collects streamed `agent_message_chunk` text into `SubagentResult.output`. A prompt/transport failure resolves with `stopReason: 'error'`, or `aborted` when the required request signal or disposal requested cancellation.

`dispose()` is idempotent. It removes the signal listener, requests ACP cancellation when possible, then runs this backend's own teardown ladder (`disposeAcpChild`) over the seam's verbs: close stdin and wait `disposeEofGraceMs` for cooperative quiescence, then invoke the handle's `terminate()` escalation (SIGTERM, the spawn grace, SIGKILL — Windows force-terminates directly) and await the subprocess owner's managed-range exit proof. A failed cooperative exit observation still reaches termination and the final wait. One observation failure is preserved; failures from both waits are aggregated. A rejected command outcome alone does not establish range quiescence. Every run uses a fresh process; process pooling is not implemented.

<a id="capabilities-and-context"></a>
## Capabilities and context

ACP advertises no start-time capabilities because this process cannot enforce the remote child's depth, tool filter, persona, or structured-output runtime. It also reports `inheritsParentContext: false`: the remote session starts fresh, and the only parent-derived input is the workspace cwd described above — no conversation context crosses the process boundary.

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `acp` | Registry name on `ctx.subagents`. |
| `command` | required | Executable spawned for each run. |
| `args` | `[]` | Command arguments. |
| `cwd` | parent session cwd | Working-directory override for the child process and its ACP session; must be non-empty, a relative value resolves against the harness launch directory at load, and the result must name a directory the harness can enter. |
| `permission` | `reject` | Auto-answer permission requests by rejecting or choosing the first `allow_once` or `allow_always` option. |
| `env` | `{}` | Explicit child environment layered over a credential-scrubbed parent environment. |
| `disposeEofGraceMs` | `6000` | Positive grace after stdin EOF before platform termination; it cannot exceed [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `disposeGraceMs` | `3000` | Positive POSIX grace after SIGTERM before SIGKILL (Windows force-terminates directly); it cannot exceed [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `resume` | `false` | Enable persistent members: the provider gains `prepareContinuable`, and member children run as in-process continuation-managed Agents whose model calls drive durable ACP sessions through `session/load`. Requires the `llm` service and an agent advertising `loadSession`. |
| `stateDir` | `~/.dsh/external-members` | Directory holding the member binding store (`acp.jsonl`). Used only with `resume`. |
| `memberCwd` | `cwd`, else member Session cwd | Workspace override for persistent members, validated on their execution target. |

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: node
    args: ['--import', 'tsx', './packages/examples/acp-demo/src/bin.ts', '--config', './examples/acp-agent/cordis.yml']
    permission: reject
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

<a id="persistent-members-resume"></a>
## Persistent members (`resume`)

With `resume: true` the provider advertises `prepareContinuable`, so `ctx.subagents.startContinuable` accepts it — the Team roster's provider-selection channel included. A member child is an ordinary in-process Agent owned by the continuation manager (durable identity, inbox, persistence, restart); this package contributes only the model route: every member model call spawns one ACP child process, attaches to the member's durable ACP session (`session/load` when bound, `session/new` on the first turn), issues one prompt, and disposes the process.

`session/load` is optional, so member creation probes it before publishing the durable child. The binding store retains the child ↔ ACP session mapping, pending prompt, and consumed cursor. A live prompt completes only with `end_turn`; cancellation and other stop reasons fail. Loaded history has no request-correlated terminal result, so an interrupted prompt reports `EXTERNAL_TURN_OUTCOME_UNKNOWN` without resending. This preserves durable-session continuation without treating partial replayed text as success.

With `resume` unset the provider stays one-shot only — no `prepareContinuable`, so continuable starts reject `UNSUPPORTED_CAPABILITY`.

<a id="stop-reason-mapping"></a>
## Stop-reason mapping

| ACP | Harness |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `refusal` | `refusal` |
| `cancelled` | `aborted` |
| `max_turn_requests` or unknown | `error` |

<a id="process-boundary"></a>
## Process boundary

The child spawns through the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam: credential-shaped ambient variables and ambient `DSH_*` names are removed by the shared scrub, then explicit `config.env` values merge after it (an intended `DEEPSEEK_API_KEY` survives, and a `DSH_*` deployment fact such as `DSH_PERMISSION_MODE` reaches the child the same way — the scrub drops only its stale ambient namesake), stderr is inherited to the parent's own stream, and disposal applies this plugin's EOF window before the subprocess-owned SIGTERM→SIGKILL escalation and managed-range join. The provider documents its containment and observation limits. The ACP wire is the real serialization boundary; same-process subagent values are not defensively cloned.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Each run drives one child over the ACP wire; the child's runtime owns its session and the provider holds only the in-flight client.

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The remote child receives the standalone task content through ACP plus its own process's configured system prompt, tools, and fresh session. It receives no parent conversation. This provider advertises no optional start-time capabilities, so the local service rejects requests for `agentOptions`, persona, tool filtering, depth enforcement, or structured output instead of silently omitting them.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each ACP child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final streamed assistant text or that consumer's exact stop-reason error, not intermediate messages or tool traffic. Non-completed results present the safe diagnostic before separately preserved partial assistant output. A request already cancelled before publication becomes exactly `Error: subagent request was aborted before the ACP child started`; another start failure contains only the fixed `Subagent failure (...)` line.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A fresh process per run** — persistent-process pooling is a future optimization ([the seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)).
- **Remote prerequisites** — SSH targets need a preinstalled compatible ACP program with `loadSession`; this package never installs it or falls back to the Host.
- **No optional start-time capabilities** — this provider cannot apply the local harness's `outputSchema`, depth cap, tool filter, or persona inside the remote process, so it advertises none and the service rejects requests that require them.
- **Only committed `agent_message_chunk` text is collected** — the automation server keeps reasoning, tool activity, plans, and other trace data in the child session log rather than emitting them on ACP.
- **Permission prompts are auto-answered** (`permission: allow | reject`) — no human is surfaced a child's `session/request_permission`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
