# Agent Note: Sidebar footer and document layout hierarchy

Status: implemented

English | [中文](2026-08-24-sidebar-footer-document-layout.zh.md)

## Problem

The sidebar footer rendered scope, Documents, Sign out, and Settings as independent 42px rows. The controls had different ownership but no shared spacing contract, so Sign out carried the same visual weight as workspace actions and the Settings transition was easy to miss. The document manager also placed filters and mutations in one wrapping toolbar, which made the action order harder to scan on narrow screens.

## Decision

`SidebarRoot` owns the footer rhythm through inherited custom properties. Expanded footer rows use a 36px visual height, a shared radius, and a two-pixel stack gap; coarse pointers and compact viewports raise each row to the existing 44px touch target. Rail controls remain 36px circles and use the shell's rail gap.

The scope selector is the context row and receives a quiet layer fill with a border cue. Documents and Settings use flat rows. Settings begins a separate account group with a divider. Sign out keeps the native Gateway form and accessible name, but uses secondary ink and a 14px desktop glyph; hover and focus expose the danger color. The rail keeps a neutral hover treatment so the destructive cue is not shown merely because the sidebar is collapsed.

The document manager toolbar has a filter group and an action group with independent responsive rules. Desktop keeps the groups side by side; compact layouts stack them and preserve touch targets. Document rows have stable horizontal padding, a light hover state, and the existing wrapped action layout so long names cannot push controls out of view.

## Alternatives considered

**Only reduce the Sign out row.** This would leave four unrelated spacing systems and would not clarify which control represents the active runtime. The shell-owned rhythm makes future footer registrants align automatically.

**Put every footer control in one filled card.** A card would make Settings and Sign out look like the same task family and would add a nested framed surface to the sidebar. A divider provides the account grouping without another container.

**Use CSS-only responsive wrapping for the document toolbar.** Natural wrapping lets a refresh control move between the filter and mutation controls at intermediate widths. Explicit groups preserve action order and give compact layouts a predictable stack.

## Consequences

The footer packages continue to own their content, registration order, forms, and tooltips; they consume only inherited geometry variables and keep package boundaries intact. Existing 44px coarse-pointer guarantees remain in force even though desktop rows are shorter. The document manager adds two localized group names for assistive technology without adding explanatory copy to the visual layout.

## Verification

Focused Vitest coverage pins the footer variables, context treatment, secondary Sign out behavior, grouped document toolbar, compact rules, and sidebar snapshots. The assembled Web client is checked at expanded and rail widths, including a compact viewport, for clipping, alignment, and long document names.
