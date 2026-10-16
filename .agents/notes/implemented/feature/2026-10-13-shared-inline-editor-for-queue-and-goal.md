# Agent Note: Shared InlineEditor keeps line breaks in queue and goal edits

Status: implemented

English | [中文](2026-10-13-shared-inline-editor-for-queue-and-goal.zh.md)

## Problem

The QueueDock row editor and the GoalBar objective editor were single-line `<input>` elements. HTML strips newlines from input values, so editing a queued message or goal whose text contained line breaks silently lost them on save; a pasted multi-line draft collapsed before it could be re-edited. Upstream source: `66e101821c334723a38b98dadf289b5f771915a7` (`refactor(client): share the queued-message and goal inline editor`), present in both alpha releases.

## Decision

`ui-primitives` exports `InlineEditor`: an autofocused `<textarea>` that grows with its text up to six CSS lines, then scrolls. A `ResizeObserver` refits the height when the element's width changes, because rewrapping alters `scrollHeight` without changing the value. Keyboard contract: plain Enter saves, Shift+Enter breaks the line, Enter during IME composition (including the legacy `keyCode === 229` signal) does nothing, and Escape cancels. The caller supplies the localized `label` for the accessible name and an optional placement `className`.

QueueDock's editing branch and GoalBar's editing branch both render `InlineEditor` instead of their local `<input>` handlers; the per-consumer editor styles are gone, so both surfaces share the atom's geometry and focus ring. `Input` stays the single-line atom; its header names `InlineEditor` for multi-line inline edits.

## Alternatives considered

**Keeping a textarea per consumer.** Rejected: the two editors had already grown the same auto-fit and IME handling, and duplicating the refit logic leaves them free to drift apart again.

**Fixing `<input>` to preserve newlines.** Rejected: a single-line control cannot display the value it would preserve; the semantic element for editable multi-line text is `<textarea>`.

## Consequences

Editing a queued message or goal with embedded line breaks keeps them in the draft and on save. Both editors gain width-aware refit and identical IME protection; future inline-edit surfaces inherit the behavior through the shared atom. Consumers that only read the queue preview or goal display see no change.

## Verification

`packages/client/ui-primitives/tests/inline-editor.client.spec.tsx` covers autofocus, `rows=1`, newline-preserving `onChange`, plain-Enter save with `preventDefault`, Shift+Enter, `isComposing`/`keyCode 229` suppression, Escape cancel, scrollHeight-plus-border sizing, and `ResizeObserver` refit and disposal. `packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` and `packages/client/ui-goal/tests/goalbar.client.spec.tsx` cover the save/cancel flows through the shared editor.

## Related

- [Web input machine and slash pipeline](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) — owns the composer keyboard arbitration the queue editor sits beside.
