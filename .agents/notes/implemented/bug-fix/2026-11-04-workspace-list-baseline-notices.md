# Agent Note: Session list publishes its baseline lifecycle on the region

Status: implemented

English | [中文](2026-11-04-workspace-list-baseline-notices.zh.md)

## Problem

The workspace browser rendered rows and the empty notice from the same source but exposed nothing about the Session and Workspace baseline lifecycle behind them. A pending or failed pull looked identical to an empty list, the reconnect refresh had no status seat, and the retained-list failure had no retry path. The browser end-to-end contract therefore could not name a stable region, a loading state, a failure alert, or a constant footer edge.

## Decision

`WorkspaceBrowser` derives one `listBaseline` (`loading | ready | error`) from the two published baselines — `useWorkspaces` state plus `baselinesReady`, and `useCurrentSessions` state — and publishes it as `data-workspace-list-state` on the list region alongside `data-workspace-list-region`. Each `SessionTree`/`FlatList` renders the notices inside its `role="tree"`: `Loading…` while a pull is pending, the `Could not load the list` alert with the `Retry` button keyed `list-feedback` when the list is empty, and the rows otherwise.

A `[data-workspace-list-footer]` seat stays mounted below the tree with a hidden placeholder so the region's footer edge is constant across states; the retained-list failure reveals its alert inside it. `Retry` re-pulls only the failed baselines through the injected `retryLists` and hands focus to the tree before the notice hides. The trash header in the document manager carries `data-documents-trash-header` for the same capture contract.

## Alternatives considered

**A second client-side state machine for the notices.** It would duplicate what the managers already publish and risk diverging from `baselinesReady`.

**A footer that mounts only on failure.** The retained-list geometry contract requires a constant footer rectangle before, during, and after the error.

**Hiding the placeholder alert with the `hidden` attribute.** `display: none` collapses the reserved height; `visibility` plus `aria-hidden` keeps the footprint and removes it from the accessibility tree in both rendered and non-rendered test environments.

## Consequences

The empty tree shows a real loading seat instead of flashing "No sessions yet" during the initial pull, and a retained list keeps its rows, scroll, and focus while the failure bar offers `Retry`. `data-workspace-list-state` reads `error` whenever either baseline fails, `loading` whenever either pull is in flight or pending, and `ready` only for the settled pair.

## Verification

The browser end-to-end suite captures the region attribute, the `list-failed`, `list-loading`, `list-empty`, `list-retained-error`, and `baseline-failed` aria goldens, constant list geometry and focus across the reconnect-failure-retry cycle, and the trash-header golden. Package unit specs cover the composed browser.
