# Agent Note: Workbench restore adoption must wait for the joint sessions/workspaces baseline

Status: implemented

English | [中文](2026-11-18-workbench-restore-adoption-joint-baseline.zh.md)

## Problem

`ConversationViewportController.markCatalogReady()` adopted the restored layout's active pane as soon as catalog hydration finished, calling `select(state.activePaneId)` directly. Catalog hydration resolves through the account workbench-catalog and history reads and can complete while `workspaces.list` is still `pending` — the joint baseline `reconcileSessions()` explicitly requires before adopting anything. The premature `select` moved `sessions.current` onto the saved pane, and `RightbarRoot` — which follows `current` whenever no explicit `targetSessionId` is pinned — rendered the document-preview sidebar before `workspace.list` resolved. `workbench.e2e.ts`'s `keeps the originating conversation selected when its document preview narrows the workbench` gated `workspace.list` and observed `preview-origin-beta` already visible before baseline completion, failing on three consecutive CI runs.

## Decision

All restore-time adoption now flows through `selectWorkbenchFocus()`, which refuses to move `current` until `baselineReady` — the flag `reconcileSessions()` sets only after both `sessions.list` and `workspaces.list` report `ready`. `markCatalogReady()` calls it instead of `select` directly, and `setEnabled()`'s re-adoption path uses the same gate, so catalog readiness or client enablement alone can never adopt a pane.

`baselineReady`'s constructor seeding was corrected to the same joint definition: a controller built while `sessions.list` is already `ready` but `workspaces.list` is still `pending` no longer counts as baselined. The previous sessions-only seed both unblocked restore adoption early and permanently suppressed the `firstBaseline` adoption when workspaces resolved later.

## Alternatives considered

- Gating only `markCatalogReady()` — rejected: `setEnabled()` shared the same direct-select adoption, and fixing one call site leaves the next restoration trigger able to replay the race. Centralizing in `selectWorkbenchFocus()` makes the contract single-sourced.
- Adding `baselineReady` to `select()` itself — rejected: `select()` is also the user-gesture path (focus, add, remove, pane switching); those callers must not wait on a baseline they already own.
- Waiting for `pendingIdentity` to clear instead — rejected: `pendingIdentity` covers the v2 opaque-key rewrite, a different pending state; the failing path was a v3 record whose panes were already verified but whose workspace baseline had not arrived.

## Consequences

- The `firstBaseline` adoption in `reconcileSessions()` is again the single point that moves `current` onto a restored pane; on sessions-ready-at-construction plus late-workspaces orderings it now fires, where the old seed would have swallowed it.
- User-driven switches and duplications still select through `switchWorkbench`/`duplicateWorkbench` → `selectWorkbenchFocus()`; by the time a user can switch, the baseline has long resolved, so behavior is unchanged.
- A pane whose session is absent or archived remains rejected by the same `validSession` check inside the gate; unavailable-panend park semantics are untouched.

## Verification

- New regression `does not adopt the restored active pane before the joint sessions/workspaces baseline resolves` in `packages/client/ui-conversation/tests/viewport.client.spec.ts`: sessions and workspaces lists both `pending`, v3 account record with `activePaneId` verified via `setPaneVerification({})` — `markCatalogReady()` leaves `sessions.open` untouched until `workspaces.list` flips ready, then the `firstBaseline` reconcile adopts the pane. Stashing the fix makes it fail deterministically at the first assertion.
- `viewport.client.spec.ts` 29/29; workbench persistence, runtime-ownership, and selection-survival specs 60/60 combined.
- `apps/web` CI `web verification` previously failed this scenario on three runs in a row; the fix targets the exact ordering the test gates.
