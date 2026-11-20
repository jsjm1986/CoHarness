# Agent Note: Progressive document overview

Status: implemented

English | [中文](2026-11-19-progressive-document-overview.zh.md)

## Problem

The organization document overview returns partial metadata once its foreground deadline expires. An authorized computer that responds successfully to a direct index read can miss that deadline on every overview refresh. Extending the deadline makes all documents wait for that computer.

## Decision

The primary browser entry may request a streamed overview at the existing account endpoint. The Gateway reads one bounded page per source through the existing computer routes. It combines ready prefixes and publishes provisional first-page rows without a continuation. Each publication rechecks the browser account and document grants. Access invalidation cancels the readers, and the browser clears results on authorization failure.

The final page carries the merged ordering and the consumed position of each responding source. An unavailable computer is excluded from that pagination sequence until the next first-page query. A previously participating source that fails during continuation leaves the prior page intact for retry. Node indexes remain readable without Runtime startup.

## Alternatives considered

**Increase the JSON deadline.** All rows remain blocked by the slowest active source until the larger deadline.

**Request each failed computer again from the browser.** Combining independently returned rows into subsequent pages would move sort order and cursor ownership out of the catalog. The stream preserves the organization and account scope for each emitted page while reusing completed reads.

## Consequences

The browser can act on confirmed rows while other computers are still loading. First-page ordering may change until the final page arrives. Subsequent pages use the finalized source positions, and the Gateway retains at most one page of merged candidates plus the configured concurrent source reads. Existing JSON clients retain the foreground deadline.

## Verification

The loopback Gateway fixture holds the remote response until it observes the provisional local page. It verifies global ordering across two cursor pages, revocation before completion, request cancellation, and explicit refresh after an outage. Browser component cases cover mobile use of provisional rows and clearing the page after access changes.
