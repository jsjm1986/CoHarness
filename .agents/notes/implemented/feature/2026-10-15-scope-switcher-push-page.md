# Agent Note: Scope switcher pushes a takeover page into the sidebar column

Status: implemented

English | [中文](2026-10-15-scope-switcher-push-page.zh.md)

## Problem

The switcher lineage — floating menu, in-card drawer, card hub, phone accordion — kept carving the switcher out of the column it lives in. Each version wedged a secondary surface between the trigger and the session list: the hub's card chrome disconnected from the sidebar fill, and on the phone the same hub was a desktop idiom squeezed into a 300px drawer. Scope switching is one task with a small fixed information set — current space identity, roster, visibility staging, management entries — and it wants a page, not a resizable slice of the column.

## Decision

Both wide surfaces render the switcher as an absolutely positioned **push page**: on compact it covers the whole drawer edge to edge, and on wider layouts it aligns to the browsing region so the column's brand, New Session control, panel list, and foot stay in view. `.root` (the sidebar column) declares `position: relative`, and `SidebarRoot` publishes `.regionArea`'s box as the inherited `--dsh-sidebar-region-top`/`--dsh-sidebar-region-height` custom properties — measured in a layout effect and kept live by one ResizeObserver on the flex:1 seat, which resizes whenever the surrounding chrome changes. Below 768px `.scopePage` keeps `inset: 0`; above it the page reads `top`/`height` from those variables. The trigger keeps its tile + name + mode flag (a status dot + text shown only for non-default scopes) but swaps the down chevron for a right chevron and gains `aria-controls={pageId}` — it discloses a page, not a menu.

- **Navigation and focus.** Switching and management occupy separate tabs within the root page. Management pushes a nested visibility page; Back or Escape returns to its invoking row, while Escape at the root closes and restores the trigger. Search remains unfocused on entry so phones do not open the keyboard. Modals retain the underlying page and return to their invoking controls.
- **Information hierarchy.** The current identity and creation source sit above the tabs. Switching owns the search and flat roster; administrator and writable memberships stay quiet regardless of roster composition, with read-only and maintenance exceptions explicit. Management owns project configuration, invitations, staged visibility, the all-visible invitation center, and user-created projects. This keeps repeated administrator labels from overwhelming the scan.
- **Semantics follow focus ownership.** The page is a labeled modal dialog within the sidebar region. Outside pointers dismiss it; nested dialogs hide the retained parent from assistive navigation. Rows are plain buttons, and the selected scope carries `aria-current`. Scope rows switch and close; visibility rows stage `stagedVisibility` without closing.
- **`Menu` keeps only the rail path** (`!wide`), unchanged: portalled floating list, measured width, full item set. Modals still portal to `document.body` and layer above the page.
- The identity-tile grammar is inherited intact: `tileGlyph`/`tileTone` rows, surrogate-pair-safe initial, steward shield tile, and the circular personal-scope tile.

## Alternatives considered

**Keep the card hub / in-flow sheet.** Rejected in design review: the card surface never reconciled with the column fill, and the sheet geometry capped exactly the operations that need room. The accordion variant had the same conflict inside the drawer column.

**An anchored popover above the trigger (Slack-style).** Rejected: it reintroduces a detached floating layer, works only on desktop, and caps the roster at popover height — the phone has no equivalent surface, so the two ends would fork again.

**A persistent space rail (Discord-style icon column).** Rejected: it permanently narrows the session list for a control used in bursts, and duplicates management entries the page already groups.

## Consequences

- `Menu` owns only the rail path. Wide surfaces use inline dialog rows, and the rail retains its measured, portalled menu.
- `.root` is now a containing block — future absolute content inside the column scopes to it, and the region-geometry variables are a shell-owned contract any column-scoped overlay may read. The measurement contract lives in `SidebarRoot`; packages consuming the variables only read CSS.
- On desktop the page covers only the session browser; channel rows, brand, and the trigger remain visible. On compact it covers the drawer's whole column, including the foot. Modal focus ownership prevents background conversation shortcuts while either page is open.
- The visibility `menuitem` ids exist only on the rail path; the staged value surfaces on the root page's visibility row value and the subpage's checked row.
- Supersedes [the space-hub takeover](../../archived/feature/2026-10-13-scope-hub-sidebar-takeover.md) and [the in-card drawer](../../archived/feature/2026-10-13-scope-switcher-in-card-drawer.md), both archived; the rail's measured floating list remains described by [the adaptive panel menu](2026-10-03-scope-control-panel-menu.md).

## Testing

Component tests cover disclosure semantics, tab navigation, permission-label restraint, visibility staging, focus return, and unchanged scope-operation arguments. Shipped Web snapshots exercise the assembled sidebar at desktop and phone widths; project-dialog tests verify capability authority and unchanged creation, invitation, theme, and SSH payloads.
