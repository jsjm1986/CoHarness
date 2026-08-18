# Agent Note: Sidebar footer stacked Settings rows

Status: implemented

English | [中文](2026-08-19-sidebar-footer-stacked-rows.zh.md)

## Problem

`sidebar.footer.action` occupants (project scope, Cordis inventory, Documents) each request a full-width trigger, but `.footerActions` is a horizontal flex. On the compact drawer (`min(85%, 320px)`) and the 280px desktop sidebar those `width: 100%` children crush each other: the scope name ellipsizes to a single character beside the non-shrinking 「可编辑」 badge, and the Cordis trigger clips to `Cordis Plu`. The 56px rail has the same row, so three 36px circles overflow horizontally. No Host, session, or settings write paths are involved.

## Decision

`.footerActions` is a column of full-width rows. Each occupant uses the Settings foot geometry already shared with the Cordis badge: a 42px row (`width: calc(100% + 4px)`, pad `0 10px 0 8px`) when `wide`, and a 36px circle when not. The scope name (and the Cordis label) is `flex: 1 1 auto; min-width: 0` with ellipsis; the mode badge, chevron, and running count stay `flex: none`. Compact in-frame chrome grows the wide row to `--dsw-touch-target` via `[data-viewport='compact']`; the rail circle does not. Occupants that return null leave no empty cell. Slot contracts, inject factories, and copy are unchanged.

Related: [compact chrome density](2026-08-19-compact-chrome-density.md).

## Alternatives considered

**Identity row plus a two-up tool strip for Cordis and Documents.** Rejected: the list slot wrapper is `display: contents` with a variable occupant set, so CSS cannot stably pick "tools" versus "identity" without a new grouping slot. A half-width Cordis row still clips `Cordis Plugin` plus the running count.

**Wrap 「可编辑」 under the project name on compact.** Rejected: a 320px full-width row already fits a short name plus the badge, and a two-line control would break the 42px Settings rhythm used by the rest of the foot.

## Consequences

Compact-drawer and 280px-sidebar users can read the project name, membership mode, Cordis trigger, and Documents label as separate rows above Settings. The collapsed rail stacks the same icons vertically. The foot grows by one 42px row per occupant (at most three above Settings); the session list remains `flex: 1`. `panel.trigger` remains the English `Cordis Plugin` string in both dictionaries.

## Testing

Package CSS-contract specs pin the column, 42px row, 36px rail circle, and compact `--dsw-touch-target`. ScopeControl and DocumentsButton component tests assert the `rail` class when `wide` is false.
