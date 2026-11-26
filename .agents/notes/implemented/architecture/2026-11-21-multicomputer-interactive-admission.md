# Agent Note: Keep interactive admission responsive across computers

Status: implemented

English | [中文](2026-11-21-multicomputer-interactive-admission.zh.md)

## Problem

Two Gateway measurements can report a completed write at the entry seconds before the owner dispatches the request. In the cold preparation fixture the first Runtime on a fresh Gateway synchronously hashed the release closure after the pending response. The owning process read 18,149 files and delayed its event loop for about 2.7 seconds in an instrumented run. Under slower loads the next prepared request exceeded its deadline. The remote browser also waited for renderer assets before providing its native draft, and a reconnect could wait for both retired sockets to close.

## Decision

Gateway startup mints launch stamps before listening even when the supervisor retains zero Runtimes. The first request still checks its exact generation and Runtime launch variant. Project and personal policies, start admission, and retained workload ownership keep their existing checks.

Exact personal event upgrades reuse fresh [prepared admission](2026-11-06-governance-round-trip-collapse.md) before general Runtime resolution. The owner verifies the original browser session, target, managed lease and access revision. When a verified forwarding assertion can be used, the same statement also qualifies the currently published key and issuer lease. A nonce is consumed before dispatch and socket closure owns release of the lifecycle and access references. Stream renewal follows the existing [deadline and revocation rules](2026-10-23-event-stream-principal-renewal.md).

The Web entry mounts the account-scoped startup draft before loading the renderer module table. In a Chromium fixture with the vendor response held for 750 ms, median time to verified typing across five fresh contexts per build was 870 ms before and 28 ms with the new entry. The draft stays owned by its original document until its exact composer accepts it. Cancelling a WebSocket reader retires its frames immediately, and physical closing continues independently so the next generation can attach and replay.

## Alternatives considered

**Retire the connection after a pending response.** Draining the request, changing response framing, and opening a fresh carrier still left the cold request waiting while the owner hashed its closure. Keeping the work before listening lets ordinary requests retain transport reuse.

## Consequences

The fingerprint computation is charged to Gateway startup. Runtime readiness keeps its separate deadline. Database checkout spans distinguish waiting for a connection from statement durations and preserve the existing bounded metadata ring. The controlled browser and dual Gateway results describe their fixture workloads. Deployment quantiles use the same operations and independent network measurements under the released build.
