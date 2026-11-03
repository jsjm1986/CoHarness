# Agent Note: Recall follows the admitted question through publication

Status: implemented

English | [中文](2026-11-01-memory-recall-authority.zh.md)

## Problem

The first pre-step precedes Gateway message admission. Launching recall there can use an earlier participant state, and capturing authority there would preserve that wrong state. A separate selector controller also misses primary-turn cancellation until `turn/end`. Responses and entry reads can finish after issuer replacement. Valid selector JSON can arrive alongside a failed or aborted terminal outcome.

## Decision

Pre-step retains the question, catalog and turn signal. The first `agent/request` admission consumes that preparation after downstream listeners confirm messages and resolve the route. The selector captures its issuing authority and participants there, runs under their `runCaptured` context and passes their explicit billing witnesses. An instance-owned asynchronous context identifies its own `llm/pre-dispatch` checks after capacity admission and before physical requests. Unrelated requests have no selector context.

Recall requires current `execute` permission rather than memory-writing qualification. It compares the current service's original identity with its captured issuer after asynchronous work, and rechecks execution permission and current scopes before injection. The selector signal includes the primary turn's signal, independent settings cancellation and Session disposal. Plugin disposal waits for owned cleanup before releasing its asynchronous context. Failed or aborted terminal outcomes discard selected keys even when their text is valid JSON.

This complements [live memory availability](2026-10-31-memory-live-availability.md) and [provider notification](2026-11-01-memory-provider-availability.md). Write-qualified background curation remains governed by its [separate authorization decision](2026-11-01-memory-curation-authority.md).

## Alternatives considered

**Capture at pre-step.** Gateway has not entered the claimed messages yet; an immutable capture can still attest the wrong participant set.

**Use the current browser connection or issuer on completion.** A different caller or replacement can lend an actor that did not own the question. The captured issuer refuses replacement instead.

**Require the memory capability.** That capability controls shared-memory writes. Project readers and private conversations can recall without qualifying to write.

**Wait for `turn/end` to cancel, or accept any valid selector JSON.** Primary cancellation can precede stream cleanup and turn closure. Terminal failure does not authorize publication of partial text.

## Consequences

Recall uses the admitted question's identity and resolved route without delaying its primary request. It adds no model permit, quota, usage format or Session schema. Request-event ordering follows message admission. Runtime consumers retain the existing preparation API. The memory-context package directly declares its execution-authority dependency.

Non-recorded Gateway execution checks live in the example's expected-output lane. Revoked curation observes the captured task's actual refusal, preserving the unfinished cursor, rather than waiting for another model call after permission is gone. Recorded Session round trips retain their snapshot lane. Broader Gateway and physical-computer acceptance remain open.

## Verification

Negative cases reproduce uncaptured identity, post-replacement injection, an uncancelled queued grant and injection from failed or aborted JSON responses. Real GatewayExecution and Agent loops observe the admitted participant at selector dispatch and injection while memory-writing permission is denied. Complete private predecessor selectors fail unchanged Gateway scenarios. Capacity, pending storage, request cancellation, service capture failure and scope withdrawal have focused tests; existing settings, curation and recorded-session cases remain regression coverage.
