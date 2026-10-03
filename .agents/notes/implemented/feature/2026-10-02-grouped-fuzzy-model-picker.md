# Agent Note: Grouped fuzzy model picker and shared popup-select groups

Status: implemented

English | [中文](2026-10-02-grouped-fuzzy-model-picker.zh.md)

## Problem

The composer model seat and the `/model` command popup each rendered a flat alphabetized list. Long catalogs were unscannable (no provider grouping, no search), the command popup could not mark the current selection or order fuzzy hits, and a selection in flight looked identical to a settled one. The shared picker also kept a per-render `itemRefs.current = []` reset that a discarded concurrent render could leave emptied while committed rows still held live refs, stalling arrow-key traversal on the root pane.

## Decision

`ModelSelect` renders `MenuGroup` sections ordered by `provider-order.ts`, ranks rows per group with `rankByName` against the trimmed query, and shows the search field only above four model rows. The command popup contract gains `group`, `badge`, `active`, and `searchMode: 'fuzzy-label'`; `option-groups.ts` owns group ordering and per-group fuzzy filtering; `PopupSelectView` renders the same `MenuGroup` headings with delayed `data-stuck` styling from `observeStickyMenuGroups` (IntersectionObserver, no layout reads). Selections stay `pending` until the Host write settles: trigger and rows show `StateDot`, and a rejected selection preserves the previous route and directory.

`Input` forwards refs, `CommandUiRuntime` gains `dismiss(name)`, and `/model` passes localized `searchLabels` so both pickers read the same query copy. Row tracking uses `isConnected` filtering instead of the render-time reset, so abandoned renders cannot strand the focus map.

## Alternatives considered

**Keep flat lists and only add a search box.** Rejected: provider grouping is the part that makes fifty-model catalogs navigable; the `/model` popup and the seat menu must also agree on group order or the two entry points teach different layouts.

**Type the `apiProxy` liveness probe through a project reference.** Rejected: `apiproxy` and `api/remotes` already consume `cordis-host-runner`'s `./types` face, so a reverse reference closed a `tsc -b` cycle. The lookup goes through the untyped `Context.get` overload and narrows at the call site instead.

## Consequences

- `PopupSelectContract` options may carry `group`/`badge`/`active`; `searchMode` `'fuzzy-label'` ranks within each group and drops empty headings.
- `ModelDirectoryState.pending` is the selection in flight; consumers must not treat `current` as updated until it clears.
- The sticky heading fill resolves through `--dsw-menu-group-stuck-fill` tokens in both palettes.
- The inspect-registry spec provisions the apiProxy stand-in through `ctx.get('apiProxy' as string)`.
