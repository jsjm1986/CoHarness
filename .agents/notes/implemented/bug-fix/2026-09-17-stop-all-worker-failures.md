# Agent Note: Drain shutdown workers after target failures

Status: implemented

English | [中文](2026-09-17-stop-all-worker-failures.zh.md)

## Problem

A rejected stop can exhaust the bounded worker pool while tracked runtimes remain unattempted.

## Decision

[`stopAll()`](../../../../gateway/src/instances.ts) catches per-target failures and keeps each worker draining; each worker rejects with its own first error after draining. The outer `Promise.allSettled` waits for every worker and reports the first rejected worker in array order, not the globally chronological first error.

## Alternatives considered

**Fail-fast workers.** Rejected because simultaneous failures can leave the remaining queue untouched even when shutdown time remains.

## Consequences

Stop failures remain visible without abandoning queued work solely because of rejection. systemd remains a no-op; [local exit force cleanup](2026-08-18-gateway-startup-resilience.md) and the external shutdown deadline remain unchanged. Deadline expiry or a stop that never settles can prevent complete draining; this is not an indefinite all-attempt guarantee.

## Testing

The [instance regression](../../../../gateway/tests/instances.spec.ts) covers eight initial failures followed by a ninth target. Gaps: it does not distinguish worker-array error order from chronological order, or exercise deadline expiry and non-settling stops; no assembled shutdown snapshot is added.
