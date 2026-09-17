# Agent Note: Workbench sidebar panel and pane-scoped markdown tables

Status: implemented

English | [中文](2026-09-17-workbench-sidebar-panel.zh.md)

## Problem

Workbench mode left two gaps. Narrow panes clipped markdown tables: cell caps used `30vw` measured against the browser window rather than the pane, and wide tables kept `overflow-x: hidden` until hover, so a ~390px column silently cropped wide content. Separately, the sidebar browsing region collapsed to a blank notice, so the pane roster and the account display preferences (font size, content width) had no reachable surface in workbench mode.

## Decision

Markdown: under `[data-workbench]` only, the `.tableScroll` leaf becomes an `inline-size` query container so the cell cap resolves as `30cqw` against the pane's text column, and `md-table-wide` scrolls immediately instead of hiding overflow until hover. Single-conversation rendering is untouched because `cqw` outside a query container still resolves against the small viewport.

Sidebar: `WorkspaceBrowser` declares a `sidebar.workspaces.workbench` child hole and, in workbench mode, swaps its Workspace/Session list, section header, and rail search for that hole. `ui-workbench` fills it with `WorkbenchSidebar` — a pane roster (status dot, workspace-scoped title, focus and close), Add bound to the shared chooser store, an equalize-ratios action, and an exit control — and declares the `conversation.workbench.display` hole on the same registration. `ui-conversation` fills that hole with `WorkbenchDisplayRow`, a stacked variant of the general display row bound to the same `ConversationDisplaySettings` face, so pane-adjacent preferences share the account revision fence with the settings sheet.

## Alternatives considered

**Put `container-type: inline-size` on `.workbenchPane`.** Rejected: several non-portal `position: fixed` descendants live inside panes (`SessionSettingsSheet`, `ContextMeter` popover, `stat-dialog`); containment would re-anchor them to the pane and clip them under its `overflow: hidden`. The leaf scroller has no positioned descendants, so containment there is behavior-free besides the query unit.

**Name the display hole `sidebar.workspaces.workbench.display` and let ui-conversation fill it.** Rejected: the SlotMap merge would then live in the workspace domain and pull ui-conversation's contract toward the sidebar package; keeping the hole under `conversation.workbench.*` leaves the merge with the display-settings domain owner and adds no module edge — ui-workbench already type-imports ui-conversation.

**Duplicate the toolbar's named-workbench menu in the panel.** Rejected: the toolbar already owns switch/create/rename/duplicate/delete; a second menu would fork one affordance across two surfaces.

## Consequences

Workbench panes size markdown tables to their own column and wide tables stay scrollable. The browsing region carries pane management and display preferences in workbench mode; the conversation domain keeps ownership of display-settings contract text. Named-workbench management stays exclusively in the toolbar. The [workbench capability note](../architecture/2026-09-08-cordis-multi-session-workbench.md) continues to own the viewport model; this note covers only the sidebar presentation added on top of it.

## Verification

`ui-workbench` assembly tests mount workspace, conversation, and workbench plugins through the real slot runtime and assert the rendered roster, focus/equalize/exit actions, the shared picker opening, and the display row writing through the settings scope. A style-contract test pins the `[data-workbench]`-scoped `cqw` container and wide-table overflow, and the workbench component specs cover the add/equalize gates and empty states.
