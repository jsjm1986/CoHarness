# Agent Note: Collapsible space-picker groups and the multi-computer maintenance fold

Status: implemented

English | [中文](2026-11-11-scope-picker-collapsible-groups-and-steward-fold.zh.md)

## Problem

The scope picker (`ScopeControl`) renders every authorized destination as a flat row under four groups (favorites, recent, personal, projects). In the production deployment the projects group holds 16 rows, three of which are independent steward spaces — one per enrolled computer, named `维护中枢·<node>`. The list is dense, the maintenance triple repeats the same leading word, and there is no way to shorten the page without searching. The user's chosen direction was the conservative route: keep the existing group semantics and authorization model, add collapse, and converge the per-computer maintenance rows visually.

## Decision

Grouping stays exactly as `spaceDestinations()` + the favorites/recent/personal/projects buckets already produce it. Two pure display helpers in `space-destinations.ts` describe the row layout: `spaceRowEntries(items, flat)` maps a group's destinations to `SpaceRowEntry` rows, folding every steward destination in a group into one `steward` entry at the first steward's original position when two or more are present; `flat` bypasses folding so an active search query keeps every per-computer identity matchable and selectable. `stewardSpaceBase(destinations)` derives the fold row's name by stripping the `·<nodeName>` suffix when all members agree on the base, else falling back to the first name's `·` prefix.

The fold is deliberately display-only: [Per-node steward projects](../architecture/2026-11-07-per-node-steward-projects.md) keeps each computer's maintenance space an independent project, and nothing here merges them in the model.

`ScopeControl` holds expansion in two component-local `ReadonlySet<string>` states — `closedGroups` (keyed by group id) and `openStewards` (keyed by the owning group's id, which can host at most one fold). Group headers are real `<button>`s carrying `aria-expanded` and a rotating caret; the folded maintenance row is a `.pageRow` button with the steward shield tile, the shared base name, a localized `{count} 台电脑` computer line, and `aria-expanded`; expanding renders the unchanged destination rows inside an indented `.stewardChildren` block. Selection, disabled-while-switching, and exact runtime targets are untouched — the fold never invents a destination. Because a used steward space is promoted into Recent (or matched flat under search) as a single row, `stewardChildName` strips its `·<node>` suffix in every steward row — not only fold children — since the computer already renders as the secondary line.

Rows carry a two-line, two-slot grammar (`destinationLabel`): the name line ends on a dim `scopeAccess` access marker for non-steward grants (`只读`/`管理`), and the computer line (`destinationComputer`) ends on the runtime state tag. Resting states — `待启动` (stopped), `启动中`, `准备中` — render as `Tag` `quiet` text with no fill; only degraded reachability (`离线`, `维护中`, `待确认`) keeps a warning/danger pill, so a resting list no longer reads as a wall of warnings. The steward shield tile carries the maintenance identity, so steward rows and the fold row render no `维护` flag at all. `.pageRow` is a flat full-bleed row separated by `.5px` hairlines; it pins `appearance: none` plus explicit `border`/`border-radius`/`box-shadow` resets so host-document button defaults or an outdated bundled stylesheet cannot box the rows.

## Alternatives considered

**Inline computer pills on a merged row (variant A).** Collapses three rows into one but introduces a second selection affordance inside a row and a new pill component; rejected as more machinery than the density problem needs.

**Regrouping by computer (variant C).** Matches the workspace tree's mental model but replaces the personal/projects semantics the rest of the page (hero, management tab, flags) is built on; rejected as a model change, not a display change.

**Persisting expansion state.** `space-navigation-preferences.ts` deliberately stores only favorites and recent runtime identities; per-session collapse is transient UI state and stays in the component per the data-access ladder.

**Folding in `spaceDestinations()` itself.** Rejected: the derivation feeds search filtering, current-scope detection, and the rail menu — folding there would hide real identities from filtering and confuse `aria-current`; display-only folding keeps every consumer truthful.

## Consequences

A group with N≥2 steward destinations renders 1 fold row instead of N; expanding shows the real rows unchanged. Search (`flat`) renders every steward individually, so a node-specific query can always reach its destination. Group headers gained accessible names (`label + count`), which collided with loose test regexes — four `/个人空间/` queries were tightened to exact matches; no behavior assertion changed. Expansion state resets on remount, which matches the picker's reopen-at-root convention. The rail menu (`wide: false`) keeps its existing flat rendering; folding applies to the page list only.

## Testing

`space-destinations.client.spec.ts` covers fold placement, single-steward pass-through, flat bypass, and base-name derivation including disagreeing names. `components.client.spec.tsx` drives the real component: collapsed fold hides per-computer rows, expanding selects a steward destination with its exact runtime target, an active query flattens the fold, and group heads toggle `aria-expanded` while hiding rows. `scope-control-styles.client.spec.ts` pins the button reset, caret rotation, focus ring, child indentation, and the two-slot row contract (`scopeNameLine`/`scopeAccess`/`destinationComputer`/`computerName`/`stateTag`).
