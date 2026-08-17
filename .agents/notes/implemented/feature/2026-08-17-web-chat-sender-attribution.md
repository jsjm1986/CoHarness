# Agent Note: Web Chat labels project senders on bubbles

Status: implemented

English | [中文](2026-08-17-web-chat-sender-attribution.zh.md)

## Problem

Shared project conversations store authenticated participant metadata on each admitted `user/message`, but the Web Chat bubble rendered that message as an anonymous right-aligned prompt. Readers could not tell who sent a line without expanding the paired `collaboration-context` notice, which is model-facing JSON metadata rather than a conversation line.

## Decision

Chat labels durable user and steering bubbles from `source.participant` on the ordinary `user/message`. Display name wins; a blank display name falls back to username; a missing or unreadable participant yields no label. Organization administrators append the localized `participant.admin` suffix. Alignment stays right. Pending steering has no participant until admission, so it stays unlabeled.

The `collaboration-context` notice remains in the session log and the model request. The Chat Message Definition still matches it so the unknown-surface fallback cannot claim it, then `buildViewNode` returns null so the notice does not appear in the transcript.

Parsing stays local to `ui-conversation`. The Chat plugin does not import `dsh-collaboration-context`.

## Alternatives considered

**Show the notice as a context row.** Rejected: the notice is model metadata, not a human message, and would duplicate the name once the bubble is labeled.

**Import `dsh-collaboration-context`'s parser.** Rejected: that package validates the full project snapshot and throws on malformed data. Chat only needs a display name from a resumed or foreign log and must not fail the transcript.

**Left-align other users or show a self pronoun.** Rejected: the need is attribution for reading, not a messaging-app identity split. The current account is not a Chat-node field; comparing live Gateway context would couple historical bubbles to session identity that later account edits must not rewrite.

**Put the name inside the bubble.** Rejected: it would mix chrome with message text and change what Copy copies.

## Consequences

Personal conversations stay unlabeled. Historical names do not update when an account is renamed. A notice from an older client still occupies log space and model tokens. ACP and CLI transcripts are unchanged.

## Testing

`ui-conversation` unit coverage pins name fallbacks, the admin suffix, unlabeled personal sources, and Chat omitting the notice without promoting it to unknown-surface. jsdom Chat coverage pins user and steering bubbles. A keyless assembled Web golden seeds two attributed speakers plus a notice and asserts the names appear while the notice text does not.
