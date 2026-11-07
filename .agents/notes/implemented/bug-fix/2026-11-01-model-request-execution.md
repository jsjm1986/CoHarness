# Agent Note: Model streams retain execution and billing owners

Status: implemented

English | [中文](2026-11-01-model-request-execution.zh.md)

## Problem

The model-policy plugin can remain installed while its execution authority changes. A stream can capture billing witnesses from one authority, wait for capacity and then obtain permission from another. Matching returned fields do not establish service ownership. A later input set or primary actor can also authorize work that retains the earlier bill. Automatic compaction can consequently send an old request and replace history under a different authorization.

## Decision

Governance retains the execution authority and actual Agent when a stream enters its middleware. Initial attribution confirms that the same issuer remains present after authorization. Each downstream iterator demand and early close runs inside an instance-owned asynchronous context carrying that request's issuer, Agent, witnesses and signal. Concurrent callers cannot lend these values to one another.

The existing pre-dispatch check authorizes the retained Agent through its original service after capacity admission and at physical requests. Its returned inputs and primary actor must match the billed witnesses. The retained model-access provider also confirms issuer identity synchronously when core checks its final policy decision after asynchronous listeners. That confirmation performs no additional authorization query or capacity reservation. Route selection outside a model stream retains ordinary route decisions.

Observing an optional execution authority establishes managed behavior for the plugin lifetime. Removing that authority cannot convert pending or later work into an independent call. Missing executing Agents still refuse Auto; Runtime infrastructure calls without explicit billing proof remain unattributed even with a Session trace or ambient Agent. The [infrastructure activity decision](2026-11-01-infrastructure-model-activity.md) defines that ownership. Cancellation during initial attribution produces an aborted finish and cancelled usage rather than an identity failure.

Unload marks policy unavailable immediately. The asynchronous context remains until the last active iterator settles, while model runtime retains responsibility for transport and permit closure. The outbox accepts late durable records after its sender stops; the next activation can deliver them.

## Alternatives considered

**Authorize whichever service exists after waiting.** A replacement can approve an operation belonging to its predecessor, even with identical fields.

**Use the latest Agent or participants for an old bill.** Authorization and billing would then refer to different executions. A new request can capture the new owner; an existing request must retain its own witnesses.

**Check only in asynchronous listeners.** Another listener can wait after that check. The runtime's synchronous final model-policy decision confirms the captured issuer before transport starts.

**Share one current request or release its context during unload.** Concurrent streams and pending iterator cleanup have independent completion. Each request retains its own data until its iterator finishes.

## Consequences

Execution identity failures retain `MODEL_EXECUTION_IDENTITY_FAILED`; cancellation retains `ABORTED`. Policy, usage and Session formats are unchanged. Request logging stays with each model consumer. This complements [model-policy ownership](../architecture/2026-10-24-model-policy-owner-lifetime.md), [Auto tool admission](2026-11-01-auto-review-authority.md) and [recall publication](2026-11-01-memory-recall-authority.md); their separate policy, tool-scope and publication rules remain active.

## Verification

Actual LlmRuntime tests hold billing, model preparation, capacity, later authorization and physical transport at deterministic points. They cover equal-state replacements, changed witnesses, concurrent accounts, optional-authority withdrawal, caller cancellation and late usage after two pending calls lose their policy. Shipped SDK compositions run automatic compaction and its durable history replacement with the actual governance plugin and outbox. Failed old requests retain their original actor and full source history; later requests use the new authority; all acquired permits settle. Complete private predecessor source and built packages reproduce stale summaries and mismatched authorization, while the ordinary allowed case remains valid.
