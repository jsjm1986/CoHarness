# Agent Note: Consolidation cursor concurrency

Status: implemented

English | [中文](2026-10-23-consolidation-cursor-concurrency.zh.md)

## Problem

A scope review reads its catalog before an auxiliary model call. Members can edit that scope while the model runs. Recording the final catalog digest and resetting its counter unconditionally can mark those unreviewed edits as processed and suppress the pending review.

## Decision

The memory service provides an atomic conditional cursor write in its mutation queue. Consolidation expects the observed cursor plus its own successful mutations; unrelated counter or review-metadata changes prevent publication of a stale completion. Empty-scope reviews use the same comparison. A conflicting pass leaves the pending changes eligible without advancing their digest or interval.

The [scope scheduler](2026-10-31-memory-consolidation-coalescing.md) coalesces overlapping reviews before model admission. Conditional publication still protects member edits and other cursor writers during the active review.

## Alternatives considered

**Hold the mutation queue while the model runs.** The review executes memory tools through that same queue; holding it would block those writes and member operations.

**Compare the cursor before calling its ordinary setter.** An entry mutation can land between comparison and persistence, so the comparison and write belong in one serialized operation.

## Consequences

Concurrent changes can require another bounded review. The cursor retains every unrelated change rather than claiming that the model reviewed a newer catalog. Simultaneous review completions cannot replace newer review metadata.

## Verification

Barriers exercise edits during the model request and after an empty catalog snapshot. A real Loader snapshot runs two Agent turns and two auxiliary reviews over JSON memory, with a member deletion between model inputs.
