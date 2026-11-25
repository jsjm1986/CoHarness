# Agent Note: Existing-deployment latency sampling

Status: implemented

English | [中文](2026-11-17-existing-deployment-latency-sampling.zh.md)

## Problem

Locally spawned multi-computer fixtures can reproduce transport delay without proving the latency of a deployed node, its storage or its browser. Reusing a fixture port as a target setting risks launching a competing server. Periodic resource samples also do not measure completed user operations.

## Decision

The [manual sampler](../../../../scripts/existing-deployment-latency/README.md) targets an existing authorized personal Runtime through explicit private coordinates. Planning performs no network, authentication or browser work. Execution requires `--execute`, an already ready allocation, an owned measurement window and synthetic test histories. It reuses browser launch and click clocks without importing application fixtures.

Create, history-open and durable-send receipts remain separate. A send succeeds only through the versioned durable admission route with matching Session, application request and RPC response identities. The sampler syncs acceptance before observing the reply so an interrupted browser wait cannot erase a confirmed input. Browser event time, driver overhead, visible answer and turn completion remain distinct. Unknown outcomes stop further mutations; no automatic resubmission, cancellation or data cleanup is performed.

## Alternatives considered

**Treat synthetic fixture timings as deployed evidence.** They omit the actual node and storage path, so they retain their regression role rather than substituting for deployment measurements.

**Retry failed samples until the requested count passes.** That hides failures and can repeat an uncertain write. Raw failed attempts and unattempted remainder stay visible in the report.

**Measure only API success or local echo.** Neither proves durable acceptance or when the browser becomes usable. The sampler preserves those endpoints independently.

## Consequences

The default budget is fifty attempts per operation, with separately reported P50, P95, failures and timeouts. Dedicated test Sessions remain available for inspection. Private POSIX driver files and a ready personal Runtime are required; shared projects, cold startup, native Windows driver ACLs and crash recovery are outside this sampler. Offline tests verify planning, target guards, receipt correlation and accounting; real-deployment execution remains necessary before citing timings. Existing synthetic performance and admission notes remain active because their regression and product semantics are independent of this tooling decision.
