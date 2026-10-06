# Agent Note: Scope switcher as a sidebar-width-adaptive panel menu

Status: implemented

English | [中文](2026-10-03-scope-control-panel-menu.zh.md)

## Problem

The Scope switcher popover pinned itself to the shared `Menu` minimum width, so project names wrapped into a second line next to a caption-colored mode line, and the floating box visibly disconnected from the draggable sidebar edge. The trigger already tracks the footer row width, but the menu had no way to follow it.

## Decision

**The scope menu measures the trigger and renders as a single-line-row panel.**

- `Menu` accepts `listStyle`, a `CSSProperties` override merged under the portal's computed `left`/`top`; measurement and viewport clamping are unchanged because the override applies to the same element the positioning code measures.
- `ScopeControl` observes the trigger button with `ResizeObserver` and passes `width: clamp(trigger.offsetWidth, 240, 400)` as `listStyle`; dragging the sidebar therefore re-sizes the open menu without re-opening it.
- Scope rows render one line: a status dot (brand-colored on the active scope), the name, and a mode pill pinned to the row's trailing edge. The panel gains a `scope.menuTitle` header above the search field.

## Alternatives considered

- **A `--dsh-sidebar-width` custom property.** Rejected: the layout store does not publish one today, and deriving the menu width from the rendered trigger keeps the measurement at the element that actually constrains it, including rail mode and future footer chrome changes.
- **Per-scope avatar blocks.** Rejected in design review: generated color initials added visual weight without helping identification.

## Consequences

`Menu` grows an additive optional prop; no other caller changes. Long project names truncate instead of wrapping, and the popover keeps a consistent visual relationship to the sidebar at any width. Rail-mode triggers still clamp the menu to the 240px floor.
