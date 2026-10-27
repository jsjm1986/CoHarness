# Agent Note: Workbench pane grid redesign — identity, collapse strips, and reorder

Status: implemented

English | [中文](2026-10-15-workbench-pane-grid-redesign.zh.md)

## Problem

The multi-pane workbench rendered every pane as an identical bare column: no scope identity beyond a title string, a 2px top hairline as the only focus signal, hairline separators with no drag affordance, four always-visible header icons, and a `2/4` caption as the only capacity hint. Non-focused panes gave no signal when they completed a turn or waited on interaction, pane order could only change through menu round-trips, and nothing occupied the space between "open" and "closed" for a pane the user wants parked but not removed.

## Decision

The workbench grid is a card surface with explicit identity, posture, and attention state. All posture lives in `ConversationViewportController`'s live snapshot; nothing new enters the durable record owned by [principal-owned workbench layouts](../architecture/2026-09-23-principal-owned-workbench-layouts.md).

- **Pane identity.** Every pane header renders a scope tile (blue personal/project / amber steward) plus a two-line identity: title over a `scope · workspace` subtitle. Steward tone resolves from the pane's own session id through `parseClientSessionKey` and the `projectUiPolicy` service — never from the page's active scope. `ScopeTile` in `ui-workbench` is the shared tile; the sidebar roster and conversation picker consume the same resolver so one pane reads identically in all three surfaces.
- **Focus signal.** The active pane title uses the business accent. Header actions remain in the DOM and keep their reserved space; fine-pointer views reveal them for the active, hovered, keyboard-focused, or open-menu header. Coarse-pointer and compact views keep them visible.
- **Session controls.** The pane header supplies duplicate title and status text; Session navigation, metadata, and plugin controls keep their original display conditions. Empty slot anchors reserve no toolbar row. A lone right-sidebar opener can share the pane identity row.
- **Status language.** `StateDot` gains an optional `word` label rendering a full-word capsule (`就绪`/`运行中`/`等待批准`/`运行失败`) next to the dot; `data-state` is preserved for automation.
- **Collapsed identity strip.** `ConversationViewportSnapshot` gains `collapsedIds`. `setCollapsed` parks a pane as a 46px strip (tile, status dot, vertical title, expand affordance) and refuses to collapse the last expanded pane; collapsing the active pane moves focus to a still-expanded neighbor. `soloPane` collapses every other pane and focuses the target; invoked on the already-soloed pane it restores all. `focus` expands only the focused pane. Removing a pane drops its strip. `collapsedIds` is view-only state and is deliberately absent from `SavedWorkbench` and both localStorage schema versions — collapse posture never survives a reload.
- **Reorder.** `ConversationViewport.reorder(id, index)` moves one pane to an absolute index while preserving its width ratio. `ConversationRoot` drives native drag-and-drop from the header's `data-pane-drag` identity cluster: the source cell dims in place and the hovered sibling grows a 2px insertion edge on its drop side. Collapsed panes cannot be dragged.
- **Separators.** Each separator is a `role="separator"` control with a hover/focus pill handle, arrow-key steps, a live `n% · m%` readout while dragging, and double-click equalization of the whole row.
- **Attention.** A toolbar pill counts non-focused panes with pending interaction and focuses the first on click. A completed non-focused pane wears a blue receipt dot until focused — backed by the session summary's existing `completed` flag, which the object layer clears on selection.
- **Layout presets.** The toolbar's layout menu applies `equal` / `lead` / `trail` ratio presets through `onViewportRatios` or selects the `tabbed` single-pane presentation, which maps to a root-local `soloTabbed` flag rather than a snapshot field.
- **Tabbed toolbar.** A two-row grid keeps the title and primary actions in the first row and gives conversation tabs the full second row. The tab row scrolls horizontally when its tabs exceed the available width, independently of the actions above it.
- **Row widths.** The desktop renderer keeps one horizontal row and normalizes its expanded weights to a total of one. CSS Grid can leave unused space when the total flex factor is below one. Expanded panes have a 280px minimum; overflow scrolls horizontally and selection reveals the active pane. Saved proportions remain unchanged, and collapsed strips stay 46px.
- **Logical lifetime.** The conversation plugin owns history-window retention through the registered Workbench toolbar contribution. A global main panel replaces the conversation DOM while the selected Workbench and its sidebar remain live, so presentation unmount cannot release its bounded pane set. Actual contribution withdrawal releases windows and suspends list-based pruning: a released Runtime's missing transport rows do not prove a saved member was deleted. Reinstating the contribution requests catalog verification before missing Runtime bindings are restored. Single mode and identity withdrawal retain their release semantics.
- **Commands.** Five `conversation.*` commands register through the existing `inject(['shortcuts'])` path — pane focus (`primary+digit` desktop, `primary+alt+digit` Web where ⌘N owns browser tabs), solo toggle, and exit-solo.
- **Supporting surfaces.** The toolbar reports the current pane count and capacity. The sidebar roster is a hairline row list — leading index that swaps to the `⌘N` shortcut on hover, scope tile, title with relative `updatedAt` in the trailing cell, and one status line merging the state word with `scope · workspace` — where the active row wears a business-blue tint fill with an inked title and the completion receipt recolors the status word to `新回复`; relative time and the hover-revealed Close share the trailing cell so they never overlap, Add is a hairline row, capacity is a caption (`已开 2 栏 · 还可加 2`) holding the equalize link, and Exit Workbench pins to the panel footer. The empty state is a guidance card naming what panes do. The picker rows show scope tile, relative `updatedAt`, and `已在工作台`/`仅可查看` badges.

## Alternatives considered

**Persist collapse posture in `SavedWorkbench`.** Rejected: parking is a momentary working preference — a collapsed strip on next launch would hide content the user forgot they parked, and the durable record is principal-owned so a stale strip would follow the account across machines. `maximized` mode already sets the precedent: presentation posture stays out of the durable record.

**Local component state for collapsed/solo/tabbed.** Rejected: focus, removal, and keyboard commands all interact with collapse state (focus expands, removal trims, solo toggles), so owning it in `ConversationRoot` would duplicate invariants the controller already enforces once. `soloTabbed` stays root-local only because it is a pure layout flag with no pane-set invariants.

**Keep every menu inside the clipped pane.** Mode-lane popups remain owned by their pane body. The desktop background-job menu uses the shared anchored positioning primitive and a portal so pane overflow cannot clip it; outside dismissal includes the portal, and a hidden trigger closes its menu.

**Drag order changes through the existing `move` primitive.** Rejected: a `move(id, delta)` repeated n times loses the destination's absolute semantics mid-gesture and re-runs ratio normalization per step; `reorder` takes the absolute index once.

## Consequences

Capacity, identity, and attention are readable at a glance; panes can be parked, reordered by drag, and resized with accessible feedback. `SavedWorkbench` gains no field and needs no migration — restored sessions never resurrect a strip. `focus()` semantics narrowed: it now expands only its target instead of implicitly clearing all strips, which the tests pin.

The picker, sidebar roster, and pane header share one identity resolver; adding a fourth surface means reusing `ScopeTile` + `paneIdentity`, not re-deriving scope.

## Testing

The [keyless Web workbench scenarios](../../../../apps/web/tests/workbench.e2e.ts) compare row and pane boundaries in tabbed, horizontal, preview-constrained, and collapsed layouts, then check the original proportions after returning to a wide row.

The [Runtime ownership cases](../../../../packages/client/ui-conversation/tests/workbench-runtime-ownership.client.spec.tsx) exercise the real pool and slot registry across main-panel replacement, contribution withdrawal and restoration, single mode, identity withdrawal, and plugin unload. The [two-Host Web scenario](../../../../apps/web/tests/runtime-identity.e2e.ts) enters Plugins from either pane, returns through the selected sidebar row, and preserves active and inactive named members without another history read or Session command.

`viewport.client.spec.ts` covers collapse invariants (last-expanded refusal, active-pane focus handoff, focus-expands-target-only, removal trimming, solo toggle/restore) and `reorder` ratio preservation; persistence specs pin `collapsedIds` absent from both record versions. `workbench-grid.client.spec.tsx` mounts `ConversationRoot` against a writable store for pane counts 1–4, collapse strip rendering and affordance gating, separator equalize, drag-to-edge reorder, layout preset callback and tabbed mode, and pointer-focus/owner-callback routing. `assembly.client.spec.tsx` covers the roster seat dots, scope tiles, and equalize action end to end.
