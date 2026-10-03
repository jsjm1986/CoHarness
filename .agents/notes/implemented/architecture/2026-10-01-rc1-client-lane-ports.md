# Agent Note: Upstream rc.1 client-lane behavior ports

Status: implemented

English | [中文](2026-10-01-rc1-client-lane-ports.zh.md)

## Problem

The [rc1 client-lane audit](../../proposed/architecture/2026-09-30-rc1-client-lane-audit.md) adjudicated every upstream-only client package; several rows named real behavior gaps the fork lacked rather than structural divergences. Four were user-visible: the right sidebar carried no session-retained views, focus capture, or shortcut target model; the preparing phase of `RunningToolCall` rendered through execution rows that read dispatched arguments while they still streamed; the workspace browser had the `pinSession` Host RPC but no UI ordering or menu path; and `ui-layout`'s left-sidebar binding collided with the ported `sidebar.right.toggle`, breaking real-composition boot.

## Decision

Each behavior landed on the local session-store model instead of upstream's controller packages.

- **`ui-sidebar-right` retention and focus** — `SidebarSessionViews` selects and retains views over runtime `sessions` references; each View owns its Session reference and `keepMounted` bodies survive tab, session, and collapse changes without reparenting. `sidebarTargetFromElement`/`visibleSidebarPane` capture the focused dock or float occurrence; `registerSidebarShortcuts` binds `sidebar.right.toggle`, `pane.split`, `pane.fullscreen.toggle`, `page.close`, and `page.refresh` to `commandTarget`/`focusedTarget`/`isTargetCurrent`, with `closeTopModal` owning the `page.close` modal-dismiss fragment.
- **Preparing rows** — `phase: 'preparing'` branches through `CordisPreparingRow`, `PreparingPresentRow`, and `SkillRow`; keyed toolview cards no longer read arguments while they stream, and Cordis rows keep the tool glyph on failure instead of substituting `StateDot`. The shared `DisclosureRow` gained `running`/`contentClassName`/`contentLayoutClassName` plus a `TextShimmer` primitive and the `--dsw-alias-label-shimmer` theme tokens that drive the active-lifecycle copy.
- **Workspace pinning** — `pinnedSessionIds` rides the workspace row state; pinned rows lead every section in the section's own order and reorder only among themselves. `pinSession`/`unpinSession` write through the existing Host RPC, and `pin-order.ts` reconciles group and flat account orderings through `pinOrderSource`.
- **Agent Teams description clamp** — `TaskCard` clamps descriptions at two lines and measures actual clamping with `ResizeObserver` before offering the expand toggle.
- **Shortcut bindings** — `sidebar.left.toggle` keeps upstream's desktop `primary` / web `primary+alt`, leaving `primary+alt`/`primary+shift` to the right sidebar.

## Alternatives considered

**Adopt upstream's `session-view.ts` retention verbatim.** Rejected: it is written against the controller `SessionReferenceSourceMap`, which the fork does not carry; `SidebarSessionViews` preserves the same retention semantics over the runtime object layer.

**Keep `StateDot` status indicators beside the preparing branch.** Rejected: upstream's fix keeps the tool glyph for every status and reports failure through the error summary, so the indicator duplicated the same fact in two elements.

**Keep pin ordering out because drag ordering exists.** Rejected: drag persists manual order, while pinning is a membership set with its own RPC; the two compose rather than overlap.

## Consequences

- The real assembly boots with no conflicting shortcut defaults; desktop and web bindings differ deliberately.
- Every `phase: 'preparing'` surface renders a non-expandable shimmer row without touching execution or inventory hooks.
- `verify-client-packages` now requires `ui-sidebar-right`'s `dsh.client.inject` row to name `dsh-client-shortcuts`.

## Testing

`ui-sidebar-right` holds 258 focused specs across retention, focus capture, and command resolution; the real assembly spec (15 tests) proves no shortcut collision. Cordis status-icon, present-row, and skill-row specs pin the preparing branch; workspace tree/rows specs pin ordering and menu wiring.
