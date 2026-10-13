# Agent Note: Continuable children accept an outputSchema with scoped capture

Status: implemented

English | [中文](2026-10-13-continuable-structured-output.zh.md)

## Problem

`ContinuableStartSpec.request` omitted `outputSchema`, so a model could delegate a continuable child but never require its final structured result. Settlement notices likewise carried only the stop reason and closing text: a committed structured value or a provider diagnostic could not reach the parent through the Activation path. Upstream sources: `3d852a1cea5`, `6f0174b5a2b`, `a1da7bcfb96`, all in alpha.2 only.

## Decision

`ContinuableStartSpec.request` omits only `label` and `signal`. `SubagentRuntime.startContinuable` runs the same capability gate as one-shot `start` (`assertCapabilities` plus `assertObjectJsonSchema`) before materialization, so a provider without `outputSchema` is rejected before any child identity is reserved.

The scoped structured runtime moved into the subagent package as `src/structured.ts` and is exported for sibling in-process providers; the in-process driver imports it instead of keeping a private copy and still re-exports `STRUCTURED_OUTPUT_TOOL`/`STRUCTURED_OUTPUT_INSTRUCTION` for existing consumers. `attachStructuredRuntime` takes a `canComplete` predicate that decides whether a valid tool call may stage its capture.

Materialization attaches the runtime when the request carries `outputSchema`, and the closure requires the child's `nextStep`/`nextTurn` queues to be empty and the child to own no unsettled direct continuable work. Because `waitForChildren` is asynchronous and a tool execution cannot await, the registry answers synchronously through `hasPendingDirectChildren(parent)`: an in-flight materialization whose recorded lineage contains the parent, or a resident Activation naming it as `parentSession`. `SubagentRuntime` exposes it only through the symbol-keyed `subagentPendingDirectChildren` internal face (`internal.ts`), so the public Service Definition does not grow a probe one consumer needs.

`SubagentInbox.deliver` rejects every child-bound delivery with `INPUT_CLOSED` while the attachment reports `acceptsInput() === false`: from capture staging through the authoritative `tools/result` verdict (including an enclosing PTC execution). A failed result discards the staged capture and reopens input; a valid call committed once cannot be reopened or superseded.

`ActivationTerminal` carries optional `structured` and `diagnostic` beside `output`. The observer's `capture(child, structured)` reads the committed value and downgrades a `completed` epoch with no committed capture to `error`. The settlement notice appends `Structured result: <JSON>` and then the diagnostic text, each independent of closing text. Local continuable children are manager-owned in-process Agents, so no provider produces a diagnostic on this path; the field keeps the terminal vocabulary able to carry one the way one-shot and out-of-process runs already do.

The durable descriptor still omits `outputSchema` — it budgets one activation's result contract, not durable child composition — so a cold-resumed epoch accepts no structured result.

## Alternatives considered

**Resolving settlement-time descendants asynchronously.** Rejected: `waitForChildren` cannot run inside the tool execution that must decide admission; the synchronous registry probe answers the same residency question without widening the public service surface.

**Rejecting `outputSchema` on continuable starts.** Rejected: upstream admits it under the standard capability gate, and the scoped runtime already enforces one-shot children; duplicating a weaker continuable variant would leave two capture contracts to maintain.

## Consequences

A delegating model can require a structured result from a continuable child with the same schema contract as a one-shot run. The child cannot receive further input once a valid call stages, cannot submit while own work is unsettled, and a missing capture fails the epoch rather than silently settling `completed`. A cold-resumed epoch never reports structured output because no schema survives resume.

## Verification

`packages/subagent/subagent/tests/continuation.spec.ts` covers committed capture reaching the settlement notice, a missing capture settling `error`, `INPUT_CLOSED` during staging, queued input admitted before staging being consumed first, and owned descendants blocking submission until they release. `continuation-messages.spec.ts` covers the serialized result and diagnostic blocks independent of closing text. `internal.spec.ts` covers the probe forwarding the exact live parent. `packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` continues to cover the shared runtime through the driver's re-exports.

## Related

- [Continuable background subagents](2026-07-21-continuable-background-subagents.md) — owns the Activation/descriptor contract the schema omission belongs to.
- [Subagent capability seam](2026-06-21-subagent-capability-seam.md) — owns the static capability gate `startContinuable` now shares.
- [Product subagent failure facts](2026-08-18-product-subagent-failure-facts.md) — owns the bounded diagnostic vocabulary `ActivationTerminal.diagnostic` can carry.
