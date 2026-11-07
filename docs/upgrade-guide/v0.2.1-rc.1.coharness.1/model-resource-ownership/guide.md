---
kind: upgrade-guide
description: "Model requests retain resource ownership and distinct admission failure codes."
---

# Handle model resource ownership and admission failures

English | [中文](guide.zh.md)

## Change

Physical model streams retain the resource provider present before middleware starts. Withdrawal or replacement during preparation, admission, authorization or credential resolution ends the stream with `RESOURCE_BUDGET_UNAVAILABLE` before HTTP dispatch. A late grant returns to its original provider. An old request cannot acquire capacity from a replacement provider, and removing a managed requirement cannot make a captured managed request independent.

This applies to ordinary and prepared model operations in managed and standalone compositions with an installed resource provider. Standalone calls that never require or install resource admission remain supported. Orchestration turns reserve no model capacity; each nested model request uses its own current provider. No settings or stored data need rewriting.

Resource admission failures retain their category: unavailable service uses `RESOURCE_BUDGET_UNAVAILABLE`, cancellation uses `ABORTED` and an aborted finish, queue expiry uses `RESOURCE_ADMISSION_EXPIRED`, and refusal uses `RESOURCE_ADMISSION_REFUSED`. These local failures add no provider HTTP status and do not change default retry policy. Validated detailed failure facts retain priority.

The governance plugin also retains the execution authority, Agent and billing witnesses when it admits a stream. Replacing that service or changing the billed input set or primary actor refuses the pending physical request with `MODEL_EXECUTION_IDENTITY_FAILED`. Optional-authority removal cannot turn managed work into an independent call. New streams use current authorization; failed old streams retain their original attribution. Model-policy, usage and Session formats are unchanged.

Infrastructure model requests retain Runtime admission and default unattributed activity. A traced Session or ambient Agent does not assign their cost to a later execution actor. Existing explicit `executionIdentity` remains supported; callers that intentionally attribute infrastructure activity supply that proof and its Session explicitly. Project/personal billing ownership, model-policy checks and ordinary execution conflict checks are unchanged. Rebuild the governance plugin with the matching Runtime. Historical usage remains as reported; this change adds no policy, usage or Session format.

Main-request markers belong to each `LlmRuntime`. The free `markAgentLoopRequest` and `isAgentLoopRequest` exports are replaced by methods of those names on `ctx.llm`. The exact frozen request is recognized only by its live owning service; marking through a withdrawn service throws `MODEL_REQUEST_ORIGIN_UNAVAILABLE`. Global LLM waterfall listeners check their emitting `this: LlmRuntime` receiver.

## Migration

1. Deploy the updated `@deepseek-ai/dsh-llm` artifact with its matching Runtime payload. Keep the [managed resource registration procedure](../managed-resource-admission/guide.md) for provider startup.
2. For applications that replace `resourceBudget` during live work, handle `RESOURCE_BUDGET_UNAVAILABLE` and construct a new stream after restoring the provider. Do not reuse a once-only prepared operation.
3. Confirm a request queued against the old provider sends no HTTP after replacement, returns any late grant to that provider, and a new request uses the replacement provider. See the [LLM reference](../../../../packages/llm/llm/README.md).
4. Route resource admission outcomes by code. Treat `ABORTED` as cancellation; retain the separate expiry and refusal categories instead of interpreting either as an upstream rate limit.
5. Rebuild and deploy the matching `dsh-model-governance` plugin. Verify an execution-authority replacement while automatic compaction waits: no stale summary is dispatched or committed, its original usage attribution is retained, its permit is released, and a later model call can use the new authority.
6. Update direct marker consumers to the owning service methods and rebuild matching LLM, AgentLoop and session-title artifacts. Verify foreign-service requests leave pending titles unchanged and ordinary loop requests still generate titles. No Session or SDK wire migration is required.
