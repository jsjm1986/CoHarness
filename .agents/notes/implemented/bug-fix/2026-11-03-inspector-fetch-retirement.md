# Agent Note: Inspector fetch capture follows its owning lifetime

Status: implemented

English | [中文](2026-11-03-inspector-fetch-retirement.zh.md)

## Problem

Independent Inspector plugins can observe the same global fetch. Their unload order is independent of installation order; restoring a saved wrapper can reactivate capture owned by a disposed plugin. Native requests can also settle after capture stops.

## Decision

Each [fetch wrapper](../../../../packages/experimental/inspector/src/host/inspection/network.ts) retains its own cancellation signal and predecessor descriptor. Stopping retires capture synchronously, cancels clone readers and joins their settlement. A current wrapper restores the nearest live predecessor with its property attributes; an unrelated replacement remains intact. Retained stopped wrappers delegate the caller's original arguments without recording. Late native responses and failures retain their caller-owned outcome and cannot resume capture.

## Alternatives considered

**Require reverse disposal order.** Independent Cordis applications and concurrent plugin cleanup do not provide that ordering.

**Keep a process-wide observer registry.** Each wrapper already has an explicit owner and predecessor; a mutable singleton would add another lifetime.

## Consequences

Stopping capture preserves ongoing native requests and the cancellation behavior of responses already returned. Worker termination and resource acknowledgement retain their [separate ownership](2026-10-29-inspector-resource-completion.md).

## Verification

Deterministic cases cover all three-observer disposal permutations, retained references and native settlement after stop. The real Loader [example](../../../../packages/experimental/inspector/tests/fixtures/fetch-retirement.mjs) runs independent Web compositions, completes native HTTP requests, and observes Worker exits and exact fetch restoration in both disposal orders.
