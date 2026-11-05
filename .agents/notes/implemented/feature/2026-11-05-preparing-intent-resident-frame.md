# Agent Note: Preparing intents mount the resident conversation frame

Status: implemented

English | [中文](2026-11-05-preparing-intent-resident-frame.zh.md)

## Problem

`ConversationIntents.begin()` shows an editable draft while a selected Session is acquired, but the standalone card it rendered was a bare textarea floating in an empty page: no conversation chrome, no composer affordances, and a visible layout jump when the Session landed. The mechanism is a perceived-speed feature; the presentation read as a broken page.

## Decision

`ConversationRoot` mounts the resident `conversation.content` factory for the active intent and passes the intent through new optional `pendingIntent`/`onIntentInput`/`onIntentRetry`/`onIntentHide` owner props on `ConversationContentInputProps`. When `pendingIntent` is set, `ConversationContent` resolves the active (docked) phase, suppresses the session header slot, the transcript views, the `data-conversation-session` marker, the session-scoped `conversation.composer` takeover chain, and every `conversation.composer.bar` render — an ambient committed Session cannot leak into the preparing surface. The composer seat instead renders `PendingIntentComposer`, a draft card that mirrors the InputBar surface (22px radius, input-major fill, soft elevation, 16/16/12 padding, 14/20 text) and edits `intent.text` through `intents.edit`, so the real composer lands in the same seat without a layout step on `transfer()`. It owns no send action because submission requires the acquired Session. Workbench panes render the same card standalone via the `solo` presentation.

## Alternatives considered

**Bind the provisional sessionId to a real `inputHub` shell.** The bar would be fully functional but the draft would live in the pseudo-session shell while `transfer()` moves only `intent.text`; a shell-to-intent mirror subscription adds a second source of truth for one short-lived surface.

**Render the no-session `conversation.composer.bar`.** The session-maybe bar is inert without a Session — a disabled textarea cannot hold the type-ahead draft that is the feature's purpose.

## Consequences

The preparing state reuses the resident frame, tokens, and composer geometry; no parallel visual system was added. The card keeps `role="status"` for the preparing/unavailable/denied copy and the retry/back actions. Session-only controls (attachments, plan/model seats, docks, takeovers) stay absent because the pending path never mounts session-scoped slots. Coverage lives in `tests/skeleton.client.spec.tsx`: the pending frame renders no session slot calls, the textarea edits call `onIntentInput`, and the unavailable/denied states expose retry and back.
