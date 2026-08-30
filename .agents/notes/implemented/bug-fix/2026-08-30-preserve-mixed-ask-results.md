# Agent Note: Preserve mixed ask-user result diagnostics

Status: implemented

English | [中文](2026-08-30-preserve-mixed-ask-results.zh.md)

## Problem

The ask-user summary row parsed every text block in a successful tool result and discarded non-text blocks before rendering. A result that contained valid answers plus a reasoning or diagnostic block therefore showed an answer count while hiding information that the generic expanded output could preserve.

## Decision

The tool-view model uses `singleResultText` only when a settled result contains exactly one text block. Mixed or non-text results keep the generic summary and output path, which serializes every content block. This keeps answer-count parsing best-effort without dropping diagnostic data.

## Alternatives considered

**Continue concatenating all text blocks.** Rejected because it silently loses non-text diagnostics and can make unrelated text parse as an answer document.

**Parse mixed content and add a second bespoke renderer.** Rejected because it duplicates the generic content contract and would need to define presentation for every future block kind.

**Reject the whole tool result.** Rejected because a valid answer payload remains useful; the generic renderer can show it together with the diagnostic.

## Consequences

Single-text answer results retain the existing answered-count summary. Mixed results expose their complete JSON-like output when expanded and do not claim a parsed answer count. Future content block kinds automatically remain visible through the generic path.

## Testing

The ask-user row test covers a valid answer text block paired with a reasoning block and asserts that the generic expanded output includes both the block type and diagnostic text.
