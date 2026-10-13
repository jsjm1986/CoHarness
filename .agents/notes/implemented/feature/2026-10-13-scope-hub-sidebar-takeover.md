# Agent Note: Scope control becomes a persistent space hub in the footer column

Status: implemented

English | [中文](2026-10-13-scope-hub-sidebar-takeover.zh.md)

## Problem

The scope surface was designed as a one-shot picker: switching, project creation, member management, project settings, and new-conversation visibility all arrived as flat items in one list. Persistent operations — theme policy, invitations, member review, visibility staging — competed with rows that trigger a page reload, so the surface could not grow beyond a picker's height. The in-card drawer also capped its card skin at `min(340px, 48vh)`, which squeezed exactly the operations that need room.

## Decision

The expanded sidebar sheet becomes a **space hub**: the same `Menu`-owned in-flow sheet, rendered transparent on the footer column so its blocks read as the sidebar's own surface rather than an embedded card.

- The sheet's header region carries the hub: a back control and roster count, a current-space card (28px identity tile, name, mode/status meta, and a settings action when `loadProjectConfiguration`/`setProjectThemePolicy` are injected and the active project is in the roster), an invitation row that switches to the warn family while `getInvitationCount` reports pending work, and the existing project search field.
- New-conversation visibility leaves the item list and becomes a `radiogroup` of two `radio` buttons inside the current-space card. The track mirrors the conversation header's segmented control: an `interactive-bg-hover` track, a `::before` raised pill sliding via `--dsh-vis-index`, `radius-card`/`radius-control` corners. Choosing a value stages the setting without dismissing the sheet — a staged preference is not a selection.
- The pinned footer keeps only `project:create` in wide mode; member and settings entries move into the header blocks. The rail and compact paths are unchanged: the portalled floating menu still carries the visibility items and the full footer set.
- `.scopeSheet` drops its card chrome — `--dsw-menu-surface-fill: transparent`, `box-shadow: none`, `border-radius: 0` — and the cap grows to `min(560px, calc(100vh - 150px))` so the roster scrolls while the trigger and Settings rows stay reachable.

`Menu` still owns selection, keyboard navigation, search filtering, outside-click/Escape close, and focus return; the hub adds no row or dismissal logic.

Related: [the in-card drawer](2026-10-13-scope-switcher-in-card-drawer.md) owns the in-flow sheet mechanism this hub reuses; [the adaptive panel menu](2026-10-03-scope-control-panel-menu.md) still describes the rail path's measured floating list.

## Alternatives considered

**A secondary column sliding out beside the sidebar.** Rejected in design review: it needs a new host column and duplicates the footer column's chrome; the takeover delivers the same persistent surface inside the existing slot.

**A centered command palette or grid board.** Rejected: both are modal surfaces for one-shot switching; they would bury the persistent settings, member, and invitation entries behind an extra layer and abandon `Menu`'s behavior contract.

**Keep visibility as menu items.** Rejected for the wide hub: a staged setting rendered as `menuitem` implies an action that runs and closes the surface; a `radiogroup` states the true semantics and does not dismiss the hub on change.

## Consequences

- The wide sheet no longer looks like a card: its surface is transparent and each block carries its own chrome. Anything rendered in the sheet header must supply its own fill/hairline or inherit the sidebar fill.
- `.scopeField`/`.scopeSheet` doubled selectors remain mandatory.
- The visibility `menuitem` ids exist only on the rail path; tests must not query them in wide mode (use `radio` roles).
- `currentMeta` doubles as the status line: `scopeBusy`/`scopeError` states surface inside the current-space card while the trigger keeps its busy/error treatment.

## Testing

`components.client.spec.tsx` asserts the hub surface — radiogroup staging without dismissal, the back control, the warn invitation entry with its badge, and the settings action opening `ProjectSettingsModal` — plus unchanged row/selection behavior. `scope-control-styles.client.spec.ts` pins the takeover skin (transparent fill, no shadow, `order: -1`, `position: static`, height cap) and the hub chrome (card fill/hairline, segmented track, sliding pill, warn row). Focused suites pass (75 tests across 5 files) and `tsc -b packages/client/ui-collaboration/tsconfig.json` is clean. A Chromium render built from the real `Menu`/`MenuSurface`/theme/`ScopeControl` stylesheets verified the rw-with-pending and ro surfaces.
