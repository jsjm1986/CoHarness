# Agent Note: Memory consolidation scope enforcement

Status: implemented

English | [中文](2026-10-28-memory-curation-scope.zh.md)

## Problem

Consolidation reviews one memory scope and commits that scope's review cursor. Letting its tools address every scope available to the Agent can disclose unreviewed entries, mutate unrelated memory, and count another scope's writes against the reviewed cursor. Defaulting an omitted scope to personal also misroutes workspace reviews.

## Decision

Each pass captures its permitted scopes: all offered scopes for extraction, exactly the selected scope for consolidation. Every tool uses their intersection with the Agent's current scopes. Unfiltered search searches only this set. An omitted scope selects the sole captured scope, while an explicit unavailable scope refuses before storage access. The restriction applies to search, read, save, and delete.

This complements the [triggering execution identity](2026-10-23-curation-execution-identity.md) and [write authority lifetime](2026-10-23-memory-member-authority.md); neither participant attribution nor write authorization replaces the pass's scope restriction.

## Alternatives considered

**Rely on the prompt or tool schema.** The model can return a scope outside the one it reviewed. The executor owns the allowed operation set and enforces it for every call.

**Retain all Agent scopes for consolidation.** The prompt and cursor cover one scope. Cross-scope reads and mutations require a separate design for review input and cursor accounting.

## Consequences

Extraction can still correlate personal and workspace memories. Consolidation reads and writes one scope, and its successful-write count belongs to the same cursor. Disabling memory removes the executable scopes even from an already dispatched response.

## Verification

Six source regressions cover all four cross-scope tools, unfiltered search, and an omitted workspace scope. The real Loader, Agent, auxiliary model runtime, and JSON storage snapshot checks model-facing refusals and final durable entries in both scopes.
