# Agent Note: Session header split into identity zones with state dots and a metadata seat

Status: implemented

English | [中文](2026-10-12-session-header-identity-zones-and-status-dots.zh.md)

## Problem

The session header rendered title, tabs, and every contributor's control in one undifferentiated flex row. The agent preset sat in `header.actions` styled as a pill, presenting as a clickable control though it carried no action. Session state was invisible without opening a surface: nothing announced that the turn awaited interaction. Contributed triggers mixed vocabularies — capsule radii beside ghost squares, 14px labels beside icon-only buttons — and the row had no overflow policy, so dense headers could wrap or clip. Compact mode duplicated the AppFrame-owned title.

## Decision

The header declares explicit zones in a single non-wrapping row: leading content, a centered identity cluster, tabs, actions, and utilities. The identity cluster owns the session's semantic presence — a `StateDot` before the breadcrumbs, then the crumb trail, then a new `conversation.session.header.titleMeta` seat for non-interactive identity suffixes.

- **State dots mirror `sessionDotState`.** Warning marks a turn waiting on interaction, ongoing marks active work, and an idle session draws no dot. State text reaches screen readers through a visually hidden span; the dot stays presentational.
- **`titleMeta` is the identity-suffix contract.** Contributors that describe *what the session is* — not what it can do — register here and render as text after a hairline divider. `ui-agent-preset` moved from `header.actions` to this seat; its pill chrome and click affordance went away, which is the intent: it was never an action.
- **Header controls converge on one vocabulary.** Icon-only triggers use 28px quiet-ghost targets with `--dsw-radius-md`; surviving text controls drop to the 13px tier. The workbench trigger shed its capsule radius, the desktop-confirmation trigger became a monitor glyph bearing a status dot (confirmed, pending, unavailable), and the right-sidebar expand control joined the same geometry.
- **Status-bearing triggers read eagerly.** The desktop-confirmation control reads its status at mount keyed to the active connection and session binding, then refreshes when the dialog opens; the status-read contract moved from open-time to mount-time because a header dot that waits for the dialog to open would announce nothing.
- **One row at every width.** `.titleRow` sets `flex-wrap: nowrap`; the breadcrumb strip scrolls horizontally without a scrollbar chrome instead of wrapping. Compact mode hides the identity cluster — crumbs, dot, and metadata — because the AppFrame already owns the phone-level title; tabs and controls remain.

## Alternatives considered

**Keeping tabs inside the centered cluster.** Dropped: tabs are a mode switch for the whole session surface, not identity text — centering them beside the title crowded both and broke the visual anchor of a centered title.

**Wrapping overflow into a second row.** Dropped: the row's height anchors the pane's chrome; a variable-height header reflows the entire layout below it. Horizontal scroll inside the breadcrumb strip degrades identity first and chrome never.

**Styling the preset pill without relocating it.** Dropped: the problem was the seat, not the chrome — an inert element in `header.actions` reads as a broken button.

## Consequences

New contributors choose a seat by intent: identity text goes to `titleMeta`, controls to `actions` or `utilities`, and the distinction is now structural rather than conventional. Trigger components that surface live state in the header must budget a mount-time status read keyed to connection and session binding, not an open-time read. The titleMeta seat is typed in `ConversationSessionHeaderSlotProps`, so consumers compile against it; workbench pane headers suppress the repeated identity chrome since the parent row already carries it.
