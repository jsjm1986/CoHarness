# Agent Note: Settings saves acknowledge individual submitted drafts

Status: implemented

English | [中文](2026-09-23-settings-save-acknowledgments.zh.md)

## Problem

A credential presence read cannot prove that a replacement succeeded: an old key remains configured after a refused write. Clearing a whole form when an asynchronous save settles also discards edits that were never submitted. Two reads of the same credential reference can arrive in reverse order and restore obsolete state.

## Decision

The [plugin card form](../../../../packages/client/ui-settings-plugins/src/client/card-form.ts) clears only the exact drafts acknowledged by successful writes. A refusal, transport failure or lost namespace write access stops the remaining operations, releases the saving state and preserves pending edits. Credential replacements require their own successful RPC result and an unchanged target reference; credential presence alone is insufficient. Read generations reject superseded responses for both identical and different references.

The [plugin-owned settings decision](../architecture/2026-08-12-plugin-owned-settings-surface.md) continues to own registration and presentation. This decision changes acknowledgment and draft lifetime, without introducing another settings writer or changing account and project ownership.

## Alternatives considered

**Disable every editor during saves.** This prevents concurrent edits but does not establish whether a rejected credential write succeeded. Retaining newer drafts allows continued editing without mistaking them for saved values.

**Treat any configured key as success.** This confuses credential existence with replacement acknowledgment and hides authorization or transport failures.

**Roll back earlier fields after a later failure.** Fields use independently revision-fenced operations; compensating writes could overwrite another editor. The form reports partial acceptance and retains only pending edits.

## Consequences

Settings remain editable during saves, while failed writes stay visible and retryable. Saves are not multi-field transactions. Deterministic deferred-response tests protect draft ownership and read order; assembled browser tests exercise real settings persistence and credential-provider refusal without model calls.
