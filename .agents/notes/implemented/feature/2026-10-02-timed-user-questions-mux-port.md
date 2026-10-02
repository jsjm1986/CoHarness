# Agent Note: Timed user questions ported onto the mux question transport

Status: implemented

English | [中文](2026-10-02-timed-user-questions-mux-port.zh.md)

## Problem

Upstream timed `ask_user_question` (the `#5178` stack) reached us as a package built on a different interaction model: plugin-registered pending interactions fed through `uiSession`, Remote waterfall subscriptions, and Remote claim streams. This fork's question transport is the mux `question/requested` frame answered by `/api/respond`, and other surfaces (approval, queued composer input, ACP) share that wire. A wholesale transport swap would retire a working path; ignoring the stack would leave timed waits, late answers, and read-only answer review unshipped.

## Decision

Keep the mux transport and port the card model onto it.

- `Session.publishInteraction` adds plugin-owned entries to the Session pending feed alongside wire `PendingWait`s; the feed is the single pending surface the composer seat and the session row read.
- `PendingQuestion` keeps the upstream card lifecycle — waterfall channel, countdown deadline, hide/reveal, review — with the waterfall `resolve`/`reject`/`delegate` bridged to `wait.respond`, so the mux frame remains the answer carrier.
- A wait carrying `wait.timed` opens the Remote `userQuestions.attachWait` claim stream once; the waterfall attaches only after the opening frame lands the deadline, so the countdown never flashes a wrong value.
- A live card retains its Session scope (`userQuestion` reference source). Scope teardown prunes the session-scoped draft store, so deselecting a session must not release it while a question remains answerable; the release happens when the card closes.
- A re-bound Session starts with an empty published feed, so cards re-anchor onto the new Session object on every reconcile pass. Conversely, only the Session object that carried a wait may vouch for its departure — absence after a re-bind is not a settlement.
- A closed turn owns a turn-process row even without assistant evidence, so a reply-only turn still folds what it leaves behind; folded members stay mounted under `hidden` instead of leaving the DOM, since a late reply mutates while hidden and must paint complete on reveal.
- A late answer lands as a `user/message` whose source is `user-question-reply`; the `question-reply` node definition projects it as a read-only review row that reopens the recorded answer batch.

## Alternatives considered

**Adopt upstream's plugin-published pending model wholesale.** Rejected: it retires the mux `question/requested` frame and `/api/respond` that approval and other transports share, and rewrites a working wire for no product-visible gain.

**Keep the wire-only card list and bolt the timer on.** Rejected: the pre-port card had no notion of a continued or late answer; the upstream `PendingQuestion` lifecycle already encodes exactly those states.

**Key question drafts by session id in a global store.** Rejected: the session-scoped draft store is the declared home for remount-surviving state; a second store would duplicate its lifecycle rules.

## Consequences

- `SessionPendingEntry` widens to include plugin-published entries; consumers narrow on `kind` before reading wire fields.
- `SessionReferenceSourceMap` gains the `userQuestion` source; retention shows up in `retainInfo` like every other owner.
- A released scope replays no pending waits, so wait-departure detection is object-scoped, not key-scoped — a stale `WaitBinding` survives a re-bind until the card closes.

## Testing

`browser-plugin.client.spec.ts` drives the port end to end against the mux `PendingWait` — adoption, timed claim anchoring, reconnect replay, feed departure, and the retain/release contract. `question-composer.e2e.ts` records the late-answer scenario: the reply row mounts folded inside its turn's process disclosure and expands to a read-only answer review.
