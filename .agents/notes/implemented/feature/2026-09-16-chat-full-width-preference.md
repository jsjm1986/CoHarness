# Agent Note: Chat content width carries a separate persisted fill flag

Status: implemented

English | [中文](2026-09-16-chat-full-width-preference.zh.md)

## Problem

`CHAT_CONTENT_WIDTH_RANGE` clamps the transcript column to 560–1080px, a readability bound shared by the settings slider, the drag handle, the persisted settings schema, and the Gateway account-preference validator. On wide panes the column stops growing and margins keep expanding. Users asked for a way to let the transcript fill the pane without weakening the pixel bound for everyone else. A width value alone cannot express fill intent: any sentinel inside the numeric range collides with range validation on both the browser and the Gateway, and an out-of-range sentinel loses the user's remembered pixel width.

## Decision

`ConversationSettings` gains an independent persisted boolean, `chatFullWidth`, defaulting to `false`. The pixel `chatContentWidth` stays stored while fill is on, so disabling fill restores the previous width without a second preference. The transcript renders `calc(100% - 2 × side clearance)` when fill is on, preserving the composer margin relationship; the settings row disables the slider and reports the fill state instead of a number.

Fill is a mode, not a width. Any explicit pixel choice — slider, drag handle, or keyboard step — clears `chatFullWidth` and persists both mutations through the same scope. The drag handle measures the rendered column width as its drag origin while fill is on, so leaving fill continues from what the user sees instead of the stale stored number.

The field travels the existing account-preference path end to end: the zod settings schema, the display-settings store's pending-write reconciliation, the settings row checkbox, the `AccountPreferenceMutation` field whitelist and `string | number | boolean` value union, the Gateway `normalizeAccountPreferenceMutation` boolean check, the `harness.user_preferences.chat_full_width` column added by migration `026_chat_full_width.sql`, and the legacy `settings.yaml` reader used during PostgreSQL row initialization. The values view defaults the field to `false`; the overrides layer omits it while the column is null.

## Alternatives considered

**Encode fill as a sentinel width.** A magic number inside or outside the numeric range conflates two intents in one field, forces both the client schema and the Gateway validator to special-case it, and overwrites the remembered pixel width the user expects back when leaving fill.

**Keep fill as session-local UI state.** A transient toggle would not follow the account across browsers and runtimes, which is the contract every other display preference already honors through the account scope.

**Raise `CHAT_CONTENT_WIDTH_RANGE.max` instead.** Widening the pixel bound removes the readability cap for every user and still cannot express "fill however wide the pane is"; fill is an opt-in escape, not a new default.

## Consequences

Every layer of the account-preference path must accept the new field or writes fail closed. That is exactly what the first version of the feature proved: the Gateway field whitelist and the PostgreSQL column lagged the browser UI, so `PATCH /account/api/preferences` rejected `chatFullWidth` and every row sharing the `ui-conversation` write state rendered the save error. The field therefore ships with coverage at each acceptance boundary — route-level accepts/rejects in `gateway/tests/account-preferences.spec.ts`, transport decoding and legacy defaults in the connection spec, scope mutation typing in the account-scope spec, and the column path in the PostgreSQL service test.

Fill mode widens the transcript beyond the documented readability bound only when the account opts in; the pixel range, its Gateway validation, and the drag-handle clamp remain unchanged for explicit widths.
