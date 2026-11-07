# Agent Note: Retain failed language-server cleanup before replacement

Status: implemented

English | [中文](2026-11-03-lsp-cleanup-retry.zh.md)

## Problem

A failed managed-range observation does not prove that a language server stopped. Removing its dead instance from the workspace pool loses the provider's cleanup reference and lets a later query allocate a replacement while the old native server remains alive. Permanently caching the failed teardown also prevents later cleanup from recovering.

## Decision

The [pool](../../../../packages/lsp/lsp-stdio/src/index.ts) evicts an instance only after successful cleanup. A later query retries cleanup of a retained dead instance before allocating its replacement. Provider disposal retains unsuccessful slots and drains siblings before reporting failures; a later cleanup attempt can retry those slots.

The [instance](../../../../packages/lsp/lsp-stdio/src/instance.ts) shares each teardown attempt among concurrent callers. After an explicit disposal observes failure, it clears only that failed attempt, while query admission stays closed. Successful teardown remains cached. Internal cancellation preserves the attempt until the provider observes and reports its outcome.

## Alternatives considered

**Evict every dead instance.** A transport failure prevents queries but cannot establish physical process quiescence.

**Cache failed disposal forever.** A recoverable observation failure then makes cleanup permanently fail without another native attempt.

**Start replacements while retaining a separate failed list.** It permits overlapping native servers for one provider and workspace.

## Consequences

An unconfirmed cleanup refuses the affected query instead of creating another server. Cleanup can recover on a later query or provider cleanup attempt. Native containment and whole-Host crash recovery remain responsibilities of the subprocess provider; this decision adds no broader platform guarantee.

## Verification

The real Loader [example](../../../../packages/lsp/lsp-stdio/tests/fixtures/cleanup-retry.mjs) retains a real stdio server through a controlled native-cleanup observation failure. It verifies that cleanup stops that server before replacement, then joins both native servers. Unit cases cover concurrent disposal failure, closed query admission, retained pool slots and sibling cleanup aggregation.
