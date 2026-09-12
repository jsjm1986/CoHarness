# Agent Note: Sweep visibility races — replay pacing window, hover-click retry, and uploaded evidence

Status: implemented

English | [中文](2026-09-12-sweep-visibility-races.zh.md)

## Problem

On the serialized master sweep two browser scenarios kept failing while their PR-lane twins stayed green. `steering.e2e.ts`'s queue-flush scenario lost its whole interaction window: the dock expander resolved but stayed invisible for 30 s because the question card had already elected the `conversation.composer` overlay, which keeps the fallback — dock included — mounted under `display:none`. The scenario prefix (three fills, three Enters, the expand) has to fit inside call 0's replayed stream, which was paced at 50 ms per chunk. `workspace-management.e2e.ts`'s `clickHoverAction` hovered, polled the button visible, then clicked — a projection refresh between the poll and the click replaced the row node, dropped `:hover`, and the hover-only button never remounted. A `whenTurnSettled` deadline created before the interactions also reported its timeout as an unhandled rejection whenever an upstream step failed first.

## Decision

The steer-all scenario runs its own replay pace (300 ms) so the six browser round trips fit the server-side window on a starved runner; the expander is matched by accessible name and a failure now records a DOM/layout dump alongside the screenshot. `clickHoverAction` retries scroll-into-view + hover + a bounded click as one loop until a 30 s deadline, re-hovering the freshly mounted row each pass, and dumps the row's DOM state on exhaustion. The `settled` deadline carries a marking `catch` so its rejection only surfaces through the real `await`. The sweep job uploads `.artifacts/` on failure, and `ci-workflow.spec.ts` pins that the consumer step exports no `DSH_SNAPSHOT`.

## Alternatives considered

**Branch on the card having mounted.** Rejected: with the composer overlay elected the dock and the textarea are both hidden, so neither the expand nor the Cmd+Enter flush can run — the ordering the scenario exercises is unrecoverable mid-test, and the fixture's second call already assumes both steers landed first.

**Drop the pre-flush dock row assertions.** Rejected: they are the only coverage of the collapsed-to-expanded multi-row dock. Widening the server-side window keeps the coverage instead of deleting it.

**Split the sweep into a dedicated web job.** Deferred: `check:ci:consumers` already runs its gates serially under `DSH_GATE_CONCURRENCY=1`, and a second job would need its own build and a second client build record. The contention hypothesis did not survive the evidence — the failures were single-operation stalls, not throughput loss.

## Consequences

The sweep keeps the same coverage with a window sized for a loaded runner, hover-only actions tolerate projection churn, and every red sweep now ships its failure evidence as a workflow artifact. `whenTurnSettled` deadlines no longer surface as unhandled rejections on top of the real failure.
