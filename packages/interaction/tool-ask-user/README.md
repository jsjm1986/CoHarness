---
description: "The model-facing ask_user_question tool over the user-questions seam, for users and maintainers composing or debugging interactive agent surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ask-user

English | [中文](README.zh.md)

## Summary

`ask_user_question` asks the human for confirmation, a choice, or missing information. By default it keeps the original blocking legacy behavior unchanged: the model waits for an answer. The asynchronous timed variant is an explicit Cordis opt-in with `mode: timed`; it waits for a foreground window, then returns a pending result so the model can continue independent work while the question stays answerable. Within timed mode, `timeout: -1` requests an indefinite blocking wait for that call. A live child agent owned by another agent cannot call this tool. The package renders nothing; callers provide the user interaction surface.

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

Compose this plugin wherever the model should be able to pause for a human decision: it provides the `ask_user_question` tool and needs the `ctx.userQuestions` seam with an answerer that accepts the scoped request. Without one, the tool call fails with an error instead of degrading.

Shipped presets omit config and therefore expose the original blocking legacy tool. To switch on the alternate asynchronous behavior, set `mode: timed` on the `tool-ask-user` row inside the active preset's `config.plugins` list:

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120
```

This snippet is a plugin row, not a top-level `--patch` entry. The shipped Web profile nests it inside `preset-standard`, so a Web profile patch must update that preset's plugin list, or the same setting can be changed in the Agent Preset editor. Use `mode: legacy` (or omit `config`) to keep the blocking schema. In timed mode, the row's `timeout` is the default for every tool call. Setting it to `-1` makes every call wait indefinitely unless the model passes a positive `timeout` argument. A `timeout: -1` argument changes only that tool call, which may contain several questions; one answer batch settles the call.

### When to call the tool

The model calls `ask_user_question` when it needs confirmation, a choice, or missing information before proceeding. Send one or more questions, each with an `id` unique within that call and echoed in the answer; separate calls may reuse an id because their call IDs distinguish them. A recommended option goes first with `(Recommended)` appended to its label. The optional per-call `timeout` is measured in seconds; `-1` makes the new tool block when work cannot safely proceed without an answer. A timeout is never approval. The Web card also lets a user explicitly take time or begin editing, which holds that Client's pending wait indefinitely until the answer is submitted or the call is cancelled. Choosing the complete old tool is a Cordis composition decision, not a model argument.

```json
{
  "questions": [
    {
      "id": "cleanup",
      "question": "Proceed with the destructive cleanup?",
      "header": "Confirm",
      "options": [
        { "label": "Yes, delete them (Recommended)", "description": "Removes the three stale files." },
        { "label": "No, keep them", "description": "Aborts the cleanup." }
      ]
    }
  ]
}
```

### What the model gets back

An answer received before the timeout returns one answer object per question: `selected` holds the chosen option labels, and `custom` carries a free-form answer — supplementing `selected` for a multi-select question and overriding it for a single-select question. An explicitly skipped question is a completed answer item with empty `selected` and no `custom`. By contrast, `{ "pending": true, "callId": "…" }` means no answer batch arrived before the initial wait expired; the questions remain answerable, the model continues only independent work, and a later answer is delivered as an ordinary user message whose `kind`, `tool`, and `callId` identify the earlier pending tool call. The Web chat presents that payload as the original questions paired with their answers; other consumers retain the compact JSON text.

```json
{ "answers": [{ "id": "cleanup", "selected": ["Yes, delete them (Recommended)"] }] }
```

### When the call fails

In the default legacy mode the tool call always waits for the human answer. With `mode: timed`, the alternate tool blocks until the human answers, its timeout expires, or the turn is cancelled; `timeout: -1` keeps that timed call blocking indefinitely. No accepting answerer, an aborted call, or a caller that is not the exact live runtime root each settles as an error the model sees in the tool result — most notably, a live child agent owned by another agent is rejected (`DELEGATED_CALLER`) and must include the unresolved question or decision in its final result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains the tool definition and its relationship to the seam.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration: `ask_user_question` schema, execute path, result render |
| [`src/legacy.ts`](src/legacy.ts) | Frozen pre-timeout description, arguments, output, and blocking execution |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls. |

### Consumer role

The plugin registers exactly one `defineTool` entry on `ctx.tools` with injects `['tools', 'userQuestions']`. The default mode registers the original legacy tool verbatim, as a frozen copy in `src/legacy.ts` that shares no schema or mapping code with the timed tool, and routes every call through blocking `ask()`. Setting the Cordis config to `mode: timed` registers the alternate timed schema and routes positive timeouts through `askTimed()` while `-1` routes through blocking `ask()`. The two definitions never appear together. Both forward the exact calling agent and turn signal; the seam owns identity checks, waterfall dispatch, and the error taxonomy. Every timed-mode request names the call in `wait`, including the indefinite `-1` form, so a Client can key its question surface to this tool call; the legacy request stays unkeyed. The timed schema's `timeout` parameter is also what the `userQuestions` projection reads out of the logged request header to tell a timed call from a legacy one.

### Result rendering

The `render` output projects the structured value to a single text block via `JSON.stringify`, which is why the model-facing result is compact JSON rather than a richer content-block vocabulary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool surface to the seam contract and its answerer waterfall.

- [User interaction subsystem reference](../../../docs/subsystems/user-questions.md) — the service contract, question vocabulary, and answerer waterfall behind this tool.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user) — the generated `ask_user_question` schema.
- [user-questions package](../user-questions/README.md) — the seam this tool consumes.
- [Interaction group map](../README.md) — adjacent approval and command surfaces.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The shipped presets expose the original blocking [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user). A custom Cordis row with `mode: timed` switches to the alternate schema, including question ids, prompts, headings, options, multi-select flags, `timeout`, and the pending result; the model sees only the selected definition.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The model's full questions remain in the assistant tool-call arguments. An answer inside the foreground wait appears in the next step as compact JSON in the exact shape `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}`; `custom` is omitted when unused and `selected` can contain zero, one, or several labels. A pending step reads as one compact `{"pending":true,"callId":"<pending-call-id>","message":"<instruction>"}` object, whose `message` directs the model to continue independent work; the instruction is a field rather than prose beside the object because the recorded result text is also read back as one JSON object by the question projection and the Web card. After a pending result, the eventual answer is a user message in the shape `{"kind":"answer_to_pending_question","tool":"ask_user_question","callId":"<pending-call-id>","questions":[...],"answers":[...]}`. The discriminator and call id explicitly tell the model that this answers an earlier pending call, while the repeated questions keep the answer self-contained. UI interaction while the call is pending is not model context.

#### Token effect

Arguments and answer JSON are data-dependent retained tokens; there is no token cost while waiting for the human.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a UI backlog.

- **The legacy tool never reports pending** — `mode: legacy` keeps the blocking in-memory wait and returns only an answer or an error. Its calls never enter the `userQuestions` projection, because the request header records the legacy schema, so a legacy call interrupted by process loss shows no continued question and takes no late answer, exactly as before timed questions existed.
- **Runtime-owned subagents cannot ask the user** — `ask_user_question` rejects a live child owned by another agent with `DELEGATED_CALLER`; the child must include the unresolved question or decision in its final result. Durable lineage does not decide this boundary, so a lineage-bearing session resumed as a runtime root may ask normally.
- **Native answers render as JSON text** — the canonical value remains structured, but the model-facing result uses compact JSON rather than a richer content-block vocabulary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The rollout keeps both definitions during adoption, then makes the timed tool the default, then removes the legacy definition and `mode: legacy` after existing profiles have migrated. Removing the old executable tool must not change historical Session replay: the [`userQuestions` projection](../user-questions/src/projection.ts) must keep distinguishing calls by the schema recorded in each `request/header`, as its [mixed-schema tests](../user-questions/tests/projection.spec.ts) do today. A missing `timeout` argument cannot identify an old call because timed calls may omit it too. `timeout: -1` provides an indefinite wait in timed mode but does not reproduce the old schema or card behavior. If the projection's state or fold changes during removal, bump its `stateVersion` so stored caches refold from the logs.

</details>
