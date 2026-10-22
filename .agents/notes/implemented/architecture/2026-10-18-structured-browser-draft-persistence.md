# Agent Note: Structured browser draft persistence

Status: implemented

English | [中文](2026-10-18-structured-browser-draft-persistence.zh.md)

## Problem

A reference's display text does not contain its full identity. Persisting only clipboard text keeps a draft sendable but loses the reference spans that drive decoration, editing, and serialization after reload. Persisting executable command callbacks would instead give stored data authority that belongs to the live reference source.

## Decision

The conversation chat store persists a versioned, editor-independent `DraftSnapshot` containing text and semantic reference data. The [codec](../../../../packages/client/ui-conversation/src/client/input/persisted-draft.ts) accepts legacy string drafts and validates stored snapshots at the storage boundary. Restoration remints occurrence ids, retains valid matching spans, and preserves readable text when reference metadata is unusable.

Command callbacks are not persisted. A restored leading command remains text until its registered source claims it. Draft restoration does not send a message, acquire an Agent, or write a Session event. Attachments retain their separate ownership.

The snapshot extends the [Workspace draft-transfer representation](../feature/2026-10-18-rc2-client-surface-parity.md). [Draft initialization](2026-10-17-session-draft-initialization.md) remains responsible for navigation commit, explicit clearing, and refusal during submission.

## Alternatives considered

**Store only canonical clipboard text.** Rejected: the text can be sent but does not preserve the displayed reference's identity and edit behavior.

**Persist runtime occurrence ids and callbacks.** Rejected: occurrence ids belong to the receiving input machine, and executable behavior must be supplied by the current source.

**Replace the textarea with the upstream editor.** Rejected: the existing input machine already owns the necessary reference data; persistence needs its serializable projection.

## Consequences

Reload and Workspace reuse preserve structured references without changing the Session log format. Invalid reference metadata degrades to text rather than constructing an executable reference. Legacy string drafts remain readable.

## Verification

Conversation tests cover serialization round trips, legacy values, damaged reference metadata, regenerated occurrence ids, and failed-submit restoration. The [browser scenario](../../../../apps/web/tests/draft-initialization.e2e.ts) reloads a file reference, verifies its structured presentation and edit behavior, and preserves it through Workspace reuse before any Host message is sent.
