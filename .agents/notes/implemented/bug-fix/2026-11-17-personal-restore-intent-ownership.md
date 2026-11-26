# Agent Note: Personal recovery owns its pending editor

Status: implemented

English | [中文](2026-11-17-personal-restore-intent-ownership.zh.md)

## Problem

A browser refresh can recover both its saved personal Session and its Workbench layout. Selecting a restored pane supersedes navigation without publishing a user-committed selection. Cancelling only the personal recovery's history request leaves its independent pending editor active, so its settled callback can publish an unavailable composer above otherwise usable panes.

## Decision

[Personal directory recovery](../../../../packages/client/runtime/src/client/personal-directory.ts) owns a cancellation subscription for its exact conversation intent. Supersession withdraws only that editor. Empty input is discarded; nonempty input remains bound to its original target for an explicit retry. Retrying obtains a new navigation lifetime while retaining the original account and document lifetimes and rechecking current availability. It cannot adopt another computer or a later account.

Successful recovery transfers text to the verified Session composer and removes its cancellation subscription before selecting that Session. Selection can then supersede navigation without cancelling its own transfer. The directory owner retains every outstanding recovery promise until settlement, including a cancelled read that overlaps a new retry. Neither view cancellation nor disposal submits input or cancels a Host task.

The selection priorities remain separate: a saved personal selection can supersede an earlier ambient selection, a later navigation cancels an in-flight restore, and a committed user selection prevents a new ambient restore. Same-account renewal keeps its existing behavior described in [Pending conversation intents survive renewal](2026-11-08-pending-intents-survive-renewal.md).

## Alternatives considered

**Hide all pending editors in Workbench mode.** This removes valid new-conversation input and conceals lost ownership instead of correcting it.

**Make every ambient selection preserve the previous navigation.** Pane focus would then stop cancelling older view operations. Recovery ownership can be corrected without changing the shared navigation API.

**Retain a cancelled signal for explicit retry.** The text remains visible but can never reach its original composer. Retry needs a fresh navigation lifetime while keeping the captured target and account lifetime.

## Consequences

Cancellation and successful transfer have distinct ownership transitions. Controlled completion barriers cover both personal-first and Workbench-first restoration, empty and nonempty text, a newer unrelated intent, overlapping retry, original-target transfer, unchanged pane drafts, and absence of prompt or cancel requests. The [two-Host Workbench browser scenario](../../../../apps/web/tests/workbench-cross-runtime-drafts.e2e.ts) exercises the assembled client and durable Host messages; deployment acceptance additionally checks the actual computers and Send controls.
