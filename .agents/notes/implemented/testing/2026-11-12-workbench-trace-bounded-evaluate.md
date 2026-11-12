# Agent Note: Workbench pointer trace bounds its page evaluates

Status: implemented

English | [中文](2026-11-12-workbench-trace-bounded-evaluate.zh.md)

## Problem

`traceWorkbenchTabs` in `apps/web/tests/workbench.e2e.ts` instruments the page for the pointer-input scenarios. Its harness-side `trace.evaluate` calls (`mark`, `stop`, `dispose`) carry no deadline: when the renderer's main thread stops answering — observed as a layout burst pinning the page — the call never settles, vitest's `testTimeout` cannot interrupt a pending protocol await, and the whole `web verification` job sits silent for ~35 minutes until the step-level timeout kills it with no failing-test report. The same signature (last output `[workbench-pointer-restoration] {"scenario":"preview-width","restored":true}`) appeared on five CI runs across branches whose diffs contained no web code, blocking unrelated merges on a required check.

## Decision

- The MutationObserver disconnects once its 256-row buffer saturates: past the cap each delivery still ran `JSON.stringify(snapshot())` over the full pane DOM, which keeps the main thread busy exactly while `stop()` needs it. Saturating mutations now only increment `dropped`, preserving the existing `dropped === 0` tripwire.
- `mark`, `stop`, and `dispose` evaluate through a shared 15-second `Promise.race` deadline. A wedged page now fails the owning test in seconds with an explicit message instead of freezing the suite. `dispose` is best-effort because a dead channel cannot answer the release either; the browser teardown collects the handle regardless. The losing promise gets a `.catch` so a late rejection cannot surface as an unhandled rejection.

## Alternatives considered

- **Rely on vitest `testTimeout`** — it cannot interrupt a protocol await whose promise never settles; the worker stays silent well past the budget, which is exactly the observed failure.
- **Throttle the observer instead of disconnecting** — a debounce would still run the full-DOM stringify per burst and keeps the same starvation channel alive.
- **Skip the trace entirely under CI** — the trace is what diagnoses genuine pointer regressions; bounding work preserves it.

## Consequences

A frozen page degrades to a normal, attributable test failure (`Workbench tab trace stop exceeded 15000 ms`) rather than a silent job death, so `web verification` reports the culprit test and other files keep their evidence. Normal runs are unchanged: the deadline sits far above the observed sub-second evaluate latency, and the observer only disconnects after the existing cap the test already treats as a failure.
