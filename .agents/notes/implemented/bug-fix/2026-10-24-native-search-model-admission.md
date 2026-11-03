# Agent Note: Native search owns model admission

Status: implemented

English | [中文](2026-10-24-native-search-model-admission.zh.md)

## Problem

DeepSeek native search performs a Messages model request through private HTTP. It bypassed node-wide model admission and could outlive provider removal because it does not dispatch through the LLM service.

## Decision

The registered provider captures its initiating Session before awaiting an execution model permit. It resolves current settings and credentials after admission, logs against that Session and retains the permit through response processing or cancellation. Missing required admission refuses HTTP. A late grant after cancellation is released without dispatch.

A plugin-owned controller cancels queued and active searches. Unload joins accepted work, including permit release. Provider and release failures preserve both causes. Standalone compositions may omit the budget; the exported transport class remains independent HTTP. This governs resource ownership without converting the native protocol into an LLM adapter.

## Alternatives considered

**Count only LLM-service calls.** Native Messages inference consumes model-request capacity despite its different transport.

**Release at response headers.** Body processing and cancellation still belong to the active operation.

**Discard late grants after cancellation.** Returned permits still occupy accounting and require awaited release.

## Consequences

Native search queues or refuses under node limits. Settings changes during queuing affect dispatch, and removal waits for accepted searches. The package declares the resource-budget peer explicitly. Model messages and endpoint choices retain their representations.

## Verification

A real HTTP negative control contacts Messages despite a denying budget. Tests cover captured Session logging, queue and body ownership, caller/provider/budget cancellation, late-grant drainage and combined failures. Both changed modules meet per-file coverage; the registration-file exception is removed. The shipped headless replay requires a live execution permit at its real Messages endpoint while preserving recorded output. An earlier ordinary-Node build fails that assertion by sending without admission.
