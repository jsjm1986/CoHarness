---
description: "Out-of-process SDK subagent backend: drives a child DeepSeek Harness runtime subprocess over stdio JSON-RPC through the TypeScript SDK client"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-sdk

English | [中文](README.zh.md)

The SDK provider runs each subagent as a complete DeepSeek Harness runtime in a fresh subprocess, driven over stdio JSON-RPC through the [TypeScript SDK client](../../sdk/client/README.md). It is the second out-of-process backend beside [`subagent-acp`](../subagent-acp/README.md), differing in the wire and the child contract: the ACP backend drives any Agent Client Protocol agent; this backend drives specifically a harness SDK runtime launched through a named `dsh` SDK profile, so the child is a full peer harness — own `cordis.yml`-decided composition, session persistence, model route, and tools.

## Summary

`dsh-subagent-dsh-sdk` runs each delegated task in a fresh DeepSeek Harness subprocess with its own profile, session, model route, and tools. The parent provides the task and working directory, while each child uses its configured runtime and remains isolated from the parent conversation. Only the final assistant text or a safe error enters the parent conversation. Managed parent control observes model requests and chunks for authorization and metering; the child retains its own transcript. Choose this backend when delegation needs a complete Harness runtime rather than shared in-process state, and accept the cost of starting a new process for every run.

## Table of Contents

- [Start and ownership](#start-and-ownership)
- [Stop-reason mapping](#stop-reason-mapping)
- [Capabilities and context](#capabilities-and-context)
- [Configuration](#configuration)
- [Process boundary](#process-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="start-and-ownership"></a>
## Start and ownership

`start(request)` resolves the child's working directory, spawns the runtime through `DeepSeekHarness`, and completes the `initialize` handshake (with the configured `provider`/`model` route and optional `maxTokens` output cap) before it fulfills. Fulfillment means the child runtime is ready and ownership has transferred to the caller. A failed start owns rollback; unconfirmed process cleanup or permit acknowledgement remains retained by the provider. The provider retries that original cleanup before another launch and on unload; continued failure refuses replacement. A working-directory resolution failure rejects before allocation.

The subagent service resolves the child working directory before the SDK provider starts. That directory becomes the child process cwd and its effective Session directory; the parent Session header remains its origin. There is no provider-level `cwd` setting.

The returned run id is minted in the parent namespace; the child runtime's session id exists only inside the child process. After publication the provider owns one SDK activity and reads the child's answer from its session events: the last complete non-empty `assistant/message` (an empty-content message that records usage is skipped), or the accumulated `text-delta` stream when no such message exists. Partial output remains available after cancellation or an error.

`dispose()` is idempotent: it settles the result locally as `aborted` (there is no wire-level prompt cancel), then closes the runtime — a bounded protocol `shutdown` request followed by the shared stdin-EOF → SIGTERM → SIGKILL ladder to actual exit.

Model policy, resource admission, parent LLM middleware and execution authority resolve from the initiating Agent’s Context, including its isolated services. Provider unload retains lifecycle ownership of every pending or published child.

An installed resource budget admits `kind: process` with execution ownership and the initiating parent Session before SDK client construction. A required budget that is absent or refuses admission prevents launch. The permit stays occupied until SDK cleanup confirms the runtime process exited; unconfirmed cleanup reports uncertainty. Permit cancellation and provider unload close pending starts and published children, and provider teardown joins cleanup. One-shot completion also closes the child; `dispose()` shares that cleanup. Each managed child model request and child-owned subprocess has separate parent admission.

SDK starts retain the initiating resource provider, required-provider flag and execution authority before waiting for earlier cleanup. A queued grant or control-listener wait cannot transfer the start to a replacement owner or make it independent. Ownership is checked before native startup, after initialization, before the first prompt and before publication. A stale start returns unused capacity or joins its original runtime cleanup; failed cleanup remains retained. Restore ownership and request a new delegation.

When parent resource admission, model policy or execution authority is installed, a private bootstrap runs before every child profile plugin. Child model calls retain the original parent policy across waits, run every parent authorization owner after admission, and report actual usage through `llm/delegated-stream`. Parent replay cursors remain separate. The child keeps its own adapters, credentials, attachments and exact logged inputs, including native model operations. Child subprocess Consumers use the parent resource provider. Cancellation stops queued and active work; missing cleanup acknowledgement retains uncertain occupancy. A managed child must confirm bootstrap activation before its SDK run is published.

Resource completion retries the original permit after a rejected acknowledgement. Parent and child serialize reports, allow acknowledged uncertainty to advance to released after proven cleanup, and preserve that proof against late uncertainty. Parent and child retain uncertain operations until quiescence is acknowledged; the parent counts them within `maxControlOperations`. The child continues observing the original parent permit during uncertainty, so withdrawal still cancels live native work. Only final release or child-provider closure stops that observation. A rejected parent-control close can retry accounting while its listener remains closed ([decision](../../../.agents/notes/implemented/architecture/2026-10-24-sdk-managed-model-requests.md)).

The child retains each operation from registration through its completion acknowledgement, including a grant cancelled before lease publication and a model span whose close acknowledgement failed. Later model or process admission retries unfinished model closures before requesting more capacity; resource admission also retries unfinished resource reports. Shutdown reports unacknowledged cleanup failures. Completion messages advertise the last settled registration attempt through private `settledRegistration` metadata, so consecutive cancellations can retire old ids without a successful registration between them. Already registered operations retain their permits and queued grants.

Private control credentials are consumed during bootstrap, hidden from the launch-environment snapshot and excluded from ordinary subprocess inheritance. Compositions without parent resource admission, model policy or execution authority keep their standalone behavior.

Authenticated control uploads enforce `controlRequestTimeoutMs` while reading the body, independently of Node HTTP timeout scans. Incomplete and oversized uploads are refused; incomplete request connections close after the response, freeing their request slots before further admission. Provider closure cancels pending body reads.

Control HTTP concurrency is limited to twice `maxControlOperations`, capped at the maximum safe integer. Model input and output, or resource observation and completion, can overlap for one operation. This transport allowance does not raise the model-span or resource-operation admission limit.

Model cancellation applies to its model permit. Cancellation or managed-provider withdrawal aborts the adapter and joins its completion report even when the stream consumer has paused between chunks. Model cleanup, pending admissions, consumer shutdown and final reports share `controlCleanupTimeoutMs`; final reporting time is reserved inside it. A timeout rejects cleanup and retains unacknowledged operations for exact retry. A child process retains its own caller signal and resource permit; finishing the model call that created it does not terminate that separately owned process.

<a id="stop-reason-mapping"></a>
## Stop-reason mapping

The SDK client returns an owned child activity rather than a prompt result. The provider reads the last durable `turn/end` inside that activity and maps it into the seam vocabulary: `completed` → `completed`, `max-tokens` → `max-tokens`, `blocked` → `refusal`, `aborted` → `aborted` (a child-side `disposed` cause adds a `child-disposed` diagnostic); everything else — `error`, `interrupted`, a future variant, or an activity with no turn — maps to `error`, carrying a fixed safe diagnostic where one applies, so an unclean stop is never reported as success. Transport-level failures after publication flatten to `stopReason: 'error'` with a diagnostic through the `onError` diagnostic sink (wired to `ctx.logger.warn`); the seam contract forbids `result` rejecting.

<a id="capabilities-and-context"></a>
## Capabilities and context

The provider advertises `agentOptions: true`, with `agentPreset`/`outputSchema`/`depthLimit` false, and `inheritsParentContext: false`: the child is a fresh runtime in another process, and the child receives its task and workspace cwd without parent conversation history. Managed execution also retains the initiating parent authority. `dsh-tool-subagent` deployments over this provider set `maxDepth: 'provider-managed'` — the child harness owns its own recursion budget.

<a id="configuration"></a>
## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `dsh-sdk` | Registry name on `ctx.subagents`. |
| `dshBin` | same-version SDK dependency | Optional existing CLI module; resolved against the launch directory at plugin load. |
| `profile` | `sdk` | Named child profile. |
| `patches` | `[]` | Ordered profile patch files, resolved and verified at load. |
| `dshHome` | required | Absolute isolated Harness home for child profiles and persistent data. |
| `provider` | `deepseek-official` | Provider route sent in the child's `initialize`. |
| `model` | `deepseek-v4-flash` | Model sent in the child's `initialize`. |
| `reasoningEffort` | (unset) | Default child reasoning effort; a request override takes precedence. |
| `maxTokens` | adapter/provider route default | Per-request output-token cap sent in the child's `initialize`; it applies to the child root agent and its in-process descendants. |
| `env` | `{}` | Explicit child environment layered over a credential-scrubbed parent environment (e.g. the child's own `DEEPSEEK_API_KEY`, or `DSH_CORDIS_CONFIG`). |
| `initializeTimeoutMs` | `10000` | Bound on the child's protocol `initialize` handshake during start. |
| `shutdownTimeoutMs` | `1000` | Bound on the protocol `shutdown` exchange during dispose. |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before platform termination. |
| `disposeGraceMs` | `3000` | Exit-confirmation grace after termination; POSIX also waits this long after SIGTERM before SIGKILL. |
| `maxControlBytes` | `8388608` | Maximum private control request or response bytes. |
| `maxControlOperations` | `1024` | Maximum active model spans and resource operations per child. |
| `controlRequestTimeoutMs` | `1000` | Bound on one private control exchange. |
| `controlPollMs` | `100` | Resource observation interval and maximum held output read. |
| `controlCleanupTimeoutMs` | `4000` | Bound on joined control cleanup. |

`controlPollMs < controlRequestTimeoutMs < controlCleanupTimeoutMs` is required. Give EOF shutdown enough time for cooperative control cleanup; forced termination preserves uncertainty for missing resource reports. Managed model calls require the parent LLM service and a CLI supporting the private bootstrap. Configure resource capacity on the parent rather than installing an independent child budget.

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    profile: sdk
    dshHome: /absolute/path/to/child-harness-home
    patches: []
    maxTokens: 49152
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

<a id="process-boundary"></a>
## Process boundary

The child environment is the [`dsh-subprocess`](../../subprocess/README.md) seam's `scrubbedParentEnv()` base — ambient credential-shaped and `DSH_*` names dropped — with explicit `config.env` values merged after the scrub. The child is spawned by the SDK client rather than through `ctx.subprocess` (the subprocess README's documented exception for SDK-managed transports), which is why this backend applies the scrub itself. The JSON-RPC wire is the real serialization boundary.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The child runtime's model receives the standalone task as its user message plus that runtime's own configured system prompt, tools, and fresh session. It receives no parent conversation. A parent tool call may choose the child provider, model, and reasoning effort for this run; the selected route and any deployment-owned output cap are fixed for the new child process. Independent presets, depth enforcement, and structured output remain unsupported and are rejected instead of silently omitted.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each SDK child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final assistant text (or accumulated partial text) or that consumer's exact stop-reason error, not intermediate messages or tool traffic. A diagnostic-bearing non-completed result presents the safe diagnostic before separately preserved partial assistant output; startup and shutdown errors expose the same fixed facts without raw SDK text.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A fresh runtime process per run** — no pooling; a harness runtime boots a full plugin tree, so per-run spawn cost is higher than the ACP backend's typical child.
- **No non-route start-time capabilities** — the parent can select the child agent route but cannot enforce `agentPreset`, `outputSchema`, or depth inside the child process; configure the child's own `cordis.yml` instead.
- **The child's transcript stays in the child's own session root** — the parent retains its delegation call/result, child catalog and background-job lifecycle records. The streamed child `session.event` channel is consumed for output extraction, not copied into the parent transcript.
- **Local child processes only** — SSH-bound parent Sessions are refused before admission; their target cannot become a Host working directory. A remote runtime needs its own backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
