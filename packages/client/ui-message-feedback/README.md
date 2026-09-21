# @deepseek-ai/dsh-client-ui-message-feedback

English | [中文](README.zh.md)

Per-message feedback plugin, browser half: a Like/Dislike pair plus an optional note, contributed as the `feedback` entry (order 10) of the `conversation.chat.assistant-actions` strip. The strip is declared by `ui-conversation` and rendered inside the finalized assistant message's IconActions row, between copy and branch, so the controls inherit that row's chrome and hover behavior. Changing or creating a rating opens a confirmation dialog before the sidecar mutation; re-clicking the recorded rating retracts it immediately. The note editor itself does not sit in that row: it is a `role="dialog"` popover portaled to `document.body` and anchored under its trigger on desktop; below 768px it becomes a safe-area phone sheet with the shared backdrop and touch-sized save/cancel actions, so the row keeps its single line and the editor remains reachable. A rating or list-load failure shows inline in the row; a note-save failure shows inside the popover, which stays open so the draft can be corrected. Only finalized messages reach the slot — an interruption-frozen partial carries no `messageId` and therefore no feedback controls. The strip renders once per turn, on the closing assistant message that owns the turn's IconActions row: earlier steps of a multi-step turn produce tool rows rather than a rateable body, so they present no controls even though the Host would accept them as targets.

One `MessageFeedbackController` per Session backs every message control in that Session, so a single `messageFeedback.list` read seeds the whole transcript. The read is deferred to the first hover or focus rather than fired on mount, because the controls mount once per settled message in the visible history.

Mutations go through `ctx.remote.messageFeedback`; the Host owns per-item compare-and-set. Every `put` and `delete` carries the `version` this controller last observed, and a `version-conflict` reply carries the authoritative item, so a lost race reconciles from the reply itself instead of refetching the Session. Mutations serialize per Session, so a queued operation always compares against the committed version. Re-clicking the recorded rating retracts the feedback; switching sides carries the existing note forward.

The `/client` exports are the plugin body (`apply`/`inject`), the `MessageFeedbackActions` component, the `MessageFeedbackController` class, and the injected face types.

## Summary

This package is the Web GUI's feedback surface: the Like/Dislike pair in the finalized assistant message's action strip, the feedback dialog with its acknowledgement and failure toasts in the composer overlay, and a decoration that opens the dialog from a bare `/feedback`. Like and Dislike both open the dialog, which collects a category and an optional description before recording the selected rating. One surface per Session backs every entry, so a single list read seeds the whole transcript and one dialog serves the Session and its messages. Ratings, categories, and notes are log-only Session events that never enter model context.

## Model Experience

None, as ratings, categories, and notes are log-only events, not model input. Optional Session-log delivery uses request metadata rather than model context.

#### KV Cache effect

None; feedback mutations leave the model-visible history unchanged.

## Known Limitations and Deferred Work

- **Note size is a Host policy** — the deployment configures `maxNoteBytes` (8192 in the Web bundle) and the Host rejects an oversized note with `note-too-large`. The editor does not pre-check the limit, so an oversized note fails on save rather than while typing.
- **No cross-tab push** — a second tab's rating becomes visible on reconnect or on the next conflict reply, not immediately; the sidecar publishes no live frames.
- **Chat view only** — the trajectory and waterfall views render no feedback controls even though their assistant nodes now carry the same `messageId`.

## Invariants

**Runtime invariant:** No companion is published. Feedback records live in the Host-owned sidecar domain; the browser half renders the action strip and confirmation dialog without holding feedback state.
