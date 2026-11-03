# Agent Note: Model policy ownership survives request waits

Status: implemented

English | [中文](2026-10-24-model-policy-owner-lifetime.zh.md)

## Problem

A queued model call can outlive its authorization plugin. Looking up pre-dispatch listeners after the resource wait can then find no guard and dispatch a request that originally required policy. New calls also need to distinguish an intentionally independent runtime from a managed runtime whose provider disappeared.

## Decision

Gateway runtime publishes `modelAccessRequired` on the root context lifetime. LLM streams capture the current policy owner before constructing middleware, retain its identity through model preparation and admission, and refuse an absent required owner or any owner replacement. After asynchronous dispatch guards, core enforces the retained provider's route decision. The policy provider retains responsibility for refreshing its data.

Provider identity compares `symbols.original` for Cordis Service tracing proxies while decisions use the captured proxy and its caller context. Fresh proxies of one Service remain the same owner; replacing the underlying Service still refuses dispatch.

Governance marks its access service unavailable before awaiting watcher and outbox shutdown. A late valid file notification cannot reopen that stopped owner. Native model operations use this same policy path and cannot switch to an independent transport after owner withdrawal.

Ordinary `PreparedAdapterCall.stream()` and direct `LlmAdapter.stream()` implementations receive the retained authorization callback from the runtime. DeepSeek invokes it after credentials and request extensions and for every Files operation; authorization failures do not become inline fallback. pi-ai checks after explicit preparation and again when its provider submits the payload after internal authentication. Serialized provider error events cannot replace the original authorization failure.

The policy service and execution authority have separate ownership. [Per-request execution retention](../bug-fix/2026-11-01-model-request-execution.md) governs the issuing execution service, Agent and billing witnesses while the policy provider remains installed.

## Alternatives considered

**Read whichever policy exists after admission.** A different provider can authorize a request whose attribution and middleware belonged to the previous owner.

**Rely on the listener registration alone.** Disposing the listener removes the very check needed by requests already waiting elsewhere.

## Consequences

Calls interrupted by a policy replacement must retry under the new provider. An independent composition with no policy and no requirement remains usable. Policy decisions run after provider refresh guards, so a stale access snapshot cannot reject a freshly refreshed permission before the provider has read it.

## Verification

The previous implementation dispatches after the actual governance fiber is disposed during model admission. Regressions now refuse that call, release its permit, reject new managed calls without policy, and retain ownership during asynchronous model preparation. Native search composition cases additionally revoke route access, execution permission and the governance owner while queued; no case contacts HTTP.

Ordinary prepared and unprepared provider cases revoke access during explicit credential resolution, while a pi-ai case holds its internal stored-credential read. DeepSeek Files refusals retain their code and issue no fallback inference. Source and built SDK profile transcripts cover both real provider routes with zero upstream requests and usage, one acquired and released permit, and a completed failed turn. Built Node22 and24 runs also retain the native Codex SDK request projection.
