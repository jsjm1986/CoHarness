# Agent Note: Scope switcher pushes a takeover page into the sidebar column

Status: implemented

English | [中文](2026-10-15-scope-switcher-push-page.zh.md)

## Problem

The switcher lineage — floating menu, in-card drawer, card hub, phone accordion — kept carving the switcher out of the column it lives in. Each version wedged a secondary surface between the trigger and the session list: the hub's card chrome disconnected from the sidebar fill, and on the phone the same hub was a desktop idiom squeezed into a 300px drawer. Scope switching is one task with a small fixed information set — current space identity, roster, visibility staging, management entries — and it wants a page, not a resizable slice of the column.

## Decision

Both wide surfaces — the desktop sidebar column and the compact drawer — render the switcher as an absolutely positioned **push page** that covers its containing column edge to edge. `ScopeControl` derives nothing new per breakpoint: `wide` renders `.scopePage` at `inset: 0`; the phone drawer already supplies an absolute containing block, and `.sidebarCol` declares `position: relative` so the page scopes to the column rather than the viewport. The trigger keeps its tile + name + mode pill but swaps the down chevron for a right chevron and gains `aria-controls={pageId}` — it discloses a page, not a menu.

- **Two-level navigation.** `pageView` selects `root` or `visibility`; `pageNav` (`push`/`pop`) picks the slide direction. The visibility row on the root page pushes the second level; the back button and Escape pop it, and Escape on the root closes the page. Closing or reopening always lands on the root level.
- **Root page inventory.** A page nav row (back control + `scope.menuTitle`), a current-space hero (identity tile, name, mode/status meta), a management group (new-conversation visibility › with its staged value, invitations › with the pending badge, project settings ›), and an all-spaces group (personal + project rows carrying the identity tiles, trailing check on the selected scope, caption values for read-only/steward). Roster search renders past four projects; `project:create` sits at the foot when injected.
- **Semantics follow the surface.** The page is a labeled `role="group"`, rows are plain buttons, and the selected scope carries `aria-current`. Scope rows switch and close; visibility rows stage `stagedVisibility` without closing — a staged preference is not a selection.
- **`Menu` keeps only the rail path** (`!wide`), unchanged: portalled floating list, measured width, full item set. Modals still portal to `document.body` and layer above the page.
- The identity-tile grammar is inherited intact: `tileGlyph`/`tileTone` rows, surrogate-pair-safe initial, steward shield tile, and the circular personal-scope tile.

## Alternatives considered

**Keep the card hub / in-flow sheet.** Rejected in design review: the card surface never reconciled with the column fill, and the sheet geometry capped exactly the operations that need room. The accordion variant had the same conflict inside the drawer column.

**An anchored popover above the trigger (Slack-style).** Rejected: it reintroduces a detached floating layer, works only on desktop, and caps the roster at popover height — the phone has no equivalent surface, so the two ends would fork again.

**A persistent space rail (Discord-style icon column).** Rejected: it permanently narrows the session list for a control used in bursts, and duplicates management entries the page already groups.

## Consequences

- `Menu` no longer owns the wide path: there are no `menu`/`menuitem` roles, no `ResizeObserver` width tracking, and no portalled list on either wide surface. Tests must query page rows (buttons inside the `group`), not menuitems; the rail keeps the menu roles.
- `.sidebarCol` is now a containing block — any future absolute content inside the sidebar column scopes to it, and the column's `overflow: hidden` clips the page during push/pop.
- While the page is open it covers the channel rows (文档/设置) below the trigger's column; the accepted trade is that switching is a modal task with an explicit back/Escape exit. The rail trigger is unaffected.
- The visibility `menuitem` ids exist only on the rail path; the staged value surfaces on the root page's visibility row value and the subpage's checked row.
- Supersedes [the space-hub takeover](../../archived/feature/2026-10-13-scope-hub-sidebar-takeover.md) and [the in-card drawer](../../archived/feature/2026-10-13-scope-switcher-in-card-drawer.md), both archived; the rail's measured floating list remains described by [the adaptive panel menu](2026-10-03-scope-control-panel-menu.md).

## Testing

`components.client.spec.tsx` asserts the pushed page on both wide surfaces: trigger disclosure semantics (`aria-expanded`/`aria-controls`), root-page inventory (hero, management rows, badge), visibility push/pop with staging without dismissal, Escape depth behavior, scope-row switching with close, rail `Menu` retained with no duplicate trigger. `scope-control-styles.client.spec.ts` pins the page geometry (`inset: 0`, column containing block, push/pop keyframes, reduced-motion fallbacks) and the row/hero/group grammar. Focused suites pass (76 tests across 5 files) and `tsc -b packages/client/ui-collaboration/tsconfig.json` is clean.
