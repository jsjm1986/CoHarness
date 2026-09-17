# Agent Note: Plugin-owned Session message projections

Status: implemented

English | [中文](2026-09-18-session-message-projections.zh.md)

## Problem

Plugin-owned message changes must replay without mutating committed events. Cached messages must not remain readable after their interpreter unloads.

## Decision

[Session](../../../../packages/core/session/README.md) interprets plugin-owned content decisions before accepting their events. The surface manager plans updates without mutating current messages, commits the returned immutable copies after log acceptance, and invalidates cached derivation through a content generation distinct from positional replacement generation. Original events remain unchanged.

Registration belongs to the plugin fiber. Sessions borrow definitions across creation, persistence restore and fork; removing a used definition invalidates cached and committed-but-not-yet-folded decisions. An uncommitted candidate does not retain its interpreter. This prevents replay from silently presenting original content after its interpreter disappears.

## Local adaptation

The local `seedSource: 'persistence'` ownership protocol, absolute-sequence event windows, packed chunk records and immutable Session generations remain intact. The catalog generator derives required interpreters from `@messageProjection`, rejecting declarations that also perform positional surface operations. No production event uses this annotation in this phase; image offload remains a later consumer. Tests provide a required fixture type without adding it to the production catalog.

## Alternatives considered

Mutating source events breaks immutable logs. Special-casing plugin event types in Session couples replay to providers. Returning original messages after interpreter disposal silently loses committed decisions.

## Consequences

Five regression cases cover missing interpreters, atomic rejection, replay, restore, fork, disposal, windows and uncommitted candidates. Generator cases cover discovery and invalid dual declarations. The real Loader preset scenario applies a logged decision on `agent/message-entered`, verifies unchanged durable input and requires the projected text in the first model request. Existing TypeScript SDK transcripts remain unchanged. This mechanism does not change wire envelopes or Session format versions.
