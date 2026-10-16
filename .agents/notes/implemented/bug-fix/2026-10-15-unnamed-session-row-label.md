# Agent Note: Unnamed session rows localize their label instead of showing the directory name

Status: implemented

English | [中文](2026-10-15-unnamed-session-row-label.zh.md)

## Problem

The workspace tree's `sessionTitle` read `SessionSummary.displayTitle`, the host-facing label that falls back to the workspace basename and then the session id. A history session with no stored title therefore rendered its directory name as if it were a title, and the local title search matched on that directory name too. The upstream fix is `bcf0ba45cb0` plus its rename-entry-point follow-up `a4ac7e9eb36`; most render faces (the `session.untitled` dictionaries, row and search-result labels, empty-draft rename, hover copy suppression) were already present locally — `sessionTitle` was the remaining caller of the fallback label.

## Decision

`sessionTitle` now yields `session.title?.trim() ?? ''` — the persisted title or empty. Renderers own the fallback: blank rows show `session.new`, non-blank rows with an empty title show `session.untitled` in both the tree and the search-result list. Row-title search consequently matches only real stored titles, never a directory name. `SessionRowOwnerProps.displayTitle` keeps its contract — persisted title or empty — because slot owners (rename, fork, archive dialogs) must see the durable value rather than a localized presentation label.

## Alternatives considered

**Fix the host's `displayTitle` to stop falling back.** The basename fallback is what makes the header, workbench toolbar, archive section, and `AppFrame` window title useful for unnamed sessions; those surfaces intentionally keep the host label. Removing the fallback at the wire level would turn every such surface blank.

**Localize inside `sessionTitle`.** Title search consumes the same helper, and matching a localized label against a user's query would be both wrong and locale-dependent; the empty title is the honest projection and presentation labels stay at the render boundary.

## Consequences

Unnamed history rows read 未命名/Untitled in either locale; the rename entry points (double-click and the `session.rename` shortcut) open an empty draft for them rather than pre-filling a directory name; copying a row's title copies nothing when none is stored. The wire `displayTitle` is unchanged — title-bearing consumers elsewhere in the client keep their existing label.

## Verification

`tree.client.spec.ts` asserts an unnamed summary (no `title`, directory `displayTitle`) derives an empty row title, and its `summary()` fixture seeds `title` alongside `displayTitle` so search-match cases exercise the stored-title path. `rows.client.spec.tsx` and `shortcuts.client.spec.ts` already cover the localized labels and the empty rename draft. The `workspace-browser` fixture maps a `displayTitle` override to a stored `title` so the assembled views keep showing named rows.

## Related

- [2026-07-21 log-backed session titles](../feature/2026-07-21-log-backed-session-titles.md) — the title projection and `displayTitle` wire contract this change renders against.
