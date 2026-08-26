# Agent Note: Human-readable Admin archive conversation reader

Status: implemented

English | [中文](2026-08-26-admin-archive-conversation-reader.zh.md)

## Problem

The Admin archive reader rendered every event envelope as a card. Sequence numbers, session identifiers, internal lifecycle records, and raw JSON obscured the user and assistant messages, while configuration-only archives looked like broken conversations.

## Decision

The Admin archive detail projects the lossless event page into a chat-oriented reader. User and assistant messages use role-labelled bubbles, paired tool calls and results use a compact tool card, and selected permission, sandbox, plan, approval, and failure events use short system notices. Empty message content is omitted from the chat projection. Session identifiers, sequence numbers, and raw JSON stay inside a collapsed technical-details section that also retains the session tree and every returned event. Long message and result text scrolls inside its card, and the reader keeps the same hierarchy on narrow screens.

The projection remains in the Admin client rather than changing the archive API. The API continues to return lossless events for export and future event types; unknown events are available through technical details without being guessed into a user-facing message.

## Alternatives considered

**Keep one raw card for every event.** Rejected because log-only records and envelope metadata dominate the reading order and make a normal conversation difficult to follow.

**Remove raw events from the reader response.** Rejected because administrators still need an audit path for unknown, failed, or configuration-only records; collapsing the details preserves that evidence without making it the default view.

**Build a server-side transcript field.** Rejected because presentation labels and responsive grouping belong to the Admin client, while the existing event response remains the lossless source for export and other consumers.

## Consequences

Administrators see the conversation first and can expand one technical-details section when they need sequence, session, or JSON data. Configuration-only archives explain that no user or assistant messages were recorded instead of appearing empty. Tool output and long text remain bounded within the dialog on desktop and mobile. New event types remain auditable but do not appear in the chat view until the client has an explicit human-readable mapping.

## Verification

The Admin archive page tests cover message and tool projection, collapsed raw details, and configuration-only archives. The complete Admin UI suite passes, and the Admin Vite build emits the updated production bundle.
