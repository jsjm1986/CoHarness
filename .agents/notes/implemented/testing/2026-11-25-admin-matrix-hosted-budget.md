# Agent Note: Narrow the Admin acceptance matrix on hosted web-verification runners

Status: implemented

English | [中文](2026-11-25-admin-matrix-hosted-budget.zh.md)

## Problem

The `web verification` lane burned its exact 90-minute `timeout-minutes` twice in a row with an apparently dead browser: the last pool file result printed about 45 minutes into the lane, after which the log held zero output until cancellation. The file was not deadlocked — it was arithmetically unable to finish. `apps/web/tests/admin-responsive-pages.e2e.ts` loops every one of the 18 `adminResponsiveSizes` viewports inside each test, across 20 admin scenarios and three browser engines, and each viewport pass performs a login, several page loads, `networkidle` settles, control audits, and dialog interactions. Even at an optimistic few seconds per viewport pass the file needs one to three hours serially, while the lane reaches it with at most ~48 minutes left — and Vitest batches a file's output until completion in non-TTY runs, so the oversized matrix masqueraded as a hung process. Worse, the matrix is serial inside one file, so no worker count can shrink its wall-clock cost. The oversized matrix exposed a second structural deficit: extrapolating the observed per-byte execution rate over the complete 180-file inventory costs roughly 95 minutes of serial test time at one worker, before checkout, install, and build — over the timeout even with the Admin sweep removed, because the inventory grew from 144 to 180 files in this release-candidate stack while hosted parallelism stayed at one.

## Decision

The lane sets `DSH_ADMIN_ENGINES` and `DSH_ADMIN_VIEWPORTS` — the narrowing knobs the test design already provides — through the same capacity conditional as `DSH_WEB_SNAPSHOT_WORKERS`: hosted `ubuntu-latest` runs chromium at the representative widths 320, 390, 768, and 1280 (roughly a tenfold cost reduction), while enterprise and self-hosted failover runners keep the complete engine and viewport sweep. 390 retains the viewport that exercises the text-spacing special case, and 1024's coarse/fine boundary remains covered by adjacent widths. Hosted pool parallelism rises from one worker to two — the exact configuration the master snapshot sweep already operates on the same runner class, where it completes the smaller master inventory in about 43 minutes; pool files are written parallel-safe (ephemeral ports, per-file fixtures) because serial owners were already extracted into separate processes. `scripts/ci-workflow.spec.ts` pins all three expressions, so a future workflow edit cannot silently drop or widen either lever.

## Alternatives considered

- **Raising `timeout-minutes`** — the full matrix needs one to three hours for this file alone on degraded hosted runners; no plausible timeout hosts it, and the lane is already the pull-request wall-clock ceiling.
- **Trimming the matrix inside the test sources** — the full sweep is deliberate local and release-time deep verification; the design already ships the environment narrowing knobs for exactly this caller decision, and test-source edits would shrink coverage for every runner class.
- **Splitting the file or parallelizing** — Vitest parallelizes files, not tests within a file, and `fileParallelism: false` keeps the lane serial regardless, so no split changes the wall-clock cost.
- **Raising only the timeout without parallelism** — even 120 minutes leaves no headroom for runner degradation at one worker, and the pull-request wall clock doubles for every full-mode change; the sweep's two-worker precedent on the identical runner class is the evidence-backed calibration.
- **Treating the silence as a browser deadlock** — the evidence contradicts it: every neighboring file completed on time, the cancellation hit the exact timeout twice, and the cost model closes the gap without any additional defect.

## Consequences

Hosted runs now finish the Admin sweep in minutes and, crucially, the lane completes and reports its real failure inventory instead of expiring silently; failures in sibling admin specs become visible per-test rather than being amputated with the run. The complete matrix still runs locally by default and on the master/nightly sweep's capable runners. Files whose per-test loops multiply large matrices carry a lane-budget risk this pattern — narrowing at the workflow layer through the test's own knobs — should be reused for. Related: [tiered web browser verification](2026-09-11-web-verification-tiering.md) owns scenario selection and remains authoritative; this note covers per-file cost inside the selected inventory.
