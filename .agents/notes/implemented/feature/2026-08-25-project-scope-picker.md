# Agent Note: Scalable project scope picker

Status: implemented

English | [中文](2026-08-25-project-scope-picker.zh.md)

## Problem

The personal/project scope menu rendered every project row at once. A growing membership roster could make the menu occupy most of the viewport, and choosing a project required scanning the entire list. The compact layout also needed the same search and scrolling behavior without hiding actions behind the mobile keyboard or safe-area inset.

## Decision

`ScopeControl` provides a localized project-name search field whenever project memberships exist. Filtering is local to the open menu, keeps the personal scope and project-management actions available, reports an explicit no-match state, and clears when the menu closes or the project list becomes empty. Existing selected-scope and staged-visibility checks remain the menu's selection markers.

The shared `Menu` primitive accepts non-scrolling `header` content and a `listClassName` for list-level geometry. Scope control sets a 480px cap, further clamped to the viewport, while the item viewport scrolls and management actions remain pinned in the footer. Below 768px, the menu is the shared safe-area phone sheet; the item viewport remains the only scrollport, and the search and clear controls grow to the shared touch target. The sheet's existing visual-viewport height variable keeps the list above the on-screen keyboard.

## Alternatives considered

**Leave the roster unbounded and rely on browser page scrolling.** Rejected because the portal menu can cover the sidebar and move its create/member actions out of reach; a local scrollport preserves the anchor interaction.

**Replace the menu with a separate project-management modal.** Rejected because scope switching is a lightweight selection action and would add a second presentation and dismissal model for the same entries.

**Add search without a height cap.** Rejected because search helps targeted selection but does not protect users who browse, and the menu would still grow with the roster.

## Consequences

Large rosters stay bounded and can be narrowed by project name while personal scope, current-selection markers, visibility choices, and management actions keep their existing semantics. The primitive's header and list-class hooks are reusable for other anchored lists, and mobile consumers inherit the same sheet safe-area and keyboard behavior. Search text is transient UI state and is not persisted or sent to the Gateway.

## Verification

Component tests cover filtering, empty results, clear/reset behavior, personal-scope retention, and pinned management actions. Primitive tests cover header placement and list-level classes. Stylesheet tests pin the scope-menu height cap and compact touch-target rules. The assembled Web replay pins desktop and phone-sheet menu structure; the focused collaboration and primitive GUI suites pass.
