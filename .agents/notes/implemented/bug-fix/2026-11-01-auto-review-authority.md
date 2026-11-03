# Agent Note: Auto reviews retain their issuer through tool admission

Status: implemented

English | [中文](2026-11-01-auto-review-authority.zh.md)

## Problem

An Auto review can wait for a working directory, model capacity, adapter preparation, a response or downstream tool policies. A replacement authority can attest identical participant fields without owning the original review. A check before those waits does not prevent a revoked reviewer request. An optional authority can also disappear before any reviewed call establishes the managed fallback.

## Decision

Each review captures its issuing service and the verified state returned for its exact pending tool execution. It derives `ExecutionInheritance` from that state and enters the issuer's `runCaptured` context. The Agent's current state cannot substitute for a tool scope. One plugin-owned asynchronous context identifies reviewer requests; its `llm/pre-dispatch` listener rechecks Auto qualification after capacity admission and before each physical model request. Unrelated model calls retain their own authorization.

Every qualification check retains the issuer's original service identity and compares scope, revision, inputs and primary actor. Final tool admission rechecks after downstream policies and synchronously confirms the issuer before returning an allow. Caller or plugin cancellation takes precedence over late results. Eligibility refusals retain the structured Auto denial; independent model failures retain their own error. Disposal aborts reviews, joins their cleanup and then releases the asynchronous context.

The presence of an execution authority makes the integration managed, including an optional provider observed before any review. That classification survives provider withdrawal and refuses an independent review already pending when the deployment becomes managed. Unloading moves its Auto Sessions to Workspace write; a genuinely independent local composition retains its existing Full access fallback.

The [execution attribution decision](2026-09-22-auto-review-execution-attribution.md) retains ownership of preset selection, settings writes, billing proofs and historical usage intake. [Exact request records](2026-10-24-auto-review-request-records.md) retain ownership of durable model input.

## Alternatives considered

**Compare participant fields alone.** Matching fields do not identify the service that admitted the work. A replacement cannot authorize its predecessor's review.

**Check only before requesting capacity or at reviewer completion.** Qualification can change while queued or while an adapter prepares its transport. The physical dispatch check prevents that request from leaving.

**Recapture the Agent or use a shared current-review variable.** A pending tool can own a narrower scope, and separate Sessions can review concurrently. Each operation retains its own attested tool state.

**Infer a local deployment from current provider absence.** Removing an authority or reviewer must not grant unreviewed Full access to a managed Session.

## Consequences

Authorization adds no model reservation or bill. One reviewer retains one Session and verified primary throughout its existing resource permit. The execution-authority API, reviewer request event and Session format are unchanged. Custom providers must support captured execution for reviewer work. This decision does not grant a replacement provider access to an in-flight review.

## Verification

Loader tests use the actual permission and tool runtimes, controlled authority providers, deterministic waiting points and an owned file-writing tool. Concurrent Sessions prove one revoked account cannot borrow another account's review. Shipped SDK compositions cover directory preparation, queued capacity, physical dispatch, response completion and an allowed call. Complete private predecessor source and built packages reproduce unnecessary requests and post-replacement file writes. Cancellation during final authorization, captured scope failure and managed unload before any reviewed call have focused coverage.
